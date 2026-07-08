import { asId } from "./ids.js";
import type { OpportunityDraftId, OpportunityId } from "./ids.js";
import type { Opportunity, OpportunityDraft } from "./types.js";
import type { Chunk, EvidenceItem, RawSignal } from "./types.js";
import type { ChunkId } from "./ids.js";
import type { ValidationIssue } from "./validation.js";
import { validateOpportunityDraft } from "./validation.js";

export interface DraftRejection {
  draftId: OpportunityDraftId;
  draft: OpportunityDraft;
  issues: ValidationIssue[];
}

export interface LibraryAdmissionResult {
  admitted: Opportunity[];
  rejected: DraftRejection[];
}

function opportunityFromDraft(draft: OpportunityDraft): Opportunity {
  const opportunityId = asId<OpportunityId>(`opp_${draft.id}`);

  return {
    id: opportunityId,
    clusterId: draft.clusterId,
    status: "hypothesis",
    demandStatement: draft.demandStatement,
    persona: draft.persona,
    scenario: draft.scenario,
    evidenceItemIds: [...draft.evidenceItemIds],
    disconfirmingEvidenceItemIds: [],
    pseudoDemandRisks: [...draft.pseudoDemandRisks],
    scoreVector: { ...draft.scoreVector },
    confidence: draft.confidence,
    confidenceReasons: [...draft.confidenceReasons],
    provenance: {
      createdBy: draft.provenance.createdBy,
      promotedBy: null,
    },
  };
}

/** Validate drafts and admit only evidence-backed opportunities to the library. */
export function admitToLibrary(
  drafts: readonly OpportunityDraft[],
  evidenceById: ReadonlyMap<EvidenceItem["id"], EvidenceItem>,
  chunksById: ReadonlyMap<ChunkId, Chunk>,
  signalsById: ReadonlyMap<RawSignal["id"], RawSignal>,
): LibraryAdmissionResult {
  const admitted: Opportunity[] = [];
  const rejected: DraftRejection[] = [];

  for (const draft of drafts) {
    const validation = validateOpportunityDraft(
      draft,
      evidenceById,
      chunksById,
      signalsById,
    );

    if (!validation.ok) {
      rejected.push({
        draftId: draft.id,
        draft,
        issues: validation.issues,
      });
      continue;
    }

    admitted.push(opportunityFromDraft(draft));
  }

  return { admitted, rejected };
}
