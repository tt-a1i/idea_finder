import type { HarvestResult, HarvestRepository } from "./ports/harvest-repository.js";
import type { ResearchRunId } from "@idea-finder/core";

export class InMemoryHarvestRepository implements HarvestRepository {
  private readonly store = new Map<string, HarvestResult>();

  async saveResult(runId: ResearchRunId, result: HarvestResult): Promise<void> {
    this.store.set(runId, result);
  }

  async getResult(runId: ResearchRunId): Promise<HarvestResult | null> {
    return this.store.get(runId) ?? null;
  }

  clear(): void {
    this.store.clear();
  }
}
