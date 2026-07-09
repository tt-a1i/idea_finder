import { describe, expect, it } from "vitest";

import { InMemoryLLMCache } from "./cache/in-memory-llm-cache.js";
import {
  BudgetExceededError,
  StructuredValidationError,
} from "./errors.js";
import { createLLMRouter } from "./llm-router.js";
import type { LLMAuditEvent } from "./ports/audit-hook.js";
import type { CompletionRequest, EmbedRequest } from "./ports/llm-provider.js";
import { FakeLLMProvider } from "./providers/fake-llm-provider.js";

const extractRequest = (
  overrides: Partial<CompletionRequest> = {},
): CompletionRequest => ({
  taskType: "extract",
  messages: [{ role: "user", content: "extract demand signals" }],
  ...overrides,
});

const embedRequest = (overrides: Partial<EmbedRequest> = {}): EmbedRequest => ({
  taskType: "embed",
  input: "hello world",
  ...overrides,
});

describe("@idea-finder/llm", () => {
  it("routes complete calls by taskType to configured provider", async () => {
    const primary = new FakeLLMProvider({ name: "primary" });
    const other = new FakeLLMProvider({ name: "other" });

    const router = createLLMRouter({
      providers: [primary, other],
      routes: [
        { taskType: "extract", providerName: "primary" },
        { taskType: "summarize", providerName: "other" },
      ],
    });

    await router.complete(extractRequest());
    await router.complete(extractRequest({ taskType: "summarize" }));

    expect(primary.completeCalls).toBe(1);
    expect(other.completeCalls).toBe(1);
  });

  it("routes embed calls to the embed provider", async () => {
    const embedder = new FakeLLMProvider({ name: "embedder" });
    const router = createLLMRouter({
      providers: [embedder],
      routes: [{ taskType: "embed", providerName: "embedder" }],
    });

    const response = await router.embed(embedRequest());
    expect(embedder.embedCalls).toBe(1);
    expect(response.embeddings).toHaveLength(1);
    expect(response.provider).toBe("embedder");
  });

  it("falls back when the primary provider fails", async () => {
    const primary = new FakeLLMProvider({ name: "primary", failOnComplete: true });
    const fallback = new FakeLLMProvider({ name: "fallback" });

    const router = createLLMRouter({
      providers: [primary, fallback],
      routes: [
        {
          taskType: "extract",
          providerName: "primary",
          fallbackProviderNames: ["fallback"],
        },
      ],
    });

    const response = await router.complete(extractRequest());
    expect(primary.completeCalls).toBe(1);
    expect(fallback.completeCalls).toBe(1);
    expect(response.provider).toBe("fallback");
  });

  it("returns cached complete responses without calling the provider again", async () => {
    const provider = new FakeLLMProvider({ name: "fake" });
    const cache = new InMemoryLLMCache();
    const router = createLLMRouter({
      providers: [provider],
      routes: [{ taskType: "extract", providerName: "fake" }],
      cache,
    });

    const request = extractRequest({ cacheKey: "extract:v1" });
    const first = await router.complete(request);
    const second = await router.complete(request);

    expect(provider.completeCalls).toBe(1);
    expect(second.cacheHit).toBe(true);
    expect(second.text).toBe(first.text);
    expect(cache.size()).toBe(1);
  });

  it("denies calls that exceed budgetCeilingUsd", async () => {
    const provider = new FakeLLMProvider({ name: "fake", costPerTokenUsd: 1 });
    const auditEvents: LLMAuditEvent[] = [];
    const router = createLLMRouter({
      providers: [provider],
      routes: [{ taskType: "extract", providerName: "fake" }],
      defaultEstimatedCostUsd: 5,
      audit: {
        append: async (event) => {
          auditEvents.push(event);
        },
      },
    });

    await expect(
      router.complete(extractRequest({ budgetCeilingUsd: 0.001 })),
    ).rejects.toBeInstanceOf(BudgetExceededError);

    expect(provider.completeCalls).toBe(0);
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]?.action).toBe("policy.denied");
  });

  it("rejects structured JSON that fails schema validation", async () => {
    const provider = new FakeLLMProvider({
      name: "fake",
      completeHandler: () => ({
        text: JSON.stringify({ label: 123 }),
        usage: { promptTokens: 1, completionTokens: 1 },
        provider: "fake",
        model: "fake-model-v1",
        estimatedCostUsd: 0.0001,
      }),
    });

    const router = createLLMRouter({
      providers: [provider],
      routes: [{ taskType: "extract", providerName: "fake" }],
    });

    await expect(
      router.complete(
        extractRequest({
          responseFormat: "json",
          responseSchema: {
            type: "object",
            required: ["label"],
            properties: { label: { type: "string" } },
          },
        }),
      ),
    ).rejects.toBeInstanceOf(StructuredValidationError);

    expect(provider.completeCalls).toBe(1);
  });

  it("uses offline-capable providers only when offline mode is enabled", async () => {
    const offlineProvider = new FakeLLMProvider({ name: "fake" });
    const onlineOnly: FakeLLMProvider & { offlineCapable: false } = Object.assign(
      new FakeLLMProvider({ name: "cloud" }),
      { offlineCapable: false as const },
    );

    const router = createLLMRouter({
      providers: [onlineOnly, offlineProvider],
      routes: [
        {
          taskType: "extract",
          providerName: "cloud",
          fallbackProviderNames: ["fake"],
        },
      ],
      offline: true,
    });

    const response = await router.complete(extractRequest());
    expect(onlineOnly.completeCalls).toBe(0);
    expect(offlineProvider.completeCalls).toBe(1);
    expect(response.provider).toBe("fake");
  });

  it("records llm.call audit events for successful calls", async () => {
    const provider = new FakeLLMProvider({ name: "fake" });
    const auditEvents: LLMAuditEvent[] = [];
    const router = createLLMRouter({
      providers: [provider],
      routes: [{ taskType: "extract", providerName: "fake" }],
      audit: {
        append: async (event) => {
          auditEvents.push(event);
        },
      },
    });

    await router.complete(extractRequest({ cacheKey: "audit-test" }));

    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]?.action).toBe("llm.call");
    expect(auditEvents[0]?.payload.cacheHit).toBe(false);
  });
});
