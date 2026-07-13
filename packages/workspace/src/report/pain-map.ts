import type { ResearchRoundSummary, ResearchStopReason, SearchPlan } from "../types.js";
import type { PainClusterSeed } from "../orchestration/research-rounds.js";

export interface PainMapReport {
  readonly schemaVersion: "pain_map_v1";
  readonly topic: string;
  readonly confirmedPlan: {
    readonly planId: string;
    readonly version: number;
    readonly personas: readonly string[];
    readonly languages: readonly string[];
    readonly sourceFamilies: readonly string[];
    readonly budgets: SearchPlan["budgets"];
  };
  readonly stats: {
    readonly queryCount: number;
    readonly sourceCount: number;
    readonly documentCount: number;
    readonly evidenceCount: number;
    readonly dedupeCount: number;
    readonly clusterCount: number;
    readonly roundCount: number;
    readonly stopReason: ResearchStopReason | "unknown";
    readonly incompleteSources: readonly string[];
  };
  readonly clusters: readonly PainMapCluster[];
  readonly facts: readonly string[];
  readonly inference: readonly string[];
  readonly contradictions: readonly string[];
  readonly partial: readonly string[];
  readonly unresolvedUncertainty: readonly string[];
}

export interface PainMapCluster {
  readonly id: string;
  readonly painStatement: string;
  readonly affectedPersonas: readonly string[];
  readonly scenario: string;
  readonly repeatedBehavior: string | null;
  readonly currentWorkaround: string | null;
  readonly alternativeSeeking: string | null;
  readonly commercialEvidence: string | null;
  readonly competitorDissatisfaction: string | null;
  readonly contradictoryEvidence: string | null;
  readonly independentSourceCount: number;
  readonly evidenceCount: number;
  readonly languages: readonly string[];
  readonly recency: string | null;
  readonly coverageLimitations: readonly string[];
  readonly nextResearchQuestions: readonly string[];
  readonly strength: "weak/single-source" | "corroborated";
  readonly evidenceRefs: readonly { readonly quote: string; readonly url?: string; readonly evidenceId?: string }[];
}

export function buildPainMapReport(input: {
  readonly plan: SearchPlan;
  readonly clusters: readonly PainClusterSeed[];
  readonly rounds: readonly ResearchRoundSummary[];
  readonly stopReason: ResearchStopReason | "unknown";
  readonly documentCount: number;
  readonly evidenceCount: number;
  readonly dedupeCount: number;
  readonly incompleteSources: readonly string[];
  readonly evidenceSnippets?: readonly { readonly clusterId: string; readonly quote: string; readonly url?: string; readonly evidenceId?: string; readonly signalType?: string }[];
}): PainMapReport {
  const clusters: PainMapCluster[] = input.clusters.map((cluster) => {
    const snippets = (input.evidenceSnippets ?? []).filter((item) => item.clusterId === cluster.id || cluster.evidenceIds.includes(item.evidenceId ?? ""));
    const byType = (type: string) => snippets.find((item) => item.signalType === type)?.quote ?? null;
    return {
      id: cluster.id,
      painStatement: cluster.painStatement,
      affectedPersonas: [...input.plan.personas],
      scenario: input.plan.scenarios[0] ?? "unspecified",
      repeatedBehavior: byType("pain"),
      currentWorkaround: byType("workaround"),
      alternativeSeeking: byType("alternative_seek"),
      commercialEvidence: byType("willingness_to_pay"),
      competitorDissatisfaction: byType("competitor_dissatisfaction"),
      contradictoryEvidence: byType("validation_negative"),
      independentSourceCount: cluster.independentSourceCount,
      evidenceCount: cluster.evidenceIds.length,
      languages: [...new Set(cluster.languages.map(String))],
      recency: null,
      coverageLimitations: input.incompleteSources.length
        ? [`Incomplete sources: ${input.incompleteSources.join(", ")}`]
        : [],
      nextResearchQuestions: [
        `What workaround is most common for: ${cluster.painStatement.slice(0, 80)}?`,
        "Is there willingness-to-pay evidence beyond this cluster?",
      ],
      strength: cluster.independentSourceCount <= 1 ? "weak/single-source" : "corroborated",
      evidenceRefs: snippets.map((item) => ({ quote: item.quote, url: item.url, evidenceId: item.evidenceId })),
    };
  });

  return {
    schemaVersion: "pain_map_v1",
    topic: input.plan.topic,
    confirmedPlan: {
      planId: input.plan.id,
      version: input.plan.version,
      personas: input.plan.personas,
      languages: input.plan.languages,
      sourceFamilies: input.plan.sourceFamilies,
      budgets: input.plan.budgets,
    },
    stats: {
      queryCount: input.plan.queries.length,
      sourceCount: new Set(input.plan.queries.map((query) => query.source)).size || input.plan.sourceFamilies.length,
      documentCount: input.documentCount,
      evidenceCount: input.evidenceCount,
      dedupeCount: input.dedupeCount,
      clusterCount: clusters.length,
      roundCount: input.rounds.length || 1,
      stopReason: input.stopReason,
      incompleteSources: input.incompleteSources,
    },
    clusters,
    facts: clusters.flatMap((cluster) => cluster.evidenceRefs.map((ref) => ref.quote)).slice(0, 20),
    inference: [
      "Cluster labels are rule/heuristic groupings over stored evidence, not validated demand.",
      "Trends, stars, downloads, and ranks are background only and are not listed as pain facts.",
    ],
    contradictions: clusters.map((cluster) => cluster.contradictoryEvidence).filter((item): item is string => Boolean(item)),
    partial: input.incompleteSources.map((source) => `Incomplete source: ${source}`),
    unresolvedUncertainty: [
      "Willingness to pay and independent corroboration may remain incomplete.",
      ...(input.stopReason === "budget_exhausted_partial" || input.stopReason === "budget_exhausted"
        ? ["Stopped due to budget before claiming market saturation."]
        : []),
      ...(input.stopReason === "saturated" ? ["Stopped after two rounds without new independent pain clusters."] : []),
    ],
  };
}

export function renderPainMapMarkdown(report: PainMapReport): string {
  const lines: string[] = [
    `# Pain map: ${report.topic}`,
    "",
    "## Research coverage",
    `- Plan: ${report.confirmedPlan.planId} v${report.confirmedPlan.version}`,
    `- Queries: ${report.stats.queryCount}`,
    `- Sources: ${report.stats.sourceCount}`,
    `- Documents: ${report.stats.documentCount}`,
    `- Evidence: ${report.stats.evidenceCount}`,
    `- Deduped: ${report.stats.dedupeCount}`,
    `- Clusters: ${report.stats.clusterCount}`,
    `- Rounds: ${report.stats.roundCount}`,
    `- Stop reason: ${report.stats.stopReason}`,
    `- Incomplete sources: ${report.stats.incompleteSources.join(", ") || "none"}`,
    "",
    "## Pain clusters",
  ];
  for (const cluster of report.clusters) {
    lines.push(`### ${cluster.painStatement}`);
    lines.push(`- Strength: ${cluster.strength}`);
    lines.push(`- Personas: ${cluster.affectedPersonas.join(", ")}`);
    lines.push(`- Scenario: ${cluster.scenario}`);
    lines.push(`- Independent sources: ${cluster.independentSourceCount}; evidence: ${cluster.evidenceCount}`);
    lines.push(`- Languages: ${cluster.languages.join(", ")}`);
    if (cluster.currentWorkaround) lines.push(`- Workaround: ${cluster.currentWorkaround}`);
    if (cluster.alternativeSeeking) lines.push(`- Alternative seeking: ${cluster.alternativeSeeking}`);
    if (cluster.commercialEvidence) lines.push(`- Commercial: ${cluster.commercialEvidence}`);
    if (cluster.competitorDissatisfaction) lines.push(`- Competitor dissatisfaction: ${cluster.competitorDissatisfaction}`);
    if (cluster.contradictoryEvidence) lines.push(`- Contradiction: ${cluster.contradictoryEvidence}`);
    for (const ref of cluster.evidenceRefs) {
      lines.push(`- Evidence: "${ref.quote}"${ref.url ? ` (${ref.url})` : ""}`);
    }
    lines.push("");
  }
  lines.push("## Facts", ...report.facts.map((item) => `- ${item}`), "");
  lines.push("## Inference", ...report.inference.map((item) => `- ${item}`), "");
  lines.push("## Contradictory evidence", ...(report.contradictions.length ? report.contradictions.map((item) => `- ${item}`) : ["- none"]), "");
  lines.push("## Partial result", ...(report.partial.length ? report.partial.map((item) => `- ${item}`) : ["- none"]), "");
  lines.push("## Unresolved uncertainty", ...report.unresolvedUncertainty.map((item) => `- ${item}`), "");
  return lines.join("\n");
}
