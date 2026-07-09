import type { HuntingTaskId } from "@idea-finder/core";
import type { QueryPlan } from "@idea-finder/connectors";
import type { HuntingBrief } from "../types.js";

const DEFAULT_MANUAL_IMPORTS = [
  {
    text: "I invoice from a Google Sheet every month — painful workaround reconciling Stripe payouts.",
  },
  {
    text: "Would pay $30/mo for lightweight solo SaaS invoicing with Stripe sync.",
  },
  {
    text: "Need something simpler than QuickBooks for month-end invoicing.",
  },
  {
    text: "QuickBooks works fine for enterprise — not a problem for us.",
  },
] as const;

export function resolveHarvestMode(brief: HuntingBrief): "manual" | "l0" {
  return brief.queryPlan?.harvestMode ?? "manual";
}

/** Build a QueryPlan from brief config, falling back to safe manual imports. */
export function buildQueryPlanFromBrief(
  brief: HuntingBrief,
  huntingTaskId: HuntingTaskId,
): QueryPlan {
  const saved = brief.queryPlan;
  const harvestMode = resolveHarvestMode(brief);

  if (saved?.searches?.length || saved?.manualImports?.length) {
    return {
      huntingTaskId,
      searches: (saved.searches ?? []).map((search) => ({
        ...search,
        huntingTaskId,
      })),
      manualImports: saved.manualImports,
    };
  }

  if (harvestMode === "l0") {
    const terms = [
      ...brief.lenses,
      ...brief.description.split(/\s+/).filter((w) => w.length > 3).slice(0, 3),
    ];
    const uniqueTerms = [...new Set(terms)].slice(0, 4);
    return {
      huntingTaskId,
      searches: brief.sourcesEnabled
        .filter((platform) => platform !== "manual" && platform !== "reddit")
        .map((platform) => ({
          platform,
          terms: uniqueTerms.length > 0 ? uniqueTerms : ["tooling"],
          huntingTaskId,
          limit: 5,
        })),
      manualImports: brief.description
        ? [{ text: brief.description }]
        : undefined,
    };
  }

  const manualImports = brief.description
    ? [{ text: brief.description }, ...DEFAULT_MANUAL_IMPORTS]
    : [...DEFAULT_MANUAL_IMPORTS];

  return {
    huntingTaskId,
    searches: [],
    manualImports,
  };
}

export function queryTermsFromBrief(brief: HuntingBrief): string[] {
  const fromPlan = brief.queryPlan?.searches?.flatMap((s) => s.terms) ?? [];
  const fromLenses = [...brief.lenses];
  const fromDescription = brief.description
    .split(/\s+/)
    .filter((w) => w.length > 3)
    .slice(0, 5);
  return [...new Set([...fromPlan, ...fromLenses, ...fromDescription])];
}
