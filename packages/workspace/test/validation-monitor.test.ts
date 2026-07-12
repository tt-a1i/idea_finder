import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { runCli } from "../src/cli/main.js";
import { resolveWorkspacePaths } from "../src/storage/workspace-store.js";
import { WorkspaceService } from "../src/workspace-service.js";
import { createFixtureResearchRunner } from "../src/ports/runner-impl.js";

describe("validation and monitor diff", () => {
  it("promoted opportunity → validation experiment → result updates metadata", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "idea-finder-val-"));
    const svc = new WorkspaceService({ paths: resolveWorkspacePaths(root), runnerMode: "fixture" });

    const brief = await svc.createBrief({
      slug: "val",
      title: "Validation slice",
      description: "test",
    });
    await svc.runResearch(brief.slug);
    const [hypothesis] = await svc.listOpportunities(brief.slug);
    expect(hypothesis).toBeDefined();

    const promoted = await svc.applyBoardCalibration({
      opportunityId: hypothesis!.id,
      action: "promote",
      note: "validate next",
    });
    expect(promoted.opportunity.status).toBe("promoted");

    const experiment = await svc.createValidationExperiment({
      opportunityId: promoted.opportunity.id,
      type: "mom_test",
      hypothesis: "Founders will pay $20/mo for Stripe invoicing sync",
      start: true,
    });
    expect(experiment.status).toBe("running");

    const completed = await svc.completeValidationExperiment({
      experimentId: experiment.id,
      outcome: "validated",
      summary: "4/6 mom-test interviews confirmed pain and WTP",
    });
    expect(completed.experiment.result?.outcome).toBe("validated");
    expect(completed.opportunity.confidenceReasons).toContain("validation_validated");

    const state = await svc.getState();
    expect(state.validationExperiments[experiment.id]?.status).toBe("completed");
  });

  it("two runs → monitor diff with evidence counts", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "idea-finder-mon-"));
    const svc = new WorkspaceService({ paths: resolveWorkspacePaths(root), runnerMode: "fixture" });

    const brief = await svc.createBrief({
      slug: "mon",
      title: "Monitor slice",
      description: "test",
    });

    const run1 = await svc.runResearch(brief.slug);
    const run2 = await svc.runResearch(brief.slug);
    await svc.setMonitorSchedule({ briefSlugOrId: brief.slug, cadence: "manual" });

    const diff = await svc.compareMonitorDiff({
      briefSlugOrId: brief.slug,
      baselineRunId: run1.run.id,
      compareRunId: run2.run.id,
    });

    expect(diff.entries.length).toBeGreaterThan(0);
    expect(diff.summary.added + diff.summary.heated + diff.summary.cooled + diff.summary.unchanged).toBe(
      diff.entries.length,
    );

    const schedule = await svc.getMonitorSchedule(brief.slug);
    expect(schedule?.lastComparedRunId).toBeNull();
  });

  it("external monitor invocations create fresh runs, advance the cursor, and suppress false cooling under partial coverage", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "idea-finder-monitor-run-"));
    try {
      const paths = resolveWorkspacePaths(root);
      const service = new WorkspaceService({ paths, runnerMode: "fixture" });
      const brief = await service.createBrief({ slug: "continuous", title: "Continuous", description: "external scheduler" });
      const schedule = await service.setMonitorSchedule({ briefSlugOrId: brief.id, cadence: "daily", thresholds: { minCoolingEvidenceLoss: 2 } });
      expect(schedule).toMatchObject({ cadence: "daily", thresholds: { minCoolingEvidenceLoss: 2 } });
      const baseline = await service.invokeMonitor({ briefSlugOrId: brief.id });
      expect(baseline).toMatchObject({ baselineRunId: null, comparison: null });
      const compared = await service.invokeMonitor({ briefSlugOrId: brief.id });
      expect(compared.run.run.id).not.toBe(baseline.run.run.id);
      expect(compared).toMatchObject({ baselineRunId: baseline.run.run.id, comparison: { diff: { baselineRunId: baseline.run.run.id, compareRunId: compared.run.run.id } } });
      const partialService = new WorkspaceService({ paths, runner: createFixtureResearchRunner("partial-zero") });
      const partial = await partialService.invokeMonitor({ briefSlugOrId: brief.id });
      expect(partial.run.run.status).toBe("partial");
      expect(partial.comparison?.diff.coverage.partial).toBe(true);
      expect(partial.comparison?.diff.summary.cooled).toBe(0);
      expect(partial.comparison?.diff.entries.some((entry) => entry.coolingSuppressed && !entry.conclusive)).toBe(true);
      const restarted = new WorkspaceService({ paths, runnerMode: "fixture" });
      expect(await restarted.getMonitorSchedule(brief.id)).toMatchObject({ cadence: "daily", lastComparedRunId: partial.run.run.id, lastInvokedAt: expect.any(String) });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("CLI: validation add/list/complete and monitor diff", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "idea-finder-val-cli-"));
    const lines: string[] = [];
    const errors: string[] = [];
    const cliOpts = {
      workspaceDir: root,
      stdout: (l: string) => lines.push(l),
      stderr: (l: string) => errors.push(l),
    };

    expect(
      await runCli(
        ["brief", "create", "v", "--title", "V", "--description", "d"],
        cliOpts,
      ),
    ).toBe(0);
    expect(await runCli(["run", "v", "--fixture"], cliOpts)).toBe(0);

    const libStart = lines.length;
    expect(await runCli(["library", "--brief", "v"], cliOpts)).toBe(0);
    const oppId = lines
      .slice(libStart)
      .find((l) => l.startsWith("opp_"))
      ?.split("\t")[0];
    expect(oppId).toBeTruthy();

    expect(
      await runCli(
        ["board", "calibrate", oppId!, "--action", "promote", "--note", "go"],
        cliOpts,
      ),
    ).toBe(0);

    const valStart = lines.length;
    expect(
      await runCli(
        [
          "validation",
          "add",
          oppId!,
          "--type",
          "landing",
          "--hypothesis",
          "5% signup from landing",
          "--start",
        ],
        cliOpts,
      ),
    ).toBe(0);
    const experimentId = lines
      .slice(valStart)
      .find((l) => l.startsWith("Created validation vexp_"))
      ?.split(" ")[2];
    expect(experimentId).toBeTruthy();

    expect(await runCli(["validation", "list", "--opportunity", oppId!], cliOpts)).toBe(0);
    expect(
      await runCli(
        [
          "validation",
          "complete",
          experimentId!,
          "--outcome",
          "inconclusive",
          "--summary",
          "Low traffic week",
        ],
        cliOpts,
      ),
    ).toBe(0);

    expect(await runCli(["run", "v", "--fixture"], cliOpts)).toBe(0);
    const state = await new WorkspaceService({
      paths: resolveWorkspacePaths(root),
      runnerMode: "fixture",
    }).getState();
    const runs = state.runs.filter((r) => r.briefId.startsWith("task_v"));
    expect(runs.length).toBeGreaterThanOrEqual(2);

    expect(
      await runCli(
        [
          "monitor",
          "diff",
          "--brief",
          "v",
          "--baseline",
          runs[0]!.run.id,
          "--compare",
          runs[1]!.run.id,
        ],
        cliOpts,
      ),
    ).toBe(0);

    expect(lines.some((l) => l.includes("Monitor diff"))).toBe(true);
    expect(errors).toHaveLength(0);
  });
});
