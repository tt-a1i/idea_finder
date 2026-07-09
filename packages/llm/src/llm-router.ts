import {
  BudgetExceededError,
  LLMProviderError,
  OfflineModeError,
  StructuredValidationError,
} from "./errors.js";
import type { LLMAuditHook } from "./ports/audit-hook.js";
import type { LLMCache } from "./ports/llm-cache.js";
import type {
  CompletionRequest,
  CompletionResponse,
  EmbedRequest,
  EmbedResponse,
  LLMProvider,
  LLMRouter,
  RouteRule,
} from "./ports/llm-provider.js";
import { parseJsonText, validateStructuredResponse } from "./validation.js";

export interface LLMRouterOptions {
  readonly providers: readonly LLMProvider[];
  readonly routes: readonly RouteRule[];
  readonly offline?: boolean;
  readonly cache?: LLMCache;
  readonly audit?: LLMAuditHook;
  readonly defaultEstimatedCostUsd?: number;
}

export function createLLMRouter(options: LLMRouterOptions): LLMRouter {
  const providerByName = new Map(options.providers.map((provider) => [provider.name, provider]));
  const routeByTask = new Map(options.routes.map((route) => [route.taskType, route]));
  const offline = options.offline ?? false;
  const cache = options.cache;
  const audit = options.audit;
  const defaultEstimatedCostUsd = options.defaultEstimatedCostUsd ?? 0.01;

  return {
    complete: (request) => executeComplete(request),
    embed: (request) => executeEmbed(request),
  };

  async function executeComplete(request: CompletionRequest): Promise<CompletionResponse> {
    if (request.cacheKey && cache) {
      const cached = await cache.get<CompletionResponse>(completionCacheKey(request.cacheKey));
      if (cached) {
        await auditCall("complete", request, cached.provider, cached.model, {
          cacheHit: true,
          estimatedCostUsd: 0,
        });
        return { ...cached, cacheHit: true };
      }
    }

    assertBudget(request.budgetCeilingUsd, defaultEstimatedCostUsd, request.taskType);

    const route = resolveRoute(request.taskType);
    const response = await callWithFallback(
      route,
      (provider, model) => provider.complete({ ...request, model: request.model ?? model }),
    );

    const validated = validateCompletionResponse(request, response);
    const finalResponse = { ...validated, cacheHit: false };

    if (request.cacheKey && cache) {
      await cache.set(completionCacheKey(request.cacheKey), finalResponse);
    }

    await auditCall("complete", request, finalResponse.provider, finalResponse.model, {
      cacheHit: false,
      estimatedCostUsd: finalResponse.estimatedCostUsd,
    });

    return finalResponse;
  }

  async function executeEmbed(request: EmbedRequest): Promise<EmbedResponse> {
    if (request.cacheKey && cache) {
      const cached = await cache.get<EmbedResponse>(embedCacheKey(request.cacheKey));
      if (cached) {
        await auditCall("embed", request, cached.provider, cached.model, {
          cacheHit: true,
          estimatedCostUsd: 0,
        });
        return { ...cached, cacheHit: true };
      }
    }

    assertBudget(request.budgetCeilingUsd, defaultEstimatedCostUsd, request.taskType);

    const route = resolveRoute("embed");
    const response = await callWithFallback(
      route,
      (provider, model) => {
        if (!provider.embed) {
          throw new LLMProviderError(provider.name, "embed not supported");
        }
        return provider.embed({ ...request, model: request.model ?? model });
      },
    );

    const finalResponse = { ...response, cacheHit: false };

    if (request.cacheKey && cache) {
      await cache.set(embedCacheKey(request.cacheKey), finalResponse);
    }

    await auditCall("embed", request, finalResponse.provider, finalResponse.model, {
      cacheHit: false,
      estimatedCostUsd: finalResponse.estimatedCostUsd,
    });

    return finalResponse;
  }

  function resolveRoute(taskType: RouteRule["taskType"]): RouteRule {
    const route = routeByTask.get(taskType);
    if (!route) {
      throw new Error(`No LLM route configured for taskType: ${taskType}`);
    }
    return route;
  }

  async function callWithFallback<T>(
    route: RouteRule,
    invoke: (provider: LLMProvider, model?: string) => Promise<T>,
  ): Promise<T> {
    const chain = [route.providerName, ...(route.fallbackProviderNames ?? [])];
    let lastError: unknown;

    for (const providerName of chain) {
      const provider = providerByName.get(providerName);
      if (!provider) {
        lastError = new Error(`Unknown provider: ${providerName}`);
        continue;
      }

      if (offline && !provider.offlineCapable) {
        lastError = new OfflineModeError(provider.name);
        continue;
      }

      try {
        return await invoke(provider, route.model);
      } catch (error) {
        lastError = error;
      }
    }

    if (lastError instanceof Error) {
      throw lastError;
    }
    throw new LLMProviderError(route.providerName, "all providers in route failed", lastError);
  }

  function assertBudget(
    ceilingUsd: number | undefined,
    estimatedUsd: number,
    taskType: string,
  ): void {
    if (ceilingUsd === undefined) {
      return;
    }
    if (estimatedUsd > ceilingUsd) {
      void audit?.append({
        at: new Date().toISOString(),
        actor: "llm-router",
        action: "policy.denied",
        resource: taskType,
        payload: { reason: "budget_ceiling", ceilingUsd, estimatedUsd },
      });
      throw new BudgetExceededError(ceilingUsd, estimatedUsd);
    }
  }

  async function auditCall(
    kind: "complete" | "embed",
    request: CompletionRequest | EmbedRequest,
    provider: string,
    model: string,
    details: { cacheHit: boolean; estimatedCostUsd: number },
  ): Promise<void> {
    if (!audit) {
      return;
    }

    await audit.append({
      at: new Date().toISOString(),
      actor: "llm-router",
      action: "llm.call",
      resource: request.taskType,
      payload: {
        kind,
        provider,
        model,
        cacheKey: request.cacheKey ?? null,
        cacheHit: details.cacheHit,
        estimatedCostUsd: details.estimatedCostUsd,
        responseSchemaId:
          "responseSchemaId" in request ? request.responseSchemaId ?? null : null,
      },
    });
  }
}

function validateCompletionResponse(
  request: CompletionRequest,
  response: CompletionResponse,
): CompletionResponse {
  if (request.responseFormat !== "json") {
    return response;
  }

  const parsed =
    response.parsed ??
    (() => {
      const result = parseJsonText(response.text);
      if (!result.ok) {
        throw new StructuredValidationError([`invalid JSON: ${result.error}`], response.text);
      }
      return result.value;
    })();

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new StructuredValidationError(["expected JSON object"], response.text);
  }

  if (request.responseSchema) {
    const validation = validateStructuredResponse(parsed, request.responseSchema);
    if (!validation.ok) {
      throw new StructuredValidationError(validation.errors, response.text);
    }
  }

  return { ...response, parsed: parsed as Record<string, unknown> };
}

function completionCacheKey(key: string): string {
  return `complete:${key}`;
}

function embedCacheKey(key: string): string {
  return `embed:${key}`;
}
