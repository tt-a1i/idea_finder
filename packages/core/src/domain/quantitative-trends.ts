import { asId } from "./ids.js";
import type { MetricObservationId, TrendEventId, TrendSeriesId } from "./ids.js";
import type {
  GitHubMetric,
  GitHubMetricObservation,
  GitHubTrendSeries,
  MetricObservationProvenance,
  MetricSubject,
  QuantitativeEvidenceLane,
  TrendEvent,
  TrendEventKind,
} from "./types.js";
import { InvariantViolation } from "./validation.js";

const GITHUB_METRIC_LANES: Readonly<Record<GitHubMetric, QuantitativeEvidenceLane>> = {
  stars: "developer_adoption",
  forks: "developer_adoption",
  contributors: "developer_adoption",
  issue_opened: "developer_adoption",
  issue_closed: "developer_adoption",
  open_issues: "supply",
  repository_count: "supply",
  trending_rank: "supply",
};

export function classifyGitHubMetric(metric: GitHubMetric): QuantitativeEvidenceLane {
  const lane = GITHUB_METRIC_LANES[metric];
  if (!lane) {
    throw new InvariantViolation(
      "metric.github_unsupported",
      `Unsupported GitHub metric: ${String(metric)}`,
    );
  }
  return lane;
}

function assertFiniteNonNegative(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new InvariantViolation(
      "metric.invalid_value",
      `${field} must be a finite non-negative number`,
    );
  }
}

function assertIsoDate(value: string, field: string): void {
  if (!value || Number.isNaN(Date.parse(value))) {
    throw new InvariantViolation("metric.invalid_time", `${field} must be an ISO date-time`);
  }
}

function subjectKey(subject: MetricSubject): string {
  return `${subject.kind}:${subject.externalId}:${subject.url}`;
}

export interface CreateGitHubMetricObservationInput {
  readonly id: MetricObservationId;
  readonly subject: MetricSubject;
  readonly metric: GitHubMetric;
  readonly geography?: string | null;
  readonly observedAt: string;
  readonly rawValue: number;
  readonly normalizedValue: number;
  readonly provenance: MetricObservationProvenance;
}

/** Creates quantitative GitHub evidence; callers cannot relabel popularity as demand. */
export function createGitHubMetricObservation(
  input: CreateGitHubMetricObservationInput,
): GitHubMetricObservation {
  if (!input.subject.externalId.trim() || !input.subject.url.trim()) {
    throw new InvariantViolation("metric.subject_required", "Metric subject id and URL are required");
  }
  assertIsoDate(input.observedAt, "observedAt");
  assertIsoDate(input.provenance.collectedAt, "provenance.collectedAt");
  assertFiniteNonNegative(input.rawValue, "rawValue");
  assertFiniteNonNegative(input.normalizedValue, "normalizedValue");
  if (
    !input.provenance.collector.trim() ||
    !input.provenance.collectorVersion.trim() ||
    !input.provenance.sourceRef.trim()
  ) {
    throw new InvariantViolation("metric.provenance_required", "Metric provenance is required");
  }

  return {
    ...input,
    source: "github",
    lane: classifyGitHubMetric(input.metric),
    geography: input.geography?.trim() || null,
    unit: input.metric === "trending_rank" ? "rank" : "count",
    collectionMethod: input.provenance.interface,
  };
}

function observationIdentity(observation: GitHubMetricObservation): string {
  return [
    observation.source,
    subjectKey(observation.subject),
    observation.metric,
    observation.observedAt,
    observation.collectionMethod,
  ].join("|");
}

export function buildTrendSeries(
  id: TrendSeriesId,
  observations: readonly GitHubMetricObservation[],
): { readonly series: GitHubTrendSeries; readonly observations: readonly GitHubMetricObservation[] } {
  if (observations.length === 0) {
    throw new InvariantViolation("trend.empty_series", "TrendSeries requires observations");
  }
  const first = observations[0]!;
  const expectedSubject = subjectKey(first.subject);
  const unique = new Map<string, GitHubMetricObservation>();
  for (const observation of observations) {
    if (
      observation.source !== first.source ||
      subjectKey(observation.subject) !== expectedSubject ||
      observation.metric !== first.metric ||
      observation.lane !== first.lane
    ) {
      throw new InvariantViolation(
        "trend.mixed_series",
        "TrendSeries observations must share source, subject, metric, and lane",
      );
    }
    const key = observationIdentity(observation);
    const existing = unique.get(key);
    if (existing && JSON.stringify(existing) !== JSON.stringify(observation)) {
      throw new InvariantViolation(
        "trend.observation_conflict",
        `Conflicting observations for ${key}`,
      );
    }
    unique.set(key, observation);
  }
  const ordered = [...unique.values()].sort(
    (a, b) => a.observedAt.localeCompare(b.observedAt) || a.id.localeCompare(b.id),
  );
  return {
    observations: ordered,
    series: {
      id,
      subject: first.subject,
      source: first.source,
      metric: first.metric,
      lane: first.lane,
      observationIds: ordered.map((item) => item.id),
      startedAt: ordered[0]!.observedAt,
      endedAt: ordered.at(-1)!.observedAt,
    },
  };
}

export interface DetectTrendEventOptions {
  readonly detectedAt: string;
  readonly stableRelativeThreshold?: number;
}

export function detectLatestTrendEvent(
  series: GitHubTrendSeries,
  observationsById: ReadonlyMap<MetricObservationId, GitHubMetricObservation>,
  options: DetectTrendEventOptions,
): TrendEvent | null {
  if (series.observationIds.length < 2) return null;
  assertIsoDate(options.detectedAt, "detectedAt");
  const previous = observationsById.get(series.observationIds.at(-2)!);
  const current = observationsById.get(series.observationIds.at(-1)!);
  if (!previous || !current) {
    throw new InvariantViolation("trend.missing_observation", "TrendEvent requires series observations");
  }
  const delta = current.normalizedValue - previous.normalizedValue;
  const relativeDelta = previous.normalizedValue === 0 ? null : delta / previous.normalizedValue;
  const threshold = options.stableRelativeThreshold ?? 0;
  if (!Number.isFinite(threshold) || threshold < 0) {
    throw new InvariantViolation("trend.invalid_threshold", "stableRelativeThreshold must be non-negative");
  }
  const comparableDelta = relativeDelta ?? (delta === 0 ? 0 : Math.sign(delta) * Infinity);
  const kind: TrendEventKind =
    Math.abs(comparableDelta) <= threshold
      ? "stable"
      : delta > 0
        ? "momentum_up"
        : "momentum_down";
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
    detector: "two_point_delta_v1",
  };
}
