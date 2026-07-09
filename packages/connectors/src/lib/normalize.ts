import type {
  FetchMethod,
  HuntingTaskId,
  LegalBasis,
  RawDocument,
  RetentionClass,
  SourceTier,
} from "@idea-finder/core";

import { documentId } from "./ids.js";

export interface NormalizeDocumentInput {
  readonly platform: string;
  readonly externalId: string | null;
  readonly url: string;
  readonly rawBody: string;
  readonly contentType: RawDocument["contentType"];
  readonly huntingTaskId: HuntingTaskId;
  readonly fetchMethod: FetchMethod;
  readonly legalBasis: LegalBasis;
  readonly sourceTier?: SourceTier;
  readonly retentionClass?: RetentionClass;
  readonly fetchedAt?: string;
}

/** Build a RawDocument with L0 defaults and required provenance fields. */
export function normalizeDocument(input: NormalizeDocumentInput): RawDocument {
  const key = input.externalId ?? input.url;
  return {
    id: documentId(input.platform, key),
    sourceTier: input.sourceTier ?? "L0",
    platform: input.platform,
    externalId: input.externalId,
    url: input.url,
    fetchedAt: input.fetchedAt ?? new Date().toISOString(),
    fetchMethod: input.fetchMethod,
    fetchAgentRunId: null,
    contentType: input.contentType,
    rawBody: input.rawBody,
    huntingTaskId: input.huntingTaskId,
    retentionClass: input.retentionClass ?? "standard",
    legalBasis: input.legalBasis,
  };
}
