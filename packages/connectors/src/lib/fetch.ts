export interface FetchOptions {
  readonly fetchFn?: typeof fetch;
  readonly minIntervalMs?: number;
  readonly userAgent?: string;
}

export interface RateLimitedFetcher {
  fetch(url: string | URL, init?: RequestInit): Promise<Response>;
}

/** Shared rate-limited fetch wrapper for L0 API connectors. */
export function createRateLimitedFetcher(options: FetchOptions = {}): RateLimitedFetcher {
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const forcedUnavailable = process.env.IDEA_FINDER_FORCE_UNAVAILABLE === "1";
  const minIntervalMs = forcedUnavailable ? 0 : (options.minIntervalMs ?? 250);
  const userAgent = options.userAgent ?? "idea-finder/0.1 (+https://github.com/idea-finder)";
  let lastFetchAt = 0;

  return {
    async fetch(url, init) {
      if (forcedUnavailable) {
        throw new Error("network unavailable (IDEA_FINDER_FORCE_UNAVAILABLE=1)");
      }
      const now = Date.now();
      const waitMs = Math.max(0, minIntervalMs - (now - lastFetchAt));
      if (waitMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
      lastFetchAt = Date.now();
      const headers = new Headers(init?.headers);
      if (!headers.has("User-Agent")) {
        headers.set("User-Agent", userAgent);
      }
      return fetchFn(url, { ...init, headers });
    },
  };
}

export async function fetchJson<T>(
  fetcher: RateLimitedFetcher,
  url: string | URL,
  init?: RequestInit,
): Promise<T> {
  const response = await fetcher.fetch(url, init);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  return (await response.json()) as T;
}
