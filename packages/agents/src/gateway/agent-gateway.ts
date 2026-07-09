import type { AgentConnector, AgentRequest, AgentResult } from "../types/agent-contract.js";
import type { PolicyEngine, PolicyEvaluation } from "../policy/policy-engine.js";
import { createPolicyEngine } from "../policy/policy-engine.js";

export interface InvocationRecord {
  readonly invocationId: string;
  readonly kind: AgentRequest["kind"];
  readonly intent: string;
  readonly dryRun: boolean;
  readonly requestedAt: string;
  readonly completedAt: string | null;
  readonly policy: PolicyEvaluation;
  readonly result: AgentResult | null;
}

export interface AgentGatewayOptions {
  readonly policy?: PolicyEngine;
  readonly clock?: () => string;
}

/**
 * Records invocation metadata and routes to connectors.
 * Never mutates domain objects (Opportunity, EvidenceItem, etc.).
 */
export class AgentGateway {
  private readonly policy: PolicyEngine;
  private readonly clock: () => string;
  private readonly records = new Map<string, InvocationRecord>();

  constructor(options: AgentGatewayOptions = {}) {
    this.policy = options.policy ?? createPolicyEngine();
    this.clock = options.clock ?? (() => new Date().toISOString());
  }

  getInvocation(invocationId: string): InvocationRecord | undefined {
    return this.records.get(invocationId);
  }

  listInvocations(): readonly InvocationRecord[] {
    return [...this.records.values()];
  }

  async invoke(
    request: AgentRequest,
    connector: AgentConnector,
  ): Promise<AgentResult> {
    const requestedAt = this.clock();
    const policy = this.policy.evaluate(request);

    if (!policy.allowed) {
      const blocked: AgentResult = {
        invocationId: request.invocationId,
        status: "blocked",
        artifacts: [],
        policyDenials: policy.denials,
        dryRun: request.scope.dryRun,
        structured: { blocked: true },
      };
      this.records.set(request.invocationId, {
        invocationId: request.invocationId,
        kind: request.kind,
        intent: request.intent,
        dryRun: request.scope.dryRun,
        requestedAt,
        completedAt: this.clock(),
        policy,
        result: blocked,
      });
      return blocked;
    }

    const result = await connector.invoke(request);
    const normalized: AgentResult = {
      ...result,
      invocationId: request.invocationId,
      dryRun: request.scope.dryRun,
    };

    this.records.set(request.invocationId, {
      invocationId: request.invocationId,
      kind: request.kind,
      intent: request.intent,
      dryRun: request.scope.dryRun,
      requestedAt,
      completedAt: this.clock(),
      policy,
      result: normalized,
    });

    return normalized;
  }
}
