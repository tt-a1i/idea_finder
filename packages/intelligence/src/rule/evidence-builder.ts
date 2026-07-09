import { asId, type Chunk, type EvidenceItem, type RawDocument, type RawSignal } from "@idea-finder/core";
import { MAX_QUOTE_VERBATIM_LENGTH } from "@idea-finder/core";

import type { SignalCluster } from "./cluster.js";
import { signalTypeToSupportsClaim } from "./signal-to-claim.js";

export function buildEvidenceFromSignal(
  signal: RawSignal,
  clusterId: SignalCluster["id"],
  chunk: Chunk,
  document: RawDocument,
): EvidenceItem | null {
  const supportsClaim = signalTypeToSupportsClaim(signal.signalType);
  if (!supportsClaim || supportsClaim === "disconfirming") {
    return null;
  }

  const quoteVerbatim = trimQuote(signal.quoteVerbatim, chunk.text);
  if (!quoteVerbatim || !chunk.text.includes(quoteVerbatim)) {
    return null;
  }

  const strength =
    supportsClaim === "wtp" || supportsClaim === "workaround" ? "primary" : "supporting";

  return {
    id: asId(`ev_${signal.id}`),
    clusterId,
    opportunityId: null,
    rawSignalId: signal.id,
    documentId: signal.documentId,
    chunkId: signal.chunkId,
    platform: document.platform,
    url: document.url,
    linkStatus: "ok",
    quoteVerbatim,
    supportsClaim,
    strength,
    userVerified: false,
    provenance: { createdBy: "pipeline", agentRunId: null },
    fetchedAt: document.fetchedAt,
  };
}

function trimQuote(quote: string, chunkText: string): string {
  if (quote.length <= MAX_QUOTE_VERBATIM_LENGTH && chunkText.includes(quote)) {
    return quote;
  }
  const truncated = quote.slice(0, MAX_QUOTE_VERBATIM_LENGTH);
  if (chunkText.includes(truncated)) {
    return truncated;
  }
  const window = chunkText.slice(0, MAX_QUOTE_VERBATIM_LENGTH);
  return window.length > 0 ? window : "";
}
