import { asId } from "./ids.js";
import type { MetricObservationId, TrendEventId, TrendSeriesId } from "./ids.js";
import type {
  PackageDownloadObservation,
  PackageDownloadProvenance,
  PackageDownloadSeries,
  PackageDownloadTrendEvent,
  PackageEcosystem,
  PackageSubject,
  TrendEventKind,
} from "./types.js";
import { InvariantViolation } from "./validation.js";

const NPM_NAME = /^[a-z0-9][a-z0-9._~-]*$/;

export function canonicalizePackageName(ecosystem: PackageEcosystem, input: string): string {
  const name = input.trim();
  if (!name) throw new InvariantViolation("package.name_required", "Package name is required");
  if (ecosystem === "npm") {
    if (name !== name.toLowerCase()) {
      throw new InvariantViolation("package.npm_name_not_canonical", "npm package names must be lowercase");
    }
    const parts = name.startsWith("@") ? name.slice(1).split("/") : [name];
    if (parts.length === 0 || parts.length > 2 || parts.some((part) => !NPM_NAME.test(part))) {
      throw new InvariantViolation("package.npm_name_invalid", "Invalid npm package name or scope");
    }
    if (name.startsWith("@") && parts.length !== 2) {
      throw new InvariantViolation("package.npm_scope_invalid", "Scoped npm packages require @scope/name");
    }
    if (!name.startsWith("@") && parts.length !== 1) {
      throw new InvariantViolation("package.npm_name_invalid", "Unscoped npm package names cannot contain a slash");
    }
    return name;
  }
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(name)) {
    throw new InvariantViolation("package.pypi_name_invalid", "Invalid PyPI project name");
  }
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

export function createPackageSubject(ecosystem: PackageEcosystem, name: string): PackageSubject {
  const canonicalName = canonicalizePackageName(ecosystem, name);
  return {
    kind: "package",
    ecosystem,
    name: name.trim(),
    canonicalName,
    externalId: `${ecosystem}:${canonicalName}`,
    url: ecosystem === "npm"
      ? `https://www.npmjs.com/package/${encodeURIComponent(canonicalName)}`
      : `https://pypi.org/project/${encodeURIComponent(canonicalName)}/`,
  };
}

function assertTime(value: string, field: string): void {
  if (!value || Number.isNaN(Date.parse(value))) {
    throw new InvariantViolation("package.invalid_time", `${field} must be an ISO date-time`);
  }
}

function sameSubject(left: PackageSubject, right: PackageSubject): boolean {
  return left.ecosystem === right.ecosystem &&
    left.canonicalName === right.canonicalName &&
    left.externalId === right.externalId;
}

export interface CreatePackageDownloadObservationInput {
  readonly id: MetricObservationId;
  readonly ecosystem: PackageEcosystem;
  readonly packageName: string;
  readonly bucket: PackageDownloadObservation["bucket"];
  readonly downloads: number;
  readonly provenance: PackageDownloadProvenance;
}

/** Creates adoption evidence; lane and daily-rate normalization are Core-owned. */
export function createPackageDownloadObservation(
  input: CreatePackageDownloadObservationInput,
): PackageDownloadObservation {
  const subject = createPackageSubject(input.ecosystem, input.packageName);
  assertTime(input.bucket.startAt, "bucket.startAt");
  assertTime(input.bucket.endAt, "bucket.endAt");
  assertTime(input.provenance.collectedAt, "provenance.collectedAt");
  if (Date.parse(input.bucket.startAt) >= Date.parse(input.bucket.endAt)) {
    throw new InvariantViolation("package.invalid_bucket", "Download bucket start must precede end");
  }
  if (!input.bucket.timezone.trim()) throw new InvariantViolation("package.timezone_required", "Bucket timezone is required");
  if (!Number.isInteger(input.bucket.coverageDays) || input.bucket.coverageDays <= 0) {
    throw new InvariantViolation("package.coverage_invalid", "coverageDays must be a positive integer");
  }
  if (!Number.isInteger(input.downloads) || input.downloads < 0) {
    throw new InvariantViolation("package.downloads_invalid", "downloads must be a non-negative integer");
  }
  if (!input.provenance.collector.trim() || !input.provenance.collectorVersion.trim() || !input.provenance.sourceRef.trim()) {
    throw new InvariantViolation("package.provenance_required", "Package download provenance is required");
  }
  return {
    id: input.id,
    subject,
    source: input.ecosystem === "npm" ? "npm_registry" : "pypi",
    ecosystem: input.ecosystem,
    metric: "downloads",
    lane: "developer_adoption",
    geography: null,
    observedAt: input.bucket.endAt,
    bucket: input.bucket,
    rawValue: input.downloads,
    normalizedValue: input.downloads / input.bucket.coverageDays,
    normalizationMethod: "bucket_count_to_daily_rate_v1",
    unit: "downloads_per_day",
    collectionMethod: input.provenance.interface,
    provenance: input.provenance,
  };
}

export function buildPackageDownloadSeries(
  id: TrendSeriesId,
  observations: readonly PackageDownloadObservation[],
): { readonly series: PackageDownloadSeries; readonly observations: readonly PackageDownloadObservation[] } {
  if (observations.length === 0) throw new InvariantViolation("trend.empty_series", "Package series requires observations");
  const first = observations[0]!;
  const unique = new Map<string, PackageDownloadObservation>();
  for (const observation of observations) {
    if (
      observation.source !== first.source ||
      observation.ecosystem !== first.ecosystem ||
      !sameSubject(observation.subject, first.subject) ||
      observation.bucket.resolution !== first.bucket.resolution ||
      observation.bucket.timezone !== first.bucket.timezone ||
      observation.normalizationMethod !== first.normalizationMethod
    ) {
      throw new InvariantViolation("package.mixed_series", "Package series cannot mix ecosystem, package, resolution, timezone, or normalization");
    }
    const key = `${observation.subject.externalId}|${observation.bucket.startAt}|${observation.bucket.endAt}|${observation.normalizationMethod}`;
    const existing = unique.get(key);
    if (existing && JSON.stringify(existing) !== JSON.stringify(observation)) {
      throw new InvariantViolation("trend.observation_conflict", `Conflicting package download bucket ${key}`);
    }
    unique.set(key, observation);
  }
  const ordered = [...unique.values()].sort((a, b) => a.bucket.startAt.localeCompare(b.bucket.startAt) || a.id.localeCompare(b.id));
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1]!;
    const current = ordered[index]!;
    if (previous.bucket.endAt !== current.bucket.startAt) {
      throw new InvariantViolation("package.non_contiguous_series", "Package download buckets must be contiguous and non-overlapping");
    }
  }
  return {
    observations: ordered,
    series: {
      id,
      subject: first.subject,
      source: first.source,
      ecosystem: first.ecosystem,
      metric: "downloads",
      lane: "developer_adoption",
      resolution: first.bucket.resolution,
      timezone: first.bucket.timezone,
      normalizationMethod: "bucket_count_to_daily_rate_v1",
      observationIds: ordered.map((item) => item.id),
      startedAt: ordered[0]!.bucket.startAt,
      endedAt: ordered.at(-1)!.bucket.endAt,
    },
  };
}

export interface DetectPackageDownloadEventOptions {
  readonly detectedAt: string;
  readonly stableRelativeThreshold?: number;
}

export function detectLatestPackageDownloadEvent(
  series: PackageDownloadSeries,
  observationsById: ReadonlyMap<MetricObservationId, PackageDownloadObservation>,
  options: DetectPackageDownloadEventOptions,
): PackageDownloadTrendEvent | null {
  if (series.observationIds.length < 2) return null;
  assertTime(options.detectedAt, "detectedAt");
  const threshold = options.stableRelativeThreshold ?? 0;
  if (!Number.isFinite(threshold) || threshold < 0) {
    throw new InvariantViolation("package.threshold_invalid", "stableRelativeThreshold must be non-negative");
  }
  // Exclude incomplete / future / partial buckets from momentum; missing data must never look like a real drop.
  const comparableIds = series.observationIds.filter((id) => {
    const observation = observationsById.get(id);
    return observation !== undefined && !observation.bucket.partial;
  });
  if (comparableIds.length < 2) return null;
  const previous = observationsById.get(comparableIds.at(-2)!);
  const current = observationsById.get(comparableIds.at(-1)!);
  if (!previous || !current) throw new InvariantViolation("trend.missing_observation", "Package event requires series observations");
  const delta = current.normalizedValue - previous.normalizedValue;
  const relativeDelta = previous.normalizedValue === 0 ? null : delta / previous.normalizedValue;
  const comparable = relativeDelta ?? (delta === 0 ? 0 : Math.sign(delta) * Infinity);
  const kind: TrendEventKind = Math.abs(comparable) <= threshold ? "stable" : delta > 0 ? "momentum_up" : "momentum_down";
  return {
    id: asId<TrendEventId>(`tevt_${series.id}_${current.id}_${kind}`),
    seriesId: series.id,
    kind,
    detectedAt: options.detectedAt,
    previousObservationId: previous.id,
    currentObservationId: current.id,
    previousValue: previous.normalizedValue,
    currentValue: current.normalizedValue,
    absoluteDelta: delta,
    relativeDelta,
    detector: "package_download_delta_v1",
    stableRelativeThreshold: threshold,
  };
}
