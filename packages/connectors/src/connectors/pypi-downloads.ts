import type { FetchOptions } from "../lib/fetch.js";
import { createRateLimitedFetcher } from "../lib/fetch.js";
import { collected, parseBuckets, validDay, validateWindow } from "../lib/package-downloads.js";
import { PackageDownloadsSourceError, type PackageDownloadsConnector } from "../ports/package-downloads-connector.js";

export interface PyPiDownloadsConnectorOptions extends FetchOptions { readonly baseUrl?: string; readonly now?: () => Date; }
function packageName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || !/^[A-Za-z0-9._-]+$/.test(trimmed)) throw new Error("Invalid PyPI package name");
  return trimmed.toLowerCase().replace(/[-_.]+/g, "-");
}

export function createPyPiDownloadsConnector(options: PyPiDownloadsConnectorOptions = {}): PackageDownloadsConnector {
  const root = new URL(options.baseUrl ?? "https://pypistats.org");
  if (root.protocol !== "https:") throw new Error("pypistats API must use HTTPS");
  const fetcher = createRateLimitedFetcher(options);
  const now = options.now ?? (() => new Date());
  let exhaustedUntil: string | null = null;
  return {
    ecosystem: "pypi",
    async collect(input) {
      const name = packageName(input.package);
      const { from, to } = validateWindow(input);
      if (exhaustedUntil && now().getTime() < Date.parse(exhaustedUntil)) throw new PackageDownloadsSourceError("rate_limited", "pypistats API is locally rate limited", exhaustedUntil);
      const url = new URL(`/api/packages/${encodeURIComponent(name)}/overall`, root);
      url.searchParams.set("mirrors", "false");
      const response = await fetcher.fetch(url, { redirect: "error" });
      if (response.status === 404) throw new PackageDownloadsSourceError("missing_package", `PyPI package not found via pypistats: ${name}`);
      if (response.status === 429) {
        const seconds = Number(response.headers.get("retry-after"));
        exhaustedUntil = Number.isFinite(seconds) && seconds >= 0 ? new Date(now().getTime() + seconds * 1000).toISOString() : "9999-12-31T23:59:59.999Z";
        throw new PackageDownloadsSourceError("rate_limited", "pypistats API rate limited", exhaustedUntil);
      }
      if (!response.ok) throw new PackageDownloadsSourceError("unavailable_history", `pypistats API HTTP ${response.status}`);
      const body = await response.json() as Record<string, unknown>;
      if (typeof body.package !== "string" || packageName(body.package) !== name) throw new PackageDownloadsSourceError("response_drift", "pypistats package identity mismatch");
      if (body.type !== "overall_downloads") throw new PackageDownloadsSourceError("response_drift", "pypistats type drift");
      if (!Array.isArray(body.data)) throw new PackageDownloadsSourceError("response_drift", "pypistats data must be an array");
      if (body.data.some((item) => !item || typeof item !== "object" || (item as Record<string, unknown>).category !== "without_mirrors")) {
        throw new PackageDownloadsSourceError("response_drift", "pypistats mirror category drift");
      }
      const selected = body.data;
      const mapped = selected.map((item) => ({ day: (item as Record<string, unknown>).date, downloads: (item as Record<string, unknown>).downloads }));
      if (mapped.some((item) => typeof item.day !== "string" || !validDay(item.day)
        || typeof item.downloads !== "number" || !Number.isSafeInteger(item.downloads) || item.downloads < 0)) {
        throw new PackageDownloadsSourceError("response_drift", "pypistats daily bucket drift");
      }
      const rows = parseBuckets(mapped.filter((item) => (item.day as string) >= from && (item.day as string) <= to), from, to, "pypistats");
      const provenance = { provider: "pypistats" as const, interface: "pypistats_public_api" as const, sourceRef: url.toString(), retrievedAt: now().toISOString(), caveat: "Third-party statistics derived from the public PyPI download dataset; not an official PyPI statistics API." };
      return { ecosystem: "pypi", package: name, from, to, buckets: collected("pypi", name, rows, provenance), provenance };
    },
  };
}
