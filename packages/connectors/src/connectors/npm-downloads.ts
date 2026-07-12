import type { FetchOptions } from "../lib/fetch.js";
import { createRateLimitedFetcher } from "../lib/fetch.js";
import { collected, isFutureUtcDay, parseBuckets, validateWindow } from "../lib/package-downloads.js";
import { PackageDownloadsSourceError, type PackageDownloadsConnector } from "../ports/package-downloads-connector.js";

export interface NpmDownloadsConnectorOptions extends FetchOptions { readonly baseUrl?: string; readonly now?: () => Date; }

function packageName(value: string): string {
  const name = value.trim();
  if (!/^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/.test(name)) throw new Error("Invalid npm package name");
  return name;
}

export function createNpmDownloadsConnector(options: NpmDownloadsConnectorOptions = {}): PackageDownloadsConnector {
  const root = new URL(options.baseUrl ?? "https://api.npmjs.org");
  if (root.protocol !== "https:") throw new Error("npm downloads API must use HTTPS");
  const fetcher = createRateLimitedFetcher(options);
  const now = options.now ?? (() => new Date());
  let exhaustedUntil: string | null = null;
  return {
    ecosystem: "npm",
    async collect(input) {
      const name = packageName(input.package);
      const { from, to } = validateWindow(input);
      if (exhaustedUntil && now().getTime() < Date.parse(exhaustedUntil)) throw new PackageDownloadsSourceError("rate_limited", "npm downloads API is locally rate limited", exhaustedUntil);
      const url = new URL(`/downloads/range/${from}:${to}/${encodeURIComponent(name)}`, root);
      if (url.origin !== root.origin || url.protocol !== "https:") throw new Error("npm downloads API URL escaped configured origin");
      const response = await fetcher.fetch(url, { redirect: "error" });
      if (response.status === 404) throw new PackageDownloadsSourceError("missing_package", `npm package not found: ${name}`);
      if (response.status === 429) {
        const seconds = Number(response.headers.get("retry-after"));
        exhaustedUntil = Number.isFinite(seconds) && seconds >= 0 ? new Date(now().getTime() + seconds * 1000).toISOString() : "9999-12-31T23:59:59.999Z";
        throw new PackageDownloadsSourceError("rate_limited", "npm downloads API rate limited", exhaustedUntil);
      }
      if (!response.ok) throw new PackageDownloadsSourceError("unavailable_history", `npm downloads API HTTP ${response.status}`);
      const body = await response.json() as Record<string, unknown>;
      if (typeof body.package !== "string" || packageName(body.package) !== name || body.start !== from || body.end !== to) {
        throw new PackageDownloadsSourceError("response_drift", "npm downloads response identity/window mismatch");
      }
      const parsed = parseBuckets(body.downloads, from, to, "npm");
      // Future calendar days are never comparable observations; drop them instead of treating provider zeros as real.
      const usable = parsed.rows.filter((row) => !isFutureUtcDay(row.day, now()));
      const droppedFuture = parsed.rows.filter((row) => isFutureUtcDay(row.day, now())).map((row) => row.day);
      const missingDays = [...new Set([...parsed.missingDays, ...droppedFuture])].sort();
      if (usable.length === 0) throw new PackageDownloadsSourceError("unavailable_history", "npm returned no comparable history for the requested window");
      const provenance = { provider: "npm" as const, interface: "npm_downloads_public_api" as const, sourceRef: url.toString(), retrievedAt: now().toISOString(), caveat: missingDays.length ? `Incomplete coverage; missing days: ${missingDays.join(", ")}` : null };
      return {
        ecosystem: "npm",
        package: name,
        from,
        to,
        buckets: collected("npm", name, usable, provenance),
        provenance,
        missingDays,
        coverageComplete: missingDays.length === 0,
      };
    },
  };
}
