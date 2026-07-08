import { describe, expect, it } from "vitest";

import { asId } from "../../src/domain/ids.js";
import {
  assertValid,
  InvariantViolation,
  MIN_EVIDENCE_REF_COUNT,
  validateActorMayWriteOpportunity,
  validateAgentEvidenceWrite,
  validateChunkQuote,
  validateEvidenceItem,
  validateOpportunity,
  validateOpportunityDraft,
  validateOpportunityHasEvidenceRefs,
  validateOpportunityStatusEvidenceRequirements,
  validateRawSignal,
  validateDisconfirmingEvidenceItemIds,
  validateDisconfirmingSignalIds,
} from "../../src/domain/validation.js";
import type {
  Chunk,
  EvidenceItem,
  Opportunity,
  OpportunityDraft,
  RawSignal,
} from "../../src/domain/types.js";

const chunk: Chunk = {
  id: asId("chunk-1"),
  documentId: asId("doc-1"),
  text: "I still invoice clients from a Google Sheet and copy rows into Wave for 2-3 hrs/month.",
  spanStart: 0,
  spanEnd: 86,
};

const baseSignal: RawSignal = {
  id: asId("signal-1"),
  chunkId: chunk.id,
  documentId: chunk.documentId,
  signalType: "workaround",
  signalSubtype: "manual_process",
  quoteVerbatim: "invoice clients from a Google Sheet",
  quoteHash: "hash-1",
  spanStart: 10,
  spanEnd: 44,
  confidenceRule: 0.9,
  detector: "rule_v1",
  detectorVersion: "1.0.0",
  extractedAt: "2026-07-09T00:00:00.000Z",
};

function makeEvidence(
  id: string,
  documentId: string,
  overrides: Partial<EvidenceItem> = {},
): EvidenceItem {
  return {
    id: asId(id),
    clusterId: asId("cluster-1"),
    opportunityId: null,
    rawSignalId: baseSignal.id,
    documentId: asId(documentId),
    chunkId: chunk.id,
    platform: "hn",
    url: `https://example.com/${id}`,
    linkStatus: "ok",
    quoteVerbatim: baseSignal.quoteVerbatim,
    supportsClaim: "workaround",
    strength: "primary",
    userVerified: false,
    provenance: { createdBy: "pipeline", agentRunId: null },
    fetchedAt: "2026-07-09T00:00:00.000Z",
    ...overrides,
  };
}

describe("quote_verbatim substring invariant", () => {
  it("accepts an exact substring", () => {
    expect(validateChunkQuote(chunk, baseSignal.quoteVerbatim).ok).toBe(true);
  });

  it("rejects quotes not present in chunk.text", () => {
    const result = validateChunkQuote(chunk, "Stripe sync without accounting bloat");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0]?.code).toBe("quote.not_substring");
    }
  });

  it("rejects empty quotes", () => {
    const result = validateRawSignal({ ...baseSignal, quoteVerbatim: "" }, chunk);
    expect(result.ok).toBe(false);
  });
});

describe("opportunity evidence refs", () => {
  it("rejects opportunities without evidence references", () => {
    const result = validateOpportunityHasEvidenceRefs([], new Map());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0]?.code).toBe("opportunity.no_evidence_refs");
    }
  });

  it("rejects missing evidence ids", () => {
    const result = validateOpportunityHasEvidenceRefs(
      [asId("missing-evidence")],
      new Map(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0]?.code).toBe("opportunity.missing_evidence");
    }
  });
});

describe("hypothesis/promoted evidence thresholds", () => {
  const evidence = [
    makeEvidence("e1", "doc-1"),
    makeEvidence("e2", "doc-2"),
    makeEvidence("e3", "doc-3"),
  ];
  const evidenceById = new Map(evidence.map((item) => [item.id, item]));
  const signalsById = new Map([[baseSignal.id, baseSignal]]);

  it("requires at least three non-disconfirming items for hypothesis", () => {
    const result = validateOpportunityStatusEvidenceRequirements(
      "hypothesis",
      evidence.slice(0, 2),
      signalsById,
    );
    expect(result.ok).toBe(false);
  });

  it("allows hypothesis with three supporting evidence items", () => {
    const result = validateOpportunityStatusEvidenceRequirements(
      "hypothesis",
      evidence,
      signalsById,
    );
    expect(result.ok).toBe(true);
  });

  it("requires corroboration for promoted unless WTP/workaround is explicit", () => {
    const painSignal: RawSignal = {
      ...baseSignal,
      id: asId("signal-pain"),
      signalType: "pain",
      quoteVerbatim: "invoice clients from a Google Sheet",
    };
    const singleDocEvidence = [
      makeEvidence("e1", "doc-1", {
        rawSignalId: painSignal.id,
        supportsClaim: "pain",
      }),
      makeEvidence("e2", "doc-1", {
        rawSignalId: painSignal.id,
        supportsClaim: "pain",
      }),
      makeEvidence("e3", "doc-1", {
        rawSignalId: painSignal.id,
        supportsClaim: "pain",
      }),
    ];

    const result = validateOpportunityStatusEvidenceRequirements(
      "promoted",
      singleDocEvidence,
      new Map([[painSignal.id, painSignal]]),
    );
    expect(result.ok).toBe(false);
  });

  it("allows promoted with one document when WTP/workaround evidence exists", () => {
    const wtpSignal: RawSignal = {
      ...baseSignal,
      id: asId("signal-wtp"),
      signalType: "willingness_to_pay",
      quoteVerbatim: "Google Sheet",
    };
    const singleDocEvidence = [
      makeEvidence("e1", "doc-1", {
        rawSignalId: wtpSignal.id,
        supportsClaim: "wtp",
        quoteVerbatim: "Google Sheet",
      }),
      makeEvidence("e2", "doc-1"),
      makeEvidence("e3", "doc-1"),
    ];

    const result = validateOpportunityStatusEvidenceRequirements(
      "promoted",
      singleDocEvidence,
      new Map([
        [wtpSignal.id, wtpSignal],
        [baseSignal.id, baseSignal],
      ]),
    );
    expect(result.ok).toBe(true);
  });

  it("validates full opportunity objects through the aggregate validator", () => {
    const opportunity: Opportunity = {
      id: asId("opp-1"),
      clusterId: asId("cluster-1"),
      status: "promoted",
      demandStatement: "Solo SaaS needs lightweight invoicing",
      persona: "solo founder",
      scenario: "month-end invoicing",
      evidenceItemIds: evidence.map((item) => item.id),
      disconfirmingEvidenceItemIds: [],
      pseudoDemandRisks: [],
      scoreVector: {
        frequency: 0.8,
        crossSource: 0.9,
        recency: 0.7,
        wtpStrength: 0.6,
        workaroundDepth: 0.8,
      },
      confidence: "high",
      confidenceReasons: ["cross-source"],
      provenance: { createdBy: "pipeline", promotedBy: "user" },
    };

    const result = validateOpportunity(
      opportunity,
      evidenceById,
      new Map([[chunk.id, chunk]]),
      signalsById,
    );
    expect(result.ok).toBe(true);
  });
});

describe("agent/browser write boundaries", () => {
  it("forbids browser agents from writing opportunities directly", () => {
    const result = validateActorMayWriteOpportunity("browser_agent");
    expect(result.ok).toBe(false);
  });

  it("forbids computer agents from writing opportunities directly", () => {
    const result = validateActorMayWriteOpportunity("computer_agent");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0]?.code).toBe("opportunity.agent_write_forbidden");
    }
  });

  it("requires agentRunId for browser_agent evidence", () => {
    const evidence = makeEvidence("e1", "doc-1", {
      provenance: { createdBy: "browser_agent", agentRunId: null },
    });
    expect(validateEvidenceItem(evidence, chunk).ok).toBe(false);
  });

  it("allows browser_agent evidence when agentRunId is present", () => {
    const evidence = makeEvidence("e1", "doc-1", {
      provenance: {
        createdBy: "browser_agent",
        agentRunId: asId("agent-run-1"),
      },
    });

    expect(validateAgentEvidenceWrite(evidence.provenance).ok).toBe(true);
    expect(validateEvidenceItem(evidence, chunk).ok).toBe(true);
  });

  it("requires agentRunId for computer_agent evidence", () => {
    const evidence = makeEvidence("e1", "doc-1", {
      provenance: { createdBy: "computer_agent", agentRunId: null },
    });
    expect(validateEvidenceItem(evidence, chunk).ok).toBe(false);
  });

  it("rejects opportunity drafts created by browser agents", () => {
    const evidence = [
      makeEvidence("e1", "doc-1"),
      makeEvidence("e2", "doc-2"),
      makeEvidence("e3", "doc-3"),
    ];
    const draft: OpportunityDraft = {
      id: asId("draft-1"),
      clusterId: asId("cluster-1"),
      demandStatement: "test",
      persona: "solo founder",
      scenario: "month-end",
      evidenceItemIds: evidence.map((item) => item.id),
      disconfirmingSignalIds: [],
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
      llmModel: "test",
      promptVersion: "v1",
      provenance: { createdBy: "browser_agent" },
    };

    const result = validateOpportunityDraft(
      draft,
      new Map(evidence.map((item) => [item.id, item])),
      new Map([[chunk.id, chunk]]),
      new Map([[baseSignal.id, baseSignal]]),
    );
    expect(result.ok).toBe(false);
  });

  it("rejects opportunity drafts created by computer agents", () => {
    const evidence = [
      makeEvidence("e1", "doc-1"),
      makeEvidence("e2", "doc-2"),
      makeEvidence("e3", "doc-3"),
    ];
    const draft: OpportunityDraft = {
      id: asId("draft-computer"),
      clusterId: asId("cluster-1"),
      demandStatement: "test",
      persona: "solo founder",
      scenario: "month-end",
      evidenceItemIds: evidence.map((item) => item.id),
      disconfirmingSignalIds: [],
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
      llmModel: "test",
      promptVersion: "v1",
      provenance: { createdBy: "computer_agent" },
    };

    const result = validateOpportunityDraft(
      draft,
      new Map(evidence.map((item) => [item.id, item])),
      new Map([[chunk.id, chunk]]),
      new Map([[baseSignal.id, baseSignal]]),
    );
    expect(result.ok).toBe(false);
  });

  it("throws InvariantViolation via assertValid", () => {
    expect(() =>
      assertValid(validateActorMayWriteOpportunity("browser_agent")),
    ).toThrow(InvariantViolation);
  });
});

describe("disconfirming reference anchoring", () => {
  it("rejects dangling disconfirming signal ids on drafts", () => {
    const evidence = [
      makeEvidence("e1", "doc-1"),
      makeEvidence("e2", "doc-2"),
      makeEvidence("e3", "doc-3"),
    ];
    const draft: OpportunityDraft = {
      id: asId("draft-dangling-signal"),
      clusterId: asId("cluster-1"),
      demandStatement: "test",
      persona: "solo founder",
      scenario: "month-end",
      evidenceItemIds: evidence.map((item) => item.id),
      disconfirmingSignalIds: [asId("missing-signal")],
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
      llmModel: "test",
      promptVersion: "v1",
      provenance: { createdBy: "pipeline" },
    };

    const result = validateOpportunityDraft(
      draft,
      new Map(evidence.map((item) => [item.id, item])),
      new Map([[chunk.id, chunk]]),
      new Map([[baseSignal.id, baseSignal]]),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.issues.some((issue) => issue.code === "opportunity.missing_disconfirming_signal"),
      ).toBe(true);
    }
  });

  it("rejects dangling disconfirming evidence ids on opportunities", () => {
    const evidence = [
      makeEvidence("e1", "doc-1"),
      makeEvidence("e2", "doc-2"),
      makeEvidence("e3", "doc-3"),
    ];
    const opportunity: Opportunity = {
      id: asId("opp-dangling-evidence"),
      clusterId: asId("cluster-1"),
      status: "hypothesis",
      demandStatement: "test",
      persona: "solo founder",
      scenario: "month-end",
      evidenceItemIds: evidence.map((item) => item.id),
      disconfirmingEvidenceItemIds: [asId("missing-evidence")],
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
      provenance: { createdBy: "pipeline", promotedBy: null },
    };

    const result = validateOpportunity(
      opportunity,
      new Map(evidence.map((item) => [item.id, item])),
      new Map([[chunk.id, chunk]]),
      new Map([[baseSignal.id, baseSignal]]),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.issues.some(
          (issue) => issue.code === "opportunity.missing_disconfirming_evidence",
        ),
      ).toBe(true);
    }
  });

  it("validates disconfirming helpers directly", () => {
    expect(
      validateDisconfirmingSignalIds([asId("missing")], new Map(), new Map()).ok,
    ).toBe(false);
    expect(
      validateDisconfirmingEvidenceItemIds(
        [asId("missing")],
        new Map(),
        new Map(),
      ).ok,
    ).toBe(false);
  });
});

describe("constants", () => {
  it("documents minimum evidence count", () => {
    expect(MIN_EVIDENCE_REF_COUNT).toBe(3);
  });
});
