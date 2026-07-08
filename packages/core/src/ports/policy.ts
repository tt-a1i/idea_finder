/** Fail-closed authorization for agents and connectors. Implementation deferred. */
export interface TaskScope {
  readonly writablePaths: readonly string[];
  readonly readablePaths: readonly string[];
  readonly allowNetwork: boolean;
}

export interface PolicyDecision {
  readonly allowed: boolean;
  readonly reason?: string;
}

export interface PolicyEngine {
  evaluate(scope: TaskScope): PolicyDecision;
}
