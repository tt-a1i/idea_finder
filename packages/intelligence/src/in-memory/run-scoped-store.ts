import type { ResearchRunId } from "@idea-finder/core";

import type { RunScopedReader } from "../ports/run-scoped-read.js";
import type { RunScopedWriter } from "../ports/run-scoped-write.js";

export class InMemoryRunScopedStore<T extends { id: string }>
  implements RunScopedReader<T>, RunScopedWriter<T>
{
  private readonly byRun = new Map<string, Map<string, T>>();

  save(runId: ResearchRunId, entity: T): void {
    const runKey = String(runId);
    let bucket = this.byRun.get(runKey);
    if (!bucket) {
      bucket = new Map();
      this.byRun.set(runKey, bucket);
    }
    bucket.set(entity.id, entity);
  }

  get(id: string): T | null {
    for (const bucket of this.byRun.values()) {
      const entity = bucket.get(id);
      if (entity) return entity;
    }
    return null;
  }

  listByRun(runId: ResearchRunId): readonly T[] {
    const bucket = this.byRun.get(String(runId));
    if (!bucket) return [];
    return [...bucket.values()];
  }

  clear(): void {
    this.byRun.clear();
  }
}
