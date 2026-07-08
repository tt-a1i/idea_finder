export type LLMTaskType =
  | "extract"
  | "classify"
  | "summarize"
  | "narrate"
  | "embed";

export interface TokenUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
}

export interface CompletionRequest {
  readonly taskType: LLMTaskType;
  readonly messages: readonly { role: string; content: string }[];
  readonly model?: string;
  readonly responseSchemaId?: string;
  readonly cacheKey?: string;
}

export interface CompletionResponse {
  readonly text: string;
  readonly parsed?: Record<string, unknown>;
  readonly usage: TokenUsage;
  readonly provider: string;
  readonly model: string;
}

export interface LLMProvider {
  readonly name: string;
  complete(request: CompletionRequest): Promise<CompletionResponse>;
}
