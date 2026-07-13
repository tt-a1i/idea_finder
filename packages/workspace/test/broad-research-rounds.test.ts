import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { asId } from "@idea-finder/core";
import type { SourceConnector } from "@idea-finder/connectors";
import { createHarvestPipeline } from "@idea-finder/harvest";
import { createIntelligencePipeline } from "@idea-finder/intelligence";
import { createStorageHarvestRepository } from "@idea-finder/orchestration";
import { openLocalStorage } from "@idea-finder/storage";
import { buildBroadQueryVariants, coverageStats } from "../src/orchestration/broad-search-plan.js";
import { runBroadResearchRounds } from "../src/orchestration/broad-research-rounds.js";
import {
  applyQueryExecutionWriteback,
  clusterPainSignals,
  countNewClusters,
  evaluateStopCondition,
  generateDivergenceQueries,
  generateFollowUpQueries,
} from "../src/orchestration/research-rounds.js";
import { buildProposedSearchPlan, confirmSearchPlanEntity } from "../src/orchestration/search-plan.js";
import { queryTermsFromBrief } from "../src/orchestration/query-plan-builder.js";
import type { HuntingBrief } from "../src/types.js";

describe("semantic pain clustering", () => {
  it("merges similar pain quotes and keeps distinct pains separate", () => {
    const independence = new Map([["doc_a", "g1"], ["doc_b", "g2"], ["doc_c", "g3"]]);
    const clusters = clusterPainSignals({
      signals: [
        { id: "s1", signalType: "pain", quoteVerbatim: "Monday standup notes get lost between coding agents", documentId: "doc_a" },
        { id: "s2", signalType: "pain", quoteVerbatim: "Standup notes lost every Monday between agents", documentId: "doc_b" },
        { id: "s3", signalType: "workaround", quoteVerbatim: "We paste deploy logs into a spreadsheet manually", documentId: "doc_c" },
      ],
      independenceGroupByDocumentId: independence,
    });
    expect(clusters).toHaveLength(2);
    expect(clusters.some((cluster) => cluster.signalTypes.includes("pain") && cluster.signalTypes.includes("workaround"))).toBe(false);
    expect(clusters.find((cluster) => cluster.signalTypes.includes("pain"))?.documentIds).toEqual(expect.arrayContaining(["doc_a", "doc_b"]));
  });

  it("uses stable cluster ids when similar signals arrive in later rounds", () => {
    const independence = new Map([["doc_a", "g1"], ["doc_b", "g1"]]);
    const round1 = clusterPainSignals({
      signals: [{ id: "s1", signalType: "pain", quoteVerbatim: "painful handoff workflow", documentId: "doc_a" }],
      independenceGroupByDocumentId: independence,
    });
    const round2 = clusterPainSignals({
      signals: [
        { id: "s1", signalType: "pain", quoteVerbatim: "painful handoff workflow", documentId: "doc_a" },
        { id: "s2", signalType: "pain", quoteVerbatim: "painful handoff workflow every week", documentId: "doc_b" },
      ],
      independenceGroupByDocumentId: independence,
    });
    expect(countNewClusters(new Set(round1.map((cluster) => cluster.id)), round2)).toBe(0);
  });

  it("is order-stable for the same signal set", () => {
    const independence = new Map([["doc_a", "g1"], ["doc_b", "g2"], ["doc_c", "g3"]]);
    const signals = [
      { id: "s1", signalType: "pain", quoteVerbatim: "Monday standup notes get lost between coding agents", documentId: "doc_a" },
      { id: "s2", signalType: "pain", quoteVerbatim: "Standup notes lost every Monday between agents", documentId: "doc_b" },
      { id: "s3", signalType: "workaround", quoteVerbatim: "We paste deploy logs into a spreadsheet manually", documentId: "doc_c" },
    ];
    const forward = clusterPainSignals({ signals, independenceGroupByDocumentId: independence });
    const reverse = clusterPainSignals({ signals: [...signals].reverse(), independenceGroupByDocumentId: independence });
    expect(forward.map((cluster) => cluster.id).sort()).toEqual(reverse.map((cluster) => cluster.id).sort());
  });
});

describe("balanced broad query coverage", () => {
  it("rotates languages sources and lenses under budget caps", () => {
    const plan = buildProposedSearchPlan({
      topic: "agent coding workflows",
      languages: ["en", "zh"],
      sourceFamilies: ["hn", "stack_exchange", "github_issues", "v2ex"],
      budgets: { queries: 48 },
    });
    const queries = buildBroadQueryVariants(plan);
    const stats = coverageStats(queries);
    expect(queries.length).toBe(48);
    expect(stats.languages).toBeGreaterThanOrEqual(2);
    expect(stats.sources).toBeGreaterThanOrEqual(3);
    expect(stats.lenses).toBeGreaterThanOrEqual(6);
    expect(new Set(queries.map((query) => query.source)).has("github_issues")).toBe(true);
    expect(new Set(queries.map((query) => query.source)).has("stack_exchange")).toBe(true);
    expect(queries.some((query) => query.language === "zh" && /[\u4e00-\u9fff]/.test(query.queryText))).toBe(true);
  });
});

describe("divergence and partial writeback", () => {
  it("generates divergence follow-ups when clusters are empty", () => {
    const plan = buildProposedSearchPlan({
      topic: "agent handoff",
      languages: ["en", "zh"],
      sourceFamilies: ["hn", "github_issues"],
    });
    const followUps = generateFollowUpQueries({
      plan,
      round: 2,
      clusters: [],
      existingQueryTexts: new Set(),
    });
    expect(followUps.length).toBeGreaterThan(0);
    expect(followUps.some((query) => query.language === "zh" && /[\u4e00-\u9fff]/.test(query.queryText))).toBe(true);
    expect(generateDivergenceQueries({ plan, round: 2, existingQueryTexts: new Set() }).length).toBeGreaterThan(0);
  });

  it("marks HN story/comment mixed outcomes as partial", () => {
    const updated = applyQueryExecutionWriteback(
      [{
        id: "q1",
        queryText: "x",
        language: "en",
        source: "hn",
        lens: "pain_failure",
        round: 1,
        status: "pending",
        itemCount: 0,
        error: null,
      }],
      [
        { id: "query:q1", requestKey: "query:q1", status: "success", itemCount: 2 },
        { id: "query:q1__comment", requestKey: "query:q1__comment", status: "failure", itemCount: 0, reason: "network" },
      ],
      new Set(["q1"]),
    );
    expect(updated[0]?.status).toBe("partial");
    expect(updated[0]?.itemCount).toBe(2);
  });
});

describe("runBroadResearchRounds", () => {
  const leftovers: string[] = [];

  afterEach(async () => {
    await Promise.all(leftovers.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
    vi.restoreAllMocks();
  });

  async function setup(root: string, queryCount = 4) {
    const dataDir = path.join(root, "pipeline");
    const storage = openLocalStorage({ dataDir });
    const proposed = buildProposedSearchPlan({
      topic: "agent handoff pain",
      budgets: { queries: 8, documents: 50, rounds: 3 },
      sourceFamilies: ["hn", "stack_exchange"],
    });
    const confirmed = confirmSearchPlanEntity({
      ...proposed,
      queries: buildBroadQueryVariants(proposed).slice(0, queryCount),
    });
    const brief: HuntingBrief = {
      id: asId("task_rounds"),
      slug: "rounds",
      title: "agent handoff pain",
      description: "test",
      lenses: ["pain"],
      sourcesEnabled: ["hn", "stack_exchange"],
      successCriteria: "s",
      createdAt: "2026-07-11T00:00:00.000Z",
      searchPlanId: confirmed.id,
      searchPlanVersion: confirmed.version,
      queryPlan: { harvestMode: "l0" },
    };
    storage.searchPlans.save(confirmed as { readonly id: string });
    storage.huntingBriefs.save(brief);
    const runId = asId("run_multi_round");
    storage.researchRuns.save({
      id: runId,
      huntingTaskId: brief.id,
      status: "running",
      startedAt: "2026-07-11T00:00:00.000Z",
      completedAt: null,
      configHash: "cfg_test",
      errorMessage: null,
    });
    return { storage, confirmed, brief, runId };
  }

  it("executes multiple rounds, persists ledger, and writebacks query status", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "idea-finder-rounds-"));
    leftovers.push(root);
    const { storage, confirmed, brief, runId } = await setup(root);

    let call = 0;
    const connector = (platform: string): SourceConnector => ({
      platform,
      async healthcheck() { return { ok: true }; },
      async *search(query) {
        call += 1;
        yield {
          id: asId(`doc_${platform}_${call}`),
          runId,
          platform,
          url: `https://example.test/${platform}/${call}`,
          title: `${query.queryText ?? query.terms[0]} title`,
          rawBody: call % 3 === 0
            ? "We paste deploy logs into a spreadsheet manually every week"
            : "Monday standup notes get lost between coding agents",
          fetchedAt: "2026-07-11T00:00:00.000Z",
          fetchMethod: "test",
          language: "en",
          metadata: {},
        } as never;
      },
      async fetch() { throw new Error("not used"); },
    });

    const harvestRepo = createStorageHarvestRepository(storage);
    const harvest = createHarvestPipeline({
      connectors: [connector("hn"), connector("stack_exchange")],
      repository: harvestRepo,
    });
    const intelligence = createIntelligencePipeline({
      documents: storage.rawDocuments,
      chunks: storage.chunks,
      signals: storage.rawSignals,
      evidence: storage.evidenceItems,
      drafts: storage.opportunityDrafts,
    });

    const result = await runBroadResearchRounds({
      deps: { storage, harvest, intelligence, queryTermsFromBrief },
      brief,
      runId,
      plan: confirmed,
      execution: "new",
      effectiveConfig: { mode: "test" },
    });

    expect(result.ledger.rounds.length).toBeGreaterThanOrEqual(2);
    expect(result.queries.some((query) => query.status === "success")).toBe(true);
    expect(result.queries.every((query) => query.status === "pending")).toBe(false);
    expect(["saturated", "budget_exhausted", "budget_exhausted_partial"]).toContain(result.ledger.stopReason);

    const mid = storage.researchRunConfigs.get(runId) as { researchLedger?: { rounds: unknown[] } } | null;
    expect(mid?.researchLedger?.rounds.length).toBeGreaterThanOrEqual(2);

    const reloadedPlan = storage.searchPlans.get(confirmed.id) as typeof confirmed;
    expect(reloadedPlan.queries.some((query) => query.status === "success")).toBe(true);
    storage.close();
  });

  it("retries failed queries without wiping prior round history", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "idea-finder-retry-"));
    leftovers.push(root);
    const { storage, confirmed, brief, runId } = await setup(root, 2);

    let attempts = 0;
    const flaky: SourceConnector = {
      platform: "hn",
      async healthcheck() { return { ok: true }; },
      async *search(query) {
        attempts += 1;
        if (attempts === 1) throw new Error("network unavailable");
        yield {
          id: asId(`doc_retry_${attempts}`),
          huntingTaskId: brief.id,
          sourceTier: "public_api",
          platform: "hn",
          externalId: `ext_${attempts}`,
          url: `https://example.test/hn/${attempts}`,
          fetchedAt: "2026-07-11T00:00:00.000Z",
          fetchMethod: "api",
          fetchAgentRunId: null,
          contentType: "post",
          rawBody: "Monday standup notes get lost between coding agents",
          retentionClass: "research",
          legalBasis: "public",
        } as never;
        void query;
      },
      async fetch() { throw new Error("not used"); },
    };
    const se: SourceConnector = {
      platform: "stack_exchange",
      async healthcheck() { return { ok: true }; },
      async *search() {
        yield {
          id: asId("doc_se_ok"),
          huntingTaskId: brief.id,
          sourceTier: "public_api",
          platform: "stack_exchange",
          externalId: "se1",
          url: "https://example.test/se/1",
          fetchedAt: "2026-07-11T00:00:00.000Z",
          fetchMethod: "api",
          fetchAgentRunId: null,
          contentType: "post",
          rawBody: "We paste deploy logs into a spreadsheet manually",
          retentionClass: "research",
          legalBasis: "public",
        } as never;
      },
      async fetch() { throw new Error("not used"); },
    };

    const harvestRepo = createStorageHarvestRepository(storage);
    const harvest = createHarvestPipeline({ connectors: [flaky, se], repository: harvestRepo });
    const intelligence = createIntelligencePipeline({
      documents: storage.rawDocuments,
      chunks: storage.chunks,
      signals: storage.rawSignals,
      evidence: storage.evidenceItems,
      drafts: storage.opportunityDrafts,
    });

    const first = await runBroadResearchRounds({
      deps: { storage, harvest, intelligence, queryTermsFromBrief },
      brief,
      runId,
      plan: confirmed,
      execution: "new",
      effectiveConfig: { mode: "test" },
    });
    const priorRounds = first.ledger.rounds.length;
    expect(priorRounds).toBeGreaterThanOrEqual(1);

    const planAfter = storage.searchPlans.get(confirmed.id) as typeof confirmed;
    const failed = planAfter.queries.filter((query) => query.status === "failure" || query.status === "partial");
    // Force at least one failure if all somehow succeeded: mark first query failure for resume.
    const planForRetry = {
      ...planAfter,
      queries: planAfter.queries.map((query, index) => (
        index === 0 && query.status === "success"
          ? { ...query, status: "failure" as const, error: "forced retry" }
          : query
      )),
    };
    storage.searchPlans.save(planForRetry as { readonly id: string });

    const second = await runBroadResearchRounds({
      deps: { storage, harvest, intelligence, queryTermsFromBrief },
      brief,
      runId,
      plan: planForRetry,
      execution: "retried",
      effectiveConfig: { mode: "test" },
      existingLedger: first.ledger,
    });

    expect(second.ledger.rounds.length).toBeGreaterThanOrEqual(priorRounds);
    expect(second.ledger.rounds[0]?.round).toBe(1);
    const stillPendingAll = second.queries.every((query) => query.status === "pending");
    expect(stillPendingAll).toBe(false);
    void failed;
    storage.close();
  });
});

describe("evaluateStopCondition", () => {
  it("requires two zero-new-cluster rounds before saturated", () => {
    expect(evaluateStopCondition({
      rounds: [
        { round: 1, queryIds: ["q1"], newDocumentCount: 2, newEvidenceCount: 1, newClusterCount: 1, coverageIncomplete: false },
        { round: 2, queryIds: ["q2"], newDocumentCount: 0, newEvidenceCount: 0, newClusterCount: 0, coverageIncomplete: false },
      ],
      budgets: { queries: 100, documents: 100, rounds: 5 },
      executedQueryCount: 2,
      documentCount: 2,
      coverageIncomplete: false,
    })).toBe("continue");

    expect(evaluateStopCondition({
      rounds: [
        { round: 1, queryIds: ["q1"], newDocumentCount: 1, newEvidenceCount: 1, newClusterCount: 0, coverageIncomplete: false },
        { round: 2, queryIds: ["q2"], newDocumentCount: 0, newEvidenceCount: 0, newClusterCount: 0, coverageIncomplete: false },
      ],
      budgets: { queries: 100, documents: 100, rounds: 5 },
      executedQueryCount: 2,
      documentCount: 1,
      coverageIncomplete: false,
    })).toBe("saturated");
  });
});
