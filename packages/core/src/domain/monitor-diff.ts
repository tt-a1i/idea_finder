import type { ResearchRunId } from "./ids.js";
import type {
  MonitorDiff,
  MonitorDiffEntry,
  MonitorDiffKind,
  MonitorOpportunitySnapshot,
  Opportunity,
} from "./types.js";

export interface MonitorDiffInput {
  readonly baselineRunId: ResearchRunId;
  readonly compareRunId: ResearchRunId;
  readonly baselineOpportunities: readonly Opportunity[];
  readonly compareOpportunities: readonly Opportunity[];
  readonly computedAt?: string;
}

function snapshot(opportunity: Opportunity): MonitorOpportunitySnapshot {
  return {
    opportunityId: opportunity.id,
    clusterId: opportunity.clusterId,
    demandStatement: opportunity.demandStatement,
    status: opportunity.status,
    confidence: opportunity.confidence,
    evidenceCount: opportunity.evidenceItemIds.length,
  };
}

function confidenceRank(level: Opportunity["confidence"]): number {
  return level === "high" ? 2 : level === "medium" ? 1 : 0;
}

function classifyDiff(
  before: MonitorOpportunitySnapshot | null,
  after: MonitorOpportunitySnapshot | null,
): MonitorDiffKind {
  if (!before && after) return "added";
  if (before && !after) return "cooled";
  if (!before || !after) return "unchanged";

  const evidenceDelta = after.evidenceCount - before.evidenceCount;
  const confidenceDelta = confidenceRank(after.confidence) - confidenceRank(before.confidence);
  const statusRank = (status: Opportunity["status"]) =>
    status === "promoted" ? 2 : status === "hypothesis" ? 1 : 0;
  const statusDelta = statusRank(after.status) - statusRank(before.status);

  if (evidenceDelta > 0 || confidenceDelta > 0 || statusDelta > 0) {
    return "heated";
  }
  if (evidenceDelta < 0 || confidenceDelta < 0 || statusDelta < 0) {
    return "cooled";
  }
  return "unchanged";
}

/** Compare opportunity sets from two runs, keyed by clusterId. */
export function computeMonitorDiff(input: MonitorDiffInput): MonitorDiff {
  const baselineByCluster = new Map(
    input.baselineOpportunities.map((opp) => [String(opp.clusterId), snapshot(opp)]),
  );
  const compareByCluster = new Map(
    input.compareOpportunities.map((opp) => [String(opp.clusterId), snapshot(opp)]),
  );

  const clusterIds = new Set([...baselineByCluster.keys(), ...compareByCluster.keys()]);
  const entries: MonitorDiffEntry[] = [];

  for (const clusterId of [...clusterIds].sort()) {
    const before = baselineByCluster.get(clusterId) ?? null;
    const after = compareByCluster.get(clusterId) ?? null;
    const kind = classifyDiff(before, after);
    const primary = after ?? before;
    if (!primary) continue;

    entries.push({
      kind,
      opportunityId: (after ?? before)!.opportunityId,
      clusterId: primary.clusterId,
      demandStatement: (after ?? before)!.demandStatement,
      before,
      after,
      evidenceCountDelta: (after?.evidenceCount ?? 0) - (before?.evidenceCount ?? 0),
    });
  }

  const summary = {
    added: entries.filter((e) => e.kind === "added").length,
    heated: entries.filter((e) => e.kind === "heated").length,
    cooled: entries.filter((e) => e.kind === "cooled").length,
    unchanged: entries.filter((e) => e.kind === "unchanged").length,
  };

  return {
    baselineRunId: input.baselineRunId,
    compareRunId: input.compareRunId,
    computedAt: input.computedAt ?? new Date().toISOString(),
    entries,
    summary,
  };
}
