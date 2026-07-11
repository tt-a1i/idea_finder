import type { ResearchRunId } from "./ids.js";
import type {
  EvidenceItem,
  MonitorCoverageSnapshot,
  MonitorDiff,
  MonitorDiffEntry,
  MonitorDiffKind,
  MonitorOpportunitySnapshot,
  MonitorThresholds,
  Opportunity,
} from "./types.js";

export const DEFAULT_MONITOR_THRESHOLDS: MonitorThresholds = {
  minCrossSourceGrowth: 1,
  minStrongPainGrowth: 1,
  minCommercialEvidenceGrowth: 1,
  minCoolingEvidenceLoss: 1,
};

const COMPLETE_COVERAGE: MonitorCoverageSnapshot = { complete: true, sources: [], incompleteRequestKeys: [] };

export interface MonitorDiffInput {
  readonly baselineRunId: ResearchRunId;
  readonly compareRunId: ResearchRunId;
  readonly baselineOpportunities: readonly Opportunity[];
  readonly compareOpportunities: readonly Opportunity[];
  readonly baselineEvidence?: ReadonlyMap<string, EvidenceItem>;
  readonly compareEvidence?: ReadonlyMap<string, EvidenceItem>;
  readonly baselineCoverage?: MonitorCoverageSnapshot;
  readonly compareCoverage?: MonitorCoverageSnapshot;
  readonly thresholds?: MonitorThresholds;
  readonly computedAt?: string;
}

function semanticKey(opportunity: Opportunity, runId: ResearchRunId): string {
  const normalize = (value: string) => value.toLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const clusterPrefix = `cluster_${runId}_`;
  const stableDemand = opportunity.demandStatement.replace(/\s*\([^)]*\)\s*$/, "");
  if (String(opportunity.clusterId).startsWith(clusterPrefix)) return `${normalize(opportunity.persona)}|${normalize(stableDemand)}|cluster:${normalize(String(opportunity.clusterId).slice(clusterPrefix.length))}`;
  return [opportunity.persona, stableDemand].map(normalize).join("|");
}

function snapshot(opportunity: Opportunity, evidenceById: ReadonlyMap<string, EvidenceItem>, runId: ResearchRunId): MonitorOpportunitySnapshot {
  const evidence = opportunity.evidenceItemIds.flatMap((id) => evidenceById.get(id) ?? []);
  return {
    opportunityId: opportunity.id,
    clusterId: opportunity.clusterId,
    demandStatement: opportunity.demandStatement,
    status: opportunity.status,
    confidence: opportunity.confidence,
    evidenceCount: opportunity.evidenceItemIds.length,
    monitorKey: semanticKey(opportunity, runId),
    monitorKeyVersion: "semantic-v1",
    evidenceItemIds: [...opportunity.evidenceItemIds],
    sourceCount: new Set(evidence.map((item) => item.platform)).size,
    strongPainCount: evidence.filter((item) => item.supportsClaim === "pain" && item.strength !== "weak").length,
    commercialEvidenceCount: evidence.filter((item) => item.supportsClaim === "wtp").length,
    evidenceRefs: evidence.map((item) => ({ evidenceItemId: item.id, platform: item.platform, url: item.url, supportsClaim: item.supportsClaim, strength: item.strength })),
  };
}

function evidenceChange(before: MonitorOpportunitySnapshot | null, after: MonitorOpportunitySnapshot | null) {
  const beforeIds = new Set(before?.evidenceItemIds ?? []);
  const afterIds = new Set(after?.evidenceItemIds ?? []);
  const beforeRefs = new Map((before?.evidenceRefs ?? []).map((item) => [item.evidenceItemId, item]));
  const afterRefs = new Map((after?.evidenceRefs ?? []).map((item) => [item.evidenceItemId, item]));
  return {
    addedEvidenceItemIds: [...afterIds].filter((id) => !beforeIds.has(id)).sort(),
    removedEvidenceItemIds: [...beforeIds].filter((id) => !afterIds.has(id)).sort(),
    sourceCountDelta: (after?.sourceCount ?? 0) - (before?.sourceCount ?? 0),
    strongPainDelta: (after?.strongPainCount ?? 0) - (before?.strongPainCount ?? 0),
    commercialEvidenceDelta: (after?.commercialEvidenceCount ?? 0) - (before?.commercialEvidenceCount ?? 0),
    addedEvidence: [...afterRefs].filter(([id]) => !beforeIds.has(id)).map(([, ref]) => ref),
    removedEvidence: [...beforeRefs].filter(([id]) => !afterIds.has(id)).map(([, ref]) => ref),
  };
}

/** Compare genuinely distinct runs using a stable semantic key, evidence causes, and coverage guards. */
export function computeMonitorDiff(input: MonitorDiffInput): MonitorDiff {
  if (input.baselineRunId === input.compareRunId) throw new Error("Monitor comparison requires distinct ResearchRuns");
  const baselineCoverage = input.baselineCoverage ?? COMPLETE_COVERAGE;
  const compareCoverage = input.compareCoverage ?? COMPLETE_COVERAGE;
  const thresholds = input.thresholds ?? DEFAULT_MONITOR_THRESHOLDS;
  if (Object.values(thresholds).some((value) => !Number.isInteger(value) || value <= 0)) throw new Error("Monitor thresholds must be positive integers");
  const baselineEvidence = input.baselineEvidence ?? new Map();
  const compareEvidence = input.compareEvidence ?? new Map();
  const baseline = input.baselineOpportunities.map((item) => snapshot(item, baselineEvidence, input.baselineRunId));
  const compare = input.compareOpportunities.map((item) => snapshot(item, compareEvidence, input.compareRunId));
  const baselineByKey = new Map(baseline.map((item) => [item.monitorKey, item]));
  const compareByKey = new Map(compare.map((item) => [item.monitorKey, item]));
  if (baselineByKey.size !== baseline.length || compareByKey.size !== compare.length) throw new Error("Monitor semantic key collision within ResearchRun");
  const entries: MonitorDiffEntry[] = [];

  for (const monitorKey of [...new Set([...baselineByKey.keys(), ...compareByKey.keys()])].sort()) {
    const before = baselineByKey.get(monitorKey) ?? null;
    const after = compareByKey.get(monitorKey) ?? null;
    const change = evidenceChange(before, after);
    const causes: string[] = [];
    if (change.addedEvidenceItemIds.length) causes.push("evidence_added");
    if (change.removedEvidenceItemIds.length) causes.push("evidence_removed");
    if (change.sourceCountDelta !== 0) causes.push("cross_source_changed");
    if (change.strongPainDelta !== 0) causes.push("strong_pain_changed");
    if (change.commercialEvidenceDelta !== 0) causes.push("commercial_evidence_changed");

    let kind: MonitorDiffKind;
    if (!before && after) kind = "added";
    else if (before && !after) kind = "cooled";
    else if (change.addedEvidenceItemIds.length > change.removedEvidenceItemIds.length || change.sourceCountDelta > 0 || change.strongPainDelta > 0 || change.commercialEvidenceDelta > 0) kind = "heated";
    else if (change.removedEvidenceItemIds.length > change.addedEvidenceItemIds.length || change.sourceCountDelta < 0 || change.strongPainDelta < 0 || change.commercialEvidenceDelta < 0) kind = "cooled";
    else kind = "unchanged";

    const coolingSuppressed = kind === "cooled" && !compareCoverage.complete;
    if (coolingSuppressed) { kind = "unchanged"; causes.push("source_coverage_incomplete"); }
    const notificationReasons: string[] = [];
    if (change.sourceCountDelta >= thresholds.minCrossSourceGrowth) notificationReasons.push("cross_source_growth");
    if (change.strongPainDelta >= thresholds.minStrongPainGrowth) notificationReasons.push("strong_pain_growth");
    if (change.commercialEvidenceDelta >= thresholds.minCommercialEvidenceGrowth) notificationReasons.push("commercial_evidence_growth");
    if (!coolingSuppressed && kind === "cooled" && -((after?.evidenceCount ?? 0) - (before?.evidenceCount ?? 0)) >= thresholds.minCoolingEvidenceLoss) notificationReasons.push("material_cooling");
    const primary = after ?? before!;
    entries.push({
      kind, opportunityId: primary.opportunityId, clusterId: primary.clusterId, demandStatement: primary.demandStatement,
      before, after, evidenceCountDelta: (after?.evidenceCount ?? 0) - (before?.evidenceCount ?? 0), evidenceChange: change,
      causes, conclusive: !coolingSuppressed, coolingSuppressed, notify: notificationReasons.length > 0, notificationReasons,
    });
  }

  const summary = {
    added: entries.filter((item) => item.kind === "added").length,
    heated: entries.filter((item) => item.kind === "heated").length,
    cooled: entries.filter((item) => item.kind === "cooled").length,
    unchanged: entries.filter((item) => item.kind === "unchanged").length,
  };
  const notificationEntries = entries.filter((item) => item.notify);
  return {
    baselineRunId: input.baselineRunId, compareRunId: input.compareRunId, computedAt: input.computedAt ?? new Date().toISOString(), entries, summary,
    coverage: { baseline: baselineCoverage, compare: compareCoverage, partial: !baselineCoverage.complete || !compareCoverage.complete },
    notifications: { triggered: notificationEntries.length > 0, reasons: [...new Set(notificationEntries.flatMap((item) => item.notificationReasons))].sort(), monitorKeys: notificationEntries.map((item) => item.after?.monitorKey ?? item.before!.monitorKey) },
    thresholds,
  };
}
