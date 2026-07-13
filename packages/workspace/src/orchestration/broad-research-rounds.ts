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

type SourceStatusRow = {
  readonly id?: string;
  readonly requestKey?: string;
  readonly status: string;
  readonly itemCount: number;
  readonly reason?: string | null;
  readonly artifactIds?: readonly string[];
};

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
  const retryableRounds = queries
    .filter((query) => isRetryableQueryStatus(query.status))
    .map((query) => query.round);
  if (retryableRounds.length > 0) return Math.min(...retryableRounds);
  if (existingRounds.length === 0) return 1;
  return Math.max(...existingRounds.map((round) => round.round)) + 1;
}

function hasRetryableQueries(queries: readonly SearchQueryVariant[]): boolean {
  return queries.some((query) => isRetryableQueryStatus(query.status));
}

/** Current unresolved failures only — historical attempt incompleteness must not permanently pollute. */
export function recomputeCoverageIncomplete(
  queries: readonly SearchQueryVariant[],
  sourceStatuses: readonly SourceStatusRow[],
): boolean {
  if (queries.some((query) => query.status === "failure" || query.status === "partial")) return true;
  return sourceStatuses.some((status) => {
    const key = status.requestKey ?? status.id ?? "";
    if (!key.startsWith("query:")) return false;
    return status.status !== "success";
  });
}

function upsertRoundSummary(rounds: ResearchRoundSummary[], summary: ResearchRoundSummary): void {
  const existingIndex = rounds.findIndex((round) => round.round === summary.round);
  if (existingIndex >= 0) {
    const prior = rounds[existingIndex]!;
    rounds[existingIndex] = {
      ...summary,
      queryIds: [...new Set([...prior.queryIds, ...summary.queryIds])],
      newDocumentCount: prior.newDocumentCount + summary.newDocumentCount,
      newEvidenceCount: prior.newEvidenceCount + summary.newEvidenceCount,
      coverageIncomplete: prior.coverageIncomplete || summary.coverageIncomplete,
    };
  } else {
    rounds.push(summary);
  }
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
  let lastCheckpoint = existingLedger?.lastCheckpoint;

  const signalsAtStart = deps.storage.rawSignals.listByRun(runId);
  const independenceAtStart = independenceMap(deps.storage, runId);
  // Resume from harvested: harvest already persisted this round's signals — do not treat them as prior clusters.
  let knownClusterIds = lastCheckpoint?.phase === "harvested" && lastCheckpoint.knownClusterIds !== undefined
    ? new Set(lastCheckpoint.knownClusterIds)
    : new Set(
      clusterPainSignals({
        signals: signalsAtStart,
        independenceGroupByDocumentId: independenceAtStart,
      }).map((cluster) => cluster.id),
    );

  // Budget: count only successful/skipped queries; failed/partial retries get a fresh attempt slot.
  let executedQueryCount = queries.filter((query) => query.status === "success" || query.status === "skipped").length;

  let documentCount = deps.storage.rawDocuments.listByRun(runId).length;
  let evidenceCount = deps.storage.evidenceItems.listByRun(runId).length;
  let roundNumber = lastCheckpoint?.phase === "harvested"
    ? lastCheckpoint.round
    : resolveStartRound(queries, rounds);

  const sourceStatusesNow = () => deps.storage.sourceStatuses.listByRun(runId) as SourceStatusRow[];
  let coverageIncomplete = recomputeCoverageIncomplete(queries, sourceStatusesNow());

  const persistAtomic = (
    stopReason: ResearchStopReason,
    phase: "harvested" | "round_complete",
    round: number,
    harvestBaseline?: {
      readonly docsBefore: number;
      readonly evidenceBefore: number;
      readonly knownClusterIds: readonly string[];
    },
  ) => {
    lastCheckpoint = phase === "harvested" && harvestBaseline
      ? {
          round,
          phase,
          docsBefore: harvestBaseline.docsBefore,
          evidenceBefore: harvestBaseline.evidenceBefore,
          knownClusterIds: [...harvestBaseline.knownClusterIds],
        }
      : { round, phase };
    const ledger: ResearchLedger = {
      rounds,
      stopReason,
      lastCheckpoint,
    };
    deps.storage.transaction(() => {
      deps.storage.searchPlans.save({ ...plan, queries, updatedAt: new Date().toISOString() } as { readonly id: string });
      deps.storage.researchRunConfigs.save({
        id: runId,
        effectiveConfig,
        execution,
        researchLedger: ledger,
      });
    });
  };

  const finishIntelligenceAndRound = async (inputRound: {
    readonly queryIds: readonly string[];
    readonly docsBefore: number;
    readonly evidenceBefore: number;
    readonly countAttempt: boolean;
  }) => {
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

    const roundIncomplete = inputRound.queryIds.some((id) => {
      const updated = queries.find((item) => item.id === id);
      return updated?.status !== "success";
    });
    const allStatuses = sourceStatusesNow();
    coverageIncomplete = recomputeCoverageIncomplete(queries, allStatuses);

    upsertRoundSummary(rounds, {
      round: roundNumber,
      queryIds: inputRound.queryIds,
      newDocumentCount: Math.max(0, documentCount - inputRound.docsBefore),
      newEvidenceCount: Math.max(0, evidenceCount - inputRound.evidenceBefore),
      newClusterCount,
      coverageIncomplete: roundIncomplete,
    });

    let nextStop = evaluateStopCondition({
      rounds,
      budgets: plan.budgets,
      executedQueryCount,
      documentCount,
      coverageIncomplete,
    });
    persistAtomic(nextStop, "round_complete", roundNumber);

    if (nextStop === "continue") {
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
        coverageIncomplete = recomputeCoverageIncomplete(queries, sourceStatusesNow());
        nextStop = coverageIncomplete ? "budget_exhausted_partial" : "budget_exhausted";
        persistAtomic(nextStop, "round_complete", roundNumber);
      } else {
        queries = mergeQueryLists(queries, followUps);
        persistAtomic(nextStop, "round_complete", roundNumber);
        roundNumber += 1;
      }
    }
    return nextStop;
  };

  let stopReason = evaluateStopCondition({
    rounds,
    budgets: plan.budgets,
    executedQueryCount,
    documentCount,
    coverageIncomplete,
  });

  // Retry/resume must not be blocked by a prior terminal stop when work remains.
  if (hasRetryableQueries(queries) || lastCheckpoint?.phase === "harvested") {
    stopReason = "continue";
  }

  while (stopReason === "continue") {
    // Resume after harvest checkpoint: skip harvest, finish intelligence for that round.
    if (lastCheckpoint?.phase === "harvested" && lastCheckpoint.round === roundNumber) {
      const queryIds = queries
        .filter((query) => query.round === roundNumber && query.status !== "pending")
        .map((query) => query.id);
      const docsBefore = lastCheckpoint.docsBefore;
      const evidenceBefore = lastCheckpoint.evidenceBefore;
      const clusterBaseline = lastCheckpoint.knownClusterIds;
      if (docsBefore === undefined || evidenceBefore === undefined || clusterBaseline === undefined) {
        const missing = [
          docsBefore === undefined ? "docsBefore" : null,
          evidenceBefore === undefined ? "evidenceBefore" : null,
          clusterBaseline === undefined ? "knownClusterIds" : null,
        ].filter((item): item is string => item !== null);
        throw new Error(
          `harvested checkpoint missing baseline(s): ${missing.join(", ")}; re-run research so harvest checkpoints include docs/evidence/cluster baselines`,
        );
      }
      knownClusterIds = new Set(clusterBaseline);
      stopReason = await finishIntelligenceAndRound({
        queryIds: queryIds.length > 0 ? queryIds : (rounds.find((round) => round.round === roundNumber)?.queryIds ?? []),
        docsBefore,
        evidenceBefore,
        countAttempt: false,
      });
      continue;
    }

    const retryableThisRound = queries.filter((query) => query.round === roundNumber && isRetryableQueryStatus(query.status));
    if (retryableThisRound.length === 0) {
      if (rounds.length === 0 && roundNumber === 1) break;
      coverageIncomplete = recomputeCoverageIncomplete(queries, sourceStatusesNow());
      stopReason = coverageIncomplete ? "budget_exhausted_partial" : "budget_exhausted";
      persistAtomic(stopReason, "round_complete", roundNumber);
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
      coverageIncomplete = recomputeCoverageIncomplete(queries, sourceStatusesNow());
      stopReason = coverageIncomplete ? "budget_exhausted_partial" : "budget_exhausted";
      persistAtomic(stopReason, "round_complete", roundNumber);
      break;
    }

    const executedIds = new Set(selection.toRun.map((query) => query.id));
    if (selection.skipped.length > 0) {
      queries = markSkipped(queries, new Set(selection.skipped.map((query) => query.id)));
    }

    queries = queries.map((query) => (
      executedIds.has(query.id) && isRetryableQueryStatus(query.status)
        ? { ...query, status: "pending", error: null }
        : query
    ));

    const docsBefore = deps.storage.rawDocuments.listByRun(runId).length;
    const evidenceBefore = deps.storage.evidenceItems.listByRun(runId).length;

    const queryPlan: QueryPlan = buildQueryPlanFromBrief(brief, brief.id, selection.toRun);
    const priorStatuses = sourceStatusesNow();
    const completedRequestKeys = new Set(
      priorStatuses.filter((item) => item.status === "success").map((item) => item.id ?? item.requestKey ?? ""),
    );

    const harvestResult = await deps.harvest.runHarvest(runId, queryPlan, { completedRequestKeys });
    for (const status of harvestResult.sourceExecutions) {
      deps.storage.sourceStatuses.save(runId, status);
    }

    const allStatuses = sourceStatusesNow();
    queries = applyQueryExecutionWriteback(queries, allStatuses, executedIds);
    executedQueryCount += selection.toRun.length;
    // Checkpoint A: query writeback + harvest baselines before intelligence so crash mid-intel is resumable.
    persistAtomic("continue", "harvested", roundNumber, {
      docsBefore,
      evidenceBefore,
      knownClusterIds: [...knownClusterIds],
    });

    stopReason = await finishIntelligenceAndRound({
      queryIds: selection.toRun.map((query) => query.id),
      docsBefore,
      evidenceBefore,
      countAttempt: true,
    });
  }

  if (stopReason === "continue") {
    coverageIncomplete = recomputeCoverageIncomplete(queries, sourceStatusesNow());
    stopReason = coverageIncomplete ? "budget_exhausted_partial" : "budget_exhausted";
    persistAtomic(stopReason, "round_complete", Math.max(roundNumber, rounds[rounds.length - 1]?.round ?? 1));
  }

  coverageIncomplete = recomputeCoverageIncomplete(queries, sourceStatusesNow());
  deps.storage.pipelineSteps.markComplete(runId, "harvest");
  deps.storage.pipelineSteps.markComplete(runId, "intelligence");

  return {
    ledger: {
      rounds,
      stopReason,
      lastCheckpoint,
    },
    queries,
    coverageIncomplete,
  };
}
