import type { HuntingTaskId } from "@idea-finder/core";

import type { SearchQuery } from "./ports/source-connector.js";

/** Per-source search parameters passed into connectors during harvest. */
export interface SourceSearchQuery extends SearchQuery {
  readonly huntingTaskId: HuntingTaskId;
  readonly limit?: number;
  /** App Store RSS: numeric app id, e.g. "544007664" for YouTube. */
  readonly appId?: string;
  /** Stack Exchange site slug; defaults to stackoverflow. */
  readonly stackExchangeSite?: string;
  readonly queryId?: string;
  readonly queryText?: string;
}

/** Manual text/URL import payload (no live fetch for body). */
export interface ManualImportInput {
  readonly text: string;
  readonly url?: string;
  readonly title?: string;
}

/** Harvest orchestration plan: which sources to query and optional manual imports. */
export interface QueryPlan {
  readonly huntingTaskId: HuntingTaskId;
  readonly searches: readonly SourceSearchQuery[];
  readonly manualImports?: readonly ManualImportInput[];
}
