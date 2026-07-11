import { createHash } from "node:crypto";
import type { CollectedPackageDownload, PackageDownloadProvenance, PackageDownloadRequest, PackageEcosystem } from "../ports/package-downloads-connector.js";
import { PackageDownloadsSourceError } from "../ports/package-downloads-connector.js";

export function validateWindow(request: PackageDownloadRequest): { from: string; to: string } {
  const valid = validDay;
  if (!valid(request.from) || !valid(request.to)) throw new Error("Package download from/to must be YYYY-MM-DD dates");
  if (request.from > request.to) throw new Error("Package download from must not be after to");
  return { from: request.from, to: request.to };
}

export function validDay(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T00:00:00.000Z`).toISOString().startsWith(value);
}

export function parseBuckets(value: unknown, from: string, to: string, label: string): Array<{ day: string; downloads: number }> {
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
  const expected: string[] = [];
  for (let cursor = Date.parse(`${from}T00:00:00.000Z`), end = Date.parse(`${to}T00:00:00.000Z`); cursor <= end; cursor += 86_400_000) {
    expected.push(new Date(cursor).toISOString().slice(0, 10));
  }
  if (expected.some((day) => !unique.has(day))) {
    throw new PackageDownloadsSourceError("unavailable_history", `${label} did not cover every day in the requested window`);
  }
  return [...unique].sort(([a], [b]) => a.localeCompare(b)).map(([day, downloads]) => ({ day, downloads }));
}

export function collected(ecosystem: PackageEcosystem, packageName: string, rows: Array<{ day: string; downloads: number }>, provenance: PackageDownloadProvenance): CollectedPackageDownload[] {
  return rows.map(({ day, downloads }) => ({
    id: `metric_${createHash("sha256").update(`${ecosystem}\0${packageName}\0${day}`).digest("hex").slice(0, 24)}`,
    ecosystem, package: packageName, subject: `${ecosystem}:${packageName}`, day, downloads, provenance,
  }));
}
