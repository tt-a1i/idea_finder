import { randomUUID } from "node:crypto";
import type { ResearchLens, SearchPlan, SearchQueryVariant } from "../types.js";

export type ResearchStopReason =
  | "budget_exhausted"
  | "budget_exhausted_partial"
  | "saturated"
  | "continue";

export interface PainClusterSeed {
  readonly id: string;
  readonly painStatement: string;
  readonly signalTypes: readonly string[];
  readonly documentIds: readonly string[];
  readonly evidenceIds: readonly string[];
  readonly independentSourceCount: number;
  readonly languages: readonly string[];
}

export interface ResearchRoundSummary {
  readonly round: number;
  readonly queryIds: readonly string[];
  readonly newDocumentCount: number;
  readonly newEvidenceCount: number;
  readonly newClusterCount: number;
  readonly coverageIncomplete: boolean;
}

export function clusterPainSignals(input: {
  readonly signals: readonly { readonly id: string; readonly signalType: string; readonly quoteVerbatim: string; readonly documentId: string }[];
  readonly independenceGroupByDocumentId: ReadonlyMap<string, string>;
  readonly documentLanguages?: ReadonlyMap<string, string>;
}): PainClusterSeed[] {
  const byType = new Map<string, Array<{ readonly id: string; readonly signalType: string; readonly quoteVerbatim: string; readonly documentId: string }>>();
  for (const signal of input.signals) {
    if (!["pain", "workaround", "alternative_seek", "willingness_to_pay", "competitor_dissatisfaction", "feature_request"].includes(signal.signalType)) {
      continue;
    }
    const bucket = byType.get(signal.signalType) ?? [];
    bucket.push(signal);
    byType.set(signal.signalType, bucket);
  }
  const clusters: PainClusterSeed[] = [];
  for (const [signalType, signals] of byType) {
    if (signals.length === 0) continue;
    const documentIds = [...new Set(signals.map((signal) => signal.documentId))];
    const groups = new Set(documentIds.map((id) => input.independenceGroupByDocumentId.get(id) ?? id));
    clusters.push({
      id: `cluster_${signalType}_${randomUUID().slice(0, 8)}`,
      painStatement: signals[0]!.quoteVerbatim.slice(0, 180),
      signalTypes: [signalType],
      documentIds,
      evidenceIds: signals.map((signal) => signal.id),
      independentSourceCount: groups.size,
      languages: documentIds.map((id) => input.documentLanguages?.get(id) ?? "und"),
    });
  }
  return clusters;
}

export function generateFollowUpQueries(input: {
  readonly plan: SearchPlan;
  readonly round: number;
  readonly clusters: readonly PainClusterSeed[];
  readonly existingQueryTexts: ReadonlySet<string>;
}): SearchQueryVariant[] {
  const followUps: SearchQueryVariant[] = [];
  const sources = input.plan.sourceFamilies.filter((source) =>
    ["hn", "v2ex", "stack_exchange", "github_issues"].includes(source),
  );
  const source = sources[0] ?? "hn";
  const language = input.plan.languages[0] ?? "en";
  const lenses: ResearchLens[] = ["persona", "workaround", "competitor_dissatisfaction", "contradiction", "commercial_intent", "pain_failure"];
  for (const cluster of input.clusters.slice(0, 6)) {
    for (const lens of lenses) {
      const queryText = `${input.plan.topic} ${cluster.painStatement.slice(0, 40)} ${lens}`;
      if (input.existingQueryTexts.has(queryText.toLowerCase())) continue;
      followUps.push({
        id: `q_${randomUUID().slice(0, 12)}`,
        queryText,
        language,
        source,
        lens,
        round: input.round,
        parentQueryId: null,
        triggerEvidenceId: cluster.evidenceIds[0] ?? null,
        status: "pending",
        itemCount: 0,
        error: null,
      });
    }
  }
  return followUps;
}

export function evaluateStopCondition(input: {
  readonly rounds: readonly ResearchRoundSummary[];
  readonly budgets: { readonly queries: number; readonly documents: number; readonly rounds: number };
  readonly executedQueryCount: number;
  readonly documentCount: number;
  readonly coverageIncomplete: boolean;
}): ResearchStopReason {
  if (input.executedQueryCount >= input.budgets.queries || input.documentCount >= input.budgets.documents || input.rounds.length >= input.budgets.rounds) {
    return input.coverageIncomplete ? "budget_exhausted_partial" : "budget_exhausted";
  }
  if (input.rounds.length >= 2) {
    const last = input.rounds[input.rounds.length - 1]!;
    const prev = input.rounds[input.rounds.length - 2]!;
    if (last.newClusterCount === 0 && prev.newClusterCount === 0) {
      return input.coverageIncomplete ? "budget_exhausted_partial" : "saturated";
    }
  }
  return "continue";
}
