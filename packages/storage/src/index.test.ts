import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { asId } from "@idea-finder/core";
import type { ResearchRun } from "@idea-finder/core";

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
});
