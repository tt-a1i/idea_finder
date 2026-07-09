import type {
  CompletionRequest,
  CompletionResponse,
  EmbedRequest,
  EmbedResponse,
  LLMProvider,
} from "../ports/llm-provider.js";

export interface FakeCompletionHandler {
  (request: CompletionRequest): CompletionResponse | Promise<CompletionResponse>;
}

export interface FakeEmbedHandler {
  (request: EmbedRequest): EmbedResponse | Promise<EmbedResponse>;
}

export interface FakeLLMProviderOptions {
  readonly name?: string;
  readonly model?: string;
  readonly costPerTokenUsd?: number;
  readonly completeHandler?: FakeCompletionHandler;
  readonly embedHandler?: FakeEmbedHandler;
  readonly failOnComplete?: boolean;
  readonly failOnEmbed?: boolean;
}

const DEFAULT_COST_PER_TOKEN_USD = 0.000_002;

export class FakeLLMProvider implements LLMProvider {
  readonly name: string;
  readonly offlineCapable = true;
  readonly model: string;
  readonly costPerTokenUsd: number;

  completeCalls = 0;
  embedCalls = 0;

  private readonly completeHandler: FakeCompletionHandler;
  private readonly embedHandler: FakeEmbedHandler;
  private readonly failOnComplete: boolean;
  private readonly failOnEmbed: boolean;

  constructor(options: FakeLLMProviderOptions = {}) {
    this.name = options.name ?? "fake";
    this.model = options.model ?? "fake-model-v1";
    this.costPerTokenUsd = options.costPerTokenUsd ?? DEFAULT_COST_PER_TOKEN_USD;
    this.failOnComplete = options.failOnComplete ?? false;
    this.failOnEmbed = options.failOnEmbed ?? false;
    this.completeHandler =
      options.completeHandler ??
      ((request) => this.defaultComplete(request));
    this.embedHandler =
      options.embedHandler ?? ((request) => this.defaultEmbed(request));
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    this.completeCalls += 1;
    if (this.failOnComplete) {
      throw new Error(`${this.name} complete failed`);
    }
    const response = await this.completeHandler(request);
    return { ...response, provider: this.name, model: response.model ?? this.model };
  }

  async embed(request: EmbedRequest): Promise<EmbedResponse> {
    this.embedCalls += 1;
    if (this.failOnEmbed) {
      throw new Error(`${this.name} embed failed`);
    }
    const response = await this.embedHandler(request);
    return { ...response, provider: this.name, model: response.model ?? this.model };
  }

  private defaultComplete(request: CompletionRequest): CompletionResponse {
    const usage = {
      promptTokens: estimatePromptTokens(request),
      completionTokens: 16,
    };
    const text =
      request.responseFormat === "json"
        ? JSON.stringify({ label: "fake", taskType: request.taskType })
        : `fake completion for ${request.taskType}`;

    return {
      text,
      parsed: request.responseFormat === "json" ? (JSON.parse(text) as Record<string, unknown>) : undefined,
      usage,
      provider: this.name,
      model: this.model,
      estimatedCostUsd: estimateCost(usage, this.costPerTokenUsd),
    };
  }

  private defaultEmbed(request: EmbedRequest): EmbedResponse {
    const inputs = Array.isArray(request.input) ? request.input : [request.input];
    const usage = {
      promptTokens: inputs.join("").length,
      completionTokens: 0,
    };

    return {
      embeddings: inputs.map((value, index) => deterministicVector(value, index)),
      usage,
      provider: this.name,
      model: this.model,
      estimatedCostUsd: estimateCost(usage, this.costPerTokenUsd),
    };
  }
}

export function estimatePromptTokens(request: CompletionRequest): number {
  return request.messages.reduce((sum, message) => sum + message.content.length, 0);
}

export function estimateCost(
  usage: { promptTokens: number; completionTokens: number },
  costPerTokenUsd: number,
): number {
  return (usage.promptTokens + usage.completionTokens) * costPerTokenUsd;
}

function deterministicVector(input: string, seed: number): number[] {
  let hash = seed;
  for (const char of input) {
    hash = (hash * 31 + char.charCodeAt(0)) % 997;
  }
  return [hash / 997, (hash % 17) / 17, (hash % 23) / 23];
}
