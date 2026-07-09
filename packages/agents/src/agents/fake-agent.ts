import type {
  AgentConnector,
  AgentKind,
  AgentRequest,
  AgentResult,
} from "../types/agent-contract.js";

export interface FakeAgentOptions {
  readonly kind: AgentKind;
  readonly name?: string;
  readonly result?: Partial<AgentResult>;
}

/** Canned agent for tests — respects dryRun without side effects. */
export class FakeAgent implements AgentConnector {
  readonly kind: AgentKind;
  readonly name: string;
  private readonly result: Partial<AgentResult>;

  constructor(options: FakeAgentOptions) {
    this.kind = options.kind;
    this.name = options.name ?? `fake-${options.kind}`;
    this.result = options.result ?? {};
  }

  async invoke(request: AgentRequest): Promise<AgentResult> {
    if (request.scope.dryRun) {
      return {
        invocationId: request.invocationId,
        status: "succeeded",
        artifacts: [],
        dryRun: true,
        structured: {
          simulated: true,
          plannedEffects: request.plannedEffects,
          ...(this.result.structured ?? {}),
        },
      };
    }

    return {
      invocationId: request.invocationId,
      status: this.result.status ?? "succeeded",
      artifacts: this.result.artifacts ?? [],
      structured: this.result.structured,
      dryRun: false,
    };
  }
}
