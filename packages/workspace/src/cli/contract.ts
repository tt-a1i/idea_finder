export const CLI_CONTRACT_VERSION = "1.0" as const;

export const CLI_EXIT_CODES = {
  success: 0,
  usage: 2,
  validation: 3,
  missingResource: 4,
  policy: 5,
  partialResult: 6,
  internal: 7,
} as const;

export type CliErrorCategory =
  | "usage"
  | "validation"
  | "missing-resource"
  | "policy"
  | "partial-result"
  | "internal";

export interface CliStructuredError {
  readonly category: CliErrorCategory;
  readonly code: string;
  readonly message: string;
  readonly details: Readonly<Record<string, unknown>> | null;
}

export interface CliIncompleteness {
  readonly incomplete: boolean;
  readonly reasons: readonly string[];
}

export interface CliMachineEnvelope {
  readonly contractVersion: typeof CLI_CONTRACT_VERSION;
  readonly command: string;
  readonly status: "success" | "partial" | "error";
  readonly data: unknown;
  readonly warnings: readonly string[];
  readonly incompleteness: CliIncompleteness;
  readonly errors: readonly CliStructuredError[];
}

export class CliFailure extends Error {
  constructor(
    readonly category: CliErrorCategory,
    readonly code: string,
    message: string,
    readonly exitCode: number,
    readonly details: Readonly<Record<string, unknown>> | null = null,
  ) {
    super(message);
    this.name = "CliFailure";
  }
}
