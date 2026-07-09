import { asId, MIN_EVIDENCE_REF_COUNT, type ConfidenceLevel, type EvidenceItem, type OpportunityDraft, type RawSignal, type ScoreVector } from "@idea-finder/core";

import type { SignalCluster } from "./cluster.js";

export interface DraftBuildInput {
  readonly cluster: SignalCluster;
  readonly evidence: readonly EvidenceItem[];
  readonly disconfirmingSignals: readonly RawSignal[];
  readonly queryTerms: readonly string[];
}

export function buildOpportunityDraft(input: DraftBuildInput): OpportunityDraft | null {
  const supporting = input.evidence.filter((item) => item.supportsClaim !== "disconfirming");
  if (supporting.length < MIN_EVIDENCE_REF_COUNT) {
    return null;
  }

  const scoreVector = scoreFromEvidence(supporting);
  const confidence = confidenceFromScore(scoreVector);
  const focus = input.queryTerms.length > 0 ? input.queryTerms.join(" ") : "harvested signals";
  const signalTypes = [...new Set(input.cluster.signals.map((s) => s.signalType))];

  return {
    id: asId(`draft_${input.cluster.id}`),
    clusterId: input.cluster.id,
    demandStatement: `Demand around ${focus} (${signalTypes.slice(0, 3).join(", ")})`,
    persona: `users discussing ${focus}`,
    scenario: `multi-source research run with ${supporting.length} evidence items`,
    evidenceItemIds: supporting.map((item) => item.id),
    disconfirmingSignalIds: input.disconfirmingSignals.map((s) => s.id),
    pseudoDemandRisks: [],
    scoreVector,
    confidence,
    confidenceReasons: buildConfidenceReasons(scoreVector, supporting),
    llmModel: "none",
    promptVersion: "rule_v1",
    provenance: { createdBy: "pipeline" },
  };
}

function scoreFromEvidence(evidence: readonly EvidenceItem[]): ScoreVector {
  const distinctDocs = new Set(evidence.map((item) => item.documentId)).size;
  const distinctPlatforms = new Set(evidence.map((item) => item.platform)).size;
  const hasWtp = evidence.some((item) => item.supportsClaim === "wtp");
  const hasWorkaround = evidence.some((item) => item.supportsClaim === "workaround");

  return {
    frequency: Math.min(1, evidence.length / 5),
    crossSource: Math.min(1, distinctPlatforms / 3),
    recency: Math.min(1, distinctDocs / 4),
    wtpStrength: hasWtp ? 0.85 : 0.35,
    workaroundDepth: hasWorkaround ? 0.8 : 0.35,
  };
}

function confidenceFromScore(score: ScoreVector): ConfidenceLevel {
  if (score.crossSource >= 0.5 && score.frequency >= 0.5) {
    return "high";
  }
  if (score.frequency >= 0.4) {
    return "medium";
  }
  return "low";
}

function buildConfidenceReasons(
  score: ScoreVector,
  evidence: readonly EvidenceItem[],
): string[] {
  const reasons: string[] = ["rule_v1_deterministic"];
  if (score.crossSource >= 0.5) reasons.push("cross_source");
  if (score.wtpStrength >= 0.8) reasons.push("wtp");
  if (score.workaroundDepth >= 0.8) reasons.push("workaround");
  if (evidence.length >= MIN_EVIDENCE_REF_COUNT) reasons.push("min_evidence_met");
  return reasons;
}
