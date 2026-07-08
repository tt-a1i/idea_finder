import type {
  Chunk,
  EvidenceItem,
  Opportunity,
  OpportunityDraft,
  OpportunityStatus,
  RawSignal,
  SignalType,
  SupportsClaim,
} from "./types.js";
import type { ActorKind } from "./types.js";
import type { ChunkId } from "./ids.js";

export const MIN_EVIDENCE_REF_COUNT = 3;
export const MIN_DISTINCT_DOCUMENTS_FOR_PROMOTED = 2;
export const MAX_QUOTE_VERBATIM_LENGTH = 500;

export class InvariantViolation extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "InvariantViolation";
    this.code = code;
  }
}

export interface ValidationIssue {
  code: string;
  message: string;
}

export type ValidationResult =
  | { ok: true }
  | { ok: false; issues: ValidationIssue[] };

const VALID: ValidationResult = { ok: true };

export function validationFailure(
  code: string,
  message: string,
): ValidationResult {
  return { ok: false, issues: [{ code, message }] };
}

export function mergeResults(...results: ValidationResult[]): ValidationResult {
  const issues = results.flatMap((result) => (result.ok ? [] : result.issues));
  return issues.length === 0 ? VALID : { ok: false, issues };
}

export function assertValid(result: ValidationResult): void {
  if (!result.ok) {
    const first = result.issues[0];
    throw new InvariantViolation(first.code, first.message);
  }
}

/** quote_verbatim must be an exact substring of chunk.text */
export function isQuoteVerbatimSubstring(
  chunkText: string,
  quoteVerbatim: string,
): boolean {
  return quoteVerbatim.length > 0 && chunkText.includes(quoteVerbatim);
}

export function validateQuoteLength(quoteVerbatim: string): ValidationResult {
  if (quoteVerbatim.length === 0) {
    return validationFailure("quote.empty", "quote_verbatim must not be empty");
  }
  if (quoteVerbatim.length > MAX_QUOTE_VERBATIM_LENGTH) {
    return validationFailure(
      "quote.too_long",
      `quote_verbatim exceeds ${MAX_QUOTE_VERBATIM_LENGTH} characters`,
    );
  }
  return VALID;
}

export function validateChunkQuote(
  chunk: Chunk,
  quoteVerbatim: string,
): ValidationResult {
  return mergeResults(
    validateQuoteLength(quoteVerbatim),
    isQuoteVerbatimSubstring(chunk.text, quoteVerbatim)
      ? VALID
      : validationFailure(
          "quote.not_substring",
          "quote_verbatim must be a substring of chunk.text",
        ),
  );
}

export function validateRawSignal(
  signal: RawSignal,
  chunk: Chunk,
): ValidationResult {
  if (signal.chunkId !== chunk.id) {
    return validationFailure(
      "signal.chunk_mismatch",
      "RawSignal.chunkId must match the provided Chunk",
    );
  }

  return mergeResults(
    validateChunkQuote(chunk, signal.quoteVerbatim),
    signal.signalType === "noise"
      ? validationFailure("signal.noise", "noise signals cannot be persisted as evidence input")
      : VALID,
  );
}

export function validateEvidenceItem(
  evidence: EvidenceItem,
  chunk: Chunk,
): ValidationResult {
  if (evidence.chunkId !== chunk.id) {
    return validationFailure(
      "evidence.chunk_mismatch",
      "EvidenceItem.chunkId must match the provided Chunk",
    );
  }

  if (!evidence.url.trim()) {
    return validationFailure("evidence.missing_url", "EvidenceItem.url is required");
  }

  return mergeResults(
    validateChunkQuote(chunk, evidence.quoteVerbatim),
    isAgentEvidenceProvenance(evidence.provenance) &&
      evidence.provenance.agentRunId === null
      ? validationFailure(
          "evidence.agent_run_required",
          "browser/computer agent evidence must include agentRunId",
        )
      : VALID,
  );
}

function isAgentEvidenceProvenance(
  provenance: EvidenceItem["provenance"],
): boolean {
  return (
    provenance.createdBy === "browser_agent" ||
    provenance.createdBy === "computer_agent"
  );
}

export function validateDisconfirmingSignalIds(
  signalIds: readonly RawSignal["id"][],
  signalsById: ReadonlyMap<RawSignal["id"], RawSignal>,
  chunksById: ReadonlyMap<ChunkId, Chunk>,
): ValidationResult {
  const issues: ValidationIssue[] = [];

  for (const signalId of signalIds) {
    const signal = signalsById.get(signalId);
    if (!signal) {
      issues.push({
        code: "opportunity.missing_disconfirming_signal",
        message: `Missing disconfirming RawSignal ${signalId}`,
      });
      continue;
    }

    const chunk = chunksById.get(signal.chunkId);
    if (!chunk) {
      issues.push({
        code: "disconfirming.missing_chunk",
        message: `Disconfirming RawSignal ${signalId} references missing chunk ${signal.chunkId}`,
      });
      continue;
    }

    const result = validateRawSignal(signal, chunk);
    if (!result.ok) {
      issues.push(...result.issues);
    }
  }

  return issues.length === 0 ? VALID : { ok: false, issues };
}

export function validateDisconfirmingEvidenceItemIds(
  evidenceItemIds: readonly EvidenceItem["id"][],
  evidenceById: ReadonlyMap<EvidenceItem["id"], EvidenceItem>,
  chunksById: ReadonlyMap<ChunkId, Chunk>,
): ValidationResult {
  if (evidenceItemIds.length === 0) {
    return VALID;
  }

  const issues: ValidationIssue[] = [];

  for (const evidenceId of evidenceItemIds) {
    const evidence = evidenceById.get(evidenceId);
    if (!evidence) {
      issues.push({
        code: "opportunity.missing_disconfirming_evidence",
        message: `Missing disconfirming EvidenceItem ${evidenceId}`,
      });
      continue;
    }

    const chunk = chunksById.get(evidence.chunkId);
    if (!chunk) {
      issues.push({
        code: "disconfirming.missing_chunk",
        message: `Disconfirming EvidenceItem ${evidenceId} references missing chunk ${evidence.chunkId}`,
      });
      continue;
    }

    const result = validateEvidenceItem(evidence, chunk);
    if (!result.ok) {
      issues.push(...result.issues);
    }
  }

  return issues.length === 0 ? VALID : { ok: false, issues };
}

export function validateEvidenceReferences(
  evidenceItems: EvidenceItem[],
  chunksById: ReadonlyMap<ChunkId, Chunk>,
): ValidationResult {
  const issues: ValidationIssue[] = [];

  for (const evidence of evidenceItems) {
    const chunk = chunksById.get(evidence.chunkId);
    if (!chunk) {
      issues.push({
        code: "evidence.missing_chunk",
        message: `EvidenceItem ${evidence.id} references missing chunk ${evidence.chunkId}`,
      });
      continue;
    }

    const result = validateEvidenceItem(evidence, chunk);
    if (!result.ok) {
      issues.push(...result.issues);
    }
  }

  return issues.length === 0 ? VALID : { ok: false, issues };
}

function collectReferencedEvidence(
  evidenceItemIds: readonly EvidenceItem["id"][],
  evidenceById: ReadonlyMap<EvidenceItem["id"], EvidenceItem>,
): ValidationResult & { evidence?: EvidenceItem[] } {
  const evidence: EvidenceItem[] = [];
  const issues: ValidationIssue[] = [];

  for (const evidenceId of evidenceItemIds) {
    const item = evidenceById.get(evidenceId);
    if (!item) {
      issues.push({
        code: "opportunity.missing_evidence",
        message: `Missing EvidenceItem ${evidenceId}`,
      });
      continue;
    }
    evidence.push(item);
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  return { ok: true, evidence };
}

/** Opportunities must always reference existing evidence ids. */
export function validateOpportunityHasEvidenceRefs(
  evidenceItemIds: readonly EvidenceItem["id"][],
  evidenceById: ReadonlyMap<EvidenceItem["id"], EvidenceItem>,
): ValidationResult {
  if (evidenceItemIds.length === 0) {
    return validationFailure(
      "opportunity.no_evidence_refs",
      "Opportunity must reference at least one EvidenceItem",
    );
  }

  return collectReferencedEvidence(evidenceItemIds, evidenceById);
}

export function countDistinctDocuments(evidenceItems: EvidenceItem[]): number {
  return new Set(evidenceItems.map((item) => item.documentId)).size;
}

export function countNonDisconfirmingEvidence(
  evidenceItems: EvidenceItem[],
): number {
  return evidenceItems.filter((item) => item.supportsClaim !== "disconfirming")
    .length;
}

export function hasWtpOrWorkaroundSignal(
  evidenceItems: EvidenceItem[],
  signalsById: ReadonlyMap<RawSignal["id"], RawSignal>,
): boolean {
  return evidenceItems.some((item) => {
    const signal = signalsById.get(item.rawSignalId);
    if (!signal) {
      return item.supportsClaim === "wtp" || item.supportsClaim === "workaround";
    }
    return (
      signal.signalType === "willingness_to_pay" ||
      signal.signalType === "workaround" ||
      item.supportsClaim === "wtp" ||
      item.supportsClaim === "workaround"
    );
  });
}

const AGENT_ACTORS: ReadonlySet<ActorKind> = new Set([
  "browser_agent",
  "computer_agent",
]);

export function isAgentActor(actor: ActorKind): boolean {
  return AGENT_ACTORS.has(actor);
}

const STATUSES_REQUIRING_MIN_EVIDENCE: ReadonlySet<OpportunityStatus> = new Set([
  "hypothesis",
  "promoted",
  "parked",
]);

/** hypothesis/promoted require enough supporting evidence. */
export function validateOpportunityStatusEvidenceRequirements(
  status: OpportunityStatus,
  evidenceItems: EvidenceItem[],
  signalsById: ReadonlyMap<RawSignal["id"], RawSignal>,
): ValidationResult {
  if (!STATUSES_REQUIRING_MIN_EVIDENCE.has(status)) {
    return VALID;
  }

  const nonDisconfirming = evidenceItems.filter(
    (item) => item.supportsClaim !== "disconfirming",
  );

  if (nonDisconfirming.length < MIN_EVIDENCE_REF_COUNT) {
    return validationFailure(
      "opportunity.insufficient_evidence",
      `${status} opportunities require at least ${MIN_EVIDENCE_REF_COUNT} non-disconfirming evidence items`,
    );
  }

  if (status === "promoted") {
    const distinctDocuments = countDistinctDocuments(nonDisconfirming);
    const strongSingleSource = hasWtpOrWorkaroundSignal(
      nonDisconfirming,
      signalsById,
    );

    if (
      distinctDocuments < MIN_DISTINCT_DOCUMENTS_FOR_PROMOTED &&
      !strongSingleSource
    ) {
      return validationFailure(
        "opportunity.insufficient_corroboration",
        "promoted opportunities require at least two distinct documents or explicit WTP/workaround evidence",
      );
    }
  }

  return VALID;
}

export function validateOpportunityDraft(
  draft: OpportunityDraft,
  evidenceById: ReadonlyMap<EvidenceItem["id"], EvidenceItem>,
  chunksById: ReadonlyMap<ChunkId, Chunk>,
  signalsById: ReadonlyMap<RawSignal["id"], RawSignal>,
): ValidationResult {
  const actorResult = validateActorMayWriteOpportunity(draft.provenance.createdBy);
  const refsResult = validateOpportunityHasEvidenceRefs(
    draft.evidenceItemIds,
    evidenceById,
  );

  if (!refsResult.ok) {
    return mergeResults(actorResult, refsResult);
  }

  const collected = collectReferencedEvidence(
    draft.evidenceItemIds,
    evidenceById,
  );
  if (!collected.ok || !collected.evidence) {
    return mergeResults(actorResult, collected);
  }

  return mergeResults(
    actorResult,
    validateEvidenceReferences(collected.evidence, chunksById),
    validateDisconfirmingSignalIds(
      draft.disconfirmingSignalIds,
      signalsById,
      chunksById,
    ),
    draft.evidenceItemIds.length < MIN_EVIDENCE_REF_COUNT
      ? validationFailure(
          "opportunity.draft_insufficient_evidence",
          `OpportunityDraft requires at least ${MIN_EVIDENCE_REF_COUNT} evidence references`,
        )
      : VALID,
    validateOpportunityStatusEvidenceRequirements(
      "hypothesis",
      collected.evidence,
      signalsById,
    ),
  );
}

export function validateOpportunity(
  opportunity: Opportunity,
  evidenceById: ReadonlyMap<EvidenceItem["id"], EvidenceItem>,
  chunksById: ReadonlyMap<ChunkId, Chunk>,
  signalsById: ReadonlyMap<RawSignal["id"], RawSignal>,
): ValidationResult {
  const refsResult = validateOpportunityHasEvidenceRefs(
    opportunity.evidenceItemIds,
    evidenceById,
  );
  if (!refsResult.ok) {
    return refsResult;
  }

  const collected = collectReferencedEvidence(
    opportunity.evidenceItemIds,
    evidenceById,
  );
  if (!collected.ok || !collected.evidence) {
    return collected;
  }

  const promotionActor =
    opportunity.status === "promoted"
      ? validateActorMayWriteOpportunity(
          opportunity.provenance.promotedBy ?? opportunity.provenance.createdBy,
        )
      : VALID;

  return mergeResults(
    validateEvidenceReferences(collected.evidence, chunksById),
    validateDisconfirmingEvidenceItemIds(
      opportunity.disconfirmingEvidenceItemIds,
      evidenceById,
      chunksById,
    ),
    validateOpportunityStatusEvidenceRequirements(
      opportunity.status,
      collected.evidence,
      signalsById,
    ),
    promotionActor,
    isAgentActor(opportunity.provenance.createdBy)
      ? validationFailure(
          "opportunity.agent_write_forbidden",
          "browser/computer agents cannot create opportunities directly",
        )
      : VALID,
  );
}

/** Browser/computer agents may attach evidence, not opportunities. */
export function validateActorMayWriteOpportunity(actor: ActorKind): ValidationResult {
  if (isAgentActor(actor)) {
    return validationFailure(
      "opportunity.agent_write_forbidden",
      "browser/computer agents cannot write opportunities directly",
    );
  }
  return VALID;
}

export function validateAgentEvidenceWrite(
  provenance: EvidenceItem["provenance"],
): ValidationResult {
  if (!isAgentEvidenceProvenance(provenance)) {
    return VALID;
  }

  if (!provenance.agentRunId) {
    return validationFailure(
      "evidence.agent_run_required",
      "browser/computer agent evidence must include agentRunId",
    );
  }

  return VALID;
}

export const WTP_SIGNAL_TYPES: ReadonlySet<SignalType> = new Set([
  "willingness_to_pay",
  "workaround",
]);

export const DISCONFIRMING_CLAIMS: ReadonlySet<SupportsClaim> = new Set([
  "disconfirming",
]);
