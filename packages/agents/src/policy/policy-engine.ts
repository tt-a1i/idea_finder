import type {
  AgentKind,
  AgentPlannedEffect,
  AgentRequest,
  PolicyDenial,
} from "../types/agent-contract.js";
import { isPathAllowed, isUrlAllowed } from "./path-url.js";

export interface PolicyEvaluation {
  readonly allowed: boolean;
  readonly denials: readonly PolicyDenial[];
}

export interface PolicyEngine {
  evaluate(request: AgentRequest): PolicyEvaluation;
}

const FAIL_CLOSE_KINDS: ReadonlySet<AgentKind> = new Set([
  "browser",
  "computer",
  "coding",
]);

const OPPORTUNITY_WRITE_BLOCKED_KINDS: ReadonlySet<AgentKind> = new Set([
  "browser",
  "computer",
]);

function deny(code: string, reason: string): PolicyDenial {
  return { code, reason };
}

function evaluateEffect(
  request: AgentRequest,
  effect: AgentPlannedEffect,
  denials: PolicyDenial[],
): void {
  const { scope, kind } = request;

  switch (effect.kind) {
    case "read_path": {
      if (!isPathAllowed(effect.target, scope.readablePaths)) {
        denials.push(
          deny(
            "policy.path_read_forbidden",
            `Read path outside scope: ${effect.target}`,
          ),
        );
      }
      return;
    }
    case "write_path": {
      if (!isPathAllowed(effect.target, scope.writablePaths)) {
        denials.push(
          deny(
            "policy.path_write_forbidden",
            `Write path outside writablePaths: ${effect.target}`,
          ),
        );
      }
      return;
    }
    case "fetch_url": {
      if (!scope.allowNetwork) {
        denials.push(
          deny(
            "policy.network_forbidden",
            "Network access is disabled for this invocation",
          ),
        );
        return;
      }
      if (!isUrlAllowed(effect.target, scope.urlAllowlist)) {
        denials.push(
          deny(
            "policy.url_not_allowed",
            `URL not in allowlist: ${effect.target}`,
          ),
        );
      }
      return;
    }
    case "domain_write": {
      if (
        effect.domainEntity === "Opportunity" &&
        OPPORTUNITY_WRITE_BLOCKED_KINDS.has(kind)
      ) {
        denials.push(
          deny(
            "policy.domain_write_forbidden",
            `${kind} agents cannot write Opportunity entities`,
          ),
        );
        return;
      }
      if (FAIL_CLOSE_KINDS.has(kind) && effect.domainEntity) {
        denials.push(
          deny(
            "policy.domain_write_forbidden",
            `${kind} agents cannot write domain entity ${effect.domainEntity}`,
          ),
        );
      }
      return;
    }
  }
}

function evaluateBudgets(
  request: AgentRequest,
  denials: PolicyDenial[],
): void {
  const { budgets } = request.scope;
  const estimatedRequests = request.plannedEffects.filter(
    (e) => e.kind === "fetch_url",
  ).length;

  if (estimatedRequests > budgets.maxRequests) {
    denials.push(
      deny(
        "policy.budget_requests_exceeded",
        `Planned ${estimatedRequests} requests exceeds maxRequests ${budgets.maxRequests}`,
      ),
    );
  }

  if (budgets.maxDurationMs <= 0) {
    denials.push(
      deny(
        "policy.budget_time_invalid",
        "maxDurationMs must be positive",
      ),
    );
  }

  if (budgets.maxCostUsd < 0) {
    denials.push(
      deny(
        "policy.budget_cost_invalid",
        "maxCostUsd cannot be negative",
      ),
    );
  }
}

/** Fail-closed policy for browser/computer/coding; research read-only allowed in scope. */
export function createPolicyEngine(): PolicyEngine {
  return {
    evaluate(request: AgentRequest): PolicyEvaluation {
      const denials: PolicyDenial[] = [];

      evaluateBudgets(request, denials);

      for (const effect of request.plannedEffects) {
        evaluateEffect(request, effect, denials);
      }

      for (const inputRef of request.inputRefs) {
        if (inputRef.kind !== "url") continue;
        if (!request.scope.allowNetwork) {
          denials.push(
            deny(
              "policy.network_forbidden",
              `Input URL requires network: ${inputRef.ref}`,
            ),
          );
          continue;
        }
        if (!isUrlAllowed(inputRef.ref, request.scope.urlAllowlist)) {
          denials.push(
            deny(
              "policy.url_not_allowed",
              `Input URL not in allowlist: ${inputRef.ref}`,
            ),
          );
        }
      }

      return {
        allowed: denials.length === 0,
        denials,
      };
    },
  };
}
