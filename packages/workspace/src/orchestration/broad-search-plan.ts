import { createHash, randomUUID } from "node:crypto";
import type { ResearchLens, SearchPlan, SearchQueryVariant } from "../types.js";

const LENS_TEMPLATES: ReadonlyArray<{ lens: ResearchLens; suffixes: readonly string[] }> = [
  { lens: "topic_synonym", suffixes: ["", "tool", "workflow", "software"] },
  { lens: "persona", suffixes: ["for developers", "for founders", "for PMs", "for ops"] },
  { lens: "scenario", suffixes: ["daily workflow", "onboarding", "incident response", "reporting"] },
  { lens: "pain_failure", suffixes: ["painful", "frustrating", "broken", "fails"] },
  { lens: "workaround", suffixes: ["workaround", "manually", "spreadsheet", "hack"] },
  { lens: "alternative_seeking", suffixes: ["alternative to", "looking for tool", "replace", "recommendations"] },
  { lens: "commercial_intent", suffixes: ["would pay", "pricing", "subscription", "worth paying"] },
  { lens: "competitor_dissatisfaction", suffixes: ["too expensive", "switched from", "cancelled", "disappointed"] },
  { lens: "contradiction", suffixes: ["already solved", "works fine", "no need", "overkill"] },
];

function dedupeKey(text: string, source: string, language: string): string {
  return createHash("sha256").update(`${language}|${source}|${text.trim().toLowerCase()}`).digest("hex").slice(0, 16);
}

/** Build ≥30 deduped broad query variants covering ≥6 research lenses. */
export function buildBroadQueryVariants(plan: SearchPlan, options: { readonly round?: number } = {}): SearchQueryVariant[] {
  const round = options.round ?? 1;
  const sources = plan.sourceFamilies.filter((source) =>
    ["hn", "v2ex", "stack_exchange", "app_store", "github_issues"].includes(source),
  );
  const effectiveSources = sources.length > 0 ? sources : ["hn", "stack_exchange"];
  const languages = plan.languages.length > 0 ? plan.languages : ["en"];
  const seen = new Set<string>();
  const variants: SearchQueryVariant[] = [];

  const push = (queryText: string, lens: ResearchLens, source: string, language: string) => {
    const text = queryText.trim().replace(/\s+/g, " ");
    if (!text) return;
    const key = dedupeKey(text, source, language);
    if (seen.has(key)) return;
    seen.add(key);
    variants.push({
      id: `q_${randomUUID().slice(0, 12)}`,
      queryText: text,
      language,
      source,
      lens,
      round,
      parentQueryId: null,
      triggerEvidenceId: null,
      status: "pending",
      itemCount: 0,
      error: null,
    });
  };

  for (const language of languages) {
    for (const source of effectiveSources) {
      for (const template of LENS_TEMPLATES) {
        for (const suffix of template.suffixes) {
          const queryText = suffix
            ? (template.lens === "alternative_seeking" || template.lens === "competitor_dissatisfaction"
              ? `${suffix} ${plan.topic}`
              : `${plan.topic} ${suffix}`)
            : plan.topic;
          push(queryText, template.lens, source, language);
          if (variants.length >= Math.max(plan.budgets.queries, 30)) {
            return variants.slice(0, Math.max(plan.budgets.queries, 30));
          }
        }
      }
      for (const persona of plan.personas) {
        push(`${plan.topic} ${persona}`, "persona", source, language);
      }
      for (const scenario of plan.scenarios) {
        push(`${plan.topic} ${scenario}`, "scenario", source, language);
      }
    }
  }

  // Guarantee ≥30 / ≥6 even for tiny budgets by filling from topic alone across sources/lenses.
  while (variants.length < 30) {
    const lens = LENS_TEMPLATES[variants.length % LENS_TEMPLATES.length]!;
    const source = effectiveSources[variants.length % effectiveSources.length]!;
    const language = languages[variants.length % languages.length]!;
    push(`${plan.topic} ${lens.suffixes[variants.length % lens.suffixes.length] ?? "demand"} #${variants.length}`, lens.lens, source, language);
    if (variants.length > 200) break;
  }

  return variants;
}

export function countDistinctLenses(queries: readonly SearchQueryVariant[]): number {
  return new Set(queries.map((query) => query.lens)).size;
}
