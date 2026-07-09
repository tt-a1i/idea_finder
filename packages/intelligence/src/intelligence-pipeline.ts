import type {
  EvidenceItem,
  OpportunityDraft,
  ResearchRunId,
} from "@idea-finder/core";

import type { IntelligenceReadPorts } from "./ports/run-scoped-read.js";
import type { IntelligenceWritePorts } from "./ports/run-scoped-write.js";
import { clusterSignals } from "./rule/cluster.js";
import { buildOpportunityDraft } from "./rule/draft-builder.js";
import { buildEvidenceFromSignal } from "./rule/evidence-builder.js";

export interface IntelligenceContext {
  readonly queryTerms?: readonly string[];
}

export interface IntelligenceResult {
  readonly evidence: readonly EvidenceItem[];
  readonly drafts: readonly OpportunityDraft[];
}

export interface IntelligencePipelineDeps extends IntelligenceReadPorts, IntelligenceWritePorts {}

export interface IntelligencePipeline {
  run(runId: ResearchRunId, context?: IntelligenceContext): Promise<IntelligenceResult>;
}

export function createIntelligencePipeline(
  deps: IntelligencePipelineDeps,
): IntelligencePipeline {
  return {
    async run(runId: ResearchRunId, context: IntelligenceContext = {}): Promise<IntelligenceResult> {
      const documents = indexById(deps.documents.listByRun(runId));
      const chunks = indexById(deps.chunks.listByRun(runId));
      const signals = deps.signals.listByRun(runId);
      const queryTerms = context.queryTerms ?? [];

      const { supporting, disconfirming } = clusterSignals(signals, String(runId));
      const evidence: EvidenceItem[] = [];
      const drafts: OpportunityDraft[] = [];

      for (const cluster of supporting) {
        const clusterEvidence: EvidenceItem[] = [];

        for (const signal of cluster.signals) {
          const chunk = chunks.get(signal.chunkId);
          const document = documents.get(signal.documentId);
          if (!chunk || !document) continue;

          const item = buildEvidenceFromSignal(signal, cluster.id, chunk, document);
          if (!item) continue;

          clusterEvidence.push(item);
          evidence.push(item);
          deps.evidence.save(runId, item);
        }

        const draft = buildOpportunityDraft({
          cluster,
          evidence: clusterEvidence,
          disconfirmingSignals: disconfirming,
          queryTerms,
        });

        if (draft) {
          drafts.push(draft);
          deps.drafts.save(runId, draft);
        }
      }

      return { evidence, drafts };
    },
  };
}

function indexById<T extends { id: string }>(items: readonly T[]): Map<string, T> {
  return new Map(items.map((item) => [item.id, item]));
}
