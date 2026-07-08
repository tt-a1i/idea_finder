import { describe, expect, it } from "vitest";

import { applyCalibration } from "../../src/domain/board.js";
import { asId } from "../../src/domain/ids.js";
import { admitToLibrary } from "../../src/domain/library.js";
import { InvariantViolation } from "../../src/domain/validation.js";
import type {
  Chunk,
  EvidenceItem,
  OpportunityDraft,
  RawSignal,
  ResearchRun,
} from "../../src/domain/types.js";

const chunkA: Chunk = {
  id: asId("chunk-a"),
  documentId: asId("doc-a"),
  text: "I invoice from a Google Sheet every month and it takes hours.",
  spanStart: 0,
  spanEnd: 55,
};

const chunkB: Chunk = {
  id: asId("chunk-b"),
  documentId: asId("doc-b"),
  text: "Need Stripe sync for solo SaaS invoicing without QuickBooks bloat.",
  spanStart: 0,
  spanEnd: 58,
};

const chunkC: Chunk = {
  id: asId("chunk-c"),
  documentId: asId("doc-c"),
  text: "Would pay for lightweight invoicing plus Stripe reconciliation.",
  spanStart: 0,
  spanEnd: 54,
};

const chunkDisconfirm: Chunk = {
  id: asId("chunk-d"),
  documentId: asId("doc-d"),
  text: "QuickBooks works fine for me at this scale.",
  spanStart: 0,
  spanEnd: 43,
};

const signalA: RawSignal = {
  id: asId("signal-a"),
  chunkId: chunkA.id,
  documentId: chunkA.documentId,
  signalType: "workaround",
  signalSubtype: "manual_process",
  quoteVerbatim: "invoice from a Google Sheet",
  quoteHash: "hash-a",
  spanStart: 2,
  spanEnd: 28,
  confidenceRule: 0.9,
  detector: "rule_v1",
  detectorVersion: "1.0.0",
  extractedAt: "2026-07-09T00:00:00.000Z",
};

const signalB: RawSignal = {
  ...signalA,
  id: asId("signal-b"),
  chunkId: chunkB.id,
  documentId: chunkB.documentId,
  quoteVerbatim: "Stripe sync for solo SaaS",
  spanStart: 5,
  spanEnd: 29,
};

const signalC: RawSignal = {
  ...signalA,
  id: asId("signal-c"),
  chunkId: chunkC.id,
  documentId: chunkC.documentId,
  signalType: "willingness_to_pay",
  quoteVerbatim: "Would pay for lightweight invoicing",
  spanStart: 0,
  spanEnd: 33,
};

const disconfirmingSignal: RawSignal = {
  ...signalA,
  id: asId("signal-disconfirm"),
  chunkId: chunkDisconfirm.id,
  documentId: chunkDisconfirm.documentId,
  signalType: "validation_negative",
  quoteVerbatim: "QuickBooks works fine for me",
  spanStart: 0,
  spanEnd: 28,
};

function evidence(
  id: string,
  chunk: Chunk,
  signal: RawSignal,
  documentId: string,
): EvidenceItem {
  return {
    id: asId(id),
    clusterId: asId("cluster-invoicing"),
    opportunityId: null,
    rawSignalId: signal.id,
    documentId: asId(documentId),
    chunkId: chunk.id,
    platform: "hn",
    url: `https://example.com/${id}`,
    linkStatus: "ok",
    quoteVerbatim: signal.quoteVerbatim,
    supportsClaim: "workaround",
    strength: "primary",
    userVerified: false,
    provenance: { createdBy: "pipeline", agentRunId: null },
    fetchedAt: "2026-07-09T00:00:00.000Z",
  };
}

const validDraft: OpportunityDraft = {
  id: asId("draft-valid"),
  clusterId: asId("cluster-invoicing"),
  demandStatement: "Solo SaaS needs lightweight invoicing with Stripe sync",
  persona: "solo founder",
  scenario: "month-end invoicing",
  evidenceItemIds: [asId("e-a"), asId("e-b"), asId("e-c")],
  disconfirmingSignalIds: [disconfirmingSignal.id],
  pseudoDemandRisks: [],
  scoreVector: {
    frequency: 0.8,
    crossSource: 0.9,
    recency: 0.7,
    wtpStrength: 0.85,
    workaroundDepth: 0.8,
  },
  confidence: "high",
  confidenceReasons: ["cross-source", "wtp"],
  llmModel: "test-model",
  promptVersion: "v1",
  provenance: { createdBy: "pipeline" },
};

const underEvidencedDraft: OpportunityDraft = {
  ...validDraft,
  id: asId("draft-thin"),
  evidenceItemIds: [asId("e-a"), asId("e-b")],
};

const researchRun: ResearchRun = {
  id: asId("run-1"),
  huntingTaskId: asId("task-1"),
  status: "completed",
  startedAt: "2026-07-09T00:00:00.000Z",
  completedAt: "2026-07-09T00:05:00.000Z",
  configHash: "cfg_invoicing_v1",
  errorMessage: null,
};

describe("ResearchRun -> library admission -> board calibration", () => {
  const eA = evidence("e-a", chunkA, signalA, "doc-a");
  const eB = evidence("e-b", chunkB, signalB, "doc-b");
  const eC = evidence("e-c", chunkC, signalC, "doc-c");

  const evidenceById = new Map([
    [eA.id, eA],
    [eB.id, eB],
    [eC.id, eC],
  ]);

  const chunksById = new Map([
    [chunkA.id, chunkA],
    [chunkB.id, chunkB],
    [chunkC.id, chunkC],
    [chunkDisconfirm.id, chunkDisconfirm],
  ]);

  const signalsById = new Map([
    [signalA.id, signalA],
    [signalB.id, signalB],
    [signalC.id, signalC],
    [disconfirmingSignal.id, disconfirmingSignal],
  ]);

  it("admits valid drafts and rejects under-evidenced drafts after a ResearchRun", () => {
    expect(researchRun.status).toBe("completed");

    const { admitted, rejected } = admitToLibrary(
      [validDraft, underEvidencedDraft],
      evidenceById,
      chunksById,
      signalsById,
    );

    expect(admitted).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(admitted[0]?.status).toBe("hypothesis");
    expect(admitted[0]?.demandStatement).toBe(validDraft.demandStatement);
    expect(rejected[0]?.draftId).toBe(underEvidencedDraft.id);
    expect(rejected[0]?.issues.length).toBeGreaterThan(0);
  });

  it("supports promote, reject, park, and needs_more_evidence calibration actions", () => {
    const { admitted } = admitToLibrary(
      [validDraft],
      evidenceById,
      chunksById,
      signalsById,
    );
    const hypothesis = admitted[0]!;
    const validationContext = { evidenceById, chunksById, signalsById };

    const promoted = applyCalibration(
      hypothesis,
      "promote",
      "ready to validate",
      "user",
      "2026-07-09T01:00:00.000Z",
      validationContext,
    );
    expect(promoted.opportunity.status).toBe("promoted");
    expect(promoted.opportunity.provenance.promotedBy).toBe("user");
    expect(promoted.event.action).toBe("promote");

    const parked = applyCalibration(
      hypothesis,
      "park",
      " revisit next week",
      "user",
    );
    expect(parked.opportunity.status).toBe("parked");
    expect(parked.event.action).toBe("park");

    const rejected = applyCalibration(
      hypothesis,
      "reject",
      "not enough WTP",
      "user",
    );
    expect(rejected.opportunity.status).toBe("rejected");
    expect(rejected.event.action).toBe("reject");

    const needsMore = applyCalibration(
      hypothesis,
      "needs_more_evidence",
      "gather one more source",
      "user",
    );
    expect(needsMore.opportunity.status).toBe("hypothesis");
    expect(needsMore.event.action).toBe("needs_more_evidence");
  });

  it("blocks promote when hypothesis lacks corroboration (single document, no WTP/workaround)", () => {
    const painSignal: RawSignal = {
      ...signalA,
      id: asId("signal-pain-only"),
      signalType: "pain",
      quoteVerbatim: "invoice from a Google Sheet",
    };

    const singleDocEvidence = [
      evidence("e1", chunkA, painSignal, "doc-a"),
      evidence("e2", chunkA, painSignal, "doc-a"),
      evidence("e3", chunkA, painSignal, "doc-a"),
    ].map((item) => ({
      ...item,
      supportsClaim: "pain" as const,
      rawSignalId: painSignal.id,
    }));

    const thinDraft: OpportunityDraft = {
      ...validDraft,
      id: asId("draft-single-doc"),
      evidenceItemIds: singleDocEvidence.map((item) => item.id),
      disconfirmingSignalIds: [],
    };

    const singleEvidenceById = new Map(
      singleDocEvidence.map((item) => [item.id, item]),
    );
    const singleSignalsById = new Map([[painSignal.id, painSignal]]);

    const { admitted } = admitToLibrary(
      [thinDraft],
      singleEvidenceById,
      new Map([[chunkA.id, chunkA]]),
      singleSignalsById,
    );
    const hypothesis = admitted[0]!;

    expect(() =>
      applyCalibration(hypothesis, "promote", "should fail", "user", undefined, {
        evidenceById: singleEvidenceById,
        chunksById: new Map([[chunkA.id, chunkA]]),
        signalsById: singleSignalsById,
      }),
    ).toThrow(InvariantViolation);
  });
});
