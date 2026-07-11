import { access } from "node:fs/promises";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/main.js";
import { renderMarkdownReport } from "../src/report/markdown-export.js";
import { resolveWorkspacePaths } from "../src/storage/workspace-store.js";
import { WorkspaceService } from "../src/workspace-service.js";

describe("workspace vertical slice", () => {
  it("Brief → fixture harvest → admitToLibrary → applyCalibration → markdown export", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "idea-finder-ws-"));
    const paths = resolveWorkspacePaths(root);
    const svc = new WorkspaceService({ paths, runnerMode: "fixture" });

    const brief = await svc.createBrief({
      slug: "invoicing",
      title: "Solo SaaS invoicing",
      description: "Find lightweight Stripe-sync invoicing demand",
    });

    const run = await svc.runResearch(brief.slug);
    expect(run.admittedCount).toBe(1);
    expect(run.rejected).toHaveLength(1);

    const inbox = await svc.getInboxSummary(brief.slug);
    expect(inbox.runId).toBe(run.run.id);
    expect(inbox.inbox.length).toBeGreaterThan(0);

    const opps = await svc.listOpportunities(brief.slug);
    expect(opps).toHaveLength(1);
    const hypothesis = opps[0]!;
    expect(hypothesis.status).toBe("hypothesis");

    const calibrated = await svc.applyBoardCalibration({
      opportunityId: hypothesis.id,
      action: "promote",
      note: "ready to validate",
    });
    expect(calibrated.opportunity.status).toBe("promoted");

    const state = await svc.getState();
    const markdown = renderMarkdownReport({
      brief,
      opportunities: [calibrated.opportunity],
      calibrationEvents: state.calibrationEvents,
      evidenceById: state.evidenceById,
      inbox: inbox.inbox,
      runId: run.run.id,
    });

    expect(markdown).toContain("# Demand Workspace Report");
    expect(markdown).toContain("Solo SaaS needs lightweight invoicing");
    expect(markdown).toContain("## Evidence appendix");
    expect(markdown).toContain("promote");
  });

  it("orchestration mode: real pipeline → persisted run → library → board → export", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "idea-finder-orch-"));
    const paths = resolveWorkspacePaths(root);
    const svc = new WorkspaceService({ paths, runnerMode: "orchestration" });

    const brief = await svc.createBrief({
      slug: "orch-invoicing",
      title: "Orchestration invoicing",
      description: "Stripe invoicing pain for solo founders",
      queryPlan: {
        harvestMode: "manual",
        manualImports: [
          {
            text: "I invoice from a Google Sheet every month — painful workaround reconciling Stripe payouts.",
          },
          {
            text: "Would pay $30/mo for lightweight solo SaaS invoicing with Stripe sync.",
          },
          {
            text: "Need something simpler than QuickBooks for month-end invoicing.",
          },
          {
            text: "QuickBooks works fine for enterprise — not a problem for us.",
          },
        ],
      },
    });

    const run = await svc.runResearch(brief.slug);
    expect(run.run.status).toBe("completed");
    expect(run.signals.length).toBeGreaterThan(0);
    expect(run.evidence.length).toBeGreaterThanOrEqual(3);
    expect(run.admittedCount).toBeGreaterThanOrEqual(1);

    await expect(access(path.join(root, "pipeline", "idea_finder.db"))).resolves.toBeUndefined();

    const inbox = await svc.getInboxSummary(brief.slug);
    expect(inbox.inbox.length).toBeGreaterThan(0);

    const opps = await svc.listOpportunities(brief.slug);
    expect(opps.length).toBeGreaterThanOrEqual(1);

    const calibrated = await svc.applyBoardCalibration({
      opportunityId: opps[0]!.id,
      action: "park",
      note: "review after next harvest",
    });
    expect(calibrated.opportunity.status).toBe("parked");

    const outFile = path.join(root, "orch-report.md");
    const state = await svc.getState();
    const markdown = renderMarkdownReport({
      brief,
      opportunities: [calibrated.opportunity],
      calibrationEvents: state.calibrationEvents,
      evidenceById: state.evidenceById,
      inbox: inbox.inbox,
      runId: run.run.id,
    });
    expect(markdown).toContain("park");
  });

  it("CLI smoke: brief create → run → calibrate → export", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "idea-finder-cli-"));
    const outFile = path.join(root, "report.md");
    const lines: string[] = [];
    const errors: string[] = [];
    const cliOpts = {
      workspaceDir: root,
      stdout: (l: string) => lines.push(l),
      stderr: (l: string) => errors.push(l),
    };

    expect(
      await runCli(
        ["brief", "create", "demo", "--title", "Demo brief", "--description", "smoke"],
        cliOpts,
      ),
    ).toBe(0);

    expect(await runCli(["run", "demo", "--fixture"], cliOpts)).toBe(0);
    expect(lines.some((l) => l.includes("admitted 1"))).toBe(true);

    const libLines = lines.length;
    expect(await runCli(["library", "--brief", "demo"], cliOpts)).toBe(0);
    const libraryOutput = lines.slice(libLines).join("\n");
    const oppId = libraryOutput
      .split("\n")
      .find((l) => l.startsWith("opp_"))
      ?.split("\t")[0];
    expect(oppId).toBeTruthy();

    expect(
      await runCli(
        ["board", "calibrate", oppId!, "--action", "park", "--note", "later"],
        cliOpts,
      ),
    ).toBe(0);

    expect(
      await runCli(["export", "demo", "--out", outFile], cliOpts),
    ).toBe(0);

    const report = await readFile(outFile, "utf8");
    expect(report).toContain("Demo brief");
    expect(report).toContain("park");
    expect(errors).toHaveLength(0);
  });

  it("CLI orchestration smoke: manual import pipeline with persisted sqlite", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "idea-finder-cli-orch-"));
    const outFile = path.join(root, "orch-cli-report.md");
    const lines: string[] = [];
    const errors: string[] = [];
    const cliOpts = {
      workspaceDir: root,
      stdout: (l: string) => lines.push(l),
      stderr: (l: string) => errors.push(l),
    };

    expect(
      await runCli(
        [
          "brief",
          "create",
          "orch",
          "--title",
          "Orchestration CLI",
          "--description",
          "Manual import orchestration smoke",
          "--manual-import",
          "Painful workaround reconciling invoices every month.",
          "--manual-import",
          "Would pay for a lightweight invoicing workflow.",
          "--manual-import",
          "Need something simpler for month-end invoicing.",
        ],
        cliOpts,
      ),
    ).toBe(0);

    expect(await runCli(["run", "orch", "--orchestration"], cliOpts)).toBe(0);
    expect(lines.some((l) => l.includes("admitted"))).toBe(true);

    const libStart = lines.length;
    expect(await runCli(["library", "--brief", "orch"], cliOpts)).toBe(0);
    const oppId = lines
      .slice(libStart)
      .find((l) => l.startsWith("opp_"))
      ?.split("\t")[0];
    expect(oppId).toBeTruthy();

    expect(
      await runCli(
        ["board", "calibrate", oppId!, "--action", "park", "--note", "cli smoke"],
        cliOpts,
      ),
    ).toBe(0);

    expect(
      await runCli(["export", "orch", "--out", outFile], cliOpts),
    ).toBe(0);

    await expect(access(path.join(root, "pipeline", "idea_finder.db"))).resolves.toBeUndefined();
    const report = await readFile(outFile, "utf8");
    expect(report).toContain("Orchestration CLI");
    expect(errors).toHaveLength(0);
  });
});
