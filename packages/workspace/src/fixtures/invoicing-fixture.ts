import { asId } from "@idea-finder/core";
import type {
  Chunk,
  EvidenceItem,
  OpportunityDraft,
  RawSignal,
} from "@idea-finder/core";

const chunkA: Chunk = {
  id: asId("chunk-a"),
  documentId: asId("doc-a"),
  text: "I spend hours every month reconciling Stripe payouts with invoices in a Google Sheet",
  spanStart: 0,
  spanEnd: 72,
};

const chunkB: Chunk = {
  id: asId("chunk-b"),
  documentId: asId("doc-b"),
  text: "Wave is fine but Stripe sync is flaky — I built a Zapier hack",
  spanStart: 0,
  spanEnd: 55,
};

const chunkC: Chunk = {
  id: asId("chunk-c"),
  documentId: asId("doc-c"),
  text: "Would pay $30/mo for something that just invoices from Stripe events",
  spanStart: 0,
  spanEnd: 58,
};

const chunkDisconfirm: Chunk = {
  id: asId("chunk-disconfirm"),
  documentId: asId("doc-d"),
  text: "QuickBooks works fine for me",
  spanStart: 0,
  spanEnd: 28,
};

const signalA: RawSignal = {
  id: asId("signal-a"),
  chunkId: chunkA.id,
  documentId: chunkA.documentId,
  signalType: "pain",
  signalSubtype: "manual_reconciliation",
  quoteVerbatim: "reconciling Stripe payouts with invoices in a Google Sheet",
  quoteHash: "hash-a",
  spanStart: 28,
  spanEnd: 72,
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
  signalType: "workaround",
  signalSubtype: "zapier_hack",
  quoteVerbatim: "Stripe sync is flaky — I built a Zapier hack",
  spanStart: 18,
  spanEnd: 55,
};

const signalC: RawSignal = {
  ...signalA,
  id: asId("signal-c"),
  chunkId: chunkC.id,
  documentId: chunkC.documentId,
  signalType: "willingness_to_pay",
  signalSubtype: "price_anchor",
  quoteVerbatim: "Would pay $30/mo for something that just invoices from Stripe events",
  spanStart: 0,
  spanEnd: 58,
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

const eA = evidence("e-a", chunkA, signalA, "doc-a");
const eB = evidence("e-b", chunkB, signalB, "doc-b");
const eC = evidence("e-c", chunkC, signalC, "doc-c");

export const invoicingFixture = {
  chunks: [chunkA, chunkB, chunkC, chunkDisconfirm] as const,
  signals: [signalA, signalB, signalC, disconfirmingSignal] as const,
  evidence: [eA, eB, eC] as const,
  drafts: [
    {
      id: asId("draft-valid"),
      clusterId: asId("cluster-invoicing"),
      demandStatement: "Solo SaaS needs lightweight invoicing with Stripe sync",
      persona: "solo founder",
      scenario: "month-end invoicing",
      evidenceItemIds: [eA.id, eB.id, eC.id],
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
      llmModel: "fixture",
      promptVersion: "v1",
      provenance: { createdBy: "pipeline" },
    },
    {
      id: asId("draft-thin"),
      clusterId: asId("cluster-invoicing"),
      demandStatement: "Solo SaaS needs lightweight invoicing with Stripe sync",
      persona: "solo founder",
      scenario: "month-end invoicing",
      evidenceItemIds: [eA.id, eB.id],
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
      llmModel: "fixture",
      promptVersion: "v1",
      provenance: { createdBy: "pipeline" },
    },
  ] satisfies readonly OpportunityDraft[],
};
