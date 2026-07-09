import {
  chunkDocument,
  connectorByPlatform,
  createManualImportConnector,
  detectSignals,
  type ManualImportConnector,
  type QueryPlan,
  type SourceConnector,
} from "@idea-finder/connectors";
import type { Chunk, RawDocument, RawSignal, ResearchRunId } from "@idea-finder/core";

import type { HarvestRepository, HarvestResult } from "./ports/harvest-repository.js";

export interface HarvestPipelineDeps {
  readonly connectors: readonly SourceConnector[];
  readonly repository?: HarvestRepository;
}

export interface HarvestPipeline {
  /**
   * Runs harvest for a research run: connectors → normalize → chunk → rule signals.
   * Resolves with normalized output ready for the intelligence stage.
   */
  runHarvest(runId: ResearchRunId, plan: QueryPlan): Promise<HarvestResult>;
}

export function createHarvestPipeline(deps: HarvestPipelineDeps): HarvestPipeline {
  const manualConnector =
    (connectorByPlatform(deps.connectors, "manual") as ManualImportConnector | undefined) ??
    createManualImportConnector();

  return {
    async runHarvest(runId: ResearchRunId, plan: QueryPlan): Promise<HarvestResult> {
      const documents: RawDocument[] = [];
      const chunks: Chunk[] = [];
      const signals: RawSignal[] = [];
      const seenDocKeys = new Set<string>();

      for (const search of plan.searches) {
        const connector = connectorByPlatform(deps.connectors, search.platform);
        if (!connector) {
          throw new Error(`No connector registered for platform: ${search.platform}`);
        }

        const query = { ...search, huntingTaskId: plan.huntingTaskId };
        for await (const doc of connector.search(query)) {
          const key = `${doc.platform}:${doc.externalId ?? doc.url}`;
          if (seenDocKeys.has(key)) continue;
          seenDocKeys.add(key);
          ingestDocument(doc, chunks, signals);
          documents.push(doc);
        }
      }

      for (const input of plan.manualImports ?? []) {
        const doc = manualConnector.importText(input, plan.huntingTaskId);
        const key = `${doc.platform}:${doc.externalId ?? doc.url}`;
        if (seenDocKeys.has(key)) continue;
        seenDocKeys.add(key);
        ingestDocument(doc, chunks, signals);
        documents.push(doc);
      }

      const result: HarvestResult = { documents, chunks, signals };
      if (deps.repository) {
        await deps.repository.saveResult(runId, result);
      }
      return result;
    },
  };
}

function ingestDocument(doc: RawDocument, chunks: Chunk[], signals: RawSignal[]): void {
  const docChunks = chunkDocument(doc);
  chunks.push(...docChunks);
  signals.push(...detectSignals(docChunks, doc));
}
