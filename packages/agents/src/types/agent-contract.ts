/** Agent connector contracts — request/result schemas for safe invocation. */

export type AgentKind = "research" | "browser" | "computer" | "coding";

export type AgentInvocationStatus = "succeeded" | "failed" | "blocked" | "partial";

export type DomainEntity = "Opportunity" | "EvidenceItem" | "CalibrationEvent";

export type DomainWriteAction = "create" | "update" | "delete";

export type PlannedEffectKind = "read_path" | "write_path" | "fetch_url" | "domain_write";

export interface AgentInputRef {
  readonly kind: "document" | "evidence" | "chunk" | "url" | "file";
  readonly ref: string;
}

export interface AgentBudgets {
  readonly maxCostUsd: number;
  readonly maxRequests: number;
  readonly maxDurationMs: number;
}

/** Execution scope — fail-closed defaults (empty allowlists, dryRun off). */
export interface AgentScope {
  readonly writablePaths: readonly string[];
  readonly readablePaths: readonly string[];
  readonly allowNetwork: boolean;
  readonly urlAllowlist: readonly string[];
  readonly dryRun: boolean;
  readonly budgets: AgentBudgets;
}

export interface AgentPlannedEffect {
  readonly kind: PlannedEffectKind;
  readonly target: string;
  readonly domainEntity?: DomainEntity;
  readonly action?: DomainWriteAction;
}

export interface AgentRequest {
  readonly invocationId: string;
  readonly kind: AgentKind;
  readonly intent: string;
  readonly scope: AgentScope;
  readonly inputRefs: readonly AgentInputRef[];
  readonly plannedEffects: readonly AgentPlannedEffect[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface AgentArtifactRef {
  readonly kind: string;
  readonly path: string;
  readonly contentType?: string;
}

export interface PolicyDenial {
  readonly code: string;
  readonly reason: string;
}

export interface AgentResult {
  readonly invocationId: string;
  readonly status: AgentInvocationStatus;
  readonly artifacts: readonly AgentArtifactRef[];
  readonly structured?: Readonly<Record<string, unknown>>;
  readonly policyDenials?: readonly PolicyDenial[];
  readonly dryRun?: boolean;
}

export interface AgentConnector {
  readonly kind: AgentKind;
  readonly name: string;
  invoke(request: AgentRequest): Promise<AgentResult>;
}
