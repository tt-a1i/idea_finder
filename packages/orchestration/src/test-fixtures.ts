import type {
  Chunk,
  EvidenceItem,
  HuntingTaskId,
  OpportunityDraft,
  RawDocument,
  RawSignal,
  ResearchRunId,
} from "@idea-finder/core";
import { asId } from "@idea-finder/core";
import type { QueryPlan } from "@idea-finder/connectors";
import type { HarvestPipeline, HarvestResult } from "@idea-finder/harvest";
import type { LocalStorage } from "@idea-finder/storage";

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
  disconfirmingSignalIds: [],
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

function rawDocument(id: string): RawDocument {
  return {
    id: asId(id),
    sourceTier: "L1",
    platform: "hn",
    externalId: null,
    url: `https://example.com/${id}`,
    fetchedAt: "2026-07-09T00:00:00.000Z",
    fetchMethod: "api",
    fetchAgentRunId: null,
    contentType: "post",
    rawBody: "content",
    huntingTaskId: asId("task-fixture"),
    retentionClass: "standard",
    legalBasis: "public_api_tos",
  };
}

/** Minimal query plan for orchestration tests (no live connector calls). */
export function testQueryPlan(huntingTaskId: HuntingTaskId = asId("task-fixture")): QueryPlan {
  return { huntingTaskId, searches: [] };
}

/** Test harvest stage: writes normalized harvest output into storage. */
export function createFixtureHarvest(storage: LocalStorage): HarvestPipeline {
  return {
    async runHarvest(runId, _plan): Promise<HarvestResult> {
      storage.rawDocuments.save(runId, rawDocument("doc-a"));
      storage.rawDocuments.save(runId, rawDocument("doc-b"));
      storage.rawDocuments.save(runId, rawDocument("doc-c"));
      storage.chunks.save(runId, chunkA);
      storage.chunks.save(runId, chunkB);
      storage.chunks.save(runId, chunkC);
      storage.rawSignals.save(runId, signalA);
      storage.rawSignals.save(runId, signalB);
      storage.rawSignals.save(runId, signalC);
      return {
        documents: [
          rawDocument("doc-a"),
          rawDocument("doc-b"),
          rawDocument("doc-c"),
        ],
        chunks: [chunkA, chunkB, chunkC],
        signals: [signalA, signalB, signalC],
        sourceExecutions: [],
      };
    },
  };
}

/** Test intelligence stage: writes drafts and evidence into storage. */
export function createFixtureIntelligence(storage: LocalStorage) {
  return {
    async run(runId: ResearchRunId): Promise<void> {
      storage.evidenceItems.save(runId, evidence("e-a", chunkA, signalA, "doc-a"));
      storage.evidenceItems.save(runId, evidence("e-b", chunkB, signalB, "doc-b"));
      storage.evidenceItems.save(runId, evidence("e-c", chunkC, signalC, "doc-c"));
      storage.opportunityDrafts.save(runId, validDraft);
    },
  };
}
