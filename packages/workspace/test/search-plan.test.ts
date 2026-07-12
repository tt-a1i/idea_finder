import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CLI_EXIT_CODES } from "../src/cli/contract.js";
import { runCli } from "../src/cli/main.js";
import { buildProposedSearchPlan, confirmSearchPlanEntity } from "../src/orchestration/search-plan.js";
import { resolveWorkspacePaths } from "../src/storage/workspace-store.js";
import { WorkspaceService } from "../src/workspace-service.js";

describe("SearchPlan propose/confirm", () => {
  const leftovers: string[] = [];

  afterEach(async () => {
    await Promise.all(leftovers.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("builds a proposed plan without creating a ResearchRun", () => {
    const plan = buildProposedSearchPlan({ topic: "agent coding workflows" });
    expect(plan.status).toBe("proposed");
    expect(plan.confirmation.confirmedAt).toBeNull();
    expect(plan.topic).toBe("agent coding workflows");
    expect(plan.researchLenses.length).toBeGreaterThanOrEqual(6);
    expect(plan.sourceFamilies.length).toBeGreaterThan(0);
  });

  it("confirm marks the plan confirmed and can create a Brief", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "idea-finder-plan-"));
    leftovers.push(root);
    const service = new WorkspaceService({ paths: resolveWorkspacePaths(root) });
    const proposed = await service.proposeSearchPlan({ topic: "invoice reconciliation pain" });
    expect(proposed.status).toBe("proposed");

    const { plan, brief } = await service.confirmSearchPlan({ planId: proposed.id, mode: "explicit", slug: "invoice-pain" });
    expect(plan.status).toBe("confirmed");
    expect(plan.confirmation.confirmedAt).toBeTruthy();
    expect(brief?.slug).toBe("invoice-pain");
    expect(brief?.searchPlanId).toBe(plan.id);

    const inspected = await service.getSearchPlan(plan.id);
    expect(inspected?.status).toBe("confirmed");
  });

  it("rejects research when the Brief has no confirmed SearchPlan", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "idea-finder-gate-"));
    leftovers.push(root);
    const service = new WorkspaceService({ paths: resolveWorkspacePaths(root) });
    const brief = await service.createBrief({
      slug: "ungated",
      title: "Ungated",
      description: "no plan",
      attachConfirmedPlan: false,
    });
    expect(brief.searchPlanId).toBeUndefined();
    await expect(service.runResearch(brief.slug)).rejects.toMatchObject({ code: "plan.required" });
  });

  it("CLI propose does not create a ResearchRun; confirm then inspect works", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "idea-finder-plan-cli-"));
    leftovers.push(root);
    const lines: string[] = [];
    const proposeCode = await runCli(
      ["plan", "propose", "--topic", "developer onboarding friction", "--persona", "platform eng", "--language", "en", "--json"],
      { workspaceDir: root, stdout: (line) => lines.push(line) },
    );
    expect(proposeCode).toBe(0);
    const proposed = JSON.parse(lines.join("\n")) as { command: string; data: { plan: { id: string; status: string } } };
    expect(proposed.command).toBe("plan propose");
    expect(proposed.data.plan.status).toBe("proposed");

    const service = new WorkspaceService({ paths: resolveWorkspacePaths(root) });
    const state = await service.getState();
    expect(Object.keys(state.runs)).toHaveLength(0);

    const confirmOut: string[] = [];
    const confirmCode = await runCli(
      ["plan", "confirm", proposed.data.plan.id, "--mode", "start_now", "--slug", "onboarding", "--json"],
      { workspaceDir: root, stdout: (line) => confirmOut.push(line) },
    );
    expect(confirmCode).toBe(0);
    const confirmed = JSON.parse(confirmOut.join("\n")) as {
      data: { plan: { status: string; confirmation: { mode: string; defaultsApplied: boolean } }; brief: { slug: string } };
    };
    expect(confirmed.data.plan.status).toBe("confirmed");
    expect(confirmed.data.plan.confirmation.mode).toBe("start_now");
    expect(confirmed.data.brief.slug).toBe("onboarding");

    const inspectOut: string[] = [];
    expect(await runCli(["plan", "inspect", proposed.data.plan.id, "--json"], {
      workspaceDir: root,
      stdout: (line) => inspectOut.push(line),
    })).toBe(0);
    expect(JSON.parse(inspectOut.join("\n")).data.plan.status).toBe("confirmed");
  });

  it("CLI research run fails closed without a confirmed plan", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "idea-finder-plan-deny-"));
    leftovers.push(root);
    const service = new WorkspaceService({ paths: resolveWorkspacePaths(root) });
    await service.createBrief({
      slug: "deny-me",
      title: "Deny",
      description: "x",
      attachConfirmedPlan: false,
      queryPlan: { harvestMode: "manual", manualImports: [{ text: "painful workaround every week" }] },
    });
    const out: string[] = [];
    const code = await runCli(["research", "run", "deny-me", "--json"], {
      workspaceDir: root,
      stdout: (line) => out.push(line),
    });
    expect(code).toBe(CLI_EXIT_CODES.policy);
    expect(JSON.parse(out.join("\n")).errors[0].code).toBe("plan.required");
  });

  it("start_now confirmation records defaultsApplied", () => {
    const proposed = buildProposedSearchPlan({ topic: "x" });
    const confirmed = confirmSearchPlanEntity(proposed, { mode: "start_now" });
    expect(confirmed.confirmation.mode).toBe("start_now");
    expect(confirmed.confirmation.defaultsApplied).toBe(true);
    expect(confirmed.status).toBe("confirmed");
  });
});
