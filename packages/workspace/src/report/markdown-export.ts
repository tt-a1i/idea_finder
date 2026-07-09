import type {
  CalibrationEvent,
  EvidenceItem,
  Opportunity,
} from "@idea-finder/core";
import type { HuntingBrief, InboxSignalSummary } from "../types.js";

export interface MarkdownReportInput {
  readonly brief: HuntingBrief;
  readonly opportunities: readonly Opportunity[];
  readonly calibrationEvents: readonly CalibrationEvent[];
  readonly evidenceById: Readonly<Record<string, EvidenceItem>>;
  readonly inbox: readonly InboxSignalSummary[];
  readonly runId: string | null;
}

function formatScore(score: Opportunity["scoreVector"]): string {
  return `freq=${score.frequency.toFixed(2)} cross=${score.crossSource.toFixed(2)} wtp=${score.wtpStrength.toFixed(2)}`;
}

export function renderMarkdownReport(input: MarkdownReportInput): string {
  const lines: string[] = [
    `# Demand Workspace Report: ${input.brief.title}`,
    "",
    `**Brief:** ${input.brief.slug} (\`${input.brief.id}\`)`,
    `**Generated:** ${new Date().toISOString()}`,
    input.runId ? `**Latest run:** \`${input.runId}\`` : "",
    "",
    "## Hunting brief",
    "",
    input.brief.description,
    "",
    `- **Lenses:** ${input.brief.lenses.join(", ")}`,
    `- **Sources:** ${input.brief.sourcesEnabled.join(", ")}`,
    `- **Success criteria:** ${input.brief.successCriteria}`,
    "",
    "## Signal inbox summary",
    "",
  ];

  if (input.inbox.length === 0) {
    lines.push("_No signals yet — run research first._", "");
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
    lines.push("_No evidence items._", "");
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
