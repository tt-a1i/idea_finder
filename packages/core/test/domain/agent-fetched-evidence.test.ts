import { describe, expect, it } from "vitest";
import {
  asId,
  assertAgentFetchedEvidence,
  classifyFetchProvenance,
  toAgentFetchedRawDocument,
} from "../../src/index.js";

describe("agent-fetched evidence domain", () => {
  const valid = {
    sourceType: "web_article",
    canonicalUrl: "https://example.com/post/1",
    title: "Real post",
    author: "alice",
    retrievedAt: "2026-07-12T00:00:00.000Z",
    verbatimQuote: "This workaround is painful every Monday.",
    rawSnapshot: "Intro.\nThis workaround is painful every Monday.\nOutro.",
    queryId: "q_1",
    collectionMethod: "browser_open_and_read",
    externalId: "post-1",
    huntingTaskId: asId("task_demo"),
  };

  it("rejects missing URL, source, retrieval time, or unlocatable quote", () => {
    expect(() => assertAgentFetchedEvidence({ ...valid, canonicalUrl: "" })).toThrow(/url/i);
    expect(() => assertAgentFetchedEvidence({ ...valid, sourceType: "" })).toThrow(/source/i);
    expect(() => assertAgentFetchedEvidence({ ...valid, retrievedAt: "" })).toThrow(/retrieved/i);
    expect(() => assertAgentFetchedEvidence({ ...valid, rawSnapshot: "no quote here", replayRef: undefined })).toThrow(/locatable|snapshot/i);
  });

  it("builds agent_fetched documents distinct from manual and fixture provenance", () => {
    const document = toAgentFetchedRawDocument(valid);
    expect(document.fetchMethod).toBe("agent_fetched");
    expect(classifyFetchProvenance("agent_fetched")).toBe("agent_fetched");
    expect(classifyFetchProvenance("import")).toBe("manual");
    expect(classifyFetchProvenance("fixture")).toBe("fixture");
  });
});
