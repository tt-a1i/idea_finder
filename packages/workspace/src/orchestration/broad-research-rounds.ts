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
  baseSearchQueryId,
  buildDocumentToQueryIdMap,
  clusterPainSignals,
  countNewClusters,
  evaluateStopCondition,
  generateFollowUpQueries,
  isRetryableQueryStatus,
  selectQueriesForRound,
  type PainClusterSeed,
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

function cloneClusterSeeds(seeds: readonly PainClusterSeed[]): PainClusterSeed[] {
  return seeds.map((cluster) => ({ ...cluster }));
}

/** Count baseline ids for a harvested checkpoint. Prefer knownClusterIds (identity may diverge). */
function checkpointClusterBaseline(checkpoint: ResearchLedger["lastCheckpoint"]): readonly string[] | undefined {
  if (checkpoint?.phase !== "harvested") return undefined;
  if (checkpoint.knownClusterIds !== undefined) return checkpoint.knownClusterIds;
  if (checkpoint.knownClusters !== undefined) {
    return checkpoint.knownClusters.map((cluster) => cluster.id);
  }
  return undefined;
}

/** Fixed count-baseline seeds for a harvested resume; never take identity seeds as the baseline. */
function restoreRoundBaselineSeedsForHarvestResume(
  checkpoint: ResearchLedger["lastCheckpoint"],
  existingRoundSummary: ResearchRoundSummary | undefined,
): PainClusterSeed[] {
  if (existingRoundSummary !== undefined) {
    return restoreRoundBaselineFromSummary(existingRoundSummary).seeds;
  }
  // First harvest of this logical round: pre-harvest identity equals the count baseline.
  if (checkpoint?.knownClusterIds !== undefined && checkpoint.knownClusterIds.length === 0) {
    return [];
  }
  if (checkpoint?.knownClusters !== undefined) {
    return cloneClusterSeeds(checkpoint.knownClusters);
  }
  return [];
}

function restoreKnownClustersFromCheckpoint(
  checkpoint: ResearchLedger["lastCheckpoint"],
  clustersAtStart: PainClusterSeed[],
): PainClusterSeed[] {
  if (checkpoint?.phase !== "harvested") return clustersAtStart;
  if (checkpoint.knownClusters !== undefined) return cloneClusterSeeds(checkpoint.knownClusters);
  if (checkpoint.knownClusterIds !== undefined) {
    if (checkpoint.knownClusterIds.length === 0) return [];
    throw new Error(
      "harvested checkpoint has knownClusterIds but no knownClusters seeds; "
      + "cannot restore cluster identity after ID drift. Re-run research to regenerate checkpoints with knownClusters.",
    );
  }
  return clustersAtStart;
}

function restoreRoundBaselineFromSummary(summary: ResearchRoundSummary): {
  readonly ids: Set<string>;
  readonly seeds: PainClusterSeed[];
} {
  if (summary.clusterBaselineSeeds !== undefined) {
    const seeds = cloneClusterSeeds(summary.clusterBaselineSeeds);
    return { ids: new Set(seeds.map((cluster) => cluster.id)), seeds };
  }
  if (summary.clusterBaselineIds !== undefined) {
    if (summary.clusterBaselineIds.length === 0) {
      return { ids: new Set(), seeds: [] };
    }
    throw new Error(
      "round summary has clusterBaselineIds but no clusterBaselineSeeds; "
      + "cannot restore the fixed newClusterCount baseline after ID drift. "
      + "Re-run research to regenerate ledgers with clusterBaselineSeeds.",
    );
  }
  throw new Error("round summary missing cluster baseline");
}

/** Same-round identity must come from the latest attempt result, never the fixed count baseline. */
function restoreRoundResultSeedsFromSummary(summary: ResearchRoundSummary): PainClusterSeed[] {
  if (summary.clusterResultSeeds !== undefined) {
    return cloneClusterSeeds(summary.clusterResultSeeds);
  }
  throw new Error(
    `round ${summary.round} summary missing clusterResultSeeds; `
    + "cannot restore cluster identity for same-round retry after ID drift. "
    + "Re-run research to regenerate ledgers with clusterResultSeeds.",
  );
}

/** Current unresolved failures only — historical attempt incompleteness must not permanently pollute. */
export function recomputeCoverageIncomplete(
  queries: readonly SearchQueryVariant[],
  sourceStatuses: readonly SourceStatusRow[],
): boolean {
  if (queries.some((query) => query.status === "failure" || query.status === "partial")) return true;
  const scopedIds = new Set(queries.map((query) => query.id));
  return sourceStatuses.some((status) => {
    const key = status.requestKey ?? status.id ?? "";
    const match = /^query:(.+)$/.exec(key);
    if (!match) return false;
    const queryId = baseSearchQueryId(match[1]!);
    if (!scopedIds.has(queryId)) return false;
    return status.status !== "success";
  });
}

function restorePriorRoundResultSeeds(
  rounds: readonly ResearchRoundSummary[],
  roundNumber: number,
): PainClusterSeed[] | null {
  if (roundNumber <= 1) return null;
  const prior = rounds.find((round) => round.round === roundNumber - 1);
  if (prior === undefined) return null;
  if (prior.clusterResultSeeds !== undefined) {
    return cloneClusterSeeds(prior.clusterResultSeeds);
  }
  throw new Error(
    `round ${roundNumber - 1} summary missing clusterResultSeeds; `
    + "cannot restore cluster identity for the next round after ID drift. "
    + "Re-run research to regenerate ledgers with clusterResultSeeds.",
  );
}

function upsertRoundSummary(
  rounds: ResearchRoundSummary[],
  summary: ResearchRoundSummary,
  queries: readonly SearchQueryVariant[],
  sourceStatuses: readonly SourceStatusRow[],
  clusterBaselineIds: readonly string[],
  clusterBaselineSeeds: readonly PainClusterSeed[],
  clusterResultSeeds: readonly PainClusterSeed[],
): void {
  const existingIndex = rounds.findIndex((round) => round.round === summary.round);
  if (existingIndex >= 0) {
    const prior = rounds[existingIndex]!;
    const mergedQueryIds = [...new Set([...prior.queryIds, ...summary.queryIds])];
    const roundQueries = queries.filter((query) => mergedQueryIds.includes(query.id));
    rounds[existingIndex] = {
      round: summary.round,
      queryIds: mergedQueryIds,
      newDocumentCount: prior.newDocumentCount + summary.newDocumentCount,
      newEvidenceCount: prior.newEvidenceCount + summary.newEvidenceCount,
      // summary.newClusterCount is always relative to this round's fixed baseline.
      newClusterCount: summary.newClusterCount,
      coverageIncomplete: recomputeCoverageIncomplete(roundQueries, sourceStatuses),
      clusterBaselineIds: prior.clusterBaselineIds ?? clusterBaselineIds,
      clusterBaselineSeeds: prior.clusterBaselineSeeds ?? cloneClusterSeeds(clusterBaselineSeeds),
      // Final seeds always refresh after each attempt of this logical round.
      clusterResultSeeds: cloneClusterSeeds(clusterResultSeeds),
    };
  } else {
    const roundQueries = queries.filter((query) => summary.queryIds.includes(query.id));
    rounds.push({
      ...summary,
      coverageIncomplete: recomputeCoverageIncomplete(roundQueries, sourceStatuses),
      clusterBaselineIds,
      clusterBaselineSeeds: cloneClusterSeeds(clusterBaselineSeeds),
      clusterResultSeeds: cloneClusterSeeds(clusterResultSeeds),
    });
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

  let roundNumber = lastCheckpoint?.phase === "harvested"
    ? lastCheckpoint.round
    : resolveStartRound(queries, rounds);

  const existingRoundSummary = rounds.find((round) => round.round === roundNumber);
  const harvestedBaseline = checkpointClusterBaseline(lastCheckpoint);
  let roundClusterBaselineIds: Set<string> | null = harvestedBaseline !== undefined
    ? new Set(harvestedBaseline)
    : null;
  let roundClusterBaselineSeeds: PainClusterSeed[] | null = lastCheckpoint?.phase === "harvested"
    ? restoreRoundBaselineSeedsForHarvestResume(lastCheckpoint, existingRoundSummary)
    : null;

  if (roundClusterBaselineIds === null && existingRoundSummary !== undefined) {
    const restored = restoreRoundBaselineFromSummary(existingRoundSummary);
    roundClusterBaselineIds = restored.ids;
    roundClusterBaselineSeeds = restored.seeds;
  }

  // Same-round resume (round_complete): identity comes from latest result seeds.
  // Harvested checkpoint resume keeps using checkpoint knownClusters instead.
  const sameRoundResultSeeds = existingRoundSummary !== undefined && lastCheckpoint?.phase !== "harvested"
    ? restoreRoundResultSeedsFromSummary(existingRoundSummary)
    : null;

  const priorRoundResultSeeds = sameRoundResultSeeds === null && roundClusterBaselineSeeds === null
    ? restorePriorRoundResultSeeds(rounds, roundNumber)
    : null;

  const identityAnchor = sameRoundResultSeeds
    ?? priorRoundResultSeeds
    ?? (lastCheckpoint?.phase === "harvested"
      ? restoreKnownClustersFromCheckpoint(lastCheckpoint, [])
      : null);

  const signalsAtStart = deps.storage.rawSignals.listByRun(runId);
  const independenceAtStart = independenceMap(deps.storage, runId);
  const clustersAtStart = clusterPainSignals({
    signals: signalsAtStart,
    independenceGroupByDocumentId: independenceAtStart,
    previousClusters: identityAnchor ?? undefined,
  });
  let knownClusters = lastCheckpoint?.phase === "harvested"
    ? restoreKnownClustersFromCheckpoint(lastCheckpoint, clustersAtStart)
    : sameRoundResultSeeds !== null
      ? cloneClusterSeeds(sameRoundResultSeeds)
      : priorRoundResultSeeds !== null
        ? cloneClusterSeeds(priorRoundResultSeeds)
        : clustersAtStart;
  let knownClusterIds = new Set(knownClusters.map((cluster) => cluster.id));

  // Budget: count only successful/skipped queries; failed/partial retries get a fresh attempt slot.
  let executedQueryCount = queries.filter((query) => query.status === "success" || query.status === "skipped").length;

  let documentCount = deps.storage.rawDocuments.listByRun(runId).length;
  let evidenceCount = deps.storage.evidenceItems.listByRun(runId).length;

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
      readonly knownClusters: readonly PainClusterSeed[];
    },
  ) => {
    lastCheckpoint = phase === "harvested" && harvestBaseline
      ? {
          round,
          phase,
          docsBefore: harvestBaseline.docsBefore,
          evidenceBefore: harvestBaseline.evidenceBefore,
          knownClusterIds: [...harvestBaseline.knownClusterIds],
          knownClusters: harvestBaseline.knownClusters.map((cluster) => ({ ...cluster })),
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
      previousClusters: knownClusters,
    });
    const baselineIds = roundClusterBaselineIds ?? knownClusterIds;
    const newClusterCount = countNewClusters(baselineIds, clusters);
    knownClusters = clusters;
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
    }, queries, allStatuses, [...(roundClusterBaselineIds ?? knownClusterIds)], roundClusterBaselineSeeds ?? knownClusters, clusters);

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
        roundClusterBaselineIds = null;
        roundClusterBaselineSeeds = null;
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
      const clusterBaseline = checkpointClusterBaseline(lastCheckpoint);
      if (docsBefore === undefined || evidenceBefore === undefined || clusterBaseline === undefined) {
        const missing = [
          docsBefore === undefined ? "docsBefore" : null,
          evidenceBefore === undefined ? "evidenceBefore" : null,
          clusterBaseline === undefined ? "knownClusterIds/knownClusters" : null,
        ].filter((item): item is string => item !== null);
        throw new Error(
          `harvested checkpoint missing baseline(s): ${missing.join(", ")}; re-run research so harvest checkpoints include docs/evidence/cluster baselines`,
        );
      }
      knownClusters = restoreKnownClustersFromCheckpoint(lastCheckpoint, clustersAtStart);
      knownClusterIds = new Set(knownClusters.map((cluster) => cluster.id));
      roundClusterBaselineIds = new Set(clusterBaseline);
      roundClusterBaselineSeeds = restoreRoundBaselineSeedsForHarvestResume(
        lastCheckpoint,
        rounds.find((round) => round.round === roundNumber),
      );
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

    if (roundClusterBaselineIds === null) {
      roundClusterBaselineIds = new Set(knownClusterIds);
      roundClusterBaselineSeeds = cloneClusterSeeds(knownClusters);
    }

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
    // Checkpoint A: count baseline ids stay fixed; knownClusters stores pre-intel identity.
    persistAtomic("continue", "harvested", roundNumber, {
      docsBefore,
      evidenceBefore,
      knownClusterIds: [...roundClusterBaselineIds],
      knownClusters: knownClusters.map((cluster) => ({ ...cluster })),
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
