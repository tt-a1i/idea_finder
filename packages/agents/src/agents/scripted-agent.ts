import type {
  AgentConnector,
  AgentKind,
  AgentRequest,
  AgentResult,
} from "../types/agent-contract.js";

export type AgentScript = (
  request: AgentRequest,
) => AgentResult | Promise<AgentResult>;

/** Test double that runs a provided script per invocation. */
export class ScriptedAgent implements AgentConnector {
  constructor(
    readonly kind: AgentKind,
    readonly name: string,
    private readonly script: AgentScript,
  ) {}

  invoke(request: AgentRequest): Promise<AgentResult> {
    return Promise.resolve(this.script(request));
  }
}
