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

  it("retries failed queries: increases attempts, recovers success, skips prior success legs", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "idea-finder-retry-"));
    leftovers.push(root);
    const { storage, confirmed, brief, runId } = await setup(root, 2);

    let hnInvocations = 0;
    let seInvocations = 0;
    const firstQueryId = confirmed.queries[0]!.id;
    const commentAttempts = new Map<string, number>();
    const hn: SourceConnector = {
      platform: "hn",
      async healthcheck() { return { ok: true }; },
      async *search(query) {
        hnInvocations += 1;
        const qid = query.queryId ?? "";
        if (qid === `${firstQueryId}__comment`) {
          const n = (commentAttempts.get(qid) ?? 0) + 1;
          commentAttempts.set(qid, n);
          if (n === 1) throw new Error("network unavailable");
        }
        yield {
          id: asId(`doc_hn_${hnInvocations}`),
          huntingTaskId: brief.id,
          sourceTier: "public_api",
          platform: "hn",
          externalId: `hn_${hnInvocations}`,
          url: `https://example.test/hn/${hnInvocations}`,
          fetchedAt: "2026-07-11T00:00:00.000Z",
          fetchMethod: "api",
          fetchAgentRunId: null,
          contentType: "post",
          rawBody: "Monday standup notes get lost between coding agents",
          retentionClass: "research",
          legalBasis: "public",
        } as never;
      },
      async fetch() { throw new Error("not used"); },
    };
    const se: SourceConnector = {
      platform: "stack_exchange",
      async healthcheck() { return { ok: true }; },
      async *search() {
        seInvocations += 1;
        yield {
          id: asId(`doc_se_${seInvocations}`),
          huntingTaskId: brief.id,
          sourceTier: "public_api",
          platform: "stack_exchange",
          externalId: `se_${seInvocations}`,
          url: `https://example.test/se/${seInvocations}`,
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
    const harvest = createHarvestPipeline({ connectors: [hn, se], repository: harvestRepo });
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
    const hnAfterFirst = hnInvocations;
    const seAfterFirst = seInvocations;

    const planAfter = storage.searchPlans.get(confirmed.id) as typeof confirmed;
    const partialOrFailed = planAfter.queries.filter((query) => query.status === "failure" || query.status === "partial");
    expect(partialOrFailed.length).toBeGreaterThan(0);

    // Terminal stop from first run must not block retry.
    expect(["budget_exhausted", "budget_exhausted_partial", "saturated"]).toContain(first.ledger.stopReason);

    const second = await runBroadResearchRounds({
      deps: { storage, harvest, intelligence, queryTermsFromBrief },
      brief,
      runId,
      plan: planAfter,
      execution: "retried",
      effectiveConfig: { mode: "test" },
      existingLedger: first.ledger,
    });

    expect(hnInvocations).toBeGreaterThan(hnAfterFirst);
    expect(seInvocations).toBe(seAfterFirst); // success SE legs not re-run
    expect(second.ledger.rounds.length).toBeGreaterThanOrEqual(priorRounds);
    expect(second.ledger.rounds[0]?.round).toBe(1);
    const recovered = second.queries.find((query) => query.id === confirmed.queries[0]!.id);
    expect(recovered?.status).toBe("success");
    expect(second.coverageIncomplete).toBe(false);
    expect(second.ledger.stopReason).not.toBe("budget_exhausted_partial");
    storage.close();
  });

  it("persists harvested checkpoint before intelligence and resumes without re-harvest", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "idea-finder-intel-crash-"));
    leftovers.push(root);
    const dataDir = path.join(root, "pipeline");
    const storage = openLocalStorage({ dataDir });
    const proposed = buildProposedSearchPlan({
      topic: "agent handoff pain",
      budgets: { queries: 2, documents: 50, rounds: 1 },
      sourceFamilies: ["hn", "stack_exchange"],
    });
    const confirmed = confirmSearchPlanEntity({
      ...proposed,
      queries: buildBroadQueryVariants(proposed).slice(0, 2),
    });
    const brief: HuntingBrief = {
      id: asId("task_intel"),
      slug: "intel",
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
    const runId = asId("run_intel_crash");
    storage.researchRuns.save({
      id: runId,
      huntingTaskId: brief.id,
      status: "running",
      startedAt: "2026-07-11T00:00:00.000Z",
      completedAt: null,
      configHash: "cfg_test",
      errorMessage: null,
    });

    let harvestCalls = 0;
    const connector = (platform: string): SourceConnector => ({
      platform,
      async healthcheck() { return { ok: true }; },
      async *search() {
        harvestCalls += 1;
        yield {
          id: asId(`doc_${platform}_${harvestCalls}`),
          huntingTaskId: brief.id,
          sourceTier: "public_api",
          platform,
          externalId: `${platform}_${harvestCalls}`,
          url: `https://example.test/${platform}/${harvestCalls}`,
          fetchedAt: "2026-07-11T00:00:00.000Z",
          fetchMethod: "api",
          fetchAgentRunId: null,
          contentType: "post",
          rawBody: "Monday standup notes get lost between coding agents",
          retentionClass: "research",
          legalBasis: "public",
        } as never;
      },
      async fetch() { throw new Error("not used"); },
    });

    const harvestRepo = createStorageHarvestRepository(storage);
    const harvest = createHarvestPipeline({
      connectors: [connector("hn"), connector("stack_exchange")],
      repository: harvestRepo,
    });
    let intelCalls = 0;
    const realIntel = createIntelligencePipeline({
      documents: storage.rawDocuments,
      chunks: storage.chunks,
      signals: storage.rawSignals,
      evidence: storage.evidenceItems,
      drafts: storage.opportunityDrafts,
    });
    const intelligence = {
      run: async (run: Parameters<typeof realIntel.run>[0], opts?: Parameters<typeof realIntel.run>[1]) => {
        intelCalls += 1;
        if (intelCalls === 1) throw new Error("intelligence crashed");
        return realIntel.run(run, opts);
      },
    };

    await expect(runBroadResearchRounds({
      deps: { storage, harvest, intelligence, queryTermsFromBrief },
      brief,
      runId,
      plan: confirmed,
      execution: "new",
      effectiveConfig: { mode: "test" },
    })).rejects.toThrow("intelligence crashed");

    const midConfig = storage.researchRunConfigs.get(runId) as { researchLedger?: { lastCheckpoint?: { phase: string; round: number }; stopReason: string } };
    expect(midConfig.researchLedger?.lastCheckpoint?.phase).toBe("harvested");
    const midPlan = storage.searchPlans.get(confirmed.id) as typeof confirmed;
    expect(midPlan.queries.some((query) => query.status === "success")).toBe(true);
    const harvestAfterCrash = harvestCalls;

    const resumed = await runBroadResearchRounds({
      deps: { storage, harvest, intelligence, queryTermsFromBrief },
      brief,
      runId,
      plan: midPlan,
      execution: "resumed",
      effectiveConfig: { mode: "test" },
      existingLedger: midConfig.researchLedger as never,
    });

    expect(harvestCalls).toBe(harvestAfterCrash);
    expect(intelCalls).toBeGreaterThanOrEqual(2);
    expect(resumed.ledger.lastCheckpoint?.phase).toBe("round_complete");
    expect(resumed.ledger.rounds.length).toBeGreaterThanOrEqual(1);
    storage.close();
  });

  it("atomically rolls back SearchPlan and ledger when transaction save fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "idea-finder-tx-"));
    leftovers.push(root);
    const { storage, confirmed, brief, runId } = await setup(root, 2);

    const connector = (platform: string): SourceConnector => ({
      platform,
      async healthcheck() { return { ok: true }; },
      async *search() {
        yield {
          id: asId(`doc_${platform}_tx`),
          huntingTaskId: brief.id,
          sourceTier: "public_api",
          platform,
          externalId: `${platform}_tx`,
          url: `https://example.test/${platform}/tx`,
          fetchedAt: "2026-07-11T00:00:00.000Z",
          fetchMethod: "api",
          fetchAgentRunId: null,
          contentType: "post",
          rawBody: "painful handoff workflow",
          retentionClass: "research",
          legalBasis: "public",
        } as never;
      },
      async fetch() { throw new Error("not used"); },
    });
    const harvest = createHarvestPipeline({
      connectors: [connector("hn"), connector("stack_exchange")],
      repository: createStorageHarvestRepository(storage),
    });
    const intelligence = createIntelligencePipeline({
      documents: storage.rawDocuments,
      chunks: storage.chunks,
      signals: storage.rawSignals,
      evidence: storage.evidenceItems,
      drafts: storage.opportunityDrafts,
    });

    let saveCount = 0;
    const originalSave = storage.researchRunConfigs.save.bind(storage.researchRunConfigs);
    storage.researchRunConfigs.save = ((record: { readonly id: string }) => {
      saveCount += 1;
      if (saveCount === 1) throw new Error("forced config save failure");
      return originalSave(record);
    }) as typeof storage.researchRunConfigs.save;

    const beforePlan = storage.searchPlans.get(confirmed.id) as typeof confirmed;
    await expect(runBroadResearchRounds({
      deps: { storage, harvest, intelligence, queryTermsFromBrief },
      brief,
      runId,
      plan: confirmed,
      execution: "new",
      effectiveConfig: { mode: "test" },
    })).rejects.toThrow("forced config save failure");

    const afterPlan = storage.searchPlans.get(confirmed.id) as typeof confirmed;
    // Transaction rollback: query statuses should remain pending (plan not partially committed).
    expect(afterPlan.queries.every((query) => query.status === "pending")).toBe(true);
    expect(afterPlan.queries.map((query) => query.id)).toEqual(beforePlan.queries.map((query) => query.id));
    expect(storage.researchRunConfigs.get(runId)?.researchLedger).toBeUndefined();
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
