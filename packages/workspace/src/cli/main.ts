import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { CalibrationAction, ValidationExperimentType, ValidationOutcome } from "@idea-finder/core";
import type { AgentKind } from "@idea-finder/agents";
import { renderMarkdownReport } from "../report/markdown-export.js";
import { resolveWorkspacePaths } from "../storage/workspace-store.js";
import { WorkspaceService } from "../workspace-service.js";

const DEFAULT_WORKSPACE = "data/workspace";

export interface CliOptions {
  readonly workspaceDir?: string;
  readonly stdout?: (line: string) => void;
  readonly stderr?: (line: string) => void;
}

function out(opts: CliOptions): (line: string) => void {
  return opts.stdout ?? ((line) => console.log(line));
}

function err(opts: CliOptions): (line: string) => void {
  return opts.stderr ?? ((line) => console.error(line));
}

function parseFlag(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  if (idx === -1) return undefined;
  return argv[idx + 1];
}

function hasFlag(argv: string[], flag: string): boolean {
  return argv.includes(flag);
}

function usage(): string {
  return `idea-finder — local demand workspace CLI

Usage:
  idea-finder brief create <slug> --title <text> [--description <text>] [--lens <l1,l2>]
  idea-finder brief list
  idea-finder run <brief> [--orchestration]
  idea-finder inbox [--brief <slug>]
  idea-finder library [--brief <slug>]
  idea-finder board calibrate <opportunityId> --action <promote|reject|park|needs_more_evidence> [--note <text>]
  idea-finder validation add <opportunityId> --type <mom_test|landing|community_test|spike|custom> --hypothesis <text> [--start]
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
`;
}

function service(opts: CliOptions): WorkspaceService {
  const root = opts.workspaceDir ?? DEFAULT_WORKSPACE;
  const mode = process.env.IDEA_FINDER_RUNNER === "orchestration" ? "orchestration" : "fixture";
  return new WorkspaceService({
    paths: resolveWorkspacePaths(root),
    runnerMode: mode,
  });
}

async function cmdBriefCreate(argv: string[], opts: CliOptions): Promise<number> {
  const slug = argv[0];
  if (!slug) {
    err(opts)("brief create requires <slug>");
    return 1;
  }
  const title = parseFlag(argv, "--title");
  if (!title) {
    err(opts)("--title is required");
    return 1;
  }
  const description = parseFlag(argv, "--description") ?? "";
  const lensesRaw = parseFlag(argv, "--lens");
  const lenses = lensesRaw ? lensesRaw.split(",").map((s) => s.trim()) : undefined;

  const brief = await service(opts).createBrief({ slug, title, description, lenses });
  out(opts)(`Created brief ${brief.slug} (${brief.id})`);
  return 0;
}

async function cmdBriefList(_argv: string[], opts: CliOptions): Promise<number> {
  const briefs = await service(opts).listBriefs();
  if (briefs.length === 0) {
    out(opts)("No briefs yet.");
    return 0;
  }
  out(opts)("slug\tid\ttitle");
  for (const b of briefs) {
    out(opts)(`${b.slug}\t${b.id}\t${b.title}`);
  }
  return 0;
}

async function cmdRun(argv: string[], opts: CliOptions): Promise<number> {
  const slug = argv[0];
  if (!slug) {
    err(opts)("run requires <brief>");
    return 1;
  }
  if (hasFlag(argv, "--orchestration")) {
    process.env.IDEA_FINDER_RUNNER = "orchestration";
  }
  const stored = await service(opts).runResearch(slug);
  out(opts)(
    `Run ${stored.run.id} completed — admitted ${stored.admittedCount} opportunities (${stored.rejected.length} rejected)`,
  );
  return 0;
}

async function cmdInbox(argv: string[], opts: CliOptions): Promise<number> {
  const brief = parseFlag(argv, "--brief");
  const { runId, inbox } = await service(opts).getInboxSummary(brief);
  if (!runId) {
    out(opts)("No research runs yet.");
    return 0;
  }
  out(opts)(`Inbox for run ${runId}:`);
  if (inbox.length === 0) {
    out(opts)("  (empty)");
    return 0;
  }
  for (const row of inbox) {
    out(opts)(`  ${row.signalType}: ${row.count} — "${row.sampleQuote.slice(0, 60)}..."`);
  }
  return 0;
}

async function cmdLibrary(argv: string[], opts: CliOptions): Promise<number> {
  const brief = parseFlag(argv, "--brief");
  const opps = await service(opts).listOpportunities(brief);
  if (opps.length === 0) {
    out(opts)("Opportunity library is empty.");
    return 0;
  }
  out(opts)("id\tstatus\tconfidence\tevidence\tdemand");
  for (const o of opps) {
    out(opts)(
      `${o.id}\t${o.status}\t${o.confidence}\t${o.evidenceItemIds.length}\t${o.demandStatement}`,
    );
  }
  return 0;
}

async function cmdBoardCalibrate(argv: string[], opts: CliOptions): Promise<number> {
  const oppId = argv[0];
  const actionRaw = parseFlag(argv, "--action");
  if (!oppId || !actionRaw) {
    err(opts)("board calibrate requires <opportunityId> --action <action>");
    return 1;
  }
  const action = actionRaw as CalibrationAction;
  const note = parseFlag(argv, "--note") ?? null;
  const result = await service(opts).applyBoardCalibration({
    opportunityId: oppId,
    action,
    note,
  });
  out(opts)(`Calibrated ${result.opportunity.id} → ${result.opportunity.status}`);
  return 0;
}

async function cmdValidationAdd(argv: string[], opts: CliOptions): Promise<number> {
  const oppId = argv[0];
  const typeRaw = parseFlag(argv, "--type");
  const hypothesis = parseFlag(argv, "--hypothesis");
  if (!oppId || !typeRaw || !hypothesis) {
    err(opts)("validation add requires <opportunityId> --type <type> --hypothesis <text>");
    return 1;
  }
  const experiment = await service(opts).createValidationExperiment({
    opportunityId: oppId,
    type: typeRaw as ValidationExperimentType,
    hypothesis,
    start: hasFlag(argv, "--start"),
  });
  out(opts)(`Created validation ${experiment.id} (${experiment.status}) for ${oppId}`);
  return 0;
}

async function cmdValidationList(argv: string[], opts: CliOptions): Promise<number> {
  const opportunityId = parseFlag(argv, "--opportunity");
  const experiments = await service(opts).listValidationExperiments(opportunityId);
  if (experiments.length === 0) {
    out(opts)("No validation experiments.");
    return 0;
  }
  out(opts)("id\topportunity\tstatus\ttype\thypothesis");
  for (const e of experiments) {
    out(opts)(
      `${e.id}\t${e.opportunityId}\t${e.status}\t${e.type}\t${e.hypothesis.slice(0, 60)}`,
    );
  }
  return 0;
}

async function cmdValidationComplete(argv: string[], opts: CliOptions): Promise<number> {
  const experimentId = argv[0];
  const outcomeRaw = parseFlag(argv, "--outcome");
  const summary = parseFlag(argv, "--summary");
  if (!experimentId || !outcomeRaw || !summary) {
    err(opts)(
      "validation complete requires <experimentId> --outcome <outcome> --summary <text>",
    );
    return 1;
  }
  const result = await service(opts).completeValidationExperiment({
    experimentId,
    outcome: outcomeRaw as ValidationOutcome,
    summary,
  });
  out(opts)(
    `Completed ${result.experiment.id} → ${result.experiment.result?.outcome}; opportunity ${result.opportunity.id} now ${result.opportunity.status}/${result.opportunity.confidence}`,
  );
  return 0;
}

async function cmdMonitorDiff(argv: string[], opts: CliOptions): Promise<number> {
  const brief = parseFlag(argv, "--brief");
  const baseline = parseFlag(argv, "--baseline");
  const compare = parseFlag(argv, "--compare");
  if (!brief || !baseline || !compare) {
    err(opts)("monitor diff requires --brief <slug> --baseline <runId> --compare <runId>");
    return 1;
  }
  const diff = await service(opts).compareMonitorDiff({
    briefSlugOrId: brief,
    baselineRunId: baseline as never,
    compareRunId: compare as never,
  });
  out(opts)(
    `Monitor diff ${diff.baselineRunId} → ${diff.compareRunId}: +${diff.summary.added} heated=${diff.summary.heated} cooled=${diff.summary.cooled} unchanged=${diff.summary.unchanged}`,
  );
  for (const entry of diff.entries) {
    out(opts)(
      `  ${entry.kind}\t${entry.demandStatement.slice(0, 50)}\tevidenceΔ=${entry.evidenceCountDelta}`,
    );
  }
  return 0;
}

async function cmdMonitorSchedule(argv: string[], opts: CliOptions): Promise<number> {
  const brief = argv[0];
  const cadenceRaw = parseFlag(argv, "--cadence");
  if (!brief || !cadenceRaw) {
    err(opts)("monitor schedule requires <brief> --cadence <manual|daily|weekly>");
    return 1;
  }
  const enabledRaw = parseFlag(argv, "--enabled");
  const enabled =
    enabledRaw === undefined ? undefined : enabledRaw === "true" || enabledRaw === "1";
  const schedule = await service(opts).setMonitorSchedule({
    briefSlugOrId: brief,
    cadence: cadenceRaw as "manual" | "daily" | "weekly",
    enabled,
  });
  out(opts)(`Monitor schedule ${schedule.id}: cadence=${schedule.cadence} enabled=${schedule.enabled}`);
  return 0;
}

async function cmdExport(argv: string[], opts: CliOptions): Promise<number> {
  const slug = argv[0];
  if (!slug) {
    err(opts)("export requires <brief>");
    return 1;
  }
  const svc = service(opts);
  const brief = await svc.getBrief(slug);
  if (!brief) {
    err(opts)(`Brief not found: ${slug}`);
    return 1;
  }
  const state = await svc.getState();
  const { runId, inbox } = await svc.getInboxSummary(slug);
  const opportunities = await svc.listOpportunities(slug);
  const events = state.calibrationEvents.filter((e) =>
    opportunities.some((o) => o.id === e.opportunityId),
  );

  const markdown = renderMarkdownReport({
    brief,
    opportunities,
    calibrationEvents: events,
    evidenceById: state.evidenceById,
    inbox,
    runId,
  });

  const outPath = parseFlag(argv, "--out");
  if (outPath) {
    const abs = path.resolve(outPath);
    await writeFile(abs, markdown, "utf8");
    out(opts)(`Wrote ${abs}`);
  } else {
    out(opts)(markdown);
  }
  return 0;
}

async function cmdAgentList(_argv: string[], opts: CliOptions): Promise<number> {
  const tasks = await service(opts).listAgentTasks();
  if (tasks.length === 0) {
    out(opts)("No agent tasks yet.");
    return 0;
  }
  out(opts)("id\tkind\tstatus\topportunity\tintent");
  for (const task of tasks) {
    out(opts)(
      `${task.id}\t${task.kind}\t${task.status}\t${task.opportunityId ?? ""}\t${task.intent}`,
    );
  }
  return 0;
}

async function cmdAgentCreate(argv: string[], opts: CliOptions): Promise<number> {
  const kindRaw = parseFlag(argv, "--kind");
  const intent = parseFlag(argv, "--intent");
  if (!kindRaw || !intent) {
    err(opts)("agent create requires --kind and --intent");
    return 1;
  }
  const evidenceRaw = parseFlag(argv, "--evidence");
  const evidenceIds = evidenceRaw
    ? evidenceRaw.split(",").map((s) => s.trim()).filter(Boolean)
    : undefined;

  const task = await service(opts).createAgentTask({
    kind: kindRaw as AgentKind,
    intent,
    opportunityId: parseFlag(argv, "--opportunity") ?? null,
    evidenceIds,
    dryRun: hasFlag(argv, "--dry-run"),
    domainWrite: hasFlag(argv, "--domain-write"),
  });
  out(opts)(`Created agent task ${task.id} (${task.kind}, ${task.status})`);
  return 0;
}

async function cmdAgentRun(argv: string[], opts: CliOptions): Promise<number> {
  const taskId = argv[0];
  if (!taskId) {
    err(opts)("agent run requires <taskId>");
    return 1;
  }
  const task = await service(opts).runAgentTask(taskId);
  out(opts)(`Agent task ${task.id} → ${task.status}`);
  const last = task.invocations.at(-1);
  if (last && last.policyDenials.length > 0) {
    for (const denial of last.policyDenials) {
      err(opts)(`  ${denial.code}: ${denial.reason}`);
    }
  }
  return task.status === "blocked" || task.status === "failed" ? 1 : 0;
}

export async function runCli(argv: string[], opts: CliOptions = {}): Promise<number> {
  const workspaceDir = parseFlag(argv, "--workspace");
  const filteredArgv = argv.filter((a, i) => {
    if (a === "--workspace") return false;
    if (argv[i - 1] === "--workspace") return false;
    return true;
  });

  const cliOpts: CliOptions = {
    ...opts,
    workspaceDir: workspaceDir ?? opts.workspaceDir,
  };

  const [cmd, sub, ...rest] = filteredArgv;
  if (!cmd || cmd === "help" || hasFlag(argv, "--help")) {
    out(cliOpts)(usage());
    return 0;
  }

  try {
    if (cmd === "brief" && sub === "create") return await cmdBriefCreate(rest, cliOpts);
    if (cmd === "brief" && sub === "list") return await cmdBriefList(rest, cliOpts);
    if (cmd === "run") return await cmdRun([sub, ...rest].filter(Boolean), cliOpts);
    if (cmd === "inbox") return await cmdInbox(filteredArgv, cliOpts);
    if (cmd === "library") return await cmdLibrary(filteredArgv, cliOpts);
    if (cmd === "board" && sub === "calibrate") return await cmdBoardCalibrate(rest, cliOpts);
    if (cmd === "validation" && sub === "add") return await cmdValidationAdd(rest, cliOpts);
    if (cmd === "validation" && sub === "list") return await cmdValidationList(rest, cliOpts);
    if (cmd === "validation" && sub === "complete") return await cmdValidationComplete(rest, cliOpts);
    if (cmd === "monitor" && sub === "diff") return await cmdMonitorDiff(rest, cliOpts);
    if (cmd === "monitor" && sub === "schedule") return await cmdMonitorSchedule(rest, cliOpts);
    if (cmd === "export") return await cmdExport([sub, ...rest].filter(Boolean), cliOpts);
    if (cmd === "agent" && sub === "list") return await cmdAgentList(rest, cliOpts);
    if (cmd === "agent" && sub === "create") return await cmdAgentCreate(rest, cliOpts);
    if (cmd === "agent" && sub === "run") return await cmdAgentRun(rest, cliOpts);

    err(cliOpts)(`Unknown command: ${cmd}${sub ? ` ${sub}` : ""}`);
    err(cliOpts)(usage());
    return 1;
  } catch (e) {
    err(cliOpts)(e instanceof Error ? e.message : String(e));
    return 1;
  }
}
