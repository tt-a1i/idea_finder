export type LLMTaskType =
  | "extract"
  | "classify"
  | "summarize"
  | "narrate"
  | "embed";

export type ResponseFormat = "text" | "json";

export interface ChatMessage {
  readonly role: string;
  readonly content: string;
}

export interface TokenUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
}

export interface JsonSchemaDescriptor {
  readonly type?: string;
  readonly required?: readonly string[];
  readonly properties?: Readonly<Record<string, JsonSchemaDescriptor>>;
  readonly items?: JsonSchemaDescriptor;
}

export interface CompletionRequest {
  readonly taskType: Exclude<LLMTaskType, "embed">;
  readonly messages: readonly ChatMessage[];
  readonly model?: string;
  readonly responseFormat?: ResponseFormat;
  readonly responseSchema?: JsonSchemaDescriptor;
  readonly responseSchemaId?: string;
  readonly cacheKey?: string;
  readonly budgetCeilingUsd?: number;
}

export interface EmbedRequest {
  readonly taskType: "embed";
  readonly input: string | readonly string[];
  readonly model?: string;
  readonly cacheKey?: string;
  readonly budgetCeilingUsd?: number;
}

export interface CompletionResponse {
  readonly text: string;
  readonly parsed?: Record<string, unknown>;
  readonly usage: TokenUsage;
  readonly provider: string;
  readonly model: string;
  readonly estimatedCostUsd: number;
  readonly cacheHit?: boolean;
}

export interface EmbedResponse {
  readonly embeddings: readonly (readonly number[])[];
  readonly usage: TokenUsage;
  readonly provider: string;
  readonly model: string;
  readonly estimatedCostUsd: number;
  readonly cacheHit?: boolean;
}

/** Provider adapter port — OpenAI/Anthropic/Ollama/OpenRouter implement later. */
export interface LLMProvider {
  readonly name: string;
  readonly offlineCapable?: boolean;
  complete(request: CompletionRequest): Promise<CompletionResponse>;
  embed?(request: EmbedRequest): Promise<EmbedResponse>;
}

export interface RouteRule {
  readonly taskType: LLMTaskType;
  readonly providerName: string;
  readonly model?: string;
  readonly fallbackProviderNames?: readonly string[];
}

export interface LLMRouter {
  complete(request: CompletionRequest): Promise<CompletionResponse>;
  embed(request: EmbedRequest): Promise<EmbedResponse>;
}
