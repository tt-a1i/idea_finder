import {
  AgentGateway,
  FakeAgent,
  type AgentKind,
  type AgentPlannedEffect,
  type AgentRequest,
  type AgentResult,
  type AgentScope,
  type InvocationRecord,
} from "@idea-finder/agents";
import type { AgentTask, AgentTaskInvocation, AgentTaskStatus } from "../types.js";

export function defaultAgentScope(dryRun: boolean): AgentScope {
  return {
    writablePaths: ["/workspace/out"],
    readablePaths: ["/workspace/in", "/workspace/out"],
    allowNetwork: false,
    urlAllowlist: ["https://news.ycombinator.com/*"],
    dryRun,
    budgets: {
      maxCostUsd: 0,
      maxRequests: 5,
      maxDurationMs: 60_000,
    },
  };
}

export function buildPlannedEffects(input: {
  readonly kind: AgentKind;
  readonly opportunityId?: string | null;
  readonly domainWrite?: boolean;
  readonly plannedEffects?: readonly AgentPlannedEffect[];
}): AgentPlannedEffect[] {
  if (input.plannedEffects?.length) {
    return [...input.plannedEffects];
  }
  if (input.domainWrite) {
    return [
      {
        kind: "domain_write",
        target: input.opportunityId ?? "opp_unknown",
        domainEntity: "Opportunity",
        action: "create",
      },
    ];
  }
  if (input.kind === "research") {
    return [{ kind: "read_path", target: "/workspace/in/evidence" }];
  }
  return [{ kind: "write_path", target: "/workspace/out/agent-output.txt" }];
}

export function buildAgentRequest(task: AgentTask): AgentRequest {
  return {
    invocationId: `inv_${task.id}_${task.invocations.length + 1}`,
    kind: task.kind,
    intent: task.intent,
    scope: defaultAgentScope(task.dryRun),
    inputRefs: task.evidenceIds.map((ref) => ({ kind: "evidence", ref })),
    plannedEffects: task.plannedEffects,
    metadata: {
      opportunityId: task.opportunityId,
      taskId: task.id,
    },
  };
}

export function statusFromResult(result: AgentResult): AgentTaskStatus {
  switch (result.status) {
    case "blocked":
      return "blocked";
    case "succeeded":
      return "succeeded";
    case "failed":
    case "partial":
      return "failed";
    default:
      return "failed";
  }
}

export function invocationFromRecord(record: InvocationRecord): AgentTaskInvocation {
  return {
    invocationId: record.invocationId,
    requestedAt: record.requestedAt,
    completedAt: record.completedAt,
    policyAllowed: record.policy.allowed,
    policyDenials: record.policy.denials,
    resultStatus: record.result?.status ?? null,
    dryRun: record.dryRun,
    structured: record.result?.structured,
  };
}

export class AgentTaskRunner {
  private readonly gateway = new AgentGateway();

  async runTask(task: AgentTask): Promise<{
    readonly task: AgentTask;
    readonly result: AgentResult;
    readonly invocation: AgentTaskInvocation;
  }> {
    const request = buildAgentRequest(task);
    const connector = new FakeAgent({ kind: task.kind });
    const result = await this.gateway.invoke(request, connector);
    const record = this.gateway.getInvocation(request.invocationId);
    if (!record) {
      throw new Error(`Missing invocation record for ${request.invocationId}`);
    }

    const invocation = invocationFromRecord(record);
    const updated: AgentTask = {
      ...task,
      status: statusFromResult(result),
      updatedAt: new Date().toISOString(),
      invocations: [...task.invocations, invocation],
    };

    return { task: updated, result, invocation };
  }
}
