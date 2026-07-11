import { asId } from "./ids.js";
import { randomUUID } from "node:crypto";
import type { ValidationExperimentId } from "./ids.js";
import type {
  ActorKind,
  Opportunity,
  ValidationArtifact,
  ValidationExperiment,
  ValidationOutcome,
  ValidationExperimentType,
} from "./types.js";
import { InvariantViolation } from "./validation.js";

export interface CreateValidationExperimentInput {
  readonly opportunity: Opportunity;
  readonly type: ValidationExperimentType;
  readonly hypothesis: string;
  readonly createdAt?: string;
}

export function createValidationExperiment(
  input: CreateValidationExperimentInput,
): ValidationExperiment {
  if (input.opportunity.status !== "promoted") {
    throw new InvariantViolation(
      "validation.opportunity_not_promoted",
      "Validation experiments require a promoted opportunity",
    );
  }

  const hypothesis = input.hypothesis.trim();
  if (!hypothesis) {
    throw new InvariantViolation(
      "validation.hypothesis_required",
      "Validation experiment hypothesis must not be empty",
    );
  }

  const now = input.createdAt ?? new Date().toISOString();
  return {
    id: asId<ValidationExperimentId>(`vexp_${input.opportunity.id}_${randomUUID()}`),
    opportunityId: input.opportunity.id,
    type: input.type,
    hypothesis,
    status: "planned",
    result: null,
    artifacts: [],
    createdAt: now,
    updatedAt: now,
  };
}

export function startValidationExperiment(
  experiment: ValidationExperiment,
): ValidationExperiment {
  if (experiment.status !== "planned") {
    throw new InvariantViolation(
      "validation.invalid_status_transition",
      `Cannot start experiment in status ${experiment.status}`,
    );
  }
  return {
    ...experiment,
    status: "running",
    updatedAt: new Date().toISOString(),
  };
}

export interface CompleteValidationExperimentInput {
  readonly experiment: ValidationExperiment;
  readonly outcome: ValidationOutcome;
  readonly summary: string;
  readonly recordedBy?: ActorKind;
  readonly artifacts?: readonly ValidationArtifact[];
  readonly recordedAt?: string;
}

export interface ValidationCompletionResult {
  readonly experiment: ValidationExperiment;
  readonly opportunity: Opportunity;
}

const CONFIDENCE_RANK = { low: 0, medium: 1, high: 2 } as const;

function bumpConfidence(current: Opportunity["confidence"]): Opportunity["confidence"] {
  if (current === "low") return "medium";
  return current;
}

function lowerConfidence(current: Opportunity["confidence"]): Opportunity["confidence"] {
  if (current === "high") return "medium";
  return "low";
}

/** Record validation result and conservatively adjust opportunity metadata. */
export function completeValidationExperiment(
  opportunity: Opportunity,
  input: CompleteValidationExperimentInput,
): ValidationCompletionResult {
  if (opportunity.id !== input.experiment.opportunityId) {
    throw new InvariantViolation(
      "validation.opportunity_mismatch",
      "Validation experiment does not belong to the provided opportunity",
    );
  }

  if (input.experiment.status === "completed" || input.experiment.status === "cancelled") {
    throw new InvariantViolation(
      "validation.already_closed",
      `Experiment already ${input.experiment.status}`,
    );
  }

  const summary = input.summary.trim();
  if (!summary) {
    throw new InvariantViolation(
      "validation.summary_required",
      "Validation result summary must not be empty",
    );
  }

  const recordedAt = input.recordedAt ?? new Date().toISOString();
  const result = {
    outcome: input.outcome,
    summary,
    recordedAt,
    recordedBy: input.recordedBy ?? "user",
  };

  const experiment: ValidationExperiment = {
    ...input.experiment,
    status: "completed",
    result,
    artifacts: input.artifacts ?? input.experiment.artifacts,
    updatedAt: recordedAt,
  };

  const confidenceReasons = [...opportunity.confidenceReasons];
  let confidence = opportunity.confidence;
  let status = opportunity.status;

  switch (input.outcome) {
    case "validated":
      confidenceReasons.push("validation_validated");
      if (CONFIDENCE_RANK[confidence] < CONFIDENCE_RANK.medium) {
        confidence = bumpConfidence(confidence);
      }
      break;
    case "invalidated":
      confidenceReasons.push("validation_invalidated");
      confidence = lowerConfidence(confidence);
      if (status === "promoted") {
        status = "parked";
        confidenceReasons.push("validation_parked_after_invalidation");
      }
      break;
    case "inconclusive":
      confidenceReasons.push("validation_inconclusive");
      break;
    case "blocked":
      confidenceReasons.push("validation_blocked");
      break;
  }

  const updatedOpportunity: Opportunity = {
    ...opportunity,
    status,
    confidence,
    confidenceReasons: [...new Set(confidenceReasons)],
  };

  return { experiment, opportunity: updatedOpportunity };
}
