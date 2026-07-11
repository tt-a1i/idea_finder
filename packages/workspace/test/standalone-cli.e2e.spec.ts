import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import {
  CLI_CONTRACT_VERSION,
  CLI_EXIT_CODES,
  type CliMachineEnvelope,
} from "../src/cli/contract.js";
import { createMachineEnvelope } from "../src/cli/main.js";

const exec = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, "../../..");

interface Invocation {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly envelope: CliMachineEnvelope;
}

async function invoke(executable: string, args: readonly string[], cwd: string): Promise<Invocation> {
  try {
    const result = await exec(executable, [...args], { cwd });
    return {
      code: 0,
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
      envelope: JSON.parse(result.stdout) as CliMachineEnvelope,
    };
  } catch (error) {
    const failure = error as Error & { code: number; stdout: string; stderr: string };
    return {
      code: failure.code,
      stdout: failure.stdout.trim(),
      stderr: failure.stderr.trim(),
      envelope: JSON.parse(failure.stdout) as CliMachineEnvelope,
    };
  }
}

describe("installed standalone CLI", () => {
  let consumer: string;
  let executable: string;
  let workspace: string;

  beforeAll(async () => {
    const packDirectory = await mkdtemp(path.join(os.tmpdir(), "idea-finder-pack-"));
    await exec("npm", ["run", "build"], { cwd: repositoryRoot });
    const packed = await exec("npm", ["pack", "--pack-destination", packDirectory, "--json"], { cwd: repositoryRoot });
    const packResult = JSON.parse(packed.stdout) as Array<{ filename: string }>;
    const tarball = path.join(packDirectory, packResult[0]!.filename);

    consumer = await mkdtemp(path.join(os.tmpdir(), "idea-finder-consumer-"));
    await writeFile(path.join(consumer, "package.json"), '{"private":true}\n', "utf8");
    await exec("npm", ["install", "--ignore-scripts", "--no-audit", "--offline", tarball], { cwd: consumer });
    executable = path.join(consumer, "node_modules", ".bin", "idea-finder");
    workspace = path.join(consumer, "workspace");
  }, 30_000);

  it("installs into a clean consumer and exposes diagnostics plus Brief create/list", async () => {
    const diagnostics = await invoke(executable, ["workspace", "diagnostics", "--workspace", workspace, "--json"], consumer);
    expect(diagnostics.code).toBe(CLI_EXIT_CODES.success);
    expect(diagnostics.stderr).toBe("");
    expect(diagnostics.envelope).toMatchObject({
      contractVersion: CLI_CONTRACT_VERSION,
      command: "workspace diagnostics",
      status: "success",
      warnings: [],
      incompleteness: { incomplete: false, reasons: [] },
      errors: [],
      data: { workspace: path.resolve(workspace), accessible: true, counts: { briefs: 0 } },
    });

    const created = await invoke(executable, ["brief", "create", "agents", "--title", "Agent demand", "--workspace", workspace, "--json"], consumer);
    expect(created.code).toBe(0);
    expect(created.envelope).toMatchObject({ command: "brief create", status: "success", data: { brief: { slug: "agents", title: "Agent demand" } } });

    const listed = await invoke(executable, ["brief", "list", "--workspace", workspace, "--json"], consumer);
    expect(listed.envelope).toMatchObject({ command: "brief list", data: { briefs: [{ slug: "agents", title: "Agent demand" }] } });
  });

  it("returns the pinned envelope from every implemented command", async () => {
    const expectSuccess = (invocation: Invocation, command: string): void => {
      expect(invocation.code).toBe(0);
      expect(invocation.envelope).toMatchObject({
        contractVersion: CLI_CONTRACT_VERSION,
        command,
        status: "success",
        warnings: [],
        incompleteness: { incomplete: false, reasons: [] },
        errors: [],
      });
      expect(invocation.envelope).toHaveProperty("data");
    };

    expectSuccess(await invoke(executable, ["help", "--json"], consumer), "help");
    const run = await invoke(executable, ["run", "agents", "--fixture", "--workspace", workspace, "--json"], consumer);
    expectSuccess(run, "run");
    const runId = (run.envelope.data as { run: { id: string } }).run.id;
    expectSuccess(await invoke(executable, ["inbox", "--brief", "agents", "--workspace", workspace, "--json"], consumer), "inbox");
    const library = await invoke(executable, ["library", "--brief", "agents", "--workspace", workspace, "--json"], consumer);
    expectSuccess(library, "library");
    const opportunityId = (library.envelope.data as { opportunities: Array<{ id: string }> }).opportunities[0]!.id;
    expectSuccess(await invoke(executable, ["board", "calibrate", opportunityId, "--action", "promote", "--workspace", workspace, "--json"], consumer), "board calibrate");

    const validation = await invoke(executable, ["validation", "add", opportunityId, "--type", "mom_test", "--hypothesis", "Users have this pain", "--start", "--workspace", workspace, "--json"], consumer);
    expectSuccess(validation, "validation add");
    const experimentId = (validation.envelope.data as { experiment: { id: string } }).experiment.id;
    expectSuccess(await invoke(executable, ["validation", "list", "--opportunity", opportunityId, "--workspace", workspace, "--json"], consumer), "validation list");
    expectSuccess(await invoke(executable, ["validation", "complete", experimentId, "--outcome", "inconclusive", "--summary", "More interviews needed", "--workspace", workspace, "--json"], consumer), "validation complete");

    expectSuccess(await invoke(executable, ["monitor", "schedule", "agents", "--cadence", "weekly", "--workspace", workspace, "--json"], consumer), "monitor schedule");
    expectSuccess(await invoke(executable, ["monitor", "diff", "--brief", "agents", "--baseline", runId, "--compare", runId, "--workspace", workspace, "--json"], consumer), "monitor diff");
    expectSuccess(await invoke(executable, ["export", "agents", "--workspace", workspace, "--json"], consumer), "export");
    expectSuccess(await invoke(executable, ["agent", "list", "--workspace", workspace, "--json"], consumer), "agent list");
    const agent = await invoke(executable, ["agent", "create", "--kind", "research", "--intent", "inspect evidence", "--workspace", workspace, "--json"], consumer);
    expectSuccess(agent, "agent create");
    const taskId = (agent.envelope.data as { task: { id: string } }).task.id;
    expectSuccess(await invoke(executable, ["agent", "run", taskId, "--workspace", workspace, "--json"], consumer), "agent run");
  });

  it("separates new scans from named retry/resume and isolates fixtures", async () => {
    const created = await invoke(executable, ["brief", "create", "lifecycle", "--title", "Lifecycle", "--description", "No evidence supplied", "--workspace", workspace, "--json"], consumer);
    expect(created.code).toBe(0);

    const first = await invoke(executable, ["run", "lifecycle", "--workspace", workspace, "--json"], consumer);
    const second = await invoke(executable, ["run", "lifecycle", "--workspace", workspace, "--json"], consumer);
    expect(first.code).toBe(0);
    expect(second.code).toBe(0);
    const firstData = first.envelope.data as { execution: string; run: { id: string; status: string; configHash: string }; chunks: unknown[]; evidence: unknown[] };
    const secondData = second.envelope.data as typeof firstData;
    expect(firstData.execution).toBe("new");
    expect(secondData.execution).toBe("new");
    expect(firstData.run.status).toBe("completed");
    expect(secondData.run.status).toBe("completed");
    expect(firstData.run.id).not.toBe(secondData.run.id);
    expect(firstData.run.configHash).toBe(secondData.run.configHash);
    expect(firstData.chunks).toEqual([]);
    expect(firstData.evidence).toEqual([]);

    const databasePath = path.join(workspace, "pipeline", "idea_finder.db");
    const interruptedDb = new DatabaseSync(databasePath);
    const firstHarvestAt = (interruptedDb.prepare("SELECT completed_at FROM pipeline_steps WHERE research_run_id = ? AND step = 'harvest'").get(firstData.run.id) as { completed_at: string }).completed_at;
    interruptedDb.prepare("UPDATE research_runs SET status = 'running', completed_at = NULL WHERE id = ?").run(firstData.run.id);
    interruptedDb.prepare("DELETE FROM pipeline_steps WHERE research_run_id = ? AND step IN ('intelligence', 'library_admission')").run(firstData.run.id);
    interruptedDb.close();

    const resumed = await invoke(executable, ["run", "lifecycle", "--resume", firstData.run.id, "--workspace", workspace, "--json"], consumer);
    const failedDb = new DatabaseSync(databasePath);
    const resumedSteps = failedDb.prepare("SELECT step, completed_at FROM pipeline_steps WHERE research_run_id = ? ORDER BY step").all(firstData.run.id) as Array<{ step: string; completed_at: string }>;
    expect(resumedSteps).toHaveLength(3);
    expect(resumedSteps.find((step) => step.step === "harvest")?.completed_at).toBe(firstHarvestAt);

    const secondCompletedSteps = failedDb.prepare("SELECT step, completed_at FROM pipeline_steps WHERE research_run_id = ? ORDER BY step").all(secondData.run.id) as Array<{ step: string; completed_at: string }>;
    failedDb.prepare("UPDATE research_runs SET status = 'failed', completed_at = NULL, error_message = 'interrupted after intelligence' WHERE id = ?").run(secondData.run.id);
    failedDb.prepare("DELETE FROM pipeline_steps WHERE research_run_id = ? AND step = 'library_admission'").run(secondData.run.id);
    failedDb.close();

    const retried = await invoke(executable, ["run", "lifecycle", "--retry", secondData.run.id, "--workspace", workspace, "--json"], consumer);
    const recoveredDb = new DatabaseSync(databasePath);
    const retriedSteps = recoveredDb.prepare("SELECT step, completed_at FROM pipeline_steps WHERE research_run_id = ? ORDER BY step").all(secondData.run.id) as Array<{ step: string; completed_at: string }>;
    recoveredDb.close();
    expect(retriedSteps).toHaveLength(3);
    for (const completed of secondCompletedSteps.filter((step) => step.step !== "library_admission")) {
      expect(retriedSteps.find((step) => step.step === completed.step)?.completed_at).toBe(completed.completed_at);
    }
    expect(resumed.code).toBe(0);
    expect(retried.code).toBe(0);
    expect(resumed.envelope).toMatchObject({ data: { execution: "resumed", run: { id: firstData.run.id, status: "completed" } } });
    expect(retried.envelope).toMatchObject({ data: { execution: "retried", run: { id: secondData.run.id, status: "completed" } } });

    const explicitBrief = await invoke(executable, [
      "brief", "create", "explicit-import", "--title", "Explicit import",
      "--manual-import", "Explicit interview: this workflow is painful and I would pay to replace it.",
      "--workspace", workspace, "--json",
    ], consumer);
    expect(explicitBrief.code).toBe(0);
    const explicitImport = await invoke(executable, ["run", "explicit-import", "--workspace", workspace, "--json"], consumer);
    expect(explicitImport.code).toBe(0);
    const explicitData = explicitImport.envelope.data as typeof firstData;
    expect(explicitData.chunks).toHaveLength(1);
    expect(explicitData.run.configHash).not.toBe(firstData.run.configHash);

    const fixture = await invoke(executable, ["run", "lifecycle", "--fixture", "--workspace", workspace, "--json"], consumer);
    expect(fixture.code).toBe(0);
    const fixtureData = fixture.envelope.data as { execution: string; run: { id: string }; evidence: unknown[] };
    expect(fixtureData.execution).toBe("new");
    expect(fixtureData.run.id).not.toBe(firstData.run.id);
    expect(fixtureData.evidence.length).toBeGreaterThan(0);
  });

  it("restarts from canonical SQLite and inspects admitted and rejected Library results", async () => {
    const created = await invoke(executable, [
      "brief", "create", "canonical", "--title", "Canonical research",
      "--description", "Explicit research persisted in SQLite",
      "--manual-import", "I invoice from a Google Sheet every month — painful workaround reconciling Stripe payouts.",
      "--manual-import", "Would pay $30/mo for lightweight solo SaaS invoicing with Stripe sync.",
      "--manual-import", "Need something simpler than QuickBooks for month-end invoicing.",
      "--manual-import", "QuickBooks works fine for enterprise — not a problem for us.",
      "--workspace", workspace, "--json",
    ], consumer);
    expect(created.code).toBe(0);
    const researched = await invoke(executable, ["run", "canonical", "--workspace", workspace, "--json"], consumer);
    expect(researched.code).toBe(0);
    const result = researched.envelope.data as {
      run: { id: string };
      documents: unknown[];
      admittedCount: number;
      rejected: unknown[];
      opportunities: Array<{ id: string }>;
    };
    expect(result.documents).toHaveLength(4);
    expect(result.admittedCount).toBeGreaterThan(0);
    expect(result.rejected.length).toBeGreaterThan(0);

    await writeFile(path.join(workspace, "state.json"), JSON.stringify({ version: 1, opportunities: { poisoned: true } }), "utf8");
    const listedBriefs = await invoke(executable, ["brief", "list", "--workspace", workspace, "--json"], consumer);
    expect(listedBriefs.envelope).toMatchObject({ data: { briefs: expect.arrayContaining([expect.objectContaining({ slug: "canonical" })]) } });
    const library = await invoke(executable, ["library", "--brief", "canonical", "--workspace", workspace, "--json"], consumer);
    const libraryData = library.envelope.data as {
      opportunities: Array<{ id: string }>;
      entries: Array<{ runId: string; opportunity: { id: string } }>;
    };
    const opportunities = libraryData.opportunities;
    expect(opportunities.length).toBeGreaterThan(0);
    const listedOccurrence = libraryData.entries.find((entry) => entry.opportunity.id === opportunities[0]!.id)!;
    expect(listedOccurrence.runId).toBe(result.run.id);
    const inspected = await invoke(executable, ["library", "inspect", opportunities[0]!.id, "--run", listedOccurrence.runId, "--workspace", workspace, "--json"], consumer);
    expect(inspected.envelope).toMatchObject({ command: "library inspect", data: { opportunity: { id: opportunities[0]!.id }, runId: result.run.id } });
    const rejected = await invoke(executable, ["library", "rejected", "--run", result.run.id, "--workspace", workspace, "--json"], consumer);
    expect((rejected.envelope.data as { results: unknown[] }).results.length).toBeGreaterThan(0);

    const db = new DatabaseSync(path.join(workspace, "pipeline", "idea_finder.db"));
    for (const table of ["hunting_briefs", "research_run_configs", "raw_documents", "chunks", "raw_signals", "evidence_items", "opportunity_drafts", "library_admission_results", "source_statuses"]) {
      const count = (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
      expect(count, table).toBeGreaterThan(0);
    }
    db.close();
  });

  it("pins usage, validation, missing-resource, policy, and internal error exits", async () => {
    expect(CLI_EXIT_CODES).toEqual({ success: 0, usage: 2, validation: 3, missingResource: 4, policy: 5, partialResult: 6, internal: 7 });
    const usage = await invoke(executable, ["unknown", "command", "--json"], consumer);
    expect(usage.code).toBe(CLI_EXIT_CODES.usage);
    expect(usage.envelope.errors[0]).toMatchObject({ category: "usage", code: "cli.unknown_command" });

    const unknownOption = await invoke(executable, ["brief", "list", "--bogus", "--json"], consumer);
    expect(unknownOption.code).toBe(CLI_EXIT_CODES.usage);
    expect(unknownOption.envelope.errors[0]).toMatchObject({ category: "usage", code: "cli.unknown_option" });

    const validation = await invoke(executable, ["monitor", "schedule", "agents", "--cadence", "hourly", "--workspace", workspace, "--json"], consumer);
    expect(validation.code).toBe(CLI_EXIT_CODES.validation);
    expect(validation.envelope.errors[0]).toMatchObject({ category: "validation", code: "cli.invalid_value" });

    const missing = await invoke(executable, ["export", "absent", "--workspace", workspace, "--json"], consumer);
    expect(missing.code).toBe(CLI_EXIT_CODES.missingResource);
    expect(missing.envelope.errors[0]).toMatchObject({ category: "missing-resource", code: "brief.not_found" });

    const created = await invoke(executable, ["agent", "create", "--kind", "browser", "--intent", "write opportunity", "--opportunity", "opp_x", "--domain-write", "--workspace", workspace, "--json"], consumer);
    const taskId = (created.envelope.data as { task: { id: string } }).task.id;
    const policy = await invoke(executable, ["agent", "run", taskId, "--workspace", workspace, "--json"], consumer);
    expect(policy.code).toBe(CLI_EXIT_CODES.policy);
    expect(policy.envelope.errors[0]).toMatchObject({ category: "policy", code: "policy.domain_write_forbidden" });

    await writeFile(path.join(workspace, "state.json"), "not json", "utf8");
    const internal = await invoke(executable, ["workspace", "diagnostics", "--workspace", workspace, "--json"], consumer);
    expect(internal.code).toBe(CLI_EXIT_CODES.internal);
    expect(internal.envelope.errors[0]).toMatchObject({ category: "internal", code: "internal.unexpected" });
  });

  it("pins partial-result as structured incompleteness with exit 6", () => {
    const partial = createMachineEnvelope("agent run", {
      command: "agent run",
      data: { retained: true },
      human: "partial",
      incompleteness: ["one source unavailable"],
      exitCode: CLI_EXIT_CODES.partialResult,
    });
    expect(partial).toMatchObject({
      status: "partial",
      data: { retained: true },
      incompleteness: { incomplete: true, reasons: ["one source unavailable"] },
      errors: [{ category: "partial-result", code: "result.partial" }],
    });
  });

  it("keeps human presentation outside the pinned machine envelope", async () => {
    const cleanWorkspace = path.join(consumer, "human-workspace");
    const human = await exec(executable, ["brief", "list", "--workspace", cleanWorkspace], { cwd: consumer });
    expect(human.stdout.trim()).toBe("No briefs yet.");
    expect(() => JSON.parse(human.stdout)).toThrow();

    const machine = await invoke(executable, ["brief", "list", "--workspace", cleanWorkspace, "--json"], consumer);
    expect(machine.envelope.data).toEqual({ briefs: [] });
  });

  it("ships only the bundled executable required at runtime", async () => {
    const installedPackage = JSON.parse(await readFile(path.join(consumer, "node_modules", "idea-finder", "package.json"), "utf8")) as { bin: Record<string, string>; dependencies?: object };
    expect(installedPackage.bin).toEqual({ "idea-finder": "./dist/idea-finder.js" });
    expect(installedPackage.dependencies).toBeUndefined();
  });
});
