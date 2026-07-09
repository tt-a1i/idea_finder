import { describe, expect, it } from "vitest";

import { asId } from "../../src/domain/ids.js";
import {
  completeValidationExperiment,
  createValidationExperiment,
  startValidationExperiment,
} from "../../src/domain/validation-experiment.js";
import { InvariantViolation } from "../../src/domain/validation.js";
import type { Opportunity } from "../../src/domain/types.js";

const promotedOpportunity: Opportunity = {
  id: asId("opp_test"),
  clusterId: asId("cluster_test"),
  status: "promoted",
  demandStatement: "Test demand",
  persona: "founder",
  scenario: "monthly",
  evidenceItemIds: [asId("e1"), asId("e2"), asId("e3")],
  disconfirmingEvidenceItemIds: [],
  pseudoDemandRisks: [],
  scoreVector: {
    frequency: 0.5,
    crossSource: 0.5,
    recency: 0.5,
    wtpStrength: 0.5,
    workaroundDepth: 0.5,
  },
  confidence: "medium",
  confidenceReasons: [],
  provenance: { createdBy: "pipeline", promotedBy: "user" },
};

describe("validation experiment domain", () => {
  it("creates experiment only for promoted opportunities", () => {
    expect(() =>
      createValidationExperiment({
        opportunity: { ...promotedOpportunity, status: "hypothesis" },
        type: "mom_test",
        hypothesis: "Users will pay",
      }),
    ).toThrow(InvariantViolation);

    const experiment = createValidationExperiment({
      opportunity: promotedOpportunity,
      type: "landing",
      hypothesis: "Landing page converts at 5%",
    });
    expect(experiment.status).toBe("planned");
    expect(experiment.opportunityId).toBe(promotedOpportunity.id);
  });

  it("records result and conservatively updates opportunity metadata", () => {
    const experiment = startValidationExperiment(
      createValidationExperiment({
        opportunity: promotedOpportunity,
        type: "spike",
        hypothesis: "Stripe webhook spike is feasible",
      }),
    );

    const validated = completeValidationExperiment(promotedOpportunity, {
      experiment,
      outcome: "validated",
      summary: "3 of 5 interviews confirmed willingness to pay",
    });
    expect(validated.experiment.status).toBe("completed");
    expect(validated.experiment.result?.outcome).toBe("validated");
    expect(validated.opportunity.confidenceReasons).toContain("validation_validated");
    expect(validated.opportunity.status).toBe("promoted");

    const invalidated = completeValidationExperiment(promotedOpportunity, {
      experiment: createValidationExperiment({
        opportunity: promotedOpportunity,
        type: "landing",
        hypothesis: "Landing converts",
      }),
      outcome: "invalidated",
      summary: "No conversion on landing page",
    });
    expect(invalidated.opportunity.confidence).toBe("low");
    expect(invalidated.opportunity.status).toBe("parked");
  });
});
