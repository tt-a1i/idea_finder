import type {
  CalibrationEvent,
  EvidenceItem,
  Opportunity,
  ResearchClaim,
  ResearchLane,
} from "@idea-finder/core";
import type { HuntingBrief, InboxSignalSummary, ResearchSourceStatus } from "../types.js";
import type { StoredMultiLaneReportRecord } from "@idea-finder/storage";

export interface MarkdownReportInput {
  readonly brief: HuntingBrief;
  readonly opportunities: readonly Opportunity[];
  readonly calibrationEvents: readonly CalibrationEvent[];
  readonly evidenceById: Readonly<Record<string, EvidenceItem>>;
  readonly inbox: readonly InboxSignalSummary[];
  readonly runId: string | null;
  readonly researchStatus?: string | null;
  readonly multiLaneReport?: StoredMultiLaneReportRecord | null;
  readonly sourceStatuses?: readonly ResearchSourceStatus[];
  readonly incompletenessReasons?: readonly string[];
}

function formatScore(score: Opportunity["scoreVector"]): string {
  return `freq=${score.frequency.toFixed(2)} cross=${score.crossSource.toFixed(2)} wtp=${score.wtpStrength.toFixed(2)}`;
}

const LANE_ORDER: readonly ResearchLane[] = [
  "qualitative_demand",
  "trend_momentum",
  "supply_competition",
  "commercial_intent",
  "contradictory_evidence",
];

function claimRefs(claim: ResearchClaim): string {
  return claim.evidenceRefs.map((ref) => {
    if (ref.kind === "text_quote") return `quote:${ref.evidenceItemId}${ref.url ? ` (${ref.url})` : ""}`;
    if (ref.kind === "observation_series") return `series:${ref.seriesId}`;
    if (ref.kind === "ranking_snapshot") return `rank:${ref.observationId}${ref.sourceUrl ? ` (${ref.sourceUrl})` : ""}`;
    return JSON.stringify(ref);
  }).join("; ");
}

export function renderMarkdownReport(input: MarkdownReportInput): string {
  const report = input.multiLaneReport ?? null;
  const lines: string[] = [
    `# Demand Workspace Report: ${input.brief.title}`,
    "",
    `**Brief:** ${input.brief.slug} (\`${input.brief.id}\`)`,
    `**Generated:** ${new Date().toISOString()}`,
    input.runId ? `**Latest run:** \`${input.runId}\`` : "",
    input.researchStatus ? `**Research status:** ${input.researchStatus}` : "",
    "",
    "## Hunting brief",
    "",
    input.brief.description,
    "",
    `- **Lenses:** ${input.brief.lenses.join(", ")}`,
    `- **Sources:** ${input.brief.sourcesEnabled.join(", ")}`,
    `- **Success criteria:** ${input.brief.successCriteria}`,
    "",
  ];

  if (report) {
    lines.push("## Multi-lane research", "");
    lines.push(`Schema version: ${report.summary.schemaVersion}`, "");
    lines.push("### Evidence lanes", "");
    for (const lane of LANE_ORDER) {
      const summary = report.summary.lanes[lane];
      lines.push(
        `- **${lane}:** total=${summary.totalClaims}, validated=${summary.validatedClaims}, unvalidated=${summary.unvalidatedClaims}, contradicted=${summary.contradictedClaims}`,
      );
    }
    lines.push("");

    lines.push("### Claims", "");
    if (report.claims.length === 0) {
      lines.push("_No claims in this research run._", "");
    } else {
      for (const claim of report.claims) {
        lines.push(
          `- **[${claim.lane}]** ${claim.statement} (\`${claim.status}\`)`,
          `  - refs: ${claimRefs(claim)}`,
          ...(claim.limitations.length ? [`  - limitations: ${claim.limitations.join("; ")}`] : []),
        );
      }
      lines.push("");
    }

    lines.push("### Source statuses", "");
    const statuses = input.sourceStatuses ?? [];
    if (statuses.length === 0) {
      lines.push("_No source statuses recorded._", "");
    } else {
      lines.push("| Source | Status | Items | Reason |", "| --- | --- | ---: | --- |");
      for (const status of statuses) {
        lines.push(`| ${status.source} | ${status.status} | ${status.itemCount} | ${(status.reason ?? status.reasonCode).replace(/\|/g, "\\|")} |`);
      }
      lines.push("");
    }

    if (input.incompletenessReasons?.length) {
      lines.push("### Incompleteness", "");
      for (const reason of input.incompletenessReasons) lines.push(`- ${reason}`);
      lines.push("");
    }

    lines.push("### Candidate admission outcomes", "");
    lines.push("_Trend, GitHub popularity, and package downloads remain unvalidated demand and cannot alone enter the Opportunity Library._", "");
    for (const candidate of report.summary.candidates) {
      lines.push(
        `- **${candidate.id}** — ${candidate.admissionOutcome} / ${candidate.status}`,
        ...candidate.validationIssues.map((issue) => `  - ${issue.code}: ${issue.message}`),
      );
    }
    lines.push("");
  }

  lines.push("## Signal inbox summary", "");

  if (input.inbox.length === 0) {
    if (report) {
      lines.push("_No qualitative RawSignals in the inbox; multi-lane research results are above._", "");
    } else if (input.runId) {
      lines.push("_No qualitative RawSignals yet for this run._", "");
    } else {
      lines.push("_No signals yet — run research first._", "");
    }
  } else {
    lines.push("| Signal type | Count | Sample quote |", "| --- | ---: | --- |");
    for (const row of input.inbox) {
      const quote = row.sampleQuote.replace(/\|/g, "\\|").slice(0, 80);
      lines.push(`| ${row.signalType} | ${row.count} | ${quote} |`);
    }
    lines.push("");
  }

  lines.push("## Opportunity library", "");
  if (input.opportunities.length === 0) {
    lines.push("_No admitted opportunities._", "");
  } else {
    lines.push(
      "| Status | Confidence | Evidence | Demand statement |",
      "| --- | --- | ---: | --- |",
    );
    for (const opp of input.opportunities) {
      const stmt = opp.demandStatement.replace(/\|/g, "\\|");
      lines.push(
        `| ${opp.status} | ${opp.confidence} | ${opp.evidenceItemIds.length} | ${stmt} |`,
      );
    }
    lines.push("");
  }

  if (input.calibrationEvents.length > 0) {
    lines.push("## Board calibration", "");
    for (const event of input.calibrationEvents) {
      lines.push(
        `- **${event.action}** on \`${event.opportunityId}\` at ${event.occurredAt}${event.note ? ` — ${event.note}` : ""}`,
      );
    }
    lines.push("");
  }

  lines.push("## Evidence appendix", "");
  const citedIds = new Set(
    input.opportunities.flatMap((o) => [
      ...o.evidenceItemIds,
      ...o.disconfirmingEvidenceItemIds,
    ]),
  );

  if (citedIds.size === 0) {
    lines.push("_No admitted-opportunity evidence items._", "");
  } else {
    for (const id of [...citedIds].sort()) {
      const item = input.evidenceById[id];
      if (!item) continue;
      lines.push(
        `### ${id}`,
        "",
        `- **Platform:** ${item.platform}`,
        `- **URL:** ${item.url}`,
        `- **Claim:** ${item.supportsClaim} (${item.strength})`,
        `- **Score vector context:** ${formatScore(
          input.opportunities.find((o) => o.evidenceItemIds.includes(item.id))
            ?.scoreVector ?? {
            frequency: 0,
            crossSource: 0,
            recency: 0,
            wtpStrength: 0,
            workaroundDepth: 0,
          },
        )}`,
        "",
        `> ${item.quoteVerbatim}`,
        "",
      );
    }
  }

  return `${lines.filter((l) => l !== undefined).join("\n")}\n`;
}
