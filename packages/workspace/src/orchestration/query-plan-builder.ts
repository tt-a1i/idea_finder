import { createHash } from "node:crypto";
import type { HuntingTaskId } from "@idea-finder/core";
import type { QueryPlan, SourceSearchQuery } from "@idea-finder/connectors";
import type { HuntingBrief, SearchQueryVariant } from "../types.js";

export function resolveHarvestMode(brief: HuntingBrief): "manual" | "l0" {
  return brief.queryPlan?.harvestMode ?? "manual";
}

const NETWORK_SOURCES = new Set(["hn", "v2ex", "app_store", "stack_exchange", "github_issues"]);

function expandHnSearches(search: SourceSearchQuery): SourceSearchQuery[] {
  if (search.platform !== "hn") return [search];
  const queryId = search.queryId ?? `hn_${search.queryText ?? search.terms[0] ?? "query"}`;
  return [
    { ...search, queryId, hnTags: "story" },
    { ...search, queryId: `${queryId}__comment`, hnTags: "comment" },
  ];
}

/** Build a QueryPlan without inventing evidence that was not explicitly configured. */
export function buildQueryPlanFromBrief(
  brief: HuntingBrief,
  huntingTaskId: HuntingTaskId,
  searchPlanQueries?: readonly { readonly id: string; readonly queryText: string; readonly source: string }[],
): QueryPlan {
  if (searchPlanQueries && searchPlanQueries.length > 0) {
    // Manual-only briefs may still reference a confirmed SearchPlan for auditability,
    // but must not enqueue network searches without L0 connectors.
    if (resolveHarvestMode(brief) === "manual") {
      return {
        huntingTaskId,
        searches: [],
        manualImports: brief.queryPlan?.manualImports,
      };
    }
    return {
      huntingTaskId,
      searches: searchPlanQueries
        .filter((query) => NETWORK_SOURCES.has(query.source))
        .flatMap((query) => expandHnSearches({
          platform: query.source,
          terms: [query.queryText],
          queryText: query.queryText,
          queryId: query.id,
          huntingTaskId,
        })),
      manualImports: brief.queryPlan?.manualImports,
    };
  }

  const saved = brief.queryPlan;
  const harvestMode = resolveHarvestMode(brief);

  if (saved?.searches?.length || saved?.manualImports?.length) {
    // Expand multi-term searches into independent query variants (one term each).
    const searches: SourceSearchQuery[] = [];
    for (const search of saved.searches ?? []) {
      const terms = [...search.terms];
      if (terms.length <= 1) {
        searches.push(...expandHnSearches({
          platform: search.platform,
          terms,
          queryText: terms[0],
          huntingTaskId,
          limit: search.limit,
          appId: search.appId,
          stackExchangeSite: search.stackExchangeSite,
        }));
        continue;
      }
      for (const [index, term] of terms.entries()) {
        searches.push(...expandHnSearches({
          platform: search.platform,
          terms: [term],
          queryText: term,
          queryId: `legacy_${search.platform}_${index}`,
          huntingTaskId,
          limit: search.limit,
          appId: search.appId,
          stackExchangeSite: search.stackExchangeSite,
        }));
      }
    }
    return {
      huntingTaskId,
      searches,
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
        .flatMap((platform) =>
          (uniqueTerms.length > 0 ? uniqueTerms : ["tooling"]).flatMap((term, index) =>
            expandHnSearches({
              platform,
              terms: [term],
              queryText: term,
              queryId: `l0_${platform}_${index}`,
              huntingTaskId,
              limit: 5,
            }),
          ),
        ),
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
      quantitative: brief.queryPlan?.quantitative ?? null,
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

export function pendingSearchPlanQueries(
  queries: readonly SearchQueryVariant[],
): readonly SearchQueryVariant[] {
  return queries.filter((query) => query.status === "pending");
}
