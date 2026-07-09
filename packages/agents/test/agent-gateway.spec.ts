import { describe, expect, it } from "vitest";
import {
  AgentGateway,
  FakeAgent,
  ScriptedAgent,
  createPolicyEngine,
  type AgentRequest,
  type AgentScope,
} from "../src/index.js";

function baseScope(overrides: Partial<AgentScope> = {}): AgentScope {
  return {
    writablePaths: ["/workspace/out"],
    readablePaths: ["/workspace/in", "/workspace/out"],
    allowNetwork: true,
    urlAllowlist: ["https://news.ycombinator.com/*", "example.com"],
    dryRun: false,
    budgets: {
      maxCostUsd: 1,
      maxRequests: 10,
      maxDurationMs: 60_000,
    },
    ...overrides,
  };
}

function request(
  partial: Partial<AgentRequest> & Pick<AgentRequest, "kind" | "plannedEffects">,
): AgentRequest {
  return {
    invocationId: partial.invocationId ?? `inv_${partial.kind}_${Date.now()}`,
    kind: partial.kind,
    intent: partial.intent ?? "test",
    scope: partial.scope ?? baseScope(),
    inputRefs: partial.inputRefs ?? [],
    plannedEffects: partial.plannedEffects,
    metadata: partial.metadata,
  };
}

describe("PolicyEngine", () => {
  const policy = createPolicyEngine();

  it("denies browser Opportunity domain writes", () => {
    const evaluation = policy.evaluate(
      request({
        kind: "browser",
        plannedEffects: [
          {
            kind: "domain_write",
            target: "opp_1",
            domainEntity: "Opportunity",
            action: "create",
          },
        ],
      }),
    );
    expect(evaluation.allowed).toBe(false);
    expect(evaluation.denials.some((d) => d.code === "policy.domain_write_forbidden")).toBe(
      true,
    );
  });

  it("denies computer Opportunity domain writes", () => {
    const evaluation = policy.evaluate(
      request({
        kind: "computer",
        plannedEffects: [
          {
            kind: "domain_write",
            target: "opp_1",
            domainEntity: "Opportunity",
            action: "update",
          },
        ],
      }),
    );
    expect(evaluation.allowed).toBe(false);
  });

  it("denies write paths outside writablePaths", () => {
    const evaluation = policy.evaluate(
      request({
        kind: "coding",
        plannedEffects: [{ kind: "write_path", target: "/etc/passwd" }],
      }),
    );
    expect(evaluation.allowed).toBe(false);
    expect(evaluation.denials.some((d) => d.code === "policy.path_write_forbidden")).toBe(
      true,
    );
  });

  it("denies fetch_url outside url allowlist", () => {
    const evaluation = policy.evaluate(
      request({
        kind: "browser",
        plannedEffects: [
          { kind: "fetch_url", target: "https://evil.example/phish" },
        ],
      }),
    );
    expect(evaluation.allowed).toBe(false);
    expect(evaluation.denials.some((d) => d.code === "policy.url_not_allowed")).toBe(true);
  });

  it("denies network when allowNetwork is false", () => {
    const evaluation = policy.evaluate(
      request({
        kind: "research",
        scope: baseScope({ allowNetwork: false }),
        plannedEffects: [
          { kind: "fetch_url", target: "https://news.ycombinator.com/item?id=1" },
        ],
      }),
    );
    expect(evaluation.allowed).toBe(false);
    expect(evaluation.denials.some((d) => d.code === "policy.network_forbidden")).toBe(true);
  });
});

describe("AgentGateway", () => {
  it("records invocation metadata without domain mutation", async () => {
    const gateway = new AgentGateway();
    const agent = new FakeAgent({
      kind: "research",
      result: {
        structured: { notes: "read-only harvest" },
      },
    });

    const req = request({
      invocationId: "inv_meta_1",
      kind: "research",
      plannedEffects: [
        {
          kind: "fetch_url",
          target: "https://news.ycombinator.com/item?id=1",
        },
      ],
      inputRefs: [
        { kind: "url", ref: "https://news.ycombinator.com/item?id=1" },
      ],
    });

    const result = await gateway.invoke(req, agent);
    expect(result.status).toBe("succeeded");

    const record = gateway.getInvocation("inv_meta_1");
    expect(record).toBeDefined();
    expect(record?.policy.allowed).toBe(true);
    expect(record?.result?.structured).toEqual({ notes: "read-only harvest" });
    expect(record?.completedAt).toBeTruthy();
  });

  it("blocks browser Opportunity writes before connector runs", async () => {
    const gateway = new AgentGateway();
    let invoked = false;
    const agent = new ScriptedAgent("browser", "spy", () => {
      invoked = true;
      return {
        invocationId: "inv_block_1",
        status: "succeeded",
        artifacts: [],
      };
    });

    const result = await gateway.invoke(
      request({
        invocationId: "inv_block_1",
        kind: "browser",
        plannedEffects: [
          {
            kind: "domain_write",
            target: "opp_new",
            domainEntity: "Opportunity",
            action: "create",
          },
        ],
      }),
      agent,
    );

    expect(result.status).toBe("blocked");
    expect(result.policyDenials?.length).toBeGreaterThan(0);
    expect(invoked).toBe(false);
  });

  it("returns simulated dry-run results without artifacts", async () => {
    const gateway = new AgentGateway();
    const agent = new FakeAgent({ kind: "browser" });

    const result = await gateway.invoke(
      request({
        invocationId: "inv_dry_1",
        kind: "browser",
        scope: baseScope({ dryRun: true }),
        plannedEffects: [
          { kind: "write_path", target: "/workspace/out/page.html" },
        ],
      }),
      agent,
    );

    expect(result.status).toBe("succeeded");
    expect(result.dryRun).toBe(true);
    expect(result.artifacts).toHaveLength(0);
    expect(result.structured?.simulated).toBe(true);
  });

  it("allows research read-only fetch within scope", async () => {
    const gateway = new AgentGateway();
    const agent = new FakeAgent({
      kind: "research",
      result: {
        artifacts: [{ kind: "raw_document", path: "/workspace/in/doc.json" }],
        structured: { documentsRead: 1 },
      },
    });

    const result = await gateway.invoke(
      request({
        invocationId: "inv_research_1",
        kind: "research",
        intent: "fetch hn thread",
        plannedEffects: [
          {
            kind: "fetch_url",
            target: "https://news.ycombinator.com/item?id=42",
          },
        ],
      }),
      agent,
    );

    expect(result.status).toBe("succeeded");
    expect(result.artifacts).toHaveLength(1);
    expect(result.structured?.documentsRead).toBe(1);
  });
});
