import { describe, expect, it } from "vitest";

import { admitToLibrary, asId } from "@idea-finder/core";

import {
  createInMemoryIntelligenceStores,
  createIntelligencePipeline,
} from "../src/index.js";

const runId = asId("run_intel_unit");
const taskId = asId("task_intel");

describe("intelligence pipeline (rule_v1)", () => {
  it("creates evidence and drafts from run-scoped signals", async () => {
    const stores = createInMemoryIntelligenceStores();
    const chunk = {
      id: asId("chk_1"),
      documentId: asId("doc_1"),
      text: "I hate this workaround. I would pay for an alternative tool.",
      spanStart: 0,
      spanEnd: 58,
    };
    const document = {
      id: chunk.documentId,
      sourceTier: "L0" as const,
      platform: "manual",
      externalId: "ext1",
      url: "https://example.com/1",
      fetchedAt: "2026-07-09T00:00:00.000Z",
      fetchMethod: "import" as const,
      fetchAgentRunId: null,
      contentType: "page" as const,
      rawBody: chunk.text,
      huntingTaskId: taskId,
      retentionClass: "standard" as const,
      legalBasis: "user_provided" as const,
    };

    const baseSignal = {
      chunkId: chunk.id,
      documentId: chunk.documentId,
      quoteHash: "hash",
      spanStart: 0,
      spanEnd: 10,
      confidenceRule: 0.8,
      detector: "rule_v1" as const,
      detectorVersion: "rule_v1.0.0",
      extractedAt: "2026-07-09T00:00:00.000Z",
    };

    const chunkDisconfirm = {
      id: asId("chk_2"),
      documentId: asId("doc_2"),
      text: "QuickBooks works fine for me at this scale.",
      spanStart: 0,
      spanEnd: 43,
    };
    const document2 = {
      id: chunkDisconfirm.documentId,
      sourceTier: "L0" as const,
      platform: "hn",
      externalId: "ext2",
      url: "https://example.com/2",
      fetchedAt: "2026-07-09T00:00:00.000Z",
      fetchMethod: "api" as const,
      fetchAgentRunId: null,
      contentType: "post" as const,
      rawBody: chunkDisconfirm.text,
      huntingTaskId: taskId,
      retentionClass: "standard" as const,
      legalBasis: "public_api_tos" as const,
    };

    const signals = [
      {
        ...baseSignal,
        id: asId("sig_pain"),
        signalType: "pain" as const,
        signalSubtype: "keyword_pain",
        quoteVerbatim: "hate",
        spanStart: 2,
        spanEnd: 6,
      },
      {
        ...baseSignal,
        id: asId("sig_workaround"),
        signalType: "workaround" as const,
        signalSubtype: "keyword_workaround",
        quoteVerbatim: "workaround",
        spanStart: 12,
        spanEnd: 22,
      },
      {
        ...baseSignal,
        id: asId("sig_wtp"),
        signalType: "willingness_to_pay" as const,
        signalSubtype: "keyword_wtp",
        quoteVerbatim: "would pay",
        spanStart: 26,
        spanEnd: 35,
      },
      {
        ...baseSignal,
        id: asId("sig_disconfirm"),
        chunkId: chunkDisconfirm.id,
        documentId: chunkDisconfirm.documentId,
        signalType: "validation_negative" as const,
        signalSubtype: "keyword_validation_negative",
        quoteVerbatim: "works fine",
        spanStart: 12,
        spanEnd: 22,
      },
    ];

    stores.documents.save(runId, document);
    stores.documents.save(runId, document2);
    stores.chunks.save(runId, chunk);
    stores.chunks.save(runId, chunkDisconfirm);
    for (const signal of signals) {
      stores.signals.save(runId, signal);
    }

    const pipeline = createIntelligencePipeline(stores);
    const result = await pipeline.run(runId, { queryTerms: ["invoicing"] });

    expect(result.evidence.length).toBeGreaterThanOrEqual(3);
    expect(result.drafts.length).toBeGreaterThanOrEqual(1);

    const evidenceById = new Map(result.evidence.map((item) => [item.id, item]));
    const chunksById = new Map([
      [chunk.id, chunk],
      [chunkDisconfirm.id, chunkDisconfirm],
    ]);
    const signalsById = new Map(signals.map((signal) => [signal.id, signal]));

    const { admitted, rejected } = admitToLibrary(
      result.drafts,
      evidenceById,
      chunksById,
      signalsById,
    );

    expect(rejected.length).toBeGreaterThan(0);
    expect(admitted.length).toBeGreaterThanOrEqual(1);
    expect(admitted[0]?.status).toBe("hypothesis");
    expect(admitted[0]?.evidenceItemIds.length).toBeGreaterThanOrEqual(3);
  });
});
