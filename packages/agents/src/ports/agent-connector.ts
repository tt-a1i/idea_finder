import type { TaskScope } from "@idea-finder/core";

export type AgentKind = "research" | "browser" | "computer" | "coding";

export type AgentInvocationStatus = "succeeded" | "failed" | "blocked" | "partial";

export interface AgentRequest {
  readonly invocationId: string;
  readonly kind: AgentKind;
  readonly intent: string;
  readonly scope: TaskScope;
  readonly input: Record<string, unknown>;
  readonly timeoutMs: number;
}

export interface AgentArtifactRef {
  readonly kind: string;
  readonly path: string;
}

export interface AgentResult {
  readonly status: AgentInvocationStatus;
  readonly artifacts: readonly AgentArtifactRef[];
  readonly structured?: Record<string, unknown>;
}

export interface AgentConnector {
  readonly kind: AgentKind;
  readonly name: string;
  invoke(request: AgentRequest): Promise<AgentResult>;
}
