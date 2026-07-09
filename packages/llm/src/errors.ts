export class BudgetExceededError extends Error {
  readonly code = "BUDGET_EXCEEDED" as const;

  constructor(
    readonly ceilingUsd: number,
    readonly estimatedUsd: number,
  ) {
    super(`LLM budget exceeded: estimated $${estimatedUsd} > ceiling $${ceilingUsd}`);
    this.name = "BudgetExceededError";
  }
}

export class StructuredValidationError extends Error {
  readonly code = "STRUCTURED_VALIDATION_FAILED" as const;

  constructor(
    readonly errors: readonly string[],
    readonly rawText: string,
  ) {
    super(`Structured response validation failed: ${errors.join("; ")}`);
    this.name = "StructuredValidationError";
  }
}

export class LLMProviderError extends Error {
  readonly code = "PROVIDER_ERROR" as const;

  constructor(
    readonly providerName: string,
    message: string,
    readonly cause?: unknown,
  ) {
    super(`LLM provider ${providerName} failed: ${message}`);
    this.name = "LLMProviderError";
  }
}

export class OfflineModeError extends Error {
  readonly code = "OFFLINE_MODE" as const;

  constructor(readonly providerName: string) {
    super(`Provider ${providerName} is not available in offline mode`);
    this.name = "OfflineModeError";
  }
}
