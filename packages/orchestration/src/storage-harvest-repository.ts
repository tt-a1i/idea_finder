import type { ResearchRunId } from "@idea-finder/core";
import type { HarvestRepository } from "@idea-finder/harvest";
import type { LocalStorage } from "@idea-finder/storage";

export function createStorageHarvestRepository(
  stores: Pick<LocalStorage, "rawDocuments" | "chunks" | "rawSignals">,
): HarvestRepository {
  return {
    async saveResult(runId: ResearchRunId, result) {
      for (const document of result.documents) {
        stores.rawDocuments.save(runId, document);
      }
      for (const chunk of result.chunks) {
        stores.chunks.save(runId, chunk);
      }
      for (const signal of result.signals) {
        stores.rawSignals.save(runId, signal);
      }
    },
    async getResult(runId) {
      const documents = stores.rawDocuments.listByRun(runId);
      const chunks = stores.chunks.listByRun(runId);
      const signals = stores.rawSignals.listByRun(runId);
      if (documents.length === 0 && chunks.length === 0 && signals.length === 0) {
        return null;
      }
      return { documents, chunks, signals };
    },
  };
}
