import { describe, expect, it } from "vitest";
import { asId } from "@idea-finder/core";
import { chunkDocument } from "../src/lib/chunking.js";
import { detectSignals, SIGNAL_RULES_ALL_V1 } from "../src/lib/signal-detector.js";
import { normalizeDocument } from "../src/lib/normalize.js";

function doc(rawBody: string) {
  return normalizeDocument({
    platform: "v2ex",
    externalId: "1",
    url: "https://example.com/1",
    rawBody,
    contentType: "post",
    huntingTaskId: asId("task_x"),
    fetchMethod: "api",
    legalBasis: "public_api_tos",
  });
}

describe("bilingual demand signals", () => {
  it("detects Chinese pain, workaround, alternative, WTP, switch, feature, and contradiction", () => {
    const text = [
      "这个工具太难用了，我只能手动复制表格。",
      "有没有别的替代方案？我愿意付费。",
      "太贵了，我准备取消订阅。",
      "希望能增加批量导出。",
      "其实已经解决了，免费就有。",
    ].join("\n");
    const document = doc(text);
    const signals = detectSignals(chunkDocument(document), document, { rules: SIGNAL_RULES_ALL_V1 });
    const types = new Set(signals.map((signal) => signal.signalType));
    expect(types.has("pain")).toBe(true);
    expect(types.has("workaround")).toBe(true);
    expect(types.has("alternative_seek")).toBe(true);
    expect(types.has("willingness_to_pay")).toBe(true);
    expect(types.has("competitor_dissatisfaction")).toBe(true);
    expect(types.has("feature_request")).toBe(true);
    expect(types.has("validation_negative")).toBe(true);
    expect(signals.every((signal) => signal.detector === "rule_v1" && signal.detectorVersion)).toBe(true);
  });

  it("ignores negated and attributed complaints", () => {
    const document = doc("这并不难用。有人说太难用，但我自己觉得还好。不需要替代方案。");
    const signals = detectSignals(chunkDocument(document), document, { rules: SIGNAL_RULES_ALL_V1 });
    expect(signals.filter((signal) => signal.signalType === "pain")).toHaveLength(0);
    expect(signals.filter((signal) => signal.signalType === "alternative_seek")).toHaveLength(0);
  });

  it("keeps English rules working with negation guards", () => {
    const document = doc("It is not painful. Someone said it sucks, but I disagree. This workaround is painful.");
    const signals = detectSignals(chunkDocument(document), document);
    const pains = signals.filter((signal) => signal.signalType === "pain");
    expect(pains.some((signal) => signal.quoteVerbatim.includes("workaround is painful"))).toBe(true);
    expect(pains.every((signal) => !/not painful/i.test(signal.quoteVerbatim))).toBe(true);
  });
});
