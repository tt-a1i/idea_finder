import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentKind } from "@idea-finder/agents";
import { createAuthorizedHttpGoogleTrendsTransport, GoogleTrendsSourceError, PackageDownloadsSourceError, type GoogleTrendsTransport, type PackageDownloadsConnector, type QuantitativeConnector } from "@idea-finder/connectors";
import type { CalibrationAction, GitHubMetric, ValidationExperimentType, ValidationOutcome } from "@idea-finder/core";
import { InvariantViolation } from "@idea-finder/core";
import { renderMarkdownReport } from "../report/markdown-export.js";
import { buildPainMapReport, renderPainMapMarkdown } from "../report/pain-map.js";
import { clusterPainSignals } from "../orchestration/research-rounds.js";
import { resolveWorkspacePaths } from "../storage/workspace-store.js";
import type { ResearchSourceStatus } from "../types.js";
import { WorkspaceService } from "../workspace-service.js";
import { createFixtureResearchRunner, type FixtureSourceScenario } from "../ports/runner-impl.js";
import {
  CLI_CONTRACT_VERSION,
  CLI_EXIT_CODES,
  CliFailure,
  type CliMachineEnvelope,
  type CliStructuredError,
} from "./contract.js";
import { resolveCliWorkspaceDir } from "./workspace-path.js";

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
const GITHUB_METRICS = ["stars", "forks", "contributors", "issue_opened", "issue_closed", "open_issues", "repository_count", "trending_rank"] as const;

function usage(): string {
  return `idea-finder — local demand workspace CLI

Usage:
  idea-finder workspace diagnostics
  idea-finder brief create <slug> --title <text> [--description <text>] [--lens <l1,l2>] [--source <hn|v2ex|app_store|stack_exchange> ...] [--term <text> ...] [--app-id <id>] [--stackexchange-site <site>] [--manual-import <text> ...]
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
  idea-finder monitor run <brief> [--transport-url <https-url>] [--fixture] [--fixture-set <representative|google-throttled|github-unauthorized|npm-unavailable>]
  idea-finder trends collect github <owner/repository> [--since <iso-time>] [--fixture]
  idea-finder trends collect google <subject> --geo <CC|WORLDWIDE> --from <iso> --to <iso> [--granularity <day|week>] [--transport-url <https-url>] [--fixture] [--fixture-pattern <spike|seasonal|sustained|insufficient>]
  idea-finder trends collect <npm|pypi> <package> --from <YYYY-MM-DD> --to <YYYY-MM-DD> [--fixture]
  idea-finder trends inspect package --ecosystem <npm|pypi> --package <name> [--from <iso>] [--to <iso>]
  idea-finder trends inspect google <subject> [--geo <CC|WORLDWIDE>] [--from <iso>] [--to <iso>]
  idea-finder trends observations [--subject <owner/repository>] [--metric <metric>]
  idea-finder trends series [--subject <owner/repository>] [--metric <metric>]
  idea-finder trends events [--subject <owner/repository>] [--metric <metric>]
  idea-finder research run <brief> [--transport-url <https-url>] [--fixture-set representative]
  idea-finder research inspect <runId> [--claim <claimId>]
  idea-finder research follow-up <runId> --proposal <id> --create <slug>
  idea-finder plan propose --topic <text> [--persona <text> ...] [--scenario <text> ...] [--language <code> ...] [--geo <CC|WORLDWIDE>] [--from <iso>] [--to <iso>] [--source-family <name> ...] [--query-budget <n>] [--document-budget <n>] [--round-budget <n>]
  idea-finder plan confirm <planId> [--mode <explicit|start_now>] [--slug <slug>] [--no-brief]
  idea-finder plan inspect <planId>
  idea-finder evidence ingest-fetched --run <runId> --json-file <path>
  idea-finder evidence list --run <runId> [--fetched-only]
  idea-finder evidence inspect <documentId> --run <runId>
  idea-finder export <brief> [--out <path.md>]
  idea-finder agent list
  idea-finder agent create --kind <research|browser|computer|coding> --intent <text> [--opportunity <id>] [--evidence <id,id>] [--domain-write] [--dry-run]
  idea-finder agent run <taskId>

Options:
  --workspace <dir>   Workspace data directory (default: user data dir, or IDEA_FINDER_WORKSPACE)
  --init              Create a missing workspace during diagnostics
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

function svc(workspaceDir: string, mode: "fixture" | "orchestration" = "orchestration", fixtureSourceScenario?: FixtureSourceScenario): WorkspaceService {
  return new WorkspaceService({
    paths: resolveWorkspacePaths(workspaceDir),
    runnerMode: mode,
    runner: mode === "fixture" && fixtureSourceScenario ? createFixtureResearchRunner(fixtureSourceScenario) : undefined,
  });
}

function configuredGoogleTrendsTransport(argv: readonly string[]): GoogleTrendsTransport | undefined {
  const endpoint = flag(argv, "--transport-url") ?? process.env.IDEA_FINDER_GOOGLE_TRENDS_ENDPOINT;
  if (!endpoint) return undefined;
  try {
    return createAuthorizedHttpGoogleTrendsTransport({
      endpoint,
      bearerToken: process.env.IDEA_FINDER_GOOGLE_TRENDS_TOKEN,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Google Trends transport configuration is invalid";
    throw new CliFailure("validation", "google_trends.transport_invalid", message, CLI_EXIT_CODES.validation);
  }
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
  "workspace diagnostics": { valueFlags: [], booleanFlags: ["--init"], positionalCount: 2 },
  "brief create": { valueFlags: ["--title", "--description", "--lens", "--source", "--term", "--app-id", "--stackexchange-site", "--manual-import", "--github-repo", "--google-subject", "--google-geo", "--npm-package", "--pypi-package", "--from", "--to"], positionalCount: 3 },
  "brief list": { valueFlags: [], positionalCount: 2 },
  run: { valueFlags: ["--retry", "--resume", "--fixture-source-outcome"], booleanFlags: ["--fixture", "--orchestration"], positionalCount: 2 },
  inbox: { valueFlags: ["--brief"], positionalCount: 1 },
  library: { valueFlags: ["--brief"], positionalCount: 1 },
  "library inspect": { valueFlags: ["--run"], positionalCount: 3 },
  "library rejected": { valueFlags: ["--run"], positionalCount: 2 },
  "board calibrate": { valueFlags: ["--action", "--note", "--run"], positionalCount: 3 },
  "validation add": { valueFlags: ["--type", "--hypothesis", "--run"], booleanFlags: ["--start"], positionalCount: 3 },
  "validation list": { valueFlags: ["--opportunity"], positionalCount: 2 },
  "validation complete": { valueFlags: ["--outcome", "--summary"], positionalCount: 3 },
  "monitor diff": { valueFlags: ["--brief", "--baseline", "--compare"], positionalCount: 2 },
  "monitor schedule": { valueFlags: ["--cadence", "--enabled", "--min-cross-source-growth", "--min-strong-pain-growth", "--min-commercial-growth", "--min-cooling-loss"], positionalCount: 3 },
  "monitor run": { valueFlags: ["--fixture-source-outcome", "--fixture-set", "--transport-url"], booleanFlags: ["--fixture"], positionalCount: 3 },
  "trends collect": { valueFlags: ["--since", "--api-base", "--fixture-time", "--fixture-stars", "--geo", "--from", "--to", "--granularity", "--transport-url", "--fixture-pattern", "--fixture-failure"], booleanFlags: ["--fixture"], positionalCount: 4 },
  "trends inspect": { valueFlags: ["--geo", "--from", "--to", "--ecosystem", "--package"], positionalCount: 4 },
  "trends observations": { valueFlags: ["--subject", "--metric"], positionalCount: 2 },
  "trends series": { valueFlags: ["--subject", "--metric"], positionalCount: 2 },
  "trends events": { valueFlags: ["--subject", "--metric"], positionalCount: 2 },
  "research run": { valueFlags: ["--fixture-set", "--retry", "--resume", "--transport-url"], positionalCount: 3 },
  "research inspect": { valueFlags: ["--claim"], positionalCount: 3 },
  "research follow-up": { valueFlags: ["--proposal", "--create"], positionalCount: 3 },
  "plan propose": { valueFlags: ["--topic", "--persona", "--scenario", "--language", "--geo", "--from", "--to", "--source-family", "--query-budget", "--document-budget", "--round-budget"], positionalCount: 2 },
  "plan confirm": { valueFlags: ["--mode", "--slug"], booleanFlags: ["--no-brief"], positionalCount: 3 },
  "plan inspect": { valueFlags: [], positionalCount: 3 },
  "evidence ingest-fetched": { valueFlags: ["--run", "--json-file"], positionalCount: 2 },
  "evidence list": { valueFlags: ["--run"], booleanFlags: ["--fetched-only"], positionalCount: 2 },
  "evidence inspect": { valueFlags: ["--run"], positionalCount: 3 },
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
    const resolved = path.resolve(workspaceDir);
    const shouldInit = has(argv, "--init");
    if (!existsSync(resolved)) {
      if (!shouldInit) {
        const data = {
          workspace: resolved,
          exists: false,
          initialized: false,
          accessible: false,
          runnerMode: "orchestration",
          counts: { briefs: 0, researchRuns: 0, opportunities: 0, agentTasks: 0 },
        };
        return {
          command: "workspace diagnostics",
          data,
          human: `Workspace ${resolved}\nStatus: missing (pass --init to create)\nBriefs: 0; runs: 0; opportunities: 0`,
        };
      }
      await mkdir(resolved, { recursive: true });
    }
    const service = svc(resolved);
    const [briefs, state] = await Promise.all([service.listBriefs(), service.getState()]);
    const data = {
      workspace: resolved,
      exists: true,
      initialized: true,
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
    const qualitativeSources = flags(rest, "--source").map((source) => oneOf(source, ["hn", "v2ex", "app_store", "stack_exchange"] as const, "source"));
    const searchTerms = flags(rest, "--term");
    const effectiveTerms = searchTerms.length > 0 ? searchTerms : (lensesRaw?.split(",").map((item) => item.trim()).filter(Boolean) ?? title.split(/\s+/).filter((item) => item.length > 2));
    const appId = flag(rest, "--app-id");
    const stackExchangeSite = flag(rest, "--stackexchange-site");
    if (searchTerms.length > 0 && qualitativeSources.length === 0) usageFailure("brief.source_required_for_terms", "--term requires at least one --source");
    if (appId && !qualitativeSources.includes("app_store")) usageFailure("brief.app_store_source_required", "--app-id requires --source app_store");
    if (stackExchangeSite && !qualitativeSources.includes("stack_exchange")) usageFailure("brief.stack_exchange_source_required", "--stackexchange-site requires --source stack_exchange");
    if (qualitativeSources.includes("app_store") && !appId) usageFailure("brief.app_id_required", "app_store source requires --app-id");
    const searches = qualitativeSources.map((platform) => ({ platform, terms: effectiveTerms.length ? effectiveTerms : [title], ...(platform === "app_store" ? { appId } : {}), ...(platform === "stack_exchange" && stackExchangeSite ? { stackExchangeSite } : {}) }));
    const github = flags(rest, "--github-repo").map((repository) => ({ repository }));
    const googleSubjects = flags(rest, "--google-subject");
    const npmPackages = flags(rest, "--npm-package");
    const pypiPackages = flags(rest, "--pypi-package");
    const from = flag(rest, "--from");
    const to = flag(rest, "--to");
    if ((googleSubjects.length || npmPackages.length || pypiPackages.length) && (!from || !to)) usageFailure("brief.quantitative_window_required", "Google/npm/PyPI sources require --from and --to");
    const geography = googleSubjects.length ? required(flag(rest, "--google-geo"), "brief.google_geo_required", "Google Trends requires --google-geo") : undefined;
    const quantitative = github.length || googleSubjects.length || npmPackages.length || pypiPackages.length ? {
      github,
      googleTrends: googleSubjects.map((subject) => ({ subject, geography: geography!, from: from!, to: to!, granularity: "day" as const })),
      packages: [...npmPackages.map((pkg) => ({ ecosystem: "npm" as const, package: pkg, from: from!, to: to! })), ...pypiPackages.map((pkg) => ({ ecosystem: "pypi" as const, package: pkg, from: from!, to: to! }))],
    } : undefined;
    const brief = await svc(workspaceDir).createBrief({
      slug,
      title,
      description: flag(rest, "--description") ?? "",
      lenses: lensesRaw?.split(",").map((item) => item.trim()),
      sourcesEnabled: qualitativeSources.length > 0 ? qualitativeSources : undefined,
      queryPlan: searches.length > 0 || manualImports.length > 0 || quantitative ? { harvestMode: searches.length > 0 ? "l0" : "manual", searches, manualImports, quantitative } : undefined,
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
    const fixtureSourceRaw = flag(rest, "--fixture-source-outcome");
    const fixtureSourceScenario = fixtureSourceRaw ? oneOf(fixtureSourceRaw, ["success", "mixed", "unauthorized", "throttled", "zero", "partial-zero", "pain-growth"] as const, "fixture-source-outcome") : undefined;
    if (fixtureSourceScenario && !fixture) throw new CliFailure("validation", "run.fixture_source_requires_fixture", "--fixture-source-outcome requires --fixture", CLI_EXIT_CODES.validation);
    const execution = retryRunId ? "retried" : resumeRunId ? "resumed" : "new";
    const stored = await svc(workspaceDir, fixture ? "fixture" : "orchestration", fixtureSourceScenario).runResearch(brief, {
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
    const incompleteStatuses = (stored.sourceStatuses ?? []).filter((status) => status.status !== "success");
    const incomplete = stored.run.status === "partial"
      ? incompleteStatuses.map((status) => `${status.source} (${status.requestKey}) ${status.status}: ${status.reason ?? status.reasonCode}`)
      : undefined;
    const coverage = incompleteStatuses.length === 0
      ? "all required sources complete"
      : `incomplete sources: ${incompleteStatuses.map((status) => `${status.source}=${status.status}`).join(", ")}`;
    return {
      command: "run",
      data: stored,
      human: `Run ${stored.run.id} ${stored.execution} → ${stored.run.status} — admitted ${stored.admittedCount} opportunities (${stored.rejected.length} rejected); ${coverage}${incompleteStatuses.length > 0 ? "; conclusions remain conditional" : ""}`,
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
    const threshold = (name: string): number | undefined => { const raw = flag(rest, name); if (raw === undefined) return undefined; const value = Number(raw); if (!Number.isInteger(value) || value <= 0) throw new CliFailure("validation", "monitor.threshold_invalid", `${name} must be a positive integer`, CLI_EXIT_CODES.validation); return value; };
    const thresholds = {
      minCrossSourceGrowth: threshold("--min-cross-source-growth"), minStrongPainGrowth: threshold("--min-strong-pain-growth"),
      minCommercialEvidenceGrowth: threshold("--min-commercial-growth"), minCoolingEvidenceLoss: threshold("--min-cooling-loss"),
    };
    const schedule = await svc(workspaceDir).setMonitorSchedule({ briefSlugOrId, cadence, enabled: enabledRaw === undefined ? undefined : enabledRaw === "true" || enabledRaw === "1", thresholds: Object.fromEntries(Object.entries(thresholds).filter(([, value]) => value !== undefined)) });
    return { command: "monitor schedule", data: { schedule }, human: `Monitor schedule ${schedule.id}: cadence=${schedule.cadence} enabled=${schedule.enabled}` };
  }

  if (cmd === "monitor" && sub === "run") {
    const briefSlugOrId = required(rest[0], "monitor.brief_required", "monitor run requires <brief>");
    const fixture = has(rest, "--fixture");
    const fixtureSourceRaw = flag(rest, "--fixture-source-outcome");
    const fixtureSourceScenario = fixtureSourceRaw ? oneOf(fixtureSourceRaw, ["success", "mixed", "unauthorized", "throttled", "zero", "partial-zero", "pain-growth"] as const, "fixture-source-outcome") : undefined;
    if (fixtureSourceScenario && !fixture) throw new CliFailure("validation", "monitor.fixture_source_requires_fixture", "--fixture-source-outcome requires --fixture", CLI_EXIT_CODES.validation);
    const fixtureSetRaw = flag(rest, "--fixture-set");
    const fixtureSet = fixtureSetRaw ? oneOf(fixtureSetRaw, ["representative", "google-throttled", "github-unauthorized", "npm-unavailable"] as const, "fixture-set") : undefined;
    const orchestrationService = svc(workspaceDir);
    const monitorBrief = await orchestrationService.getBrief(briefSlugOrId);
    if (!monitorBrief) throw new Error(`Brief not found: ${briefSlugOrId}`);
    const quantitative = Boolean(monitorBrief.queryPlan?.quantitative);
    const monitorService = fixture && !quantitative ? svc(workspaceDir, "fixture", fixtureSourceScenario) : orchestrationService;
    const googleTrendsTransport = configuredGoogleTrendsTransport(rest);
    if (fixture && googleTrendsTransport) throw new CliFailure("validation", "google_trends.transport_conflict", "Use either --fixture or an authorized Google Trends transport, not both", CLI_EXIT_CODES.validation);
    const result = await monitorService.invokeMonitor({ briefSlugOrId, fixtureSet: fixtureSet ?? (fixture && quantitative ? "representative" : undefined), googleTrendsTransport });
    const incomplete = result.sourceStatuses.filter((status) => status.status !== "success");
    const reasons = incomplete.map((status) => `${status.source} (${status.requestKey}) ${status.status}: ${status.reason ?? status.reasonCode}`);
    return { command: "monitor run", data: result, human: `Monitor run ${result.run.run.id}: ${result.comparison ? `${result.comparison.diff.summary.added} added, ${result.comparison.diff.summary.heated} heated, ${result.comparison.diff.summary.cooled} cooled, ${result.comparison.diff.summary.unchanged} unchanged` : "baseline established"}${incomplete.length ? "; partial coverage; cooling is suppressed where inconclusive" : ""}`, incompleteness: reasons.length ? reasons : undefined, exitCode: reasons.length ? CLI_EXIT_CODES.partialResult : undefined };
  }

  if (cmd === "trends" && sub === "collect") {
    if (rest[0] === "npm" || rest[0] === "pypi") {
      const ecosystem = rest[0];
      const packageName = required(rest[1], "package.name_required", `trends collect ${ecosystem} requires <package>`);
      const from = required(flag(rest, "--from"), "package.from_required", "Package collection requires --from");
      const to = required(flag(rest, "--to"), "package.to_required", "Package collection requires --to");
      const validDay = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T00:00:00.000Z`).toISOString().startsWith(value);
      if (!validDay(from) || !validDay(to) || Date.parse(from) > Date.parse(to)) throw new CliFailure("validation", "package.window_invalid", "Package downloads require real YYYY-MM-DD dates with from <= to", CLI_EXIT_CODES.validation);
      const failureRaw = flag(rest, "--fixture-failure");
      const failure = failureRaw ? oneOf(failureRaw, ["rate_limited", "missing_package", "unavailable_history", "response_drift"] as const, "fixture-failure") : undefined;
      const fixtureConnector: PackageDownloadsConnector | undefined = has(rest, "--fixture") ? {
        ecosystem,
        async collect(request) {
          if (failure) throw new PackageDownloadsSourceError(failure, `Recorded ${failure} fixture`, failure === "rate_limited" ? "2026-02-01T00:00:00.000Z" : null);
          const start = Date.parse(`${request.from}T00:00:00.000Z`);
          const end = Date.parse(`${request.to}T00:00:00.000Z`);
          const days = Array.from({ length: Math.floor((end - start) / 86_400_000) + 1 }, (_, index) => new Date(start + index * 86_400_000).toISOString().slice(0, 10));
          const provenance = { provider: "fixture" as const, interface: "recorded_fixture" as const, sourceRef: `fixture://${ecosystem}-downloads`, retrievedAt: "2026-02-01T00:00:00.000Z", caveat: "Recorded deterministic fixture" };
          return { ecosystem, package: request.package, from: request.from, to: request.to, provenance, buckets: days.map((day) => ({ id: `pkg_fixture_${ecosystem}_${day}`, ecosystem, package: request.package, subject: `${ecosystem}:${request.package}`, day, downloads: Number(day.slice(-2)) * 100, provenance })), missingDays: [], coverageComplete: true };
        },
      } : undefined;
      const service = svc(workspaceDir);
      try {
        const result = await service.collectPackageDownloads({ ecosystem, packageName, from, to, connector: fixtureConnector });
        return { command: "trends collect", data: { ...result, sourceHealth: service.inspectPackageDownloads({ ecosystem, packageName }).sourceHealth }, human: `Collected ${result.observations.length} ${ecosystem} download observations for ${packageName}` };
      } catch (error) {
        if (error instanceof PackageDownloadsSourceError) {
          const sourceHealth = service.inspectPackageDownloads({ ecosystem, packageName }).sourceHealth;
          const missing = error.status === "missing_package";
          throw new CliFailure(missing ? "missing-resource" : "partial-result", `package_downloads.${error.status}`, error.message, missing ? CLI_EXIT_CODES.missingResource : CLI_EXIT_CODES.partialResult, { sourceHealth, retryAt: error.retryAt });
        }
        throw error;
      }
    }
    if (rest[0] === "google") {
      const subject = required(rest[1], "trends.subject_required", "trends collect google requires <subject>");
      const geography = required(flag(rest, "--geo"), "trends.geo_required", "Google Trends collection requires --geo");
      if (!/^(?:[A-Za-z]{2}|WORLDWIDE)$/.test(geography)) throw new CliFailure("validation", "trends.geo_invalid", "--geo must be an ISO-3166 alpha-2 code or WORLDWIDE", CLI_EXIT_CODES.validation);
      const from = required(flag(rest, "--from"), "trends.from_required", "Google Trends collection requires --from");
      const to = required(flag(rest, "--to"), "trends.to_required", "Google Trends collection requires --to");
      if (Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to)) || Date.parse(from) >= Date.parse(to)) throw new CliFailure("validation", "trends.window_invalid", "Google Trends requires a valid from < to window", CLI_EXIT_CODES.validation);
      const granularity = oneOf(flag(rest, "--granularity") ?? "day", ["day", "week"] as const, "granularity");
      const pattern = oneOf(flag(rest, "--fixture-pattern") ?? "sustained", ["spike", "seasonal", "sustained", "insufficient"] as const, "fixture-pattern");
      const fixtureFailureRaw = flag(rest, "--fixture-failure");
      const fixtureFailure = fixtureFailureRaw ? oneOf(fixtureFailureRaw, ["throttled", "unavailable", "response_drift"] as const, "fixture-failure") : undefined;
      const configuredTransport = configuredGoogleTrendsTransport(rest);
      if (has(rest, "--fixture") && configuredTransport) {
        throw new CliFailure("validation", "google_trends.transport_conflict", "Use either --fixture or an authorized Google Trends transport, not both", CLI_EXIT_CODES.validation);
      }
      const fixtureValues = pattern === "spike" ? [10, 11, 9, 80, 15, 12]
        : pattern === "seasonal" ? [10, 50, 20, 10, 50, 20]
          : pattern === "insufficient" ? [10, 12, 14]
            : [10, 15, 22, 35, 55, 80];
      const fixtureTransport: GoogleTrendsTransport | undefined = has(rest, "--fixture") ? {
        async query(request) {
          if (fixtureFailure) throw new GoogleTrendsSourceError(fixtureFailure, `Recorded ${fixtureFailure} fixture`, fixtureFailure === "throttled" ? "2026-01-11T00:00:00.000Z" : null);
          const start = Date.parse(request.from);
          const step = request.granularity === "week" ? 7 * 86_400_000 : 86_400_000;
          return {
            payload: { rows: fixtureValues.map((value, index) => ({ time: new Date(start + index * step).toISOString(), value, partial: false })), comparisonSet: [request.subject], anchor: null },
            provenance: { transport: "recorded-fixture", transportVersion: "1", authorizedInterface: "recorded_fixture", sourceRef: "fixture://google-trends", retrievedAt: request.to },
          };
        },
      } : undefined;
      const service = svc(workspaceDir);
      try {
        const result = await service.collectGoogleTrends({ subject, geography, from, to, granularity, transport: fixtureTransport ?? configuredTransport });
        return { command: "trends collect", data: { ...result, sourceHealth: service.inspectGoogleTrends({ subject }).sourceHealth }, human: `Collected ${result.observations.length} Google Trends observations for ${subject}/${geography}` };
      } catch (error) {
        if (error instanceof GoogleTrendsSourceError) {
          const sourceHealth = service.inspectGoogleTrends({ subject }).sourceHealth;
          throw new CliFailure(error.status === "authorization_required" ? "policy" : "partial-result", `google_trends.${error.status}`, error.message, error.status === "authorization_required" ? CLI_EXIT_CODES.policy : CLI_EXIT_CODES.partialResult, { sourceHealth, retryAt: error.retryAt });
        }
        throw error;
      }
    }
    if (rest[0] !== "github") usageFailure("trends.source_required", "trends collect requires github or google");
    const subject = required(rest[1], "trends.subject_required", "trends collect github requires <owner/repository>");
    const since = flag(rest, "--since");
    if (since && Number.isNaN(Date.parse(since))) throw new CliFailure("validation", "trends.since_invalid", "--since must be an ISO date-time", CLI_EXIT_CODES.validation);
    const fixtureTime = flag(rest, "--fixture-time") ?? "2026-07-11T00:00:00.000Z";
    if (has(rest, "--fixture") && Number.isNaN(Date.parse(fixtureTime))) throw new CliFailure("validation", "trends.fixture_time_invalid", "--fixture-time must be an ISO date-time", CLI_EXIT_CODES.validation);
    const fixtureStars = Number(flag(rest, "--fixture-stars") ?? "120");
    if (has(rest, "--fixture") && (!Number.isFinite(fixtureStars) || fixtureStars < 0)) throw new CliFailure("validation", "trends.fixture_stars_invalid", "--fixture-stars must be a non-negative number", CLI_EXIT_CODES.validation);
    const fixtureConnector: QuantitativeConnector | undefined = has(rest, "--fixture") ? {
      source: "github",
      async healthcheck() { return { ok: true }; },
      async collect(request) {
        const observedAt = fixtureTime;
        return [
          ["github.repository.stars", fixtureStars], ["github.repository.forks", 18],
          ["github.repository.open_issues", 7], ["github.issue.opened", 4],
          ["github.issue.closed", 3], ["github.repository.contributors", 12],
        ].map(([metric, value]) => ({
          id: `metric_fixture_${String(metric).replace(/\W/g, "_")}_${observedAt}`,
          subject: `github:${request.subject.replace(/^github:/, "").toLowerCase()}`,
          source: "github", metric: String(metric), geography: null, observedAt,
          rawValue: Number(value), normalizedValue: Number(value), unit: "count" as const,
          collectionMethod: "authorized_public_api" as const,
          provenance: { url: "fixture://github-recorded", endpoint: "recorded-fixture", apiVersion: "2022-11-28", retrievedAt: observedAt },
        }));
      },
    } : undefined;
    const result = await svc(workspaceDir).collectGithubMetrics({ subject, since, apiBase: flag(rest, "--api-base"), connector: fixtureConnector });
    return { command: "trends collect", data: { ...result, sourceHealth: svc(workspaceDir).listQuantitativeSourceStatuses() }, human: `Collected ${result.observations.length} GitHub observations for ${subject}` };
  }

  if (cmd === "trends" && sub === "inspect") {
    if (rest[0] === "package") {
      const ecosystem = oneOf(required(flag(rest, "--ecosystem"), "package.ecosystem_required", "Package inspection requires --ecosystem"), ["npm", "pypi"] as const, "ecosystem");
      const packageName = required(flag(rest, "--package"), "package.name_required", "Package inspection requires --package");
      const result = svc(workspaceDir).inspectPackageDownloads({ ecosystem, packageName, from: flag(rest, "--from"), to: flag(rest, "--to") });
      return { command: "trends inspect", data: result, human: `${ecosystem} ${packageName}: ${result.observations.length} observations, ${result.events.length} events` };
    }
    if (rest[0] !== "google") usageFailure("trends.source_required", "trends inspect requires google <subject>");
    const subject = required(rest[1], "trends.subject_required", "trends inspect google requires <subject>");
    const result = svc(workspaceDir).inspectGoogleTrends({ subject, geography: flag(rest, "--geo"), from: flag(rest, "--from"), to: flag(rest, "--to") });
    return { command: "trends inspect", data: result, human: `Google Trends: ${result.observations.length} observations, ${result.events.length} events` };
  }

  if (cmd === "research" && sub === "run") {
    const brief = required(rest[0], "research.brief_required", "research run requires <brief>");
    const fixtureSetRaw = flag(rest, "--fixture-set");
    const fixtureSet = fixtureSetRaw ? oneOf(fixtureSetRaw, ["representative", "google-throttled", "github-unauthorized", "npm-unavailable"] as const, "fixture-set") : undefined;
    const retryRunId = flag(rest, "--retry"); const resumeRunId = flag(rest, "--resume");
    if (retryRunId && resumeRunId) throw new CliFailure("validation", "research.execution_conflict", "Use only one of --retry or --resume", CLI_EXIT_CODES.validation);
    const execution = retryRunId ? "retried" : resumeRunId ? "resumed" : "new";
    const googleTrendsTransport = configuredGoogleTrendsTransport(rest);
    if (fixtureSet && googleTrendsTransport) throw new CliFailure("validation", "google_trends.transport_conflict", "Use either --fixture-set or an authorized Google Trends transport, not both", CLI_EXIT_CODES.validation);
    const report = await svc(workspaceDir).runMultiLaneResearch(brief, { fixtureSet, execution, runId: (retryRunId ?? resumeRunId) as never, googleTrendsTransport });
    const sourceStatuses = svc(workspaceDir).listResearchSourceStatuses(report.runId);
    const incomplete = sourceStatuses.filter((status) => status.status !== "success");
    const reasons = incomplete.map((status) => `${status.source} (${status.requestKey}) ${status.status}: ${status.reason ?? status.reasonCode}`);
    return { command: "research run", data: { summary: report.summary, runId: report.runId, execution, sourceStatuses }, human: `Multi-lane research ${report.runId}: ${report.claims.length} claims; ${report.summary.candidates.filter((item) => item.status === "unvalidated").length} unvalidated candidates; ${incomplete.length ? `incomplete lanes: ${incomplete.map((item) => item.source).join(", ")}; conclusions remain conditional` : "all required lanes complete"}`, incompleteness: reasons.length ? reasons : undefined, exitCode: reasons.length ? CLI_EXIT_CODES.partialResult : undefined };
  }

  if (cmd === "research" && sub === "inspect") {
    const runId = required(rest[0], "research.run_required", "research inspect requires <runId>");
    const result = svc(workspaceDir).inspectMultiLaneResearch(runId as never, flag(rest, "--claim"));
    const sourceStatuses = svc(workspaceDir).listResearchSourceStatuses(runId as never);
    const incomplete = sourceStatuses.filter((status) => status.status !== "success");
    const reasons = incomplete.map((status) => `${status.source} (${status.requestKey}) ${status.status}: ${status.reason ?? status.reasonCode}`);
    return { command: "research inspect", data: { runId, summary: result.report.summary, claims: result.claims, details: result.details, independence: result.independence, proposals: result.proposals, sourceStatuses }, human: `Research ${runId}: ${result.claims.length} claims, ${result.details.length} evidence details; ${incomplete.length ? `incomplete lanes: ${incomplete.map((item) => item.source).join(", ")}; conclusions remain conditional` : "all required lanes complete"}`, incompleteness: reasons.length ? reasons : undefined, exitCode: reasons.length ? CLI_EXIT_CODES.partialResult : undefined };
  }

  if (cmd === "research" && sub === "follow-up") {
    const runId = required(rest[0], "research.run_required", "research follow-up requires <runId>");
    const proposalId = required(flag(rest, "--proposal"), "research.proposal_required", "research follow-up requires --proposal");
    const slug = required(flag(rest, "--create"), "research.create_required", "research follow-up requires --create <slug>");
    const brief = await svc(workspaceDir).createFollowUpBrief(runId as never, proposalId, slug);
    return { command: "research follow-up", data: { brief, proposalId, parentRunId: runId }, human: `Created follow-up brief ${brief.slug} from ${proposalId}` };
  }

  if (cmd === "plan" && sub === "propose") {
    const topic = required(flag(argv, "--topic") ?? flag(rest, "--topic"), "plan.topic_required", "--topic is required");
    const queryBudget = flag(rest, "--query-budget");
    const documentBudget = flag(rest, "--document-budget");
    const roundBudget = flag(rest, "--round-budget");
    const parseBudget = (raw: string | undefined, label: string): number | undefined => {
      if (raw === undefined) return undefined;
      const value = Number(raw);
      if (!Number.isInteger(value) || value <= 0) throw new CliFailure("validation", "plan.budget_invalid", `${label} must be a positive integer`, CLI_EXIT_CODES.validation);
      return value;
    };
    const plan = await svc(workspaceDir).proposeSearchPlan({
      topic,
      personas: flags(rest, "--persona"),
      scenarios: flags(rest, "--scenario"),
      languages: flags(rest, "--language"),
      geography: flag(rest, "--geo"),
      timeWindow: flag(rest, "--from") && flag(rest, "--to") ? { from: flag(rest, "--from")!, to: flag(rest, "--to")! } : undefined,
      sourceFamilies: flags(rest, "--source-family"),
      budgets: {
        queries: parseBudget(queryBudget, "--query-budget"),
        documents: parseBudget(documentBudget, "--document-budget"),
        rounds: parseBudget(roundBudget, "--round-budget"),
      },
    });
    return {
      command: "plan propose",
      data: { plan },
      human: `Proposed search plan ${plan.id} for "${plan.topic}" (status=proposed). Confirm before research.`,
    };
  }

  if (cmd === "plan" && sub === "confirm") {
    const planId = required(rest[0], "plan.id_required", "plan confirm requires <planId>");
    const modeRaw = flag(rest, "--mode");
    const mode = modeRaw ? oneOf(modeRaw, ["explicit", "start_now"] as const, "mode") : "explicit";
    const result = await svc(workspaceDir).confirmSearchPlan({
      planId,
      mode,
      slug: flag(rest, "--slug"),
      createBrief: !has(rest, "--no-brief"),
    });
    return {
      command: "plan confirm",
      data: result,
      human: `Confirmed search plan ${result.plan.id}${result.brief ? ` → brief ${result.brief.slug}` : ""}`,
    };
  }

  if (cmd === "plan" && sub === "inspect") {
    const planId = required(rest[0], "plan.id_required", "plan inspect requires <planId>");
    const plan = await svc(workspaceDir).getSearchPlan(planId);
    if (!plan) throw new CliFailure("missing-resource", "plan.not_found", `Search plan not found: ${planId}`, CLI_EXIT_CODES.missingResource, { planId });
    return {
      command: "plan inspect",
      data: { plan },
      human: `${plan.id}\tv${plan.version}\t${plan.status}\t${plan.topic}`,
    };
  }

  if (cmd === "evidence" && sub === "ingest-fetched") {
    const runId = required(flag(rest, "--run"), "evidence.run_required", "--run is required");
    const jsonFile = required(flag(rest, "--json-file"), "evidence.json_file_required", "--json-file is required");
    const raw = await readFile(jsonFile, "utf8");
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      throw new CliFailure("validation", "evidence.json_invalid", "--json-file must contain valid JSON", CLI_EXIT_CODES.validation);
    }
    const briefId = typeof payload.huntingTaskId === "string" ? payload.huntingTaskId : `task_${runId}`;
    try {
      const result = await svc(workspaceDir).ingestAgentFetchedEvidence({
        sourceType: String(payload.sourceType ?? ""),
        canonicalUrl: String(payload.canonicalUrl ?? ""),
        title: String(payload.title ?? ""),
        author: payload.author === null || payload.author === undefined ? null : String(payload.author),
        anonymous: Boolean(payload.anonymous),
        publishedAt: payload.publishedAt === undefined ? null : String(payload.publishedAt),
        updatedAt: payload.updatedAt === undefined ? null : String(payload.updatedAt),
        retrievedAt: String(payload.retrievedAt ?? ""),
        verbatimQuote: String(payload.verbatimQuote ?? ""),
        rawSnapshot: payload.rawSnapshot === undefined ? undefined : String(payload.rawSnapshot),
        replayRef: payload.replayRef === undefined ? undefined : String(payload.replayRef),
        queryId: String(payload.queryId ?? ""),
        collectionMethod: String(payload.collectionMethod ?? ""),
        externalId: String(payload.externalId ?? ""),
        huntingTaskId: briefId as never,
        runId: runId as never,
      });
      return {
        command: "evidence ingest-fetched",
        data: { document: result.document, idempotent: result.idempotent, provenance: "agent_fetched" },
        human: `${result.idempotent ? "Idempotent" : "Ingested"} agent-fetched evidence ${result.document.id}`,
      };
    } catch (error) {
      if (error instanceof InvariantViolation) {
        throw new CliFailure("validation", error.code, error.message, CLI_EXIT_CODES.validation);
      }
      throw error;
    }
  }

  if (cmd === "evidence" && sub === "list") {
    const runId = required(flag(rest, "--run"), "evidence.run_required", "--run is required");
    const documents = await svc(workspaceDir).listRunDocuments(runId as never, { fetchedOnly: has(rest, "--fetched-only") });
    return {
      command: "evidence list",
      data: { documents, count: documents.length },
      human: `Evidence documents: ${documents.length}`,
    };
  }

  if (cmd === "evidence" && sub === "inspect") {
    const documentId = required(rest[0], "evidence.id_required", "evidence inspect requires <documentId>");
    const runId = required(flag(rest, "--run"), "evidence.run_required", "--run is required");
    const document = await svc(workspaceDir).getRunDocument(runId as never, documentId);
    if (!document) throw new CliFailure("missing-resource", "evidence.not_found", `Document not found: ${documentId}`, CLI_EXIT_CODES.missingResource, { documentId, runId });
    return {
      command: "evidence inspect",
      data: { document, provenance: document.fetchMethod },
      human: `${document.id}\t${document.fetchMethod}\t${document.url}`,
    };
  }

  if (cmd === "trends" && ["observations", "series", "events"].includes(sub ?? "")) {
    const subject = flag(rest, "--subject")?.replace(/^github:/, "").toLowerCase();
    const metricRaw = flag(rest, "--metric");
    const metric = metricRaw ? oneOf(metricRaw, GITHUB_METRICS, "metric") as GitHubMetric : undefined;
    const service = svc(workspaceDir);
    if (sub === "observations") {
      const observations = service.listMetricObservations(subject, metric);
      return { command: "trends observations", data: { observations, sourceHealth: service.listQuantitativeSourceStatuses() }, human: `Metric observations: ${observations.length}` };
    }
    if (sub === "series") {
      const series = service.listTrendSeries(subject, metric);
      return { command: "trends series", data: { series }, human: `Trend series: ${series.length}` };
    }
    const events = service.listTrendEvents(subject, metric);
    return { command: "trends events", data: { events }, human: `Trend events: ${events.length}` };
  }

  if (cmd === "export") {
    const briefRef = required(sub, "export.brief_required", "export requires <brief>");
    const service = svc(workspaceDir);
    const brief = await service.getBrief(briefRef);
    if (!brief) throw new CliFailure("missing-resource", "brief.not_found", `Brief not found: ${briefRef}`, CLI_EXIT_CODES.missingResource, { brief: briefRef });
    const state = await service.getState();
    const { runId, inbox } = await service.getInboxSummary(briefRef);
    const opportunities = await service.listOpportunities(briefRef);
    let multiLaneReport = null as Awaited<ReturnType<typeof service.inspectMultiLaneResearch>>["report"] | null;
    let sourceStatuses: ResearchSourceStatus[] = [];
    let researchStatus: string | null = null;
    let incompletenessReasons: string[] = [];
    if (runId) {
      const run = state.runs.find((item) => item.run.id === runId);
      researchStatus = run?.run.status ?? null;
      sourceStatuses = service.listResearchSourceStatuses(runId as never);
      incompletenessReasons = sourceStatuses
        .filter((status) => status.status !== "success")
        .map((status) => `${status.source}: ${status.reason ?? status.reasonCode}`);
      try {
        multiLaneReport = service.inspectMultiLaneResearch(runId as never).report;
      } catch {
        multiLaneReport = null;
      }
    }
    let painMapMarkdown: string | null = null;
    let painMap = null as ReturnType<typeof buildPainMapReport> | null;
    if (brief.searchPlanId && runId) {
      const plan = await service.getSearchPlan(brief.searchPlanId);
      const run = state.runs.find((item) => item.run.id === runId);
      if (plan && run) {
        const independenceRecords = (service.inspectMultiLaneResearch(runId as never).independence ?? []) as Array<{ documentId: string; independenceGroupId: string }>;
        const independence = new Map(independenceRecords.map((item) => [item.documentId, item.independenceGroupId]));
        const clusters = clusterPainSignals({
          signals: run.signals,
          independenceGroupByDocumentId: independence,
        });
        painMap = buildPainMapReport({
          plan,
          clusters,
          rounds: [{ round: 1, queryIds: plan.queries.map((query) => query.id), newDocumentCount: run.documents.length, newEvidenceCount: run.evidence.length, newClusterCount: clusters.length, coverageIncomplete: incompletenessReasons.length > 0 }],
          stopReason: incompletenessReasons.length ? "budget_exhausted_partial" : (clusters.length === 0 ? "budget_exhausted" : "saturated"),
          documentCount: run.documents.length,
          evidenceCount: run.evidence.length,
          dedupeCount: Math.max(0, run.documents.length - independence.size),
          incompleteSources: incompletenessReasons.map((reason) => reason.split(":")[0]!.trim()),
          evidenceSnippets: run.evidence.map((item) => ({
            clusterId: clusters.find((cluster) => cluster.documentIds.includes(item.documentId))?.id ?? "",
            quote: item.quoteVerbatim,
            url: item.url,
            evidenceId: item.id,
            signalType: item.supportsClaim,
          })),
        });
        painMapMarkdown = renderPainMapMarkdown(painMap);
      }
    }
    const markdown = renderMarkdownReport({
      brief,
      opportunities,
      calibrationEvents: state.calibrationEvents.filter((event) => opportunities.some((item) => item.id === event.opportunityId)),
      evidenceById: state.evidenceById,
      inbox,
      runId,
      researchStatus,
      multiLaneReport,
      sourceStatuses,
      incompletenessReasons,
      painMapMarkdown,
    });
    const outputPath = flag(rest, "--out");
    if (outputPath) await writeFile(path.resolve(outputPath), markdown, "utf8");
    return {
      command: "export",
      data: {
        briefId: brief.id,
        runId,
        researchStatus,
        outputPath: outputPath ? path.resolve(outputPath) : null,
        markdown,
        painMap,
        multiLaneReport: multiLaneReport ? { summary: multiLaneReport.summary, claimCount: multiLaneReport.claims.length, candidateCount: multiLaneReport.summary.candidates.length } : null,
        sourceStatuses,
        incompleteness: incompletenessReasons.length ? { incomplete: true, reasons: incompletenessReasons } : undefined,
      },
      human: outputPath ? `Wrote ${path.resolve(outputPath)}` : markdown,
      incompleteness: incompletenessReasons.length ? incompletenessReasons : undefined,
      exitCode: incompletenessReasons.length ? CLI_EXIT_CODES.partialResult : undefined,
    };
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
  const code = (error as Error & { code?: string })?.code;
  if (code === "plan.required" || code === "plan.unconfirmed") {
    return new CliFailure("policy", code, (error as Error).message, CLI_EXIT_CODES.policy);
  }
  if (code === "plan.not_found" || (error instanceof Error && /Search plan not found/i.test(error.message))) {
    return new CliFailure("missing-resource", "plan.not_found", (error as Error).message, CLI_EXIT_CODES.missingResource);
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
  const partialFailure = failure?.category === "partial-result";
  const reasons = result?.incompleteness ?? (partialFailure ? [failure.message] : []);
  const errors: CliStructuredError[] = failure
    ? [{ category: failure.category, code: failure.code, message: failure.message, details: failure.details }]
    : reasons.length > 0
      ? [{ category: "partial-result", code: "result.partial", message: "Command completed with incomplete results", details: { reasons } }]
      : [];
  return {
    contractVersion: CLI_CONTRACT_VERSION,
    command,
    status: partialFailure || (!failure && reasons.length > 0) ? "partial" : failure ? "error" : "success",
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
    const workspaceDir = resolveCliWorkspaceDir({
      flag: flag(argv, "--workspace"),
      optsWorkspaceDir: opts.workspaceDir,
    });
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
