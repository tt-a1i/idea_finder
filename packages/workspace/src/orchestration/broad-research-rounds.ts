import type { ResearchRunId } from "@idea-finder/core";
import type { QueryPlan } from "@idea-finder/connectors";
import type { HarvestPipeline } from "@idea-finder/harvest";
import type { IntelligencePipeline } from "@idea-finder/intelligence";
import type { LocalStorage } from "@idea-finder/storage";
import type {
  HuntingBrief,
  ResearchLedger,
  ResearchRoundSummary,
  ResearchStopReason,
  SearchPlan,
  SearchQueryVariant,
  StoredResearchRunConfig,
} from "../types.js";
import { buildQueryPlanFromBrief } from "./query-plan-builder.js";
import {
  applyQueryExecutionWriteback,
  buildDocumentToQueryIdMap,
  clusterPainSignals,
  countNewClusters,
  evaluateStopCondition,
  generateFollowUpQueries,
  isRetryableQueryStatus,
  selectQueriesForRound,
} from "./research-rounds.js";

export interface BroadResearchRoundDeps {
  readonly storage: LocalStorage;
  readonly harvest: HarvestPipeline;
  readonly intelligence: IntelligencePipeline;
  readonly queryTermsFromBrief: (brief: HuntingBrief) => string[];
}

export interface BroadResearchRoundResult {
  readonly ledger: ResearchLedger;
  readonly queries: SearchQueryVariant[];
  readonly coverageIncomplete: boolean;
}

function independenceMap(storage: LocalStorage, runId: ResearchRunId): Map<string, string> {
  const records = storage.evidenceIndependence.listByRun(runId) as Array<{ documentId: string; independenceGroupId: string }>;
  return new Map(records.map((item) => [item.documentId, item.independenceGroupId]));
}

function markSkipped(queries: readonly SearchQueryVariant[], ids: ReadonlySet<string>): SearchQueryVariant[] {
  return queries.map((query) => (ids.has(query.id) ? { ...query, status: "skipped", error: "Budget exhausted before execution" } : query));
}

function mergeQueryLists(
  existing: readonly SearchQueryVariant[],
  appended: readonly SearchQueryVariant[],
): SearchQueryVariant[] {
  const byId = new Map(existing.map((query) => [query.id, query]));
  for (const query of appended) {
    if (!byId.has(query.id)) byId.set(query.id, query);
  }
  return [...byId.values()];
}

function resolveStartRound(queries: readonly SearchQueryVariant[], existingRounds: readonly ResearchRoundSummary[]): number {
  if (existingRounds.length === 0) return 1;
  const maxRound = Math.max(...existingRounds.map((round) => round.round));
  const retryableInMax = queries.some((query) => query.round === maxRound && isRetryableQueryStatus(query.status));
  return retryableInMax ? maxRound : maxRound + 1;
}

export async function runBroadResearchRounds(input: {
  readonly deps: BroadResearchRoundDeps;
  readonly brief: HuntingBrief;
  readonly runId: ResearchRunId;
  readonly plan: SearchPlan;
  readonly execution: StoredResearchRunConfig["execution"];
  readonly effectiveConfig: Readonly<Record<string, unknown>>;
  readonly existingLedger?: ResearchLedger | null;
}): Promise<BroadResearchRoundResult> {
  const { deps, brief, runId, plan, execution, effectiveConfig } = input;
  let queries: SearchQueryVariant[] = [...plan.queries];
  const existingLedger = input.existingLedger
    ?? (deps.storage.researchRunConfigs.get(runId) as StoredResearchRunConfig | null)?.researchLedger
    ?? null;

  const rounds: ResearchRoundSummary[] = existingLedger ? [...existingLedger.rounds] : [];
  let coverageIncomplete = existingLedger?.rounds.some((round) => round.coverageIncomplete) ?? false;

  const signalsAtStart = deps.storage.rawSignals.listByRun(runId);
  const independenceAtStart = independenceMap(deps.storage, runId);
  let knownClusterIds = new Set(
    clusterPainSignals({
      signals: signalsAtStart,
      independenceGroupByDocumentId: independenceAtStart,
    }).map((cluster) => cluster.id),
  );

  // Budget attempts: restore from ledger history; each new harvest attempt increments.
  let executedQueryCount = existingLedger
    ? existingLedger.rounds.reduce((sum, round) => sum + round.queryIds.length, 0)
    : 0;

  let documentCount = deps.storage.rawDocuments.listByRun(runId).length;
  let evidenceCount = deps.storage.evidenceItems.listByRun(runId).length;
  let roundNumber = resolveStartRound(queries, rounds);

  const persistState = (stopReason: ResearchStopReason) => {
    deps.storage.searchPlans.save({ ...plan, queries, updatedAt: new Date().toISOString() } as { readonly id: string });
    deps.storage.researchRunConfigs.save({
      id: runId,
      effectiveConfig,
      execution,
      researchLedger: { rounds, stopReason },
    });
  };

  let stopReason = evaluateStopCondition({
    rounds,
    budgets: plan.budgets,
    executedQueryCount,
    documentCount,
    coverageIncomplete,
  });
  persistState(stopReason);

  while (stopReason === "continue") {
    const retryableThisRound = queries.filter((query) => query.round === roundNumber && isRetryableQueryStatus(query.status));
    if (retryableThisRound.length === 0) {
      if (rounds.length === 0 && roundNumber === 1) break;
      // Advance or stop via budget/saturation after appending divergence for next round.
      if (roundNumber > (rounds[rounds.length - 1]?.round ?? 0)) {
        stopReason = coverageIncomplete ? "budget_exhausted_partial" : "budget_exhausted";
        persistState(stopReason);
        break;
      }
      stopReason = coverageIncomplete ? "budget_exhausted_partial" : "budget_exhausted";
      persistState(stopReason);
      break;
    }

    const selection = selectQueriesForRound({
      queries,
      round: roundNumber,
      budgets: plan.budgets,
      executedQueryCount,
      documentCount,
    });

    if (selection.toRun.length === 0) {
      if (selection.skipped.length > 0) {
        queries = markSkipped(queries, new Set(selection.skipped.map((query) => query.id)));
      }
      stopReason = coverageIncomplete ? "budget_exhausted_partial" : "budget_exhausted";
      persistState(stopReason);
      break;
    }

    const executedIds = new Set(selection.toRun.map((query) => query.id));
    if (selection.skipped.length > 0) {
      queries = markSkipped(queries, new Set(selection.skipped.map((query) => query.id)));
    }

    // Reset retryable queries to pending before harvest so writeback reflects this attempt.
    queries = queries.map((query) => (
      executedIds.has(query.id) && isRetryableQueryStatus(query.status)
        ? { ...query, status: "pending", error: null }
        : query
    ));

    const queryPlan: QueryPlan = buildQueryPlanFromBrief(brief, brief.id, selection.toRun);
    const priorStatuses = deps.storage.sourceStatuses.listByRun(runId) as Array<{ id: string; status: string }>;
    const completedRequestKeys = new Set(
      priorStatuses.filter((item) => item.status === "success").map((item) => item.id),
    );
    const docsBefore = deps.storage.rawDocuments.listByRun(runId).length;
    const evidenceBefore = deps.storage.evidenceItems.listByRun(runId).length;

    const harvestResult = await deps.harvest.runHarvest(runId, queryPlan, { completedRequestKeys });
    for (const status of harvestResult.sourceExecutions) {
      deps.storage.sourceStatuses.save(runId, status);
    }

    const allStatuses = deps.storage.sourceStatuses.listByRun(runId) as Array<{
      id?: string;
      requestKey?: string;
      status: string;
      itemCount: number;
      reason?: string | null;
      artifactIds?: readonly string[];
    }>;
    queries = applyQueryExecutionWriteback(queries, allStatuses, executedIds);
    executedQueryCount += selection.toRun.length;

    await deps.intelligence.run(runId, { queryTerms: deps.queryTermsFromBrief(brief) });

    documentCount = deps.storage.rawDocuments.listByRun(runId).length;
    evidenceCount = deps.storage.evidenceItems.listByRun(runId).length;
    const signals = deps.storage.rawSignals.listByRun(runId);
    const independence = independenceMap(deps.storage, runId);
    const clusters = clusterPainSignals({
      signals,
      independenceGroupByDocumentId: independence,
    });
    const newClusterCount = countNewClusters(knownClusterIds, clusters);
    knownClusterIds = new Set(clusters.map((cluster) => cluster.id));

    const roundIncomplete = selection.toRun.some((query) => {
      const updated = queries.find((item) => item.id === query.id);
      return updated?.status !== "success";
    });
    coverageIncomplete = coverageIncomplete || roundIncomplete;

    // Replace same-round summary on retry; otherwise append.
    const roundSummary: ResearchRoundSummary = {
      round: roundNumber,
      queryIds: selection.toRun.map((query) => query.id),
      newDocumentCount: Math.max(0, documentCount - docsBefore),
      newEvidenceCount: Math.max(0, evidenceCount - evidenceBefore),
      newClusterCount,
      coverageIncomplete: roundIncomplete,
    };
    const existingIndex = rounds.findIndex((round) => round.round === roundNumber);
    if (existingIndex >= 0) {
      const prior = rounds[existingIndex]!;
      rounds[existingIndex] = {
        ...roundSummary,
        queryIds: [...new Set([...prior.queryIds, ...roundSummary.queryIds])],
        newDocumentCount: prior.newDocumentCount + roundSummary.newDocumentCount,
        newEvidenceCount: prior.newEvidenceCount + roundSummary.newEvidenceCount,
        newClusterCount: prior.newClusterCount + roundSummary.newClusterCount,
        coverageIncomplete: prior.coverageIncomplete || roundSummary.coverageIncomplete,
      };
    } else {
      rounds.push(roundSummary);
    }

    stopReason = evaluateStopCondition({
      rounds,
      budgets: plan.budgets,
      executedQueryCount,
      documentCount,
      coverageIncomplete,
    });
    persistState(stopReason);
    if (stopReason !== "continue") break;

    const documentToQuery = buildDocumentToQueryIdMap(allStatuses);
    const evidenceToQueryId = new Map<string, string>();
    for (const signal of signals) {
      const parent = documentToQuery.get(signal.documentId);
      if (parent) evidenceToQueryId.set(signal.id, parent);
    }

    const followUps = generateFollowUpQueries({
      plan,
      round: roundNumber + 1,
      clusters,
      existingQueryTexts: new Set(queries.map((query) => query.queryText.toLowerCase())),
      evidenceToQueryId,
    });
    if (followUps.length === 0) {
      stopReason = coverageIncomplete ? "budget_exhausted_partial" : "budget_exhausted";
      persistState(stopReason);
      break;
    }
    queries = mergeQueryLists(queries, followUps);
    persistState(stopReason);
    roundNumber += 1;
  }

  if (stopReason === "continue") {
    stopReason = coverageIncomplete ? "budget_exhausted_partial" : "budget_exhausted";
    persistState(stopReason);
  }

  deps.storage.pipelineSteps.markComplete(runId, "harvest");
  deps.storage.pipelineSteps.markComplete(runId, "intelligence");

  return {
    ledger: { rounds, stopReason },
    queries,
    coverageIncomplete,
  };
}
