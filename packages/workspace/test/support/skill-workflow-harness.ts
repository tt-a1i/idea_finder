import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { CliMachineEnvelope } from "../../src/cli/contract.js";

const exec = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, "../../../..");
const executable = path.join(repositoryRoot, "dist", "idea-finder.js");

export interface SkillWorkflowCommand {
  readonly command: string;
  readonly exitCode: number;
  readonly envelope: CliMachineEnvelope;
}

export interface SkillWorkflowTrace {
  readonly commands: readonly SkillWorkflowCommand[];
  readonly response: string;
  readonly pausedForHumanDecision: boolean;
}

interface WorkflowInput {
  readonly skillPath: string;
  readonly prompt: string;
  readonly fixtureContext?: "opportunity";
}

interface Invocation {
  readonly exitCode: number;
  readonly envelope: CliMachineEnvelope;
}

async function invoke(args: readonly string[], workspace: string): Promise<Invocation> {
  const commandArgs = [...args, "--workspace", workspace, "--json"];
  try {
    const result = await exec(process.execPath, [executable, ...commandArgs], { cwd: repositoryRoot });
    return { exitCode: 0, envelope: JSON.parse(result.stdout) as CliMachineEnvelope };
  } catch (error) {
    const failure = error as Error & { code: number; stdout: string };
    return { exitCode: failure.code, envelope: JSON.parse(failure.stdout) as CliMachineEnvelope };
  }
}

function requireSkillPolicy(skill: string): void {
  const requiredRules = [
    "Run `idea-finder workspace diagnostics --json` before mutating a workspace.",
    "Use `--json` for every command.",
    "Treat calibration and validation mutations as human decisions.",
    "ask for an explicit user decision before calling `board calibrate`, `validation add`, or `validation complete`",
  ];
  for (const rule of requiredRules) {
    if (!skill.includes(rule)) throw new Error(`Skill is missing required workflow policy: ${rule}`);
  }
}

function commandName(envelope: CliMachineEnvelope): string {
  return envelope.command;
}

async function execute(
  args: readonly string[],
  workspace: string,
  trace: SkillWorkflowCommand[],
): Promise<CliMachineEnvelope> {
  const result = await invoke(args, workspace);
  trace.push({ command: commandName(result.envelope), exitCode: result.exitCode, envelope: result.envelope });
  return result.envelope;
}

function findString(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  if (key in value && typeof (value as Record<string, unknown>)[key] === "string") {
    return (value as Record<string, string>)[key];
  }
  for (const child of Object.values(value)) {
    const found = findString(child, key);
    if (found) return found;
  }
  return undefined;
}

async function prepareOpportunity(workspace: string): Promise<{ opportunityId: string; runId: string }> {
  await invoke(["brief", "create", "skill-validation", "--title", "Skill validation"], workspace);
  const run = await invoke(["run", "skill-validation", "--fixture"], workspace);
  const runId = findString(run.envelope.data, "runId") ?? findString(run.envelope.data, "id");
  const library = await invoke(["library", "--brief", "skill-validation"], workspace);
  const opportunities = (library.envelope.data as { opportunities?: Array<{ id: string }> }).opportunities;
  if (!runId || !opportunities?.[0]) throw new Error("Could not prepare validation fixture context");
  return { opportunityId: opportunities[0].id, runId };
}

export async function runSkillWorkflow(input: WorkflowInput): Promise<SkillWorkflowTrace> {
  const skill = await readFile(input.skillPath, "utf8");
  requireSkillPolicy(skill);
  const workspace = await mkdtemp(path.join(os.tmpdir(), "idea-finder-skill-eval-"));
  const commands: SkillWorkflowCommand[] = [];
  try {
    if (/发现|discover/i.test(input.prompt)) {
      await execute(["workspace", "diagnostics"], workspace, commands);
      await execute([
        "brief", "create", "agent-coding-demand",
        "--title", "Agent coding demand",
        "--manual-import", "Agent coding coordination is painful and this manual workaround repeats every week.",
      ], workspace, commands);
      const run = await execute(["research", "run", "agent-coding-demand"], workspace, commands);
      const runId = findString(run.data, "runId");
      if (!runId) throw new Error("Research command did not return a runId");
      const inspected = await execute(["research", "inspect", runId], workspace, commands);
      const evidenceCount = Array.isArray((inspected.data as { details?: unknown[] }).details)
        ? (inspected.data as { details: unknown[] }).details.length
        : 0;
      return {
        commands,
        response: `Stored evidence: ${evidenceCount} inspectable item(s).\nInference: repeated coordination pain is a candidate demand signal.\nContradictory evidence: none stored.\nUnresolved uncertainty: willingness to pay remains untested.`,
        pausedForHumanDecision: false,
      };
    }

    if (/验证实验|validation/i.test(input.prompt) && input.fixtureContext === "opportunity") {
      const context = await prepareOpportunity(workspace);
      const inspected = await execute(["library", "inspect", context.opportunityId, "--run", context.runId], workspace, commands);
      return {
        commands,
        response: `Stored evidence: Opportunity ${findString(inspected.data, "id") ?? context.opportunityId} was inspected.\nInference: a validation experiment could reduce uncertainty.\nUnresolved uncertainty: experiment type and hypothesis are not approved.\nHuman decision required: approve the experiment type and hypothesis before mutation.`,
        pausedForHumanDecision: true,
      };
    }

    throw new Error("The deterministic Skill harness could not route this representative prompt");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}
