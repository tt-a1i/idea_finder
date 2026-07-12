import { asId } from "./ids.js";
import { randomUUID } from "node:crypto";
import type { CalibrationEventId, ChunkId } from "./ids.js";
import type {
  ActorKind,
  CalibrationAction,
  CalibrationEvent,
  Chunk,
  EvidenceItem,
  Opportunity,
  OpportunityStatus,
  RawSignal,
} from "./types.js";
import {
  InvariantViolation,
  isAgentActor,
  validateOpportunity,
} from "./validation.js";
import type { CorroborationContext } from "./multi-lane-research.js";

export interface CalibrationResult {
  opportunity: Opportunity;
  event: CalibrationEvent;
}

export interface CalibrationValidationContext {
  evidenceById: ReadonlyMap<EvidenceItem["id"], EvidenceItem>;
  chunksById: ReadonlyMap<ChunkId, Chunk>;
  signalsById: ReadonlyMap<RawSignal["id"], RawSignal>;
  corroborationContext?: CorroborationContext;
}

function statusForAction(action: CalibrationAction): OpportunityStatus {
  switch (action) {
    case "promote":
      return "promoted";
    case "reject":
      return "rejected";
    case "park":
      return "parked";
    case "needs_more_evidence":
      return "hypothesis";
  }
}

function assertPromoteEligible(
  opportunity: Opportunity,
  actor: ActorKind,
  validationContext: CalibrationValidationContext,
): void {
  const candidate: Opportunity = {
    ...opportunity,
    status: "promoted",
    provenance: {
      ...opportunity.provenance,
      promotedBy: actor,
    },
  };

  const result = validateOpportunity(
    candidate,
    validationContext.evidenceById,
    validationContext.chunksById,
    validationContext.signalsById,
    validationContext.corroborationContext,
  );

  if (!result.ok) {
    const first = result.issues[0];
    throw new InvariantViolation(
      first?.code ?? "opportunity.promote_ineligible",
      first?.message ?? "Opportunity is not eligible for promotion",
    );
  }
}

/** Apply a board calibration action and record a CalibrationEvent. */
export function applyCalibration(
  opportunity: Opportunity,
  action: CalibrationAction,
  note: string | null,
  actor: ActorKind,
  occurredAt?: string,
  validationContext?: CalibrationValidationContext,
): CalibrationResult {
  if (isAgentActor(actor)) {
    throw new InvariantViolation(
      "calibration.agent_forbidden",
      "browser/computer agents cannot calibrate opportunities directly",
    );
  }

  if (action === "promote") {
    if (!validationContext) {
      throw new InvariantViolation(
        "calibration.promote_context_required",
        "promote requires evidence/chunk/signal maps to validate corroboration",
      );
    }
    assertPromoteEligible(opportunity, actor, validationContext);
  }

  const nextStatus = statusForAction(action);
  const promotedBy =
    action === "promote" ? actor : opportunity.provenance.promotedBy;

  const event: CalibrationEvent = {
    id: asId<CalibrationEventId>(`cal_${opportunity.id}_${randomUUID()}`),
    opportunityId: opportunity.id,
    actor,
    action,
    note,
    occurredAt: occurredAt ?? new Date().toISOString(),
  };

  return {
    opportunity: {
      ...opportunity,
      status: nextStatus,
      provenance: {
        ...opportunity.provenance,
        promotedBy,
      },
    },
    event,
  };
}
