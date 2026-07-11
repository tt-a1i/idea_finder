import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
    const run = await invoke(executable, ["run", "agents", "--workspace", workspace, "--json"], consumer);
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
