import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentKind } from "@idea-finder/agents";
import type { CalibrationAction, ValidationExperimentType, ValidationOutcome } from "@idea-finder/core";
import { renderMarkdownReport } from "../report/markdown-export.js";
import { resolveWorkspacePaths } from "../storage/workspace-store.js";
import { WorkspaceService } from "../workspace-service.js";
import {
  CLI_CONTRACT_VERSION,
  CLI_EXIT_CODES,
  CliFailure,
  type CliErrorCategory,
  type CliMachineEnvelope,
  type CliStructuredError,
} from "./contract.js";

const DEFAULT_WORKSPACE = "data/workspace";

export interface CliOptions {
  readonly workspaceDir?: string;
  readonly stdout?: (line: string) => void;
  readonly stderr?: (line: string) => void;
}

export interface CommandResult {
  readonly command: string;
  readonly data: unknown;
  readonly human: string;
  readonly warnings?: readonly string[];
  readonly incompleteness?: readonly string[];
  readonly exitCode?: number;
}

const ACTIONS = ["promote", "reject", "park", "needs_more_evidence"] as const;
const EXPERIMENT_TYPES = ["mom_test", "landing", "community_test", "spike", "custom"] as const;
const OUTCOMES = ["validated", "invalidated", "inconclusive", "blocked"] as const;
const CADENCES = ["manual", "daily", "weekly"] as const;
const AGENT_KINDS = ["research", "browser", "computer", "coding"] as const;

function usage(): string {
  return `idea-finder — local demand workspace CLI

Usage:
  idea-finder workspace diagnostics
  idea-finder brief create <slug> --title <text> [--description <text>] [--lens <l1,l2>] [--manual-import <text> ...]
  idea-finder brief list
  idea-finder run <brief> [--fixture]
  idea-finder run <brief> --retry <runId>
  idea-finder run <brief> --resume <runId>
  idea-finder inbox [--brief <slug>]
  idea-finder library [--brief <slug>]
  idea-finder library inspect <opportunityId> [--run <runId>]
  idea-finder library rejected --run <runId>
  idea-finder board calibrate <opportunityId> --action <promote|reject|park|needs_more_evidence> [--run <runId>] [--note <text>]
  idea-finder validation add <opportunityId> --type <mom_test|landing|community_test|spike|custom> --hypothesis <text> [--run <runId>] [--start]
  idea-finder validation list [--opportunity <id>]
  idea-finder validation complete <experimentId> --outcome <validated|invalidated|inconclusive|blocked> --summary <text>
  idea-finder monitor diff --brief <slug> --baseline <runId> --compare <runId>
  idea-finder monitor schedule <brief> --cadence <manual|daily|weekly> [--enabled <true|false>]
  idea-finder export <brief> [--out <path.md>]
  idea-finder agent list
  idea-finder agent create --kind <research|browser|computer|coding> --intent <text> [--opportunity <id>] [--evidence <id,id>] [--domain-write] [--dry-run]
  idea-finder agent run <taskId>

Options:
  --workspace <dir>   Workspace data directory (default: data/workspace)
  --json              Emit the versioned machine envelope
  --help              Show this help
`;
}

function flag(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) usageFailure("cli.flag_value_required", `${name} requires a value`);
  return value;
}

function flags(argv: readonly string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== name) continue;
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) usageFailure("cli.flag_value_required", `${name} requires a value`);
    values.push(value);
  }
  return values;
}

function has(argv: readonly string[], name: string): boolean {
  return argv.includes(name);
}

function required(value: string | undefined, code: string, message: string): string {
  if (!value) usageFailure(code, message);
  return value;
}

function oneOf<T extends string>(value: string, values: readonly T[], label: string): T {
  if (!values.includes(value as T)) {
    throw new CliFailure("validation", "cli.invalid_value", `${label} must be one of: ${values.join(", ")}`, CLI_EXIT_CODES.validation, { label, value, allowed: values });
  }
  return value as T;
}

function usageFailure(code: string, message: string): never {
  throw new CliFailure("usage", code, message, CLI_EXIT_CODES.usage);
}

function svc(workspaceDir: string, mode: "fixture" | "orchestration" = "orchestration"): WorkspaceService {
  return new WorkspaceService({
    paths: resolveWorkspacePaths(workspaceDir),
    runnerMode: mode,
  });
}

function commandName(argv: readonly string[]): string {
  const positional = argv.filter((value, index) => {
    if (value.startsWith("--")) return false;
    const previous = argv[index - 1];
    return previous !== "--workspace" && previous !== "--format";
  });
  return positional.slice(0, 2).join(" ") || "help";
}

interface ArgumentShape {
  readonly valueFlags: readonly string[];
  readonly booleanFlags?: readonly string[];
  readonly positionalCount: number;
}

const ARGUMENT_SHAPES: Readonly<Record<string, ArgumentShape>> = {
  "workspace diagnostics": { valueFlags: [], positionalCount: 2 },
  "brief create": { valueFlags: ["--title", "--description", "--lens", "--manual-import"], positionalCount: 3 },
  "brief list": { valueFlags: [], positionalCount: 2 },
  run: { valueFlags: ["--retry", "--resume"], booleanFlags: ["--fixture", "--orchestration"], positionalCount: 2 },
  inbox: { valueFlags: ["--brief"], positionalCount: 1 },
  library: { valueFlags: ["--brief"], positionalCount: 1 },
  "library inspect": { valueFlags: ["--run"], positionalCount: 3 },
  "library rejected": { valueFlags: ["--run"], positionalCount: 2 },
  "board calibrate": { valueFlags: ["--action", "--note", "--run"], positionalCount: 3 },
  "validation add": { valueFlags: ["--type", "--hypothesis", "--run"], booleanFlags: ["--start"], positionalCount: 3 },
  "validation list": { valueFlags: ["--opportunity"], positionalCount: 2 },
  "validation complete": { valueFlags: ["--outcome", "--summary"], positionalCount: 3 },
  "monitor diff": { valueFlags: ["--brief", "--baseline", "--compare"], positionalCount: 2 },
  "monitor schedule": { valueFlags: ["--cadence", "--enabled"], positionalCount: 3 },
  export: { valueFlags: ["--out"], positionalCount: 2 },
  "agent list": { valueFlags: [], positionalCount: 2 },
  "agent create": { valueFlags: ["--kind", "--intent", "--opportunity", "--evidence"], booleanFlags: ["--domain-write", "--dry-run"], positionalCount: 2 },
  "agent run": { valueFlags: [], positionalCount: 3 },
};

function validateArguments(argv: readonly string[]): void {
  const [cmd, sub] = argv;
  const key = cmd === "run" || cmd === "inbox" || cmd === "export" || (cmd === "library" && (!sub || sub.startsWith("--"))) ? cmd : `${cmd ?? ""} ${sub ?? ""}`.trim();
  const shape = ARGUMENT_SHAPES[key];
  if (!shape) return;
  const valueFlags = new Set(shape.valueFlags);
  const booleanFlags = new Set(shape.booleanFlags ?? []);
  const positional: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]!;
    if (value.startsWith("--")) {
      if (!valueFlags.has(value) && !booleanFlags.has(value)) {
        usageFailure("cli.unknown_option", `Unknown option for ${key}: ${value}`);
      }
      if (valueFlags.has(value)) index += 1;
      continue;
    }
    positional.push(value);
  }
  if (positional.length > shape.positionalCount) {
    usageFailure("cli.unexpected_argument", `Unexpected argument for ${key}: ${positional[shape.positionalCount]}`);
  }
}

async function execute(argv: string[], workspaceDir: string): Promise<CommandResult> {
  const [cmd, sub, ...rest] = argv;
  if (!cmd || cmd === "help" || has(argv, "--help")) {
    return { command: "help", data: { usage: usage() }, human: usage() };
  }
  validateArguments(argv);

  if (cmd === "workspace" && sub === "diagnostics") {
    await mkdir(workspaceDir, { recursive: true });
    const service = svc(workspaceDir);
    const [briefs, state] = await Promise.all([service.listBriefs(), service.getState()]);
    const data = {
      workspace: path.resolve(workspaceDir),
      accessible: true,
      runnerMode: "orchestration",
      counts: {
        briefs: briefs.length,
        researchRuns: Object.keys(state.runs).length,
        opportunities: Object.keys(state.opportunities).length,
        agentTasks: Object.keys(state.agentTasks).length,
      },
    };
    return { command: "workspace diagnostics", data, human: `Workspace ${data.workspace}\nStatus: accessible\nBriefs: ${data.counts.briefs}; runs: ${data.counts.researchRuns}; opportunities: ${data.counts.opportunities}` };
  }

  if (cmd === "brief" && sub === "create") {
    const slug = required(rest[0], "brief.slug_required", "brief create requires <slug>");
    const title = required(flag(rest, "--title"), "brief.title_required", "--title is required");
    const lensesRaw = flag(rest, "--lens");
    const manualImports = flags(rest, "--manual-import").map((text) => ({ text }));
    const brief = await svc(workspaceDir).createBrief({
      slug,
      title,
      description: flag(rest, "--description") ?? "",
      lenses: lensesRaw?.split(",").map((item) => item.trim()),
      queryPlan: manualImports.length > 0 ? { harvestMode: "manual", manualImports } : undefined,
    });
    return { command: "brief create", data: { brief }, human: `Created brief ${brief.slug} (${brief.id})` };
  }

  if (cmd === "brief" && sub === "list") {
    const briefs = await svc(workspaceDir).listBriefs();
    const human = briefs.length === 0 ? "No briefs yet." : ["slug\tid\ttitle", ...briefs.map((brief) => `${brief.slug}\t${brief.id}\t${brief.title}`)].join("\n");
    return { command: "brief list", data: { briefs }, human };
  }

  if (cmd === "run") {
    const brief = required(sub, "run.brief_required", "run requires <brief>");
    const retryRunId = flag(rest, "--retry");
    const resumeRunId = flag(rest, "--resume");
    const fixture = has(rest, "--fixture");
    if ([retryRunId, resumeRunId].filter(Boolean).length > 1) {
      throw new CliFailure("validation", "run.execution_conflict", "Use only one of --retry or --resume", CLI_EXIT_CODES.validation);
    }
    if (fixture && (retryRunId || resumeRunId)) {
      throw new CliFailure("validation", "run.fixture_named_run_forbidden", "Fixture mode cannot retry or resume a persisted run", CLI_EXIT_CODES.validation);
    }
    const execution = retryRunId ? "retried" : resumeRunId ? "resumed" : "new";
    const stored = await svc(workspaceDir, fixture ? "fixture" : "orchestration").runResearch(brief, {
      execution,
      runId: (retryRunId ?? resumeRunId) as never,
    });
    if (stored.run.status === "failed") {
      throw new CliFailure(
        "internal",
        "run.failed",
        stored.run.errorMessage ?? `ResearchRun failed: ${stored.run.id}`,
        CLI_EXIT_CODES.internal,
        { execution: stored.execution, run: stored.run },
      );
    }
    const incomplete = stored.run.status === "partial" ? ["ResearchRun completed with partial results"] : undefined;
    return {
      command: "run",
      data: stored,
      human: `Run ${stored.run.id} ${stored.execution} → ${stored.run.status} — admitted ${stored.admittedCount} opportunities (${stored.rejected.length} rejected)`,
      incompleteness: incomplete,
      exitCode: incomplete ? CLI_EXIT_CODES.partialResult : undefined,
    };
  }

  if (cmd === "inbox") {
    const result = await svc(workspaceDir).getInboxSummary(flag(argv, "--brief"));
    const human = !result.runId ? "No research runs yet." : [`Inbox for run ${result.runId}:`, ...(result.inbox.length === 0 ? ["  (empty)"] : result.inbox.map((row) => `  ${row.signalType}: ${row.count} — "${row.sampleQuote.slice(0, 60)}..."`))].join("\n");
    return { command: "inbox", data: result, human };
  }

  if (cmd === "library" && sub === "inspect") {
    const opportunityId = required(rest[0], "library.opportunity_required", "library inspect requires <opportunityId>");
    const result = await svc(workspaceDir).inspectOpportunity(opportunityId, flag(rest, "--run") as never);
    return { command: "library inspect", data: result, human: `${result.opportunity.id}\t${result.opportunity.status}\t${result.opportunity.demandStatement}` };
  }

  if (cmd === "library" && sub === "rejected") {
    const runId = required(flag(rest, "--run"), "library.run_required", "library rejected requires --run <runId>");
    const results = (await svc(workspaceDir).listAdmissionResults(runId as never)).filter((result) => result.decision === "rejected");
    return { command: "library rejected", data: { runId, results }, human: results.length === 0 ? "No rejected drafts." : results.map((result) => `${result.id}\t${result.issues.map((issue) => issue.code).join(",")}`).join("\n") };
  }

  if (cmd === "library") {
    const service = svc(workspaceDir);
    const brief = flag(argv, "--brief");
    const [opportunities, entries] = await Promise.all([
      service.listOpportunities(brief),
      service.listOpportunityEntries(brief),
    ]);
    const human = entries.length === 0 ? "Opportunity library is empty." : ["id\trun\tstatus\tconfidence\tevidence\tdemand", ...entries.map(({ runId, opportunity }) => `${opportunity.id}\t${runId}\t${opportunity.status}\t${opportunity.confidence}\t${opportunity.evidenceItemIds.length}\t${opportunity.demandStatement}`)].join("\n");
    return { command: "library", data: { opportunities, entries }, human };
  }

  if (cmd === "board" && sub === "calibrate") {
    const opportunityId = required(rest[0], "board.opportunity_required", "board calibrate requires <opportunityId>");
    const action = oneOf(required(flag(rest, "--action"), "board.action_required", "--action is required"), ACTIONS, "action") as CalibrationAction;
    const result = await svc(workspaceDir).applyBoardCalibration({ opportunityId, action, note: flag(rest, "--note") ?? null, runId: flag(rest, "--run") as never });
    return { command: "board calibrate", data: result, human: `Calibrated ${result.opportunity.id} → ${result.opportunity.status}` };
  }

  if (cmd === "validation" && sub === "add") {
    const opportunityId = required(rest[0], "validation.opportunity_required", "validation add requires <opportunityId>");
    const type = oneOf(required(flag(rest, "--type"), "validation.type_required", "--type is required"), EXPERIMENT_TYPES, "type") as ValidationExperimentType;
    const hypothesis = required(flag(rest, "--hypothesis"), "validation.hypothesis_required", "--hypothesis is required");
    const experiment = await svc(workspaceDir).createValidationExperiment({ opportunityId, type, hypothesis, runId: flag(rest, "--run") as never, start: has(rest, "--start") });
    return { command: "validation add", data: { experiment }, human: `Created validation ${experiment.id} (${experiment.status}) for ${opportunityId}` };
  }

  if (cmd === "validation" && sub === "list") {
    const experiments = await svc(workspaceDir).listValidationExperiments(flag(rest, "--opportunity"));
    const human = experiments.length === 0 ? "No validation experiments." : ["id\topportunity\tstatus\ttype\thypothesis", ...experiments.map((item) => `${item.id}\t${item.opportunityId}\t${item.status}\t${item.type}\t${item.hypothesis.slice(0, 60)}`)].join("\n");
    return { command: "validation list", data: { experiments }, human };
  }

  if (cmd === "validation" && sub === "complete") {
    const experimentId = required(rest[0], "validation.experiment_required", "validation complete requires <experimentId>");
    const outcome = oneOf(required(flag(rest, "--outcome"), "validation.outcome_required", "--outcome is required"), OUTCOMES, "outcome") as ValidationOutcome;
    const summary = required(flag(rest, "--summary"), "validation.summary_required", "--summary is required");
    const result = await svc(workspaceDir).completeValidationExperiment({ experimentId, outcome, summary });
    return { command: "validation complete", data: result, human: `Completed ${result.experiment.id} → ${result.experiment.result?.outcome}; opportunity ${result.opportunity.id} now ${result.opportunity.status}/${result.opportunity.confidence}` };
  }

  if (cmd === "monitor" && sub === "diff") {
    const briefSlugOrId = required(flag(rest, "--brief"), "monitor.brief_required", "--brief is required");
    const baselineRunId = required(flag(rest, "--baseline"), "monitor.baseline_required", "--baseline is required");
    const compareRunId = required(flag(rest, "--compare"), "monitor.compare_required", "--compare is required");
    const diff = await svc(workspaceDir).compareMonitorDiff({ briefSlugOrId, baselineRunId: baselineRunId as never, compareRunId: compareRunId as never });
    return { command: "monitor diff", data: { diff }, human: `Monitor diff ${diff.baselineRunId} → ${diff.compareRunId}: +${diff.summary.added} heated=${diff.summary.heated} cooled=${diff.summary.cooled} unchanged=${diff.summary.unchanged}` };
  }

  if (cmd === "monitor" && sub === "schedule") {
    const briefSlugOrId = required(rest[0], "monitor.brief_required", "monitor schedule requires <brief>");
    const cadence = oneOf(required(flag(rest, "--cadence"), "monitor.cadence_required", "--cadence is required"), CADENCES, "cadence");
    const enabledRaw = flag(rest, "--enabled");
    if (enabledRaw !== undefined && !["true", "false", "1", "0"].includes(enabledRaw)) throw new CliFailure("validation", "monitor.enabled_invalid", "--enabled must be true or false", CLI_EXIT_CODES.validation);
    const schedule = await svc(workspaceDir).setMonitorSchedule({ briefSlugOrId, cadence, enabled: enabledRaw === undefined ? undefined : enabledRaw === "true" || enabledRaw === "1" });
    return { command: "monitor schedule", data: { schedule }, human: `Monitor schedule ${schedule.id}: cadence=${schedule.cadence} enabled=${schedule.enabled}` };
  }

  if (cmd === "export") {
    const briefRef = required(sub, "export.brief_required", "export requires <brief>");
    const service = svc(workspaceDir);
    const brief = await service.getBrief(briefRef);
    if (!brief) throw new CliFailure("missing-resource", "brief.not_found", `Brief not found: ${briefRef}`, CLI_EXIT_CODES.missingResource, { brief: briefRef });
    const state = await service.getState();
    const { runId, inbox } = await service.getInboxSummary(briefRef);
    const opportunities = await service.listOpportunities(briefRef);
    const markdown = renderMarkdownReport({ brief, opportunities, calibrationEvents: state.calibrationEvents.filter((event) => opportunities.some((item) => item.id === event.opportunityId)), evidenceById: state.evidenceById, inbox, runId });
    const outputPath = flag(rest, "--out");
    if (outputPath) await writeFile(path.resolve(outputPath), markdown, "utf8");
    return { command: "export", data: { briefId: brief.id, outputPath: outputPath ? path.resolve(outputPath) : null, markdown }, human: outputPath ? `Wrote ${path.resolve(outputPath)}` : markdown };
  }

  if (cmd === "agent" && sub === "list") {
    const tasks = await svc(workspaceDir).listAgentTasks();
    const human = tasks.length === 0 ? "No agent tasks yet." : ["id\tkind\tstatus\topportunity\tintent", ...tasks.map((task) => `${task.id}\t${task.kind}\t${task.status}\t${task.opportunityId ?? ""}\t${task.intent}`)].join("\n");
    return { command: "agent list", data: { tasks }, human };
  }

  if (cmd === "agent" && sub === "create") {
    const kind = oneOf(required(flag(rest, "--kind"), "agent.kind_required", "--kind is required"), AGENT_KINDS, "kind") as AgentKind;
    const intent = required(flag(rest, "--intent"), "agent.intent_required", "--intent is required");
    const evidenceRaw = flag(rest, "--evidence");
    const task = await svc(workspaceDir).createAgentTask({ kind, intent, opportunityId: flag(rest, "--opportunity") ?? null, evidenceIds: evidenceRaw?.split(",").map((item) => item.trim()).filter(Boolean), dryRun: has(rest, "--dry-run"), domainWrite: has(rest, "--domain-write") });
    return { command: "agent create", data: { task }, human: `Created agent task ${task.id} (${task.kind}, ${task.status})` };
  }

  if (cmd === "agent" && sub === "run") {
    const taskId = required(rest[0], "agent.task_required", "agent run requires <taskId>");
    const task = await svc(workspaceDir).runAgentTask(taskId);
    const denials = task.invocations.at(-1)?.policyDenials ?? [];
    if (task.status === "blocked") throw new CliFailure("policy", denials[0]?.code ?? "policy.denied", denials[0]?.reason ?? "Agent task blocked by policy", CLI_EXIT_CODES.policy, { task, denials });
    if (task.invocations.at(-1)?.resultStatus === "partial") return { command: "agent run", data: { task }, human: `Agent task ${task.id} → partial`, incompleteness: ["agent task returned a partial result"], exitCode: CLI_EXIT_CODES.partialResult };
    if (task.status === "failed") throw new CliFailure("internal", "agent.failed", `Agent task ${task.id} failed`, CLI_EXIT_CODES.internal, { task });
    return { command: "agent run", data: { task }, human: `Agent task ${task.id} → ${task.status}` };
  }

  usageFailure("cli.unknown_command", `Unknown command: ${cmd}${sub ? ` ${sub}` : ""}`);
}

function classify(error: unknown): CliFailure {
  if (error instanceof CliFailure) return error;
  if (error instanceof Error && error.name === "InvariantViolation") {
    return new CliFailure("validation", (error as Error & { code?: string }).code ?? "domain.invalid", error.message, CLI_EXIT_CODES.validation);
  }
  if (error instanceof Error && /not found/i.test(error.message)) {
    return new CliFailure("missing-resource", "resource.not_found", error.message, CLI_EXIT_CODES.missingResource);
  }
  if (error instanceof Error && /configuration mismatch/i.test(error.message)) {
    return new CliFailure("validation", "run.configuration_mismatch", error.message, CLI_EXIT_CODES.validation);
  }
  return new CliFailure("internal", "internal.unexpected", error instanceof Error ? error.message : String(error), CLI_EXIT_CODES.internal);
}

export function createMachineEnvelope(command: string, result?: CommandResult, failure?: CliFailure): CliMachineEnvelope {
  const reasons = result?.incompleteness ?? [];
  const errors: CliStructuredError[] = failure
    ? [{ category: failure.category, code: failure.code, message: failure.message, details: failure.details }]
    : reasons.length > 0
      ? [{ category: "partial-result", code: "result.partial", message: "Command completed with incomplete results", details: { reasons } }]
      : [];
  return {
    contractVersion: CLI_CONTRACT_VERSION,
    command,
    status: failure ? "error" : reasons.length > 0 ? "partial" : "success",
    data: failure?.details ?? result?.data ?? null,
    warnings: result?.warnings ?? [],
    incompleteness: { incomplete: reasons.length > 0, reasons },
    errors,
  };
}

export async function runCli(argv: string[], opts: CliOptions = {}): Promise<number> {
  const stdout = opts.stdout ?? ((line: string) => console.log(line));
  const stderr = opts.stderr ?? ((line: string) => console.error(line));
  let machine = has(argv, "--json");
  let name = commandName(argv);
  try {
    const format = flag(argv, "--format");
    if (format !== undefined && format !== "json") {
      throw new CliFailure("validation", "cli.format_invalid", "--format must be json", CLI_EXIT_CODES.validation, { format });
    }
    machine = machine || format === "json";
    const workspaceDir = flag(argv, "--workspace") ?? opts.workspaceDir ?? DEFAULT_WORKSPACE;
    const filtered = argv.filter((value, index) => !["--json", "--workspace", "--format"].includes(value) && !["--workspace", "--format"].includes(argv[index - 1] ?? ""));
    name = commandName(filtered);
    const result = await execute(filtered, workspaceDir);
    if (machine) stdout(JSON.stringify(createMachineEnvelope(result.command, result)));
    else for (const line of result.human.split("\n")) stdout(line);
    return result.exitCode ?? CLI_EXIT_CODES.success;
  } catch (error) {
    const failure = classify(error);
    if (machine) stdout(JSON.stringify(createMachineEnvelope(name, undefined, failure)));
    else {
      if (failure.category === "policy" && failure.details?.task && typeof failure.details.task === "object" && "id" in failure.details.task) {
        const task = failure.details.task as { id: string; status?: string };
        stdout(`Agent task ${task.id} → ${task.status ?? "blocked"}`);
      }
      stderr(failure.category === "policy" ? `${failure.code}: ${failure.message}` : failure.message);
      if (failure.category === "usage") stderr(usage());
    }
    return failure.exitCode;
  }
}

export type { CliErrorCategory, CliMachineEnvelope } from "./contract.js";
