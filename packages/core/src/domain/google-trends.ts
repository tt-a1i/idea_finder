import { asId } from "./ids.js";
import type { MetricObservationId, TrendEventId, TrendSeriesId } from "./ids.js";
import type {
  GoogleTrendsMetricObservation,
  GoogleTrendsNormalizationContext,
  GoogleTrendsObservationProvenance,
  GoogleTrendsSeries,
  MetricSubject,
  SearchMomentumClassifierRules,
  SearchMomentumPattern,
  SearchMomentumTrendEvent,
} from "./types.js";
import { InvariantViolation } from "./validation.js";

function assertTime(value: string, field: string): void {
  if (!value || Number.isNaN(Date.parse(value))) {
    throw new InvariantViolation("google_trends.invalid_time", `${field} must be an ISO date-time`);
  }
}

export function validateGoogleTrendsNormalizationContext(
  context: GoogleTrendsNormalizationContext,
): void {
  assertTime(context.window.startAt, "window.startAt");
  assertTime(context.window.endAt, "window.endAt");
  if (Date.parse(context.window.startAt) >= Date.parse(context.window.endAt)) {
    throw new InvariantViolation("google_trends.invalid_window", "window.startAt must precede window.endAt");
  }
  if (!context.geography.trim()) {
    throw new InvariantViolation("google_trends.geography_required", "Google Trends geography is required");
  }
  if (!context.window.timezone.trim()) {
    throw new InvariantViolation("google_trends.timezone_required", "Google Trends timezone is required");
  }
  if (context.comparisonSubjects.length === 0 || context.comparisonSubjects.some((item) => !item.trim())) {
    throw new InvariantViolation("google_trends.comparison_required", "Comparison subjects are required");
  }
  if (context.anchor !== null && !context.anchor.trim()) {
    throw new InvariantViolation("google_trends.invalid_anchor", "Normalization anchor must be non-empty or null");
  }
  const canonical = [...new Set(context.comparisonSubjects.map((item) => item.trim()))].sort();
  if (canonical.length !== context.comparisonSubjects.length || canonical.some((item, index) => item !== context.comparisonSubjects[index])) {
    throw new InvariantViolation(
      "google_trends.comparison_not_canonical",
      "Comparison subjects must be unique and sorted",
    );
  }
  if (context.scale.min !== 0 || context.scale.max !== 100) {
    throw new InvariantViolation("google_trends.invalid_scale", "Google Trends scale must be 0..100");
  }
}

export interface CreateGoogleTrendsObservationInput {
  readonly id: MetricObservationId;
  readonly subject: MetricSubject & { readonly kind: "search_term" };
  readonly context: GoogleTrendsNormalizationContext;
  readonly observedAt: string;
  readonly rawValue: number;
  readonly normalizedValue: number;
  readonly partial?: boolean;
  readonly provenance: GoogleTrendsObservationProvenance;
}

/** Search momentum is fixed to its own lane and cannot be relabelled as demand evidence. */
export function createGoogleTrendsObservation(
  input: CreateGoogleTrendsObservationInput,
): GoogleTrendsMetricObservation {
  validateGoogleTrendsNormalizationContext(input.context);
  assertTime(input.observedAt, "observedAt");
  assertTime(input.provenance.collectedAt, "provenance.collectedAt");
  if (!input.subject.externalId.trim() || !input.subject.url.trim()) {
    throw new InvariantViolation("google_trends.subject_required", "Search subject id and URL are required");
  }
  if (!input.context.comparisonSubjects.includes(input.subject.externalId)) {
    throw new InvariantViolation("google_trends.subject_not_compared", "Subject must be in comparisonSubjects");
  }
  if (input.context.geography !== input.context.geography.trim()) {
    throw new InvariantViolation("google_trends.invalid_geography", "Geography must be canonical");
  }
  const observed = Date.parse(input.observedAt);
  if (observed < Date.parse(input.context.window.startAt) || observed > Date.parse(input.context.window.endAt)) {
    throw new InvariantViolation("google_trends.observation_outside_window", "Observation is outside its normalization window");
  }
  for (const [field, value] of [["rawValue", input.rawValue], ["normalizedValue", input.normalizedValue]] as const) {
    if (!Number.isFinite(value) || value < 0 || value > 100) {
      throw new InvariantViolation("google_trends.invalid_value", `${field} must be between 0 and 100`);
    }
  }
  if (!input.provenance.collector.trim() || !input.provenance.collectorVersion.trim() || !input.provenance.sourceRef.trim()) {
    throw new InvariantViolation("google_trends.provenance_required", "Google Trends provenance is required");
  }
  const partial = input.partial ?? false;
  if (partial && !input.context.includesPartialBucket) {
    throw new InvariantViolation("google_trends.unexpected_partial", "Partial observation conflicts with normalization context");
  }
  return {
    id: input.id,
    subject: input.subject,
    source: "google_trends",
    metric: "relative_search_interest",
    lane: "search_momentum",
    geography: input.context.geography,
    observedAt: input.observedAt,
    rawValue: input.rawValue,
    normalizedValue: input.normalizedValue,
    unit: "relative_interest_0_100",
    collectionMethod: input.provenance.interface,
    normalizationContextId: input.context.id,
    partial,
    provenance: input.provenance,
  };
}

function identity(observation: GoogleTrendsMetricObservation): string {
  return `${observation.normalizationContextId}|${observation.subject.externalId}|${observation.observedAt}`;
}

export function buildGoogleTrendSeries(
  id: TrendSeriesId,
  context: GoogleTrendsNormalizationContext,
  observations: readonly GoogleTrendsMetricObservation[],
): { readonly series: GoogleTrendsSeries; readonly observations: readonly GoogleTrendsMetricObservation[] } {
  validateGoogleTrendsNormalizationContext(context);
  if (observations.length === 0) throw new InvariantViolation("trend.empty_series", "TrendSeries requires observations");
  const first = observations[0]!;
  const unique = new Map<string, GoogleTrendsMetricObservation>();
  for (const observation of observations) {
    if (
      observation.source !== "google_trends" ||
      observation.lane !== "search_momentum" ||
      observation.normalizationContextId !== context.id ||
      observation.geography !== context.geography ||
      observation.subject.externalId !== first.subject.externalId ||
      observation.subject.url !== first.subject.url
    ) {
      throw new InvariantViolation("trend.mixed_normalization_context", "Google TrendSeries cannot mix subject, geography, or normalization context");
    }
    const key = identity(observation);
    const existing = unique.get(key);
    if (existing && JSON.stringify(existing) !== JSON.stringify(observation)) {
      throw new InvariantViolation("trend.observation_conflict", `Conflicting Google Trends observation ${key}`);
    }
    unique.set(key, observation);
  }
  const ordered = [...unique.values()].sort((a, b) => a.observedAt.localeCompare(b.observedAt) || a.id.localeCompare(b.id));
  return {
    observations: ordered,
    series: {
      id,
      subject: first.subject,
      source: "google_trends",
      metric: "relative_search_interest",
      lane: "search_momentum",
      geography: context.geography,
      normalizationContextId: context.id,
      window: context.window,
      observationIds: ordered.map((item) => item.id),
      startedAt: ordered[0]!.observedAt,
      endedAt: ordered.at(-1)!.observedAt,
    },
  };
}

export const DEFAULT_SEARCH_MOMENTUM_RULES: SearchMomentumClassifierRules = {
  minHistoryBuckets: 6,
  spikeBaselineBuckets: 3,
  spikeMultiplier: 2,
  spikeReturnRatio: 0.5,
  seasonalPeriodBuckets: 3,
  seasonalMinPeriods: 2,
  seasonalCorrelationThreshold: 0.8,
  seasonalMaxLevelShiftRatio: 0.25,
  growthWindowBuckets: 3,
  growthMinRelativeIncrease: 0.5,
  growthMinPositiveStepRatio: 0.7,
};

function average(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function correlation(left: readonly number[], right: readonly number[]): number {
  const leftMean = average(left);
  const rightMean = average(right);
  let numerator = 0;
  let leftSquared = 0;
  let rightSquared = 0;
  for (let index = 0; index < left.length; index += 1) {
    const l = left[index]! - leftMean;
    const r = right[index]! - rightMean;
    numerator += l * r;
    leftSquared += l * l;
    rightSquared += r * r;
  }
  const denominator = Math.sqrt(leftSquared * rightSquared);
  return denominator === 0 ? (left.every((value, index) => value === right[index]) ? 1 : 0) : numerator / denominator;
}

function classify(values: readonly number[], rules: SearchMomentumClassifierRules): SearchMomentumPattern {
  if (values.length < rules.minHistoryBuckets) return "insufficient_history";
  const seasonalLength = rules.seasonalPeriodBuckets * rules.seasonalMinPeriods;
  if (values.length >= seasonalLength) {
    const recent = values.slice(-rules.seasonalPeriodBuckets);
    const prior = values.slice(-rules.seasonalPeriodBuckets * 2, -rules.seasonalPeriodBuckets);
    const combinedRange = Math.max(...prior, ...recent) - Math.min(...prior, ...recent);
    const levelShift = Math.abs(average(recent) - average(prior));
    if (
      Math.max(...recent) > Math.min(...recent) &&
      correlation(prior, recent) >= rules.seasonalCorrelationThreshold &&
      (combinedRange === 0 ? levelShift === 0 : levelShift / combinedRange <= rules.seasonalMaxLevelShiftRatio)
    ) {
      return "seasonal";
    }
  }
  for (let index = rules.spikeBaselineBuckets; index < values.length - 1; index += 1) {
    const baseline = average(values.slice(index - rules.spikeBaselineBuckets, index));
    const peak = values[index]!;
    const threshold = baseline === 0 ? peak > 0 : peak >= baseline * rules.spikeMultiplier;
    const returned = values.slice(index + 1).some((value) => value <= baseline + (peak - baseline) * rules.spikeReturnRatio);
    if (threshold && returned) return "spike";
  }
  if (values.length >= rules.growthWindowBuckets * 2) {
    const first = average(values.slice(0, rules.growthWindowBuckets));
    const recent = average(values.slice(-rules.growthWindowBuckets));
    const increase = first === 0 ? (recent > 0 ? Infinity : 0) : (recent - first) / first;
    const positiveSteps = values.slice(1).filter((value, index) => value > values[index]!).length / (values.length - 1);
    if (increase >= rules.growthMinRelativeIncrease && positiveSteps >= rules.growthMinPositiveStepRatio) {
      return "sustained_growth";
    }
  }
  return "no_pattern";
}

export interface ClassifySearchMomentumOptions {
  readonly detectedAt: string;
  readonly rules?: Partial<SearchMomentumClassifierRules>;
}

export function classifySearchMomentum(
  series: GoogleTrendsSeries,
  observationsById: ReadonlyMap<MetricObservationId, GoogleTrendsMetricObservation>,
  options: ClassifySearchMomentumOptions,
): SearchMomentumTrendEvent {
  assertTime(options.detectedAt, "detectedAt");
  const rules = { ...DEFAULT_SEARCH_MOMENTUM_RULES, ...options.rules };
  if (Object.values(rules).some((value) => !Number.isFinite(value) || value < 0)) {
    throw new InvariantViolation("google_trends.invalid_rules", "Classifier rules must be finite and non-negative");
  }
  const observations = series.observationIds.map((id) => observationsById.get(id));
  if (observations.some((item) => !item)) {
    throw new InvariantViolation("trend.missing_observation", "Search momentum event requires all series observations");
  }
  const complete = observations.filter((item): item is GoogleTrendsMetricObservation => item !== undefined && !item.partial);
  const kind = classify(complete.map((item) => item.normalizedValue), rules);
  const currentId = complete.at(-1)?.id ?? series.observationIds.at(-1)!;
  return {
    id: asId<TrendEventId>(`tevt_${series.id}_${currentId}_${kind}`),
    seriesId: series.id,
    kind,
    detectedAt: options.detectedAt,
    observationIds: complete.map((item) => item.id),
    normalizationContextId: series.normalizationContextId,
    detector: "search_momentum_v1",
    rules,
  };
}
