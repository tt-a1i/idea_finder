import { createHash } from "node:crypto";
import type {
  EvidenceItemId,
  HuntingTaskId,
  MetricObservationId,
  RawDocumentId,
  TrendEventId,
  TrendSeriesId,
} from "./ids.js";
import type { EvidenceItem } from "./types.js";
import { InvariantViolation } from "./validation.js";

export type ResearchLane =
  | "qualitative_demand"
  | "trend_momentum"
  | "supply_competition"
  | "commercial_intent"
  | "contradictory_evidence";

export type ClaimStatus = "validated" | "unvalidated" | "contradicted";

export type ClaimEvidenceRef =
  | {
    readonly kind: "text_quote";
    readonly evidenceItemId: EvidenceItemId;
    readonly chunkId: string;
    readonly documentId: RawDocumentId;
    readonly url: string;
  }
  | {
    readonly kind: "observation_series";
    readonly seriesId: TrendSeriesId;
    readonly observationIds: readonly MetricObservationId[];
  }
  | {
    readonly kind: "ranking_snapshot";
    readonly observationId: MetricObservationId;
    readonly sourceUrl: string;
  }
  | {
    readonly kind: "source_url";
    readonly url: string;
    readonly provenanceRef: string;
  };

export interface ResearchClaim {
  readonly id: string;
  readonly lane: ResearchLane;
  readonly statement: string;
  readonly status: ClaimStatus;
  readonly evidenceRefs: readonly ClaimEvidenceRef[];
  readonly independentSourceGroupIds: readonly string[];
  readonly limitations: readonly string[];
}

const TEXT_ONLY_LANES: ReadonlySet<ResearchLane> = new Set([
  "qualitative_demand",
  "commercial_intent",
  "contradictory_evidence",
]);

export function buildResearchClaim(input: ResearchClaim): ResearchClaim {
  if (!input.id.trim() || !input.statement.trim()) {
    throw new InvariantViolation("claim.identity_required", "Claim id and statement are required");
  }
  if (input.evidenceRefs.length === 0) {
    throw new InvariantViolation("claim.evidence_required", "Every claim requires evidence references");
  }
  if (TEXT_ONLY_LANES.has(input.lane) && !input.evidenceRefs.some((ref) => ref.kind === "text_quote")) {
    throw new InvariantViolation("claim.text_evidence_required", `${input.lane} claims require a stored text quote`);
  }
  if (input.lane === "trend_momentum" && !input.evidenceRefs.some((ref) => ref.kind === "observation_series")) {
    throw new InvariantViolation("claim.series_required", "Trend momentum claims require an observation series");
  }
  for (const ref of input.evidenceRefs) {
    if (ref.kind === "text_quote" && (!ref.url.trim() || !ref.chunkId.trim())) {
      throw new InvariantViolation("claim.quote_ref_invalid", "Text quote references require chunk and URL");
    }
    if (ref.kind === "observation_series" && ref.observationIds.length === 0) {
      throw new InvariantViolation("claim.series_ref_invalid", "Observation series references require observations");
    }
    if (ref.kind === "ranking_snapshot" && !ref.sourceUrl.trim()) {
      throw new InvariantViolation("claim.ranking_ref_invalid", "Ranking snapshots require a source URL");
    }
    if (ref.kind === "source_url" && (!ref.url.trim() || !ref.provenanceRef.trim())) {
      throw new InvariantViolation("claim.source_ref_invalid", "Source URL references require provenance");
    }
  }
  return {
    ...input,
    independentSourceGroupIds: [...new Set(input.independentSourceGroupIds)].sort(),
  };
}

export interface MultiLaneCandidate {
  readonly id: string;
  readonly subject: string;
  readonly claimIds: readonly string[];
  readonly qualitativeEvidenceItemIds: readonly EvidenceItemId[];
  readonly quantitativeSeriesIds: readonly TrendSeriesId[];
  readonly status: "unvalidated" | "eligible_for_admission";
  readonly admissionOutcome: "rejected" | "eligible";
  readonly validationIssues: readonly { readonly code: string; readonly message: string }[];
}

export function evaluateMultiLaneCandidate(input: {
  readonly id: string;
  readonly subject: string;
  readonly claims: readonly ResearchClaim[];
  readonly qualitativeEvidenceItemIds: readonly EvidenceItemId[];
  readonly quantitativeSeriesIds: readonly TrendSeriesId[];
  readonly minimumIndependentQualitativeSources?: number;
  readonly independentQualitativeSourceGroupIds: readonly string[];
}): MultiLaneCandidate {
  const minimum = input.minimumIndependentQualitativeSources ?? 3;
  const independent = new Set(input.independentQualitativeSourceGroupIds);
  const issues: Array<{ code: string; message: string }> = [];
  if (input.qualitativeEvidenceItemIds.length === 0) {
    issues.push({ code: "candidate.qualitative_demand_missing", message: "Quantitative momentum cannot replace qualitative demand evidence" });
  }
  if (independent.size < minimum) {
    issues.push({ code: "candidate.independent_corroboration_insufficient", message: `Candidate requires ${minimum} independent qualitative sources` });
  }
  return {
    id: input.id,
    subject: input.subject,
    claimIds: input.claims.map((claim) => claim.id),
    qualitativeEvidenceItemIds: [...input.qualitativeEvidenceItemIds],
    quantitativeSeriesIds: [...input.quantitativeSeriesIds],
    status: issues.length === 0 ? "eligible_for_admission" : "unvalidated",
    admissionOutcome: issues.length === 0 ? "eligible" : "rejected",
    validationIssues: issues,
  };
}

export interface LaneSummary {
  readonly lane: ResearchLane;
  readonly totalClaims: number;
  readonly validatedClaims: number;
  readonly unvalidatedClaims: number;
  readonly contradictedClaims: number;
  readonly topClaimIds: readonly string[];
  readonly hasMore: boolean;
}

export interface MultiLaneSummaryV1 {
  readonly schemaVersion: "1";
  readonly briefId: HuntingTaskId;
  readonly runId: string;
  readonly lanes: Readonly<Record<ResearchLane, LaneSummary>>;
  readonly candidates: readonly MultiLaneCandidate[];
  readonly followUpProposalIds: readonly string[];
}

export function buildMultiLaneSummary(input: {
  readonly briefId: HuntingTaskId;
  readonly runId: string;
  readonly claims: readonly ResearchClaim[];
  readonly candidates?: readonly MultiLaneCandidate[];
  readonly followUpProposalIds?: readonly string[];
  readonly topClaimsPerLane?: number;
}): MultiLaneSummaryV1 {
  const limit = input.topClaimsPerLane ?? 3;
  const laneNames: ResearchLane[] = ["qualitative_demand", "trend_momentum", "supply_competition", "commercial_intent", "contradictory_evidence"];
  const lanes = Object.fromEntries(laneNames.map((lane) => {
    const claims = input.claims.filter((claim) => claim.lane === lane);
    return [lane, {
      lane,
      totalClaims: claims.length,
      validatedClaims: claims.filter((claim) => claim.status === "validated").length,
      unvalidatedClaims: claims.filter((claim) => claim.status === "unvalidated").length,
      contradictedClaims: claims.filter((claim) => claim.status === "contradicted").length,
      topClaimIds: claims.slice(0, limit).map((claim) => claim.id),
      hasMore: claims.length > limit,
    } satisfies LaneSummary];
  })) as unknown as Readonly<Record<ResearchLane, LaneSummary>>;
  return { schemaVersion: "1", briefId: input.briefId, runId: input.runId, lanes, candidates: input.candidates ?? [], followUpProposalIds: input.followUpProposalIds ?? [] };
}

export interface FollowUpHuntingTaskProposal {
  readonly id: string;
  readonly triggerEventId: TrendEventId;
  readonly triggerSeriesId: TrendSeriesId;
  readonly subject: string;
  readonly status: "proposed" | "created";
  readonly createdBriefId: HuntingTaskId | null;
  readonly createdAt: string | null;
  readonly requiredLanes: readonly ["qualitative_demand", "supply_competition", "commercial_intent"];
  readonly suggestedLenses: readonly ["pain", "workaround", "competition", "commercial_intent"];
}

export function proposeFollowUpHuntingTask(input: {
  readonly triggerEventId: TrendEventId;
  readonly triggerSeriesId: TrendSeriesId;
  readonly triggerKind: "spike" | "sustained_growth" | "momentum_up";
  readonly subject: string;
}): FollowUpHuntingTaskProposal {
  if (!input.subject.trim()) throw new InvariantViolation("follow_up.subject_required", "Follow-up subject is required");
  const digest = createHash("sha256").update(`${input.triggerEventId}|${input.subject.trim()}`).digest("hex").slice(0, 20);
  return {
    id: `followup_${digest}`,
    triggerEventId: input.triggerEventId,
    triggerSeriesId: input.triggerSeriesId,
    subject: input.subject.trim(),
    status: "proposed",
    createdBriefId: null,
    createdAt: null,
    requiredLanes: ["qualitative_demand", "supply_competition", "commercial_intent"],
    suggestedLenses: ["pain", "workaround", "competition", "commercial_intent"],
  };
}

export interface EvidenceIndependenceRecord {
  readonly documentId: RawDocumentId;
  readonly contentFingerprint: string;
  readonly independenceGroupId: string;
  readonly canonicalDocumentId: RawDocumentId;
  readonly relation: "independent" | "exact_duplicate" | "syndicated" | "unknown";
  readonly basis: "normalized_content_sha256_v1" | "normalized_content_containment_v1" | "independence_unknown";
}

export interface EvidenceIndependenceIndex {
  readonly records: readonly EvidenceIndependenceRecord[];
  readonly independenceGroupByDocumentId: ReadonlyMap<RawDocumentId, string>;
}

function normalizeContent(content: string): string {
  return content.normalize("NFKC").replace(/\s+/g, " ").trim();
}

export function buildExactDuplicateIndependenceIndex(
  documents: readonly { readonly documentId: RawDocumentId; readonly content: string }[],
): EvidenceIndependenceIndex {
  const normalized = documents.map((document) => ({ ...document, normalized: normalizeContent(document.content) }));
  for (const document of normalized) if (!document.normalized) throw new InvariantViolation("independence.content_required", `Document ${document.documentId} has no content`);
  const parent = normalized.map((_, index) => index);
  const find = (index: number): number => parent[index] === index ? index : (parent[index] = find(parent[index]!));
  const union = (left: number, right: number) => { const a = find(left); const b = find(right); if (a !== b) parent[Math.max(a, b)] = Math.min(a, b); };
  for (let left = 0; left < normalized.length; left += 1) for (let right = left + 1; right < normalized.length; right += 1) {
    const a = normalized[left]!.normalized; const b = normalized[right]!.normalized;
    const shorter = a.length <= b.length ? a : b; const longer = a.length <= b.length ? b : a;
    if (a === b || (shorter.length >= 40 && shorter.length / longer.length >= 0.6 && longer.includes(shorter))) union(left, right);
  }
  const groups = new Map<number, typeof normalized>();
  normalized.forEach((document, index) => { const root = find(index); groups.set(root, [...(groups.get(root) ?? []), document]); });
  const records: EvidenceIndependenceRecord[] = [];
  const map = new Map<RawDocumentId, string>();
  for (const members of [...groups.values()].sort((a, b) => a[0]!.documentId.localeCompare(b[0]!.documentId))) {
    const ordered = [...members].sort((a, b) => a.documentId.localeCompare(b.documentId));
    const canonical = ordered[0]!;
    const fingerprint = createHash("sha256").update(canonical.normalized).digest("hex");
    const canonicalDocumentId = canonical.documentId;
    const groupId = `ind_${fingerprint.slice(0, 24)}`;
    ordered.forEach((document, index) => {
      const exact = document.normalized === canonical.normalized;
      records.push({ documentId: document.documentId, contentFingerprint: createHash("sha256").update(document.normalized).digest("hex"), independenceGroupId: groupId, canonicalDocumentId, relation: index === 0 ? "independent" : exact ? "exact_duplicate" : "syndicated", basis: exact ? "normalized_content_sha256_v1" : "normalized_content_containment_v1" });
      map.set(document.documentId, groupId);
    });
  }
  return { records: records.sort((a, b) => a.documentId.localeCompare(b.documentId)), independenceGroupByDocumentId: map };
}

export interface CorroborationContext {
  readonly independenceGroupByDocumentId: ReadonlyMap<RawDocumentId, string>;
}

export function independentEvidenceGroupIds(
  evidence: readonly EvidenceItem[],
  context: CorroborationContext,
): string[] {
  const groups = new Set<string>();
  for (const item of evidence) {
    const group = context.independenceGroupByDocumentId.get(item.documentId);
    if (!group) throw new InvariantViolation("independence.metadata_missing", `Missing independence metadata for document ${item.documentId}`);
    groups.add(group);
  }
  return [...groups].sort();
}
