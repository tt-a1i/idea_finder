import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { asId, buildGoogleTrendSeries, classifySearchMomentum, createGoogleTrendsObservation } from "@idea-finder/core";
import type { GoogleTrendsNormalizationContext, MetricObservation, ResearchRun, TrendEvent, TrendSeries } from "@idea-finder/core";

import { openLocalStorage } from "./index.js";

function tempDataDir(): string {
  return mkdtempSync(join(tmpdir(), "idea-finder-storage-"));
}

const sampleRun = (): ResearchRun => ({
  id: asId("run_test_1"),
  huntingTaskId: asId("task_test_1"),
  status: "pending",
  startedAt: null,
  completedAt: null,
  configHash: "cfg_test_v1",
  errorMessage: null,
});

describe("@idea-finder/storage local persistence", () => {
  it("round-trips ResearchRun and is idempotent on schema init", () => {
    const dataDir = tempDataDir();
    try {
      const storage1 = openLocalStorage({ dataDir });
      storage1.researchRuns.save(sampleRun());
      storage1.close();

      const storage2 = openLocalStorage({ dataDir });
      const loaded = storage2.researchRuns.get(asId("run_test_1"));
      expect(loaded).toEqual(sampleRun());
      storage2.close();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("stores distinct runs with the same huntingTaskId + configHash", () => {
    const dataDir = tempDataDir();
    try {
      const storage = openLocalStorage({ dataDir });
      storage.researchRuns.save(sampleRun());
      storage.researchRuns.save({ ...sampleRun(), id: asId("run_test_2") });
      expect(storage.researchRuns.get(asId("run_test_1"))?.configHash).toBe("cfg_test_v1");
      expect(storage.researchRuns.get(asId("run_test_2"))?.configHash).toBe("cfg_test_v1");
      storage.close();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("migrates the legacy task/config uniqueness without losing runs", () => {
    const dataDir = tempDataDir();
    try {
      const legacy = new DatabaseSync(join(dataDir, "idea_finder.db"));
      legacy.exec(`
        CREATE TABLE research_runs (
          id TEXT PRIMARY KEY,
          hunting_task_id TEXT NOT NULL,
          status TEXT NOT NULL,
          started_at TEXT,
          completed_at TEXT,
          config_hash TEXT NOT NULL,
          error_message TEXT,
          UNIQUE (hunting_task_id, config_hash)
        );
        INSERT INTO research_runs VALUES
          ('run_legacy', 'task_test_1', 'completed', NULL, NULL, 'cfg_test_v1', NULL);
      `);
      legacy.close();

      const storage = openLocalStorage({ dataDir });
      expect(storage.researchRuns.get(asId("run_legacy"))?.configHash).toBe("cfg_test_v1");
      storage.researchRuns.save({ ...sampleRun(), id: asId("run_after_migration") });
      expect(storage.researchRuns.get(asId("run_after_migration"))?.configHash).toBe("cfg_test_v1");
      storage.close();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("migrates legacy globally keyed material tables to run-scoped identity", () => {
    const dataDir = tempDataDir();
    try {
      const legacy = new DatabaseSync(join(dataDir, "idea_finder.db"));
      legacy.exec(`
        CREATE TABLE raw_documents (
          id TEXT PRIMARY KEY,
          research_run_id TEXT NOT NULL,
          payload_json TEXT NOT NULL
        );
        CREATE INDEX idx_raw_documents_run ON raw_documents (research_run_id);
        INSERT INTO raw_documents VALUES
          ('doc_shared', 'run_legacy_a', '{"id":"doc_shared","rawBody":"legacy"}');
      `);
      legacy.close();

      const storage = openLocalStorage({ dataDir });
      const migrated = storage.rawDocuments.listByRun(asId("run_legacy_a"));
      expect(migrated).toEqual([{ id: "doc_shared", rawBody: "legacy" }]);
      storage.rawDocuments.save(asId("run_legacy_b"), migrated[0]!);
      expect(storage.rawDocuments.listByRun(asId("run_legacy_a"))).toHaveLength(1);
      expect(storage.rawDocuments.listByRun(asId("run_legacy_b"))).toHaveLength(1);
      storage.close();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("round-trips run-scoped entities", () => {
    const dataDir = tempDataDir();
    const runId = asId("run_entities");
    try {
      const storage = openLocalStorage({ dataDir });

      const doc = {
        id: asId("doc_1"),
        sourceTier: "L1" as const,
        platform: "hn",
        externalId: null,
        url: "https://example.com/1",
        fetchedAt: "2026-07-09T00:00:00.000Z",
        fetchMethod: "api" as const,
        fetchAgentRunId: null,
        contentType: "post" as const,
        rawBody: "body",
        huntingTaskId: asId("task_1"),
        retentionClass: "standard" as const,
        legalBasis: "public_api_tos" as const,
      };

      storage.rawDocuments.save(runId, doc);
      expect(storage.rawDocuments.get(runId, asId("doc_1"))).toEqual(doc);
      expect(storage.rawDocuments.listByRun(runId)).toEqual([doc]);

      storage.close();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("keeps equal entity IDs scoped to distinct ResearchRuns", () => {
    const dataDir = tempDataDir();
    try {
      const storage = openLocalStorage({ dataDir });
      const entity = {
        id: asId("doc_shared"),
        sourceTier: "L1" as const,
        platform: "manual",
        externalId: "same",
        url: "manual://same",
        fetchedAt: "2026-07-11T00:00:00.000Z",
        fetchMethod: "import" as const,
        fetchAgentRunId: null,
        contentType: "page" as const,
        rawBody: "same evidence",
        huntingTaskId: asId("task_shared"),
        retentionClass: "pinned" as const,
        legalBasis: "user_provided" as const,
      };
      storage.rawDocuments.save(asId("run_a"), entity);
      storage.rawDocuments.save(asId("run_b"), entity);
      expect(storage.rawDocuments.listByRun(asId("run_a"))).toEqual([entity]);
      expect(storage.rawDocuments.listByRun(asId("run_b"))).toEqual([entity]);
      storage.close();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("persists canonical Brief, config, admission, and source status records", () => {
    const dataDir = tempDataDir();
    try {
      const storage = openLocalStorage({ dataDir });
      storage.huntingBriefs.save({ id: "task_canonical", slug: "canonical" });
      storage.researchRunConfigs.save({ id: "run_canonical", effectiveConfig: { mode: "manual" }, execution: "new" });
      storage.libraryAdmissionResults.save(asId("run_canonical"), { id: "draft_1", decision: "rejected", opportunityId: null, issues: [{ code: "evidence.low" }] });
      storage.sourceStatuses.save(asId("run_canonical"), { id: "manual", source: "manual", status: "success", itemCount: 0, reason: null, completedAt: "2026-07-11T00:00:00.000Z" });
      storage.close();

      const restarted = openLocalStorage({ dataDir });
      expect(restarted.huntingBriefs.list()).toEqual([{ id: "task_canonical", slug: "canonical" }]);
      expect(restarted.researchRunConfigs.get("run_canonical")).toMatchObject({ effectiveConfig: { mode: "manual" } });
      expect(restarted.libraryAdmissionResults.listByRun(asId("run_canonical"))).toHaveLength(1);
      expect(restarted.sourceStatuses.listByRun(asId("run_canonical"))).toHaveLength(1);
      restarted.close();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("stores blobs content-addressed under data/blobs", async () => {
    const dataDir = tempDataDir();
    try {
      const storage = openLocalStorage({ dataDir });
      const content = new TextEncoder().encode("blob-content");
      const ref1 = await storage.blobs.put(content);
      const ref2 = await storage.blobs.put(content);

      expect(ref1.hash).toBe(ref2.hash);
      expect(ref1.path).toContain(join("blobs"));
      expect(await storage.blobs.get(ref1)).toEqual(content);
      storage.close();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("enqueues jobs idempotently", async () => {
    const dataDir = tempDataDir();
    try {
      const storage = openLocalStorage({ dataDir });
      const job1 = await storage.jobs.enqueue("harvest", { runId: "r1" }, "key-1");
      const job2 = await storage.jobs.enqueue("harvest", { runId: "r1" }, "key-1");
      expect(job1.id).toBe(job2.id);
      storage.close();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("tracks pipeline steps for idempotent orchestration", () => {
    const dataDir = tempDataDir();
    const runId = asId("run_steps");
    try {
      const storage = openLocalStorage({ dataDir });
      expect(storage.pipelineSteps.isComplete(runId, "harvest")).toBe(false);
      storage.pipelineSteps.markComplete(runId, "harvest");
      expect(storage.pipelineSteps.isComplete(runId, "harvest")).toBe(true);
      storage.pipelineSteps.markComplete(runId, "harvest");
      expect(storage.pipelineSteps.isComplete(runId, "harvest")).toBe(true);
      storage.close();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("rolls back canonical multi-record transactions", () => {
    const dataDir = tempDataDir();
    try {
      const storage = openLocalStorage({ dataDir });
      expect(() => storage.transaction(() => {
        storage.huntingBriefs.save({ id: "task_rollback", slug: "rollback" });
        throw new Error("rollback requested");
      })).toThrow("rollback requested");
      expect(storage.huntingBriefs.get("task_rollback")).toBeNull();
      storage.close();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("persists and queries canonical quantitative state across restart", () => {
    const dataDir = tempDataDir();
    const observation = {
      id: asId("metric_github_stars_1"),
      subject: { kind: "repository" as const, externalId: "octocat/hello-world", url: "https://github.com/octocat/Hello-World" },
      source: "github" as const,
      metric: "stars" as const,
      lane: "developer_adoption" as const,
      geography: null,
      observedAt: "2026-07-11T00:00:00.000Z",
      rawValue: 2150,
      normalizedValue: 2150,
      unit: "count" as const,
      collectionMethod: "github_rest_api" as const,
      provenance: {
        collector: "idea-finder-github", collectorVersion: "1", interface: "github_rest_api" as const,
        sourceRef: "https://api.github.com/repos/octocat/Hello-World", collectedAt: "2026-07-11T00:00:00.000Z",
      },
    } satisfies MetricObservation;
    const previousObservation = {
      ...observation,
      id: asId("metric_github_stars_0"),
      observedAt: "2026-07-10T00:00:00.000Z",
      rawValue: 2000,
      normalizedValue: 2000,
    } satisfies MetricObservation;
    const series = {
      id: asId("trend_github_stars"), subject: observation.subject, source: "github" as const,
      metric: "stars" as const, lane: "developer_adoption" as const, observationIds: [previousObservation.id, observation.id],
      startedAt: previousObservation.observedAt, endedAt: observation.observedAt,
    } satisfies TrendSeries;
    const event = {
      id: asId(`tevt_${series.id}_${observation.id}_momentum_up`), seriesId: series.id, kind: "momentum_up" as const,
      detectedAt: "2026-07-11T00:01:00.000Z", previousObservationId: previousObservation.id,
      currentObservationId: observation.id, previousValue: 2000, currentValue: 2150,
      absoluteDelta: 150, relativeDelta: 0.075, detector: "two_point_delta_v1" as const,
    } satisfies TrendEvent;
    try {
      const storage = openLocalStorage({ dataDir });
      storage.transaction(() => {
        storage.metricObservations.save(previousObservation);
        storage.metricObservations.save(observation);
        storage.metricObservations.save(observation);
        storage.trendSeries.save(series);
        storage.trendEvents.append(event);
        storage.quantitativeSourceStatuses.save({
          id: "github:octocat/hello-world", source: "github", subjectExternalId: "octocat/hello-world",
          status: "success", itemCount: 1, reason: null, checkedAt: observation.observedAt,
        });
      });
      expect(storage.metricObservations.list({ subjectExternalId: "octocat/hello-world", metric: "stars" })).toEqual([previousObservation, observation]);
      expect(storage.metricObservations.list({ metric: "forks" })).toEqual([]);
      storage.close();

      const restarted = openLocalStorage({ dataDir });
      expect(restarted.metricObservations.get(observation.id)).toEqual(observation);
      expect(restarted.trendSeries.list({ subjectExternalId: "octocat/hello-world" })).toEqual([series]);
      expect(restarted.trendEvents.listBySeries(series.id)).toEqual([event]);
      expect(restarted.quantitativeSourceStatuses.get("github:octocat/hello-world")?.status).toBe("success");
      restarted.close();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("fails closed on quantitative identity conflicts and rolls back a batch", () => {
    const dataDir = tempDataDir();
    try {
      const storage = openLocalStorage({ dataDir });
      const base = {
        id: asId("metric_identity"),
        subject: { kind: "repository" as const, externalId: "owner/repo", url: "https://github.com/owner/repo" },
        source: "github" as const, metric: "stars" as const, lane: "developer_adoption" as const,
        geography: null, observedAt: "2026-07-11T00:00:00.000Z", rawValue: 1, normalizedValue: 1,
        unit: "count" as const, collectionMethod: "github_rest_api" as const,
        provenance: { collector: "test", collectorVersion: "1", interface: "github_rest_api" as const, sourceRef: "fixture", collectedAt: "2026-07-11T00:00:00.000Z" },
      } satisfies MetricObservation;
      storage.metricObservations.save(base);
      expect(() => storage.metricObservations.save({ ...base, id: asId("metric_wrong_lane"), lane: "supply" })).toThrow("lane conflicts");
      expect(() => storage.metricObservations.save({ ...base, id: asId("metric_wrong_unit"), unit: "rank" })).toThrow("derived fields conflict");
      expect(() => storage.metricObservations.save({ ...base, normalizedValue: 2 })).toThrow("conflicts with canonical SQLite state");
      expect(storage.metricObservations.list()).toEqual([base]);
      expect(() => storage.trendSeries.save({
        id: asId("trend_missing"), subject: base.subject, source: "github", metric: "stars",
        lane: "developer_adoption", observationIds: [asId("metric_missing")],
        startedAt: base.observedAt, endedAt: base.observedAt,
      })).toThrow("references missing MetricObservation");
      const otherSubject = { ...base, id: asId("metric_other_subject"), subject: { ...base.subject, externalId: "other/repo", url: "https://github.com/other/repo" } };
      storage.metricObservations.save(otherSubject);
      expect(() => storage.trendSeries.save({
        id: asId("trend_mixed_identity"), subject: base.subject, source: "github", metric: "stars",
        lane: "developer_adoption", observationIds: [base.id, otherSubject.id],
        startedAt: base.observedAt, endedAt: otherSubject.observedAt,
      })).toThrow("conflicts with series identity");
      const later = { ...base, id: asId("metric_later"), observedAt: "2026-07-12T00:00:00.000Z", rawValue: 2, normalizedValue: 2 };
      storage.metricObservations.save(later);
      const validSeries = {
        id: asId("trend_valid"), subject: base.subject, source: "github" as const, metric: "stars" as const,
        lane: "developer_adoption" as const, observationIds: [base.id, later.id],
        startedAt: base.observedAt, endedAt: later.observedAt,
      } satisfies TrendSeries;
      storage.trendSeries.save(validSeries);
      expect(() => storage.trendSeries.save({
        ...validSeries,
        id: asId("trend_reversed"),
        observationIds: [later.id, base.id],
      })).toThrow("structure conflicts with canonical observations");
      expect(() => storage.trendSeries.save({
        ...validSeries,
        id: asId("trend_repeated"),
        observationIds: [base.id, base.id, later.id],
      })).toThrow("structure conflicts with canonical observations");
      expect(() => storage.trendSeries.save({
        ...validSeries,
        id: asId("trend_forged_bounds"),
        startedAt: "2020-01-01T00:00:00.000Z",
        endedAt: "2030-01-01T00:00:00.000Z",
      })).toThrow("structure conflicts with canonical observations");
      expect(() => storage.trendEvents.append({
        id: asId(`tevt_${validSeries.id}_${later.id}_momentum_up`), seriesId: validSeries.id,
        kind: "momentum_up", detectedAt: later.observedAt, previousObservationId: base.id,
        currentObservationId: later.id, previousValue: 1, currentValue: 999,
        absoluteDelta: 998, relativeDelta: 998, detector: "two_point_delta_v1",
      })).toThrow("conflicts with referenced observations");
      expect(() => storage.transaction(() => {
        storage.quantitativeSourceStatuses.save({ id: "batch-failure", source: "github", subjectExternalId: "owner/repo", status: "failure", itemCount: 0, reason: "drift", checkedAt: base.observedAt });
        throw new Error("batch rollback");
      })).toThrow("batch rollback");
      expect(storage.quantitativeSourceStatuses.get("batch-failure")).toBeNull();
      storage.close();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("persists isolated Google normalization contexts, series, and classifier events", () => {
    const dataDir = tempDataDir();
    const context = (id: string, geography: string): GoogleTrendsNormalizationContext => ({
      id: asId(id), source: "google_trends", method: "relative_interest_0_100_v1", geography,
      window: { startAt: "2026-07-01T00:00:00.000Z", endAt: "2026-07-31T00:00:00.000Z", resolution: "day", timezone: "UTC" },
      comparisonSubjects: ["ai agent"], anchor: null, category: "0", property: "web", scale: { min: 0, max: 100 }, includesPartialBucket: false,
    });
    const us = context("norm_ai_us", "US");
    const gb = context("norm_ai_gb", "GB");
    const make = (normalization: GoogleTrendsNormalizationContext, index: number, value: number) => createGoogleTrendsObservation({
      id: asId(`gobs_${normalization.geography}_${index}`),
      subject: { kind: "search_term", externalId: "ai agent", url: "https://trends.google.com/trends/explore?q=ai%20agent" },
      context: normalization, observedAt: `2026-07-0${index + 1}T00:00:00.000Z`, rawValue: value, normalizedValue: value,
      provenance: { collector: "fixture", collectorVersion: "1", interface: "recorded_fixture", sourceRef: "fixture", collectedAt: "2026-07-11T00:00:00.000Z" },
    });
    try {
      const storage = openLocalStorage({ dataDir });
      storage.normalizationContexts.save(us);
      storage.normalizationContexts.save(gb);
      const usItems = [10, 12, 14, 20, 28, 40].map((value, index) => make(us, index, value));
      const gbItem = make(gb, 0, 5);
      for (const item of [...usItems, gbItem]) storage.metricObservations.save(item);
      expect(storage.metricObservations.list({ source: "google_trends", geography: "US", normalizationContextId: us.id })).toEqual(usItems);
      expect(storage.metricObservations.list({ source: "google_trends", geography: "GB", normalizationContextId: gb.id })).toEqual([gbItem]);
      const built = buildGoogleTrendSeries(asId("gseries_ai_us"), us, usItems);
      storage.trendSeries.save(built.series);
      const event = classifySearchMomentum(built.series, new Map(usItems.map((item) => [item.id, item])), { detectedAt: "2026-07-11T00:00:00.000Z" });
      storage.trendEvents.append(event);
      expect(() => storage.metricObservations.save({ ...usItems[0]!, id: asId("gobs_bad_geo"), geography: "GB" })).toThrow("conflicts");
      expect(() => storage.trendSeries.save({ ...built.series, id: asId("gseries_reversed"), observationIds: [...built.series.observationIds].reverse() })).toThrow("structure conflicts");
      expect(() => storage.trendEvents.append({ ...event, id: asId("gevent_forged"), kind: "spike" })).toThrow("conflicts");
      expect(() => storage.transaction(() => {
        storage.normalizationContexts.save(context("norm_rollback", "CA"));
        throw new Error("google rollback");
      })).toThrow("google rollback");
      expect(storage.normalizationContexts.get("norm_rollback")).toBeNull();
      storage.close();

      const restarted = openLocalStorage({ dataDir });
      expect(restarted.normalizationContexts.list()).toEqual([gb, us]);
      expect(restarted.trendSeries.list({ source: "google_trends", normalizationContextId: us.id })).toEqual([built.series]);
      expect(restarted.trendEvents.listBySeries(built.series.id)).toEqual([event]);
      restarted.close();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
