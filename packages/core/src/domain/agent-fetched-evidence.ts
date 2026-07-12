import { createHash } from "node:crypto";
import type { HuntingTaskId } from "./ids.js";
import type { FetchMethod, RawDocument } from "./types.js";
import { InvariantViolation } from "./validation.js";

export type EvidenceProvenanceKind = "manual" | "agent_fetched" | "fixture";

export interface AgentFetchedEvidenceInput {
  readonly sourceType: string;
  readonly canonicalUrl: string;
  readonly title: string;
  readonly author: string | null;
  readonly anonymous?: boolean;
  readonly publishedAt?: string | null;
  readonly updatedAt?: string | null;
  readonly retrievedAt: string;
  readonly verbatimQuote: string;
  readonly rawSnapshot?: string;
  readonly replayRef?: string;
  readonly queryId: string;
  readonly collectionMethod: string;
  readonly externalId: string;
  readonly huntingTaskId: HuntingTaskId;
  readonly researchRunId?: string;
}

export function classifyFetchProvenance(fetchMethod: FetchMethod): EvidenceProvenanceKind {
  if (fetchMethod === "fixture") return "fixture";
  if (fetchMethod === "agent_fetched" || fetchMethod === "browser_agent") return "agent_fetched";
  if (fetchMethod === "import") return "manual";
  return "agent_fetched";
}

/** Fail-closed validation for Agent-fetched evidence (distinct from manual import / fixture). */
export function assertAgentFetchedEvidence(input: AgentFetchedEvidenceInput): void {
  if (!input.sourceType.trim()) throw new InvariantViolation("evidence.source_required", "Agent-fetched evidence requires sourceType");
  if (!input.canonicalUrl.trim()) throw new InvariantViolation("evidence.url_required", "Agent-fetched evidence requires canonicalUrl");
  if (!input.retrievedAt.trim() || Number.isNaN(Date.parse(input.retrievedAt))) {
    throw new InvariantViolation("evidence.retrieved_at_required", "Agent-fetched evidence requires retrievedAt");
  }
  if (!input.verbatimQuote.trim()) throw new InvariantViolation("evidence.quote_required", "Agent-fetched evidence requires verbatimQuote");
  if (!input.queryId.trim()) throw new InvariantViolation("evidence.query_id_required", "Agent-fetched evidence requires queryId");
  if (!input.collectionMethod.trim()) throw new InvariantViolation("evidence.collection_method_required", "Agent-fetched evidence requires collectionMethod");
  if (!input.externalId.trim()) throw new InvariantViolation("evidence.external_id_required", "Agent-fetched evidence requires externalId");
  if (!input.title.trim()) throw new InvariantViolation("evidence.title_required", "Agent-fetched evidence requires title");
  if (!input.author?.trim() && !input.anonymous) {
    throw new InvariantViolation("evidence.author_required", "Agent-fetched evidence requires author or anonymous=true");
  }
  const snapshot = input.rawSnapshot?.trim() || "";
  const replay = input.replayRef?.trim() || "";
  if (!snapshot && !replay) {
    throw new InvariantViolation("evidence.snapshot_required", "Agent-fetched evidence requires rawSnapshot or replayRef");
  }
  if (snapshot && !snapshot.includes(input.verbatimQuote.trim())) {
    throw new InvariantViolation("evidence.quote_not_in_snapshot", "verbatimQuote must be locatable in rawSnapshot");
  }
}

export function agentFetchedIdempotencyKey(input: Pick<AgentFetchedEvidenceInput, "sourceType" | "externalId" | "canonicalUrl" | "verbatimQuote">): string {
  return createHash("sha256")
    .update([input.sourceType, input.externalId, input.canonicalUrl, input.verbatimQuote.trim()].join("|"))
    .digest("hex")
    .slice(0, 24);
}

export function toAgentFetchedRawDocument(input: AgentFetchedEvidenceInput): RawDocument {
  assertAgentFetchedEvidence(input);
  const body = [
    input.title,
    input.author ? `Author: ${input.author}` : "Author: anonymous",
    input.publishedAt ? `Published: ${input.publishedAt}` : null,
    input.updatedAt ? `Updated: ${input.updatedAt}` : null,
    `Retrieved: ${input.retrievedAt}`,
    `Query: ${input.queryId}`,
    `Collection: ${input.collectionMethod}`,
    "",
    input.rawSnapshot?.trim() || input.verbatimQuote,
    input.replayRef ? `\nReplay-Ref: ${input.replayRef}` : null,
  ].filter((line) => line !== null).join("\n");

  return {
    id: `doc_agent_${agentFetchedIdempotencyKey(input)}` as never,
    sourceTier: "L1",
    platform: input.sourceType,
    externalId: input.externalId,
    url: input.canonicalUrl,
    fetchedAt: input.retrievedAt,
    fetchMethod: "agent_fetched",
    fetchAgentRunId: null,
    contentType: "post",
    rawBody: body,
    huntingTaskId: input.huntingTaskId,
    retentionClass: "pinned",
    legalBasis: "public_api_tos",
  };
}
