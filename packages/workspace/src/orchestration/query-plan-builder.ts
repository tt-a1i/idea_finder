import { createHash } from "node:crypto";
import type { HuntingTaskId } from "@idea-finder/core";
import type { QueryPlan } from "@idea-finder/connectors";
import type { HuntingBrief } from "../types.js";

export function resolveHarvestMode(brief: HuntingBrief): "manual" | "l0" {
  return brief.queryPlan?.harvestMode ?? "manual";
}

/** Build a QueryPlan without inventing evidence that was not explicitly configured. */
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
      manualImports: undefined,
    };
  }

  return {
    huntingTaskId,
    searches: [],
    manualImports: [],
  };
}

export function effectiveResearchConfig(brief: HuntingBrief): Readonly<Record<string, unknown>> {
  return {
    description: brief.description,
    harvestMode: resolveHarvestMode(brief),
    sourcesEnabled: [...brief.sourcesEnabled].sort(),
    lenses: [...brief.lenses],
    queryPlan: {
      searches: (brief.queryPlan?.searches ?? []).map((search) => ({
        platform: search.platform,
        terms: [...search.terms],
        limit: search.limit ?? null,
        appId: search.appId ?? null,
        stackExchangeSite: search.stackExchangeSite ?? null,
      })),
      manualImports: (brief.queryPlan?.manualImports ?? []).map((item) => ({
        text: item.text,
        url: item.url ?? null,
        title: item.title ?? null,
      })),
    },
  };
}

export function effectiveResearchConfigHash(brief: HuntingBrief): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(effectiveResearchConfig(brief))).digest("hex")}`;
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
