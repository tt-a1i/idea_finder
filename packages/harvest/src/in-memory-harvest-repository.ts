import type { HarvestResult, HarvestRepository } from "./ports/harvest-repository.js";
import type { ResearchRunId } from "@idea-finder/core";

export class InMemoryHarvestRepository implements HarvestRepository {
  private readonly store = new Map<string, HarvestResult>();

  async saveResult(runId: ResearchRunId, result: HarvestResult): Promise<void> {
    this.store.set(runId, result);
  }

  async saveSourceResult(runId: ResearchRunId, result: Omit<HarvestResult, "sourceExecutions">, execution: HarvestResult["sourceExecutions"][number]): Promise<void> {
    const existing = this.store.get(runId) ?? { documents: [], chunks: [], signals: [], sourceExecutions: [] };
    this.store.set(runId, {
      documents: [...existing.documents, ...result.documents], chunks: [...existing.chunks, ...result.chunks], signals: [...existing.signals, ...result.signals],
      sourceExecutions: [...existing.sourceExecutions.filter((item) => item.id !== execution.id), execution],
    });
  }

  async getResult(runId: ResearchRunId): Promise<HarvestResult | null> {
    return this.store.get(runId) ?? null;
  }

  clear(): void {
    this.store.clear();
  }
}
