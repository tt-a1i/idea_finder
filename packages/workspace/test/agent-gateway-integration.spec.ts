import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/main.js";
import { resolveWorkspacePaths } from "../src/storage/workspace-store.js";
import { WorkspaceService } from "../src/workspace-service.js";

describe("agent gateway workspace integration", () => {
  it("runs research agent task via fake gateway (read-only)", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "idea-finder-agent-"));
    const svc = new WorkspaceService({
      paths: resolveWorkspacePaths(root),
      runnerMode: "fixture",
    });

    await svc.createBrief({
      slug: "demo",
      title: "Demo",
      description: "agent test",
    });
    await svc.runResearch("demo");
    const opps = await svc.listOpportunities("demo");
    expect(opps.length).toBeGreaterThan(0);

    const task = await svc.createAgentTask({
      kind: "research",
      intent: "read linked evidence",
      opportunityId: opps[0]!.id,
      evidenceIds: opps[0]!.evidenceItemIds.slice(0, 2),
    });
    const completed = await svc.runAgentTask(task.id);
    expect(completed.status).toBe("succeeded");
    expect(completed.invocations).toHaveLength(1);
    expect(completed.invocations[0]?.policyAllowed).toBe(true);
  });

  it("blocks browser Opportunity domain write at policy layer", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "idea-finder-agent-deny-"));
    const svc = new WorkspaceService({
      paths: resolveWorkspacePaths(root),
      runnerMode: "fixture",
    });

    const task = await svc.createAgentTask({
      kind: "browser",
      intent: "attempt opportunity write",
      opportunityId: "opp_test",
      domainWrite: true,
    });
    const completed = await svc.runAgentTask(task.id);
    expect(completed.status).toBe("blocked");
    expect(completed.invocations[0]?.policyDenials.some(
      (d) => d.code === "policy.domain_write_forbidden",
    )).toBe(true);
  });

  it("blocks computer Opportunity domain write at policy layer", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "idea-finder-agent-comp-"));
    const svc = new WorkspaceService({
      paths: resolveWorkspacePaths(root),
      runnerMode: "fixture",
    });

    const task = await svc.createAgentTask({
      kind: "computer",
      intent: "attempt opportunity write",
      opportunityId: "opp_test",
      domainWrite: true,
    });
    const completed = await svc.runAgentTask(task.id);
    expect(completed.status).toBe("blocked");
  });

  it("CLI: create/run browser domain-write task shows policy denial", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "idea-finder-agent-cli-"));
    const errors: string[] = [];
    const lines: string[] = [];
    const cliOpts = {
      workspaceDir: root,
      stdout: (l: string) => lines.push(l),
      stderr: (l: string) => errors.push(l),
    };

    expect(
      await runCli(
        [
          "agent",
          "create",
          "--kind",
          "browser",
          "--intent",
          "write opportunity",
          "--opportunity",
          "opp_x",
          "--domain-write",
        ],
        cliOpts,
      ),
    ).toBe(0);

    const taskId = lines
      .find((l) => l.startsWith("Created agent task"))
      ?.split(" ")[3];
    expect(taskId).toBeTruthy();

    expect(await runCli(["agent", "run", taskId!], cliOpts)).toBe(1);
    expect(lines.some((l) => l.includes("blocked"))).toBe(true);
    expect(
      errors.some((l) => l.includes("policy.domain_write_forbidden")),
    ).toBe(true);
  });
});
