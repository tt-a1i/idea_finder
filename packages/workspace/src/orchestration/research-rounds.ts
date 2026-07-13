import { createHash } from "node:crypto";
import type {
  ResearchLens,
  ResearchRoundSummary,
  ResearchStopReason,
  SearchPlan,
  SearchQueryVariant,
} from "../types.js";

export type { ResearchRoundSummary, ResearchStopReason };

export interface PainClusterSeed {
  readonly id: string;
  readonly painStatement: string;
  readonly signalTypes: readonly string[];
  readonly documentIds: readonly string[];
  readonly evidenceIds: readonly string[];
  readonly independentSourceCount: number;
  readonly languages: readonly string[];
}

const PAIN_SIGNAL_TYPES = new Set([
  "pain",
  "workaround",
  "alternative_seek",
  "willingness_to_pay",
  "competitor_dissatisfaction",
  "feature_request",
]);

const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "to", "of", "in", "on", "for", "with", "is", "are", "was", "were",
  "this", "that", "it", "we", "you", "i", "my", "our", "their", "be", "been", "from", "at", "as",
  "by", "not", "no", "so", "if", "but", "just", "very", "into", "about", "have", "has", "had",
]);

function normalizeQuote(quote: string): string {
  return quote
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^a-z0-9\u4e00-\u9fff\s]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function significantTokens(quote: string): string[] {
  const normalized = normalizeQuote(quote);
  const raw = normalized.split(" ").filter((token) => token.length >= 3 && !STOP_WORDS.has(token));
  if (raw.length > 0) return [...new Set(raw)].slice(0, 12);
  const compact = normalized.replace(/\s+/g, "");
  const grams: string[] = [];
  for (let i = 0; i < compact.length - 1; i += 1) {
    grams.push(compact.slice(i, i + 2));
  }
  return [...new Set(grams)].slice(0, 12);
}

function jaccard(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setB = new Set(b);
  let intersection = 0;
  for (const token of a) {
    if (setB.has(token)) intersection += 1;
  }
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : intersection / union;
}

function stableClusterId(tokens: readonly string[]): string {
  const canonical = [...tokens].sort().join("|");
  return `cluster_${createHash("sha256").update(canonical || "empty").digest("hex").slice(0, 12)}`;
}

/** Lexical pain clustering: merge similar quotes; ids from shared token cores so later similar members do not churn identity. */
export function clusterPainSignals(input: {
  readonly signals: readonly {
    readonly id: string;
    readonly signalType: string;
    readonly quoteVerbatim: string;
    readonly documentId: string;
  }[];
  readonly independenceGroupByDocumentId: ReadonlyMap<string, string>;
  readonly documentLanguages?: ReadonlyMap<string, string>;
  readonly similarityThreshold?: number;
}): PainClusterSeed[] {
  const threshold = input.similarityThreshold ?? 0.35;
  type Member = {
    readonly id: string;
    readonly signalType: string;
    readonly quoteVerbatim: string;
    readonly documentId: string;
    readonly tokens: readonly string[];
  };
  const members: Member[] = [...input.signals]
    .filter((signal) => PAIN_SIGNAL_TYPES.has(signal.signalType))
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((signal) => ({ ...signal, tokens: significantTokens(signal.quoteVerbatim) }));

  type Group = { readonly anchor: Member; readonly members: Member[] };
  const groups: Group[] = [];
  for (const member of members) {
    let bestIndex = -1;
    let bestScore = 0;
    for (let i = 0; i < groups.length; i += 1) {
      const group = groups[i]!;
      const score = Math.max(...group.members.map((other) => jaccard(member.tokens, other.tokens)));
      if (score >= threshold && score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }
    if (bestIndex >= 0) groups[bestIndex]!.members.push(member);
    else groups.push({ anchor: member, members: [member] });
  }

  return groups
    .map((group) => {
      const sorted = [...group.members].sort((a, b) => a.id.localeCompare(b.id));
      const documentIds = [...new Set(sorted.map((item) => item.documentId))];
      const groupsIndep = new Set(documentIds.map((id) => input.independenceGroupByDocumentId.get(id) ?? id));
      const statement = [...sorted].sort((a, b) => b.quoteVerbatim.length - a.quoteVerbatim.length || a.id.localeCompare(b.id))[0]!.quoteVerbatim.slice(0, 180);
      const tokenSets = sorted.map((item) => item.tokens);
      let canonicalTokens = [...(tokenSets[0] ?? [])];
      for (let i = 1; i < tokenSets.length; i += 1) {
        const tokenSet = new Set(tokenSets[i]);
        canonicalTokens = canonicalTokens.filter((token) => tokenSet.has(token));
      }
      if (canonicalTokens.length === 0) {
        canonicalTokens = group.anchor.tokens.length > 0
          ? [...group.anchor.tokens]
          : [statement];
      }
      return {
        id: stableClusterId(canonicalTokens),
        painStatement: statement,
        signalTypes: [...new Set(sorted.map((item) => item.signalType))],
        documentIds,
        evidenceIds: sorted.map((item) => item.id),
        independentSourceCount: groupsIndep.size,
        languages: [...new Set(documentIds.map((id) => input.documentLanguages?.get(id) ?? "und"))].sort(),
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function countNewClusters(
  previousIds: ReadonlySet<string>,
  current: readonly PainClusterSeed[],
): number {
  return current.filter((cluster) => !previousIds.has(cluster.id)).length;
}

export function isRetryableQueryStatus(status: SearchQueryVariant["status"]): boolean {
  return status === "pending" || status === "failure" || status === "partial";
}

const DIVERGENCE_LENSES: ResearchLens[] = [
  "persona",
  "scenario",
  "workaround",
  "alternative_seeking",
  "contradiction",
  "commercial_intent",
  "pain_failure",
];

const DIVERGENCE_SUFFIXES: Record<string, { en: readonly string[]; zh: readonly string[] }> = {
  persona: { en: ["for developers", "for founders", "for PMs"], zh: ["开发者", "创业者", "产品经理"] },
  scenario: { en: ["daily workflow", "onboarding", "incident response"], zh: ["日常工作流", "上手流程", "故障排查"] },
  workaround: { en: ["workaround", "manually", "spreadsheet"], zh: ["变通办法", "手动处理", "用表格"] },
  alternative_seeking: { en: ["alternative to", "looking for tool", "replace"], zh: ["替代方案", "有没有工具", "想换掉"] },
  contradiction: { en: ["already solved", "works fine", "no need"], zh: ["已经够用", "没什么问题", "不需要"] },
  commercial_intent: { en: ["would pay", "pricing", "subscription"], zh: ["愿意付费", "价格", "订阅"] },
  pain_failure: { en: ["painful", "frustrating", "broken"], zh: ["痛点", "很麻烦", "不好用"] },
};

function divergenceText(topic: string, lens: ResearchLens, language: string, index: number): string {
  const pack = DIVERGENCE_SUFFIXES[lens] ?? DIVERGENCE_SUFFIXES.pain_failure!;
  const suffixes = language === "zh" ? pack.zh : pack.en;
  const suffix = suffixes[index % suffixes.length]!;
  if (lens === "alternative_seeking" || lens === "competitor_dissatisfaction") {
    return language === "zh" ? `${suffix} ${topic}` : `${suffix} ${topic}`;
  }
  return `${topic} ${suffix}`;
}

/** Broaden search when no pain clusters yet — rotate persona/scenario/source/language. */
export function generateDivergenceQueries(input: {
  readonly plan: SearchPlan;
  readonly round: number;
  readonly existingQueryTexts: ReadonlySet<string>;
}): SearchQueryVariant[] {
  const sources = input.plan.sourceFamilies.filter((source) =>
    ["hn", "v2ex", "stack_exchange", "github_issues"].includes(source),
  );
  const effectiveSources = sources.length > 0 ? sources : ["hn"];
  const languages = input.plan.languages.length > 0 ? input.plan.languages : ["en"];
  const followUps: SearchQueryVariant[] = [];
  let slot = 0;
  for (const lens of DIVERGENCE_LENSES) {
    for (let variant = 0; variant < 3; variant += 1) {
      const source = effectiveSources[slot % effectiveSources.length]!;
      const language = languages[slot % languages.length]!;
      slot += 1;
      const queryText = divergenceText(input.plan.topic, lens, language, variant);
      if (input.existingQueryTexts.has(queryText.toLowerCase())) continue;
      followUps.push({
        id: `q_${createHash("sha256").update(`div|${input.round}|${lens}|${source}|${language}|${variant}|${queryText}`).digest("hex").slice(0, 12)}`,
        queryText,
        language,
        source,
        lens,
        round: input.round,
        parentQueryId: null,
        triggerEvidenceId: null,
        status: "pending",
        itemCount: 0,
        error: null,
      });
    }
  }
  return followUps;
}

export function generateFollowUpQueries(input: {
  readonly plan: SearchPlan;
  readonly round: number;
  readonly clusters: readonly PainClusterSeed[];
  readonly existingQueryTexts: ReadonlySet<string>;
  readonly evidenceToQueryId?: ReadonlyMap<string, string>;
}): SearchQueryVariant[] {
  if (input.clusters.length === 0) {
    return generateDivergenceQueries(input);
  }
  const followUps: SearchQueryVariant[] = [];
  const sources = input.plan.sourceFamilies.filter((source) =>
    ["hn", "v2ex", "stack_exchange", "github_issues"].includes(source),
  );
  const effectiveSources = sources.length > 0 ? sources : ["hn"];
  const languages = input.plan.languages.length > 0 ? input.plan.languages : ["en"];
  const lenses: ResearchLens[] = [
    "persona",
    "workaround",
    "competitor_dissatisfaction",
    "contradiction",
    "commercial_intent",
    "pain_failure",
  ];
  let slot = 0;
  for (const cluster of input.clusters.slice(0, 6)) {
    for (const lens of lenses) {
      const source = effectiveSources[slot % effectiveSources.length]!;
      const language = languages[slot % languages.length]!;
      slot += 1;
      const queryText = language === "zh"
        ? `${input.plan.topic} ${cluster.painStatement.slice(0, 40)} ${divergenceText("", lens, "zh", 0).trim()}`
        : `${input.plan.topic} ${cluster.painStatement.slice(0, 40)} ${lens}`;
      if (input.existingQueryTexts.has(queryText.toLowerCase())) continue;
      const trigger = cluster.evidenceIds[0] ?? null;
      followUps.push({
        id: `q_${createHash("sha256").update(`${input.round}|${cluster.id}|${lens}|${source}|${language}`).digest("hex").slice(0, 12)}`,
        queryText,
        language,
        source,
        lens,
        round: input.round,
        parentQueryId: trigger ? (input.evidenceToQueryId?.get(trigger) ?? null) : null,
        triggerEvidenceId: trigger,
        status: "pending",
        itemCount: 0,
        error: null,
      });
    }
  }
  return followUps;
}

export function evaluateStopCondition(input: {
  readonly rounds: readonly ResearchRoundSummary[];
  readonly budgets: { readonly queries: number; readonly documents: number; readonly rounds: number };
  readonly executedQueryCount: number;
  readonly documentCount: number;
  readonly coverageIncomplete: boolean;
}): ResearchStopReason {
  if (
    input.executedQueryCount >= input.budgets.queries ||
    input.documentCount >= input.budgets.documents ||
    input.rounds.length >= input.budgets.rounds
  ) {
    return input.coverageIncomplete ? "budget_exhausted_partial" : "budget_exhausted";
  }
  if (input.rounds.length >= 2) {
    const last = input.rounds[input.rounds.length - 1]!;
    const prev = input.rounds[input.rounds.length - 2]!;
    if (last.newClusterCount === 0 && prev.newClusterCount === 0) {
      return input.coverageIncomplete ? "budget_exhausted_partial" : "saturated";
    }
  }
  return "continue";
}

export function baseSearchQueryId(queryId: string): string {
  return queryId.replace(/__(?:comment|story)$/, "");
}

export function applyQueryExecutionWriteback(
  queries: readonly SearchQueryVariant[],
  sourceStatuses: readonly {
    readonly id?: string;
    readonly requestKey?: string;
    readonly status: string;
    readonly itemCount: number;
    readonly reason?: string | null;
  }[],
  executedIds: ReadonlySet<string>,
): SearchQueryVariant[] {
  const byQuery = new Map<string, { itemCount: number; statuses: string[]; errors: string[] }>();
  for (const status of sourceStatuses) {
    const key = status.requestKey ?? status.id ?? "";
    const match = /^query:(.+)$/.exec(key);
    if (!match) continue;
    const queryId = baseSearchQueryId(match[1]!);
    const bucket = byQuery.get(queryId) ?? { itemCount: 0, statuses: [], errors: [] };
    bucket.itemCount += status.itemCount;
    bucket.statuses.push(status.status);
    if (status.reason) bucket.errors.push(status.reason);
    byQuery.set(queryId, bucket);
  }

  return queries.map((query) => {
    if (!executedIds.has(query.id)) return query;
    const bucket = byQuery.get(query.id);
    if (!bucket || bucket.statuses.length === 0) {
      return { ...query, status: "failure", itemCount: 0, error: "No source execution recorded" };
    }
    const anySuccess = bucket.statuses.some((item) => item === "success");
    const anyFailure = bucket.statuses.some((item) => item !== "success");
    if (anySuccess && anyFailure) {
      return {
        ...query,
        status: "partial",
        itemCount: bucket.itemCount,
        error: bucket.errors[0] ?? "Partial source execution failure",
      };
    }
    if (!anySuccess) {
      return {
        ...query,
        status: "failure",
        itemCount: bucket.itemCount,
        error: bucket.errors[0] ?? "Query failed",
      };
    }
    return {
      ...query,
      status: "success",
      itemCount: bucket.itemCount,
      error: null,
    };
  });
}

export function buildDocumentToQueryIdMap(
  sourceStatuses: readonly {
    readonly id?: string;
    readonly requestKey?: string;
    readonly artifactIds?: readonly string[];
  }[],
): Map<string, string> {
  const map = new Map<string, string>();
  for (const status of sourceStatuses) {
    const key = status.requestKey ?? status.id ?? "";
    const match = /^query:(.+)$/.exec(key);
    if (!match) continue;
    const queryId = baseSearchQueryId(match[1]!);
    for (const documentId of status.artifactIds ?? []) {
      map.set(documentId, queryId);
    }
  }
  return map;
}

export function selectQueriesForRound(input: {
  readonly queries: readonly SearchQueryVariant[];
  readonly round: number;
  readonly budgets: { readonly queries: number; readonly documents: number; readonly rounds: number };
  readonly executedQueryCount: number;
  readonly documentCount: number;
}): { readonly toRun: SearchQueryVariant[]; readonly skipped: SearchQueryVariant[] } {
  const remainingQueries = Math.max(0, input.budgets.queries - input.executedQueryCount);
  const remainingDocs = Math.max(0, input.budgets.documents - input.documentCount);
  const perRoundCap = Math.max(1, Math.floor(input.budgets.queries / Math.max(1, input.budgets.rounds)));
  const roundQueryBudget = Math.min(remainingQueries, perRoundCap);
  if (roundQueryBudget === 0 || remainingDocs === 0) {
    const pending = input.queries.filter((query) => query.round === input.round && isRetryableQueryStatus(query.status));
    return { toRun: [], skipped: pending };
  }
  const pending = input.queries.filter((query) => query.round === input.round && isRetryableQueryStatus(query.status));
  const toRun = pending.slice(0, roundQueryBudget);
  const skipped = pending.slice(roundQueryBudget);
  return { toRun, skipped };
}
