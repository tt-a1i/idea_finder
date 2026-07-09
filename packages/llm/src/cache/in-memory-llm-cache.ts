import type { LLMCache } from "../ports/llm-cache.js";

/** Deterministic in-memory cache for tests and offline use. */
export class InMemoryLLMCache implements LLMCache {
  private readonly store = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | null> {
    const value = this.store.get(key);
    return value === undefined ? null : (structuredClone(value) as T);
  }

  async set<T>(key: string, value: T): Promise<void> {
    this.store.set(key, structuredClone(value));
  }

  size(): number {
    return this.store.size;
  }
}
