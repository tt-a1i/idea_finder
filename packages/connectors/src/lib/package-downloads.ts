import { PackageDownloadsSourceError } from "../ports/package-downloads-connector.js";
import type { CollectedPackageDownload, PackageDownloadProvenance, PackageDownloadRequest, PackageEcosystem } from "../ports/package-downloads-connector.js";
import { createHash } from "node:crypto";

export function validateWindow(request: PackageDownloadRequest): { from: string; to: string } {
  const valid = validDay;
  if (!valid(request.from) || !valid(request.to)) throw new Error("Package download from/to must be YYYY-MM-DD dates");
  if (request.from > request.to) throw new Error("Package download from must not be after to");
  return { from: request.from, to: request.to };
}

export function validDay(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T00:00:00.000Z`).toISOString().startsWith(value);
}

export function enumerateDays(from: string, to: string): string[] {
  const days: string[] = [];
  for (let cursor = Date.parse(`${from}T00:00:00.000Z`), end = Date.parse(`${to}T00:00:00.000Z`); cursor <= end; cursor += 86_400_000) {
    days.push(new Date(cursor).toISOString().slice(0, 10));
  }
  return days;
}

export interface ParsedPackageBuckets {
  readonly rows: Array<{ day: string; downloads: number }>;
  readonly missingDays: readonly string[];
  readonly coverageComplete: boolean;
}

/**
 * Parse provider buckets without inventing zeros for missing days.
 * Partial coverage returns available rows + missingDays (does not throw when some days exist).
 */
export function parseBuckets(value: unknown, from: string, to: string, label: string): ParsedPackageBuckets {
  if (!Array.isArray(value)) throw new PackageDownloadsSourceError("response_drift", `${label} downloads must be an array`);
  const unique = new Map<string, number>();
  for (const item of value) {
    if (!item || typeof item !== "object") throw new PackageDownloadsSourceError("response_drift", `${label} download bucket must be an object`);
    const row = item as Record<string, unknown>;
    if (typeof row.day !== "string" || !validDay(row.day) || row.day < from || row.day > to) {
      throw new PackageDownloadsSourceError("response_drift", `${label} day is invalid or outside the requested window`);
    }
    if (typeof row.downloads !== "number" || !Number.isSafeInteger(row.downloads) || row.downloads < 0) {
      throw new PackageDownloadsSourceError("response_drift", `${label} downloads must be a non-negative safe integer`);
    }
    const existing = unique.get(row.day);
    if (existing !== undefined && existing !== row.downloads) throw new PackageDownloadsSourceError("response_drift", `${label} has conflicting duplicate day ${row.day}`);
    unique.set(row.day, row.downloads);
  }
  if (unique.size === 0) throw new PackageDownloadsSourceError("unavailable_history", `${label} returned no history for the requested window`);
  const expected = enumerateDays(from, to);
  const missingDays = expected.filter((day) => !unique.has(day));
  const rows = [...unique].sort(([a], [b]) => a.localeCompare(b)).map(([day, downloads]) => ({ day, downloads }));
  return { rows, missingDays, coverageComplete: missingDays.length === 0 };
}

/** UTC calendar day for `now`; buckets whose end is after now are incomplete. */
export function isIncompleteUtcDay(day: string, now: Date): boolean {
  const endMs = Date.parse(`${day}T00:00:00.000Z`) + 86_400_000;
  return now.getTime() < endMs;
}

export function isFutureUtcDay(day: string, now: Date): boolean {
  const startMs = Date.parse(`${day}T00:00:00.000Z`);
  const todayStart = Date.parse(now.toISOString().slice(0, 10) + "T00:00:00.000Z");
  return startMs > todayStart;
}

export function collected(
  ecosystem: PackageEcosystem,
  packageName: string,
  rows: Array<{ day: string; downloads: number }>,
  provenance: PackageDownloadProvenance,
): CollectedPackageDownload[] {
  return rows.map(({ day, downloads }) => ({
    id: `metric_${createHash("sha256").update(`${ecosystem}\0${packageName}\0${day}`).digest("hex").slice(0, 24)}`,
    ecosystem, package: packageName, subject: `${ecosystem}:${packageName}`, day, downloads, provenance,
  }));
}
