import type {
  Chunk,
  EvidenceItem,
  OpportunityDraft,
  RawDocument,
  RawSignal,
  ResearchRunId,
} from "@idea-finder/core";
import type { HarvestResult } from "@idea-finder/harvest";

import type { IntelligenceReadPorts } from "../ports/run-scoped-read.js";
import type { IntelligenceWritePorts } from "../ports/run-scoped-write.js";
import { InMemoryRunScopedStore } from "./run-scoped-store.js";

export interface InMemoryIntelligenceStores
  extends IntelligenceReadPorts,
    IntelligenceWritePorts {
  readonly documents: InMemoryRunScopedStore<RawDocument>;
  readonly chunks: InMemoryRunScopedStore<Chunk>;
  readonly signals: InMemoryRunScopedStore<RawSignal>;
  readonly evidence: InMemoryRunScopedStore<EvidenceItem>;
  readonly drafts: InMemoryRunScopedStore<OpportunityDraft>;
}

export function createInMemoryIntelligenceStores(): InMemoryIntelligenceStores {
  return {
    documents: new InMemoryRunScopedStore<RawDocument>(),
    chunks: new InMemoryRunScopedStore<Chunk>(),
    signals: new InMemoryRunScopedStore<RawSignal>(),
    evidence: new InMemoryRunScopedStore<EvidenceItem>(),
    drafts: new InMemoryRunScopedStore<OpportunityDraft>(),
  };
}

/** Bridge harvest output into intelligence read stores. */
export function seedFromHarvestResult(
  stores: Pick<InMemoryIntelligenceStores, "documents" | "chunks" | "signals">,
  runId: ResearchRunId,
  harvest: HarvestResult,
): void {
  for (const doc of harvest.documents) {
    stores.documents.save(runId, doc);
  }
  for (const chunk of harvest.chunks) {
    stores.chunks.save(runId, chunk);
  }
  for (const signal of harvest.signals) {
    stores.signals.save(runId, signal);
  }
}
