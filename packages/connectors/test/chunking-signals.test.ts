import { describe, expect, it } from "vitest";

import { asId } from "@idea-finder/core";

import { chunkDocument } from "../src/lib/chunking.js";
import { normalizeDocument } from "../src/lib/normalize.js";
import { detectSignals, SIGNAL_RULES_V1 } from "../src/lib/signal-detector.js";

const taskId = asId("task_chunk");

describe("chunking", () => {
  it("splits paragraphs and preserves span offsets", () => {
    const doc = normalizeDocument({
      platform: "manual",
      externalId: "1",
      url: "manual://1",
      rawBody: "First paragraph.\n\nSecond paragraph with more text.",
      contentType: "page",
      huntingTaskId: taskId,
      fetchMethod: "import",
      legalBasis: "user_provided",
    });
    const chunks = chunkDocument(doc);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.spanStart).toBe(0);
    expect(doc.rawBody.slice(chunks[1]!.spanStart, chunks[1]!.spanEnd)).toBe(chunks[1]!.text);
  });
});

describe("signal detector rule_v1", () => {
  const signalTypes = new Set(SIGNAL_RULES_V1.map((r) => r.signalType));

  it("covers required signal types", () => {
    for (const type of [
      "pain",
      "workaround",
      "alternative_seek",
      "willingness_to_pay",
      "competitor_dissatisfaction",
      "feature_request",
      "validation_negative",
      "noise",
    ] as const) {
      expect(signalTypes.has(type)).toBe(true);
    }
  });

  it("extracts quote spans that are substrings of chunk text", () => {
    const doc = normalizeDocument({
      platform: "manual",
      externalId: "sig",
      url: "manual://sig",
      rawBody: "I hate this workaround. I would pay for an alternative tool.",
      contentType: "page",
      huntingTaskId: taskId,
      fetchMethod: "import",
      legalBasis: "user_provided",
    });
    const chunks = chunkDocument(doc);
    const signals = detectSignals(chunks, doc, { extractedAt: "2024-01-01T00:00:00.000Z" });
    expect(signals.length).toBeGreaterThan(0);
    for (const signal of signals) {
      const chunk = chunks.find((c) => c.id === signal.chunkId)!;
      expect(chunk.text.slice(
        signal.spanStart - chunk.spanStart,
        signal.spanEnd - chunk.spanStart,
      )).toBe(signal.quoteVerbatim);
      expect(signal.detector).toBe("rule_v1");
    }
    const types = new Set(signals.map((s) => s.signalType));
    expect(types.has("pain")).toBe(true);
    expect(types.has("workaround")).toBe(true);
    expect(types.has("willingness_to_pay")).toBe(true);
    expect(types.has("alternative_seek")).toBe(true);
  });
});
