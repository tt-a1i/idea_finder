import type { RawDocument } from "@idea-finder/core";

export interface SearchQuery {
  readonly platform: string;
  readonly terms: readonly string[];
  readonly since?: string;
}

export interface ConnectorHealth {
  readonly ok: boolean;
  readonly message?: string;
}

/** Source plugins fetch raw documents only — no LLM or opportunity logic. */
export interface SourceConnector {
  readonly platform: string;
  healthcheck(): Promise<ConnectorHealth>;
  search(query: SearchQuery): AsyncIterable<RawDocument>;
  fetch(externalId: string): Promise<RawDocument>;
}
