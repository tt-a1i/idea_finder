import type { DatabaseSync } from "node:sqlite";

import {
  buildTrendSeries,
  buildGoogleTrendSeries,
  buildPackageDownloadSeries,
  classifySearchMomentum,
  classifyGitHubMetric,
  createGoogleTrendsObservation,
  createGitHubMetricObservation,
  createPackageDownloadObservation,
  detectLatestTrendEvent,
  detectLatestPackageDownloadEvent,
  validateGoogleTrendsNormalizationContext,
  type DeltaTrendEvent,
  type GitHubMetricObservation,
  type GitHubTrendSeries,
  type GoogleTrendsMetricObservation,
  type GoogleTrendsNormalizationContext,
  type GoogleTrendsSeries,
  type SearchMomentumTrendEvent,
  type MetricObservation,
  type PackageDownloadObservation,
  type PackageDownloadSeries,
  type TrendEvent,
  type TrendSeries,
} from "@idea-finder/core";
import type {
  MetricObservationRepository,
  NormalizationContextRepository,
  QuantitativeListFilter,
  TrendEventRepository,
  TrendSeriesRepository,
} from "../ports/repositories.js";

function parse<T>(row: { payload_json: string } | undefined): T | null {
  return row ? JSON.parse(row.payload_json) as T : null;
}

function assertIdempotent<T>(existing: T | null, incoming: T, label: string): void {
  if (existing && JSON.stringify(existing) !== JSON.stringify(incoming)) {
    throw new Error(`${label} conflicts with canonical SQLite state`);
  }
}

function samePackageFact(left: PackageDownloadObservation, right: PackageDownloadObservation): boolean {
  const normalize = (item: PackageDownloadObservation) => ({ ...item, provenance: { ...item.provenance, collectedAt: "", sourceRef: "" } });
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

function assertValidObservation(observation: MetricObservation): void {
  if (!observation.id.trim()) throw new Error("MetricObservation id is required");
  if (observation.source === "github") {
    if (observation.subject.kind !== "repository") {
      throw new Error(`MetricObservation ${observation.id} must describe a GitHub repository`);
    }
    if (classifyGitHubMetric(observation.metric) !== observation.lane) {
      throw new Error(`MetricObservation ${observation.id} lane conflicts with its metric`);
    }
    const validated = createGitHubMetricObservation({
      id: observation.id, subject: observation.subject, metric: observation.metric,
      geography: observation.geography, observedAt: observation.observedAt,
      rawValue: observation.rawValue, normalizedValue: observation.normalizedValue,
      provenance: observation.provenance,
    });
    if (validated.unit !== observation.unit || validated.collectionMethod !== observation.collectionMethod) {
      throw new Error(`MetricObservation ${observation.id} derived fields conflict with canonical values`);
    }
  }
}

function sameSubject(left: MetricObservation["subject"], right: TrendSeries["subject"]): boolean {
  return left.kind === right.kind && left.externalId === right.externalId && left.url === right.url &&
    (!("ecosystem" in left) || !("ecosystem" in right) || (
      left.ecosystem === right.ecosystem && left.canonicalName === right.canonicalName
    ));
}

function listQuantitative<T>(
  db: DatabaseSync,
  table: "metric_observations" | "trend_series",
  filter: QuantitativeListFilter = {},
): T[] {
  const clauses: string[] = [];
  const values: string[] = [];
  for (const [column, value] of [
    ["source", filter.source], ["subject_external_id", filter.subjectExternalId],
    ["metric", filter.metric], ["geography", filter.geography],
    ["normalization_context_id", filter.normalizationContextId],
    ["ecosystem", filter.ecosystem], ["package_name", filter.packageName],
    ["window_start_at", filter.windowStartAt], ["window_end_at", filter.windowEndAt],
  ] as const) {
    if (value !== undefined) { clauses.push(`${column} = ?`); values.push(value); }
  }
  const order = table === "metric_observations" ? "observed_at, id" : "id";
  const rows = db.prepare(`SELECT payload_json FROM ${table}${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""} ORDER BY ${order}`).all(...values);
  return (rows as Array<{ payload_json: string }>).map((row) => JSON.parse(row.payload_json) as T);
}

export function createNormalizationContextRepository(db: DatabaseSync): NormalizationContextRepository {
  const insert = db.prepare("INSERT INTO normalization_contexts (id, source, geography, payload_json) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING");
  const get = db.prepare("SELECT payload_json FROM normalization_contexts WHERE id = ?");
  const list = db.prepare("SELECT payload_json FROM normalization_contexts ORDER BY id");
  return {
    save(context) {
      validateGoogleTrendsNormalizationContext(context);
      insert.run(context.id, context.source, context.geography, JSON.stringify(context));
      assertIdempotent(parse(get.get(context.id) as { payload_json: string } | undefined), context, `NormalizationContext ${context.id}`);
    },
    get(id) { return parse(get.get(id) as { payload_json: string } | undefined); },
    list() { return (list.all() as Array<{ payload_json: string }>).map((row) => JSON.parse(row.payload_json) as GoogleTrendsNormalizationContext); },
  };
}

export function createMetricObservationRepository(db: DatabaseSync): MetricObservationRepository {
  const insert = db.prepare(`INSERT INTO metric_observations
    (id, source, subject_kind, subject_external_id, metric, observed_at, collection_method, geography, normalization_context_id, ecosystem, package_name, window_start_at, window_end_at, payload_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`);
  const get = db.prepare("SELECT payload_json FROM metric_observations WHERE id = ?");
  const getIdentity = db.prepare(`SELECT payload_json FROM metric_observations
    WHERE source = ? AND subject_kind = ? AND subject_external_id = ? AND metric = ? AND observed_at = ? AND collection_method = ? AND geography = ? AND normalization_context_id = ? AND ecosystem = ? AND package_name = ? AND window_start_at = ? AND window_end_at = ?`);
  const getContext = db.prepare("SELECT payload_json FROM normalization_contexts WHERE id = ?");
  return {
    save(observation) {
      assertValidObservation(observation);
      const contextId = observation.source === "google_trends" ? observation.normalizationContextId : "";
      const geography = observation.geography ?? "";
      const ecosystem = observation.source === "npm_registry" || observation.source === "pypi" ? observation.ecosystem : "";
      const packageName = observation.source === "npm_registry" || observation.source === "pypi" ? observation.subject.canonicalName : "";
      const windowStartAt = observation.source === "npm_registry" || observation.source === "pypi" ? observation.bucket.startAt : "";
      const windowEndAt = observation.source === "npm_registry" || observation.source === "pypi" ? observation.bucket.endAt : "";
      let persisted = observation;
      if (observation.source === "google_trends") {
        const context = parse<GoogleTrendsNormalizationContext>(getContext.get(contextId) as { payload_json: string } | undefined);
        if (!context) throw new Error(`MetricObservation ${observation.id} references missing NormalizationContext ${contextId}`);
        const canonical = createGoogleTrendsObservation({
          id: observation.id, subject: observation.subject, context,
          observedAt: observation.observedAt, rawValue: observation.rawValue,
          normalizedValue: observation.normalizedValue, partial: observation.partial,
          provenance: observation.provenance,
        });
        assertIdempotent(canonical, observation, `MetricObservation ${observation.id}`);
      }
      if (observation.source === "npm_registry" || observation.source === "pypi") {
        const canonical = createPackageDownloadObservation({
          id: observation.id, ecosystem: observation.ecosystem,
          packageName: observation.subject.canonicalName, bucket: observation.bucket,
          downloads: observation.rawValue, provenance: observation.provenance,
        });
        if (canonical.source !== observation.source || canonical.metric !== observation.metric ||
          canonical.lane !== observation.lane || canonical.normalizedValue !== observation.normalizedValue ||
          canonical.normalizationMethod !== observation.normalizationMethod || canonical.unit !== observation.unit ||
          canonical.collectionMethod !== observation.collectionMethod || canonical.observedAt !== observation.observedAt) {
          throw new Error(`MetricObservation ${observation.id} conflicts with canonical package values`);
        }
        persisted = canonical;
        const existing = parse<MetricObservation>(get.get(persisted.id) as { payload_json: string } | undefined);
        if (existing?.source === "npm_registry" || existing?.source === "pypi") {
          if (samePackageFact(existing, persisted)) return;
        }
      }
      insert.run(persisted.id, persisted.source, persisted.subject.kind, persisted.subject.externalId,
        persisted.metric, persisted.observedAt, persisted.collectionMethod, geography, contextId,
        ecosystem, packageName, windowStartAt, windowEndAt, JSON.stringify(persisted));
      const byId = parse<MetricObservation>(get.get(persisted.id) as { payload_json: string } | undefined);
      const byIdentity = parse<MetricObservation>(getIdentity.get(persisted.source, persisted.subject.kind,
        persisted.subject.externalId, persisted.metric, persisted.observedAt, persisted.collectionMethod, geography, contextId,
        ecosystem, packageName, windowStartAt, windowEndAt) as { payload_json: string } | undefined);
      assertIdempotent(byId, persisted, `MetricObservation ${persisted.id}`);
      assertIdempotent(byIdentity, persisted, `MetricObservation identity ${persisted.subject.externalId}/${persisted.metric}/${persisted.observedAt}`);
    },
    get(id) { return parse(get.get(id) as { payload_json: string } | undefined); },
    list(filter) { return listQuantitative(db, "metric_observations", filter); },
  };
}

export function createTrendSeriesRepository(db: DatabaseSync): TrendSeriesRepository {
  const upsert = db.prepare(`INSERT INTO trend_series (id, source, subject_external_id, metric, geography, normalization_context_id, ecosystem, package_name, window_start_at, window_end_at, payload_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET source=excluded.source,
    subject_external_id=excluded.subject_external_id, metric=excluded.metric, geography=excluded.geography,
    normalization_context_id=excluded.normalization_context_id, ecosystem=excluded.ecosystem,
    package_name=excluded.package_name, window_start_at=excluded.window_start_at,
    window_end_at=excluded.window_end_at, payload_json=excluded.payload_json`);
  const get = db.prepare("SELECT payload_json FROM trend_series WHERE id = ?");
  const getObservation = db.prepare("SELECT payload_json FROM metric_observations WHERE id = ?");
  const getContext = db.prepare("SELECT payload_json FROM normalization_contexts WHERE id = ?");
  const remove = db.prepare("DELETE FROM trend_series WHERE id = ?");
  return {
    save(series) {
      const observations: MetricObservation[] = [];
      for (const observationId of series.observationIds) {
        const observation = parse<MetricObservation>(getObservation.get(observationId) as { payload_json: string } | undefined);
        if (!observation) {
          throw new Error(`TrendSeries ${series.id} references missing MetricObservation ${observationId}`);
        }
        if (
          observation.source !== series.source ||
          !sameSubject(observation.subject, series.subject) ||
          observation.metric !== series.metric ||
          observation.lane !== series.lane
        ) {
          throw new Error(`TrendSeries ${series.id} observation ${observationId} conflicts with series identity`);
        }
        observations.push(observation);
      }
      const canonical = series.source === "google_trends"
        ? buildGoogleTrendSeries(
          series.id,
          (() => {
            const context = parse<GoogleTrendsNormalizationContext>(getContext.get(series.normalizationContextId) as { payload_json: string } | undefined);
            if (!context) throw new Error(`TrendSeries ${series.id} references missing NormalizationContext ${series.normalizationContextId}`);
            return context;
          })(),
          observations as GoogleTrendsMetricObservation[],
        ).series
        : series.source === "npm_registry" || series.source === "pypi"
          ? buildPackageDownloadSeries(series.id, observations as PackageDownloadObservation[]).series
          : buildTrendSeries(series.id, observations as GitHubMetricObservation[]).series;
      if (
        canonical.id !== series.id ||
        canonical.source !== series.source ||
        !sameSubject(canonical.subject, series.subject) ||
        canonical.metric !== series.metric ||
        canonical.lane !== series.lane ||
        (canonical.source === "google_trends" && series.source === "google_trends" && (
          canonical.geography !== series.geography ||
          canonical.normalizationContextId !== series.normalizationContextId ||
          JSON.stringify(canonical.window) !== JSON.stringify(series.window)
        )) ||
        ((canonical.source === "npm_registry" || canonical.source === "pypi") &&
          (series.source === "npm_registry" || series.source === "pypi") && (
            canonical.ecosystem !== series.ecosystem || canonical.resolution !== series.resolution ||
            canonical.timezone !== series.timezone || canonical.normalizationMethod !== series.normalizationMethod
          )) ||
        canonical.startedAt !== series.startedAt ||
        canonical.endedAt !== series.endedAt ||
        canonical.observationIds.length !== series.observationIds.length ||
        canonical.observationIds.some((id, index) => id !== series.observationIds[index])
      ) {
        throw new Error(`TrendSeries ${series.id} structure conflicts with canonical observations`);
      }
      const existing = parse<TrendSeries>(get.get(series.id) as { payload_json: string } | undefined);
      if (existing && (existing.source !== series.source || existing.subject.kind !== series.subject.kind
        || existing.subject.externalId !== series.subject.externalId || existing.subject.url !== series.subject.url
        || existing.metric !== series.metric || existing.lane !== series.lane)) {
        throw new Error(`TrendSeries ${series.id} identity conflicts with canonical SQLite state`);
      }
      upsert.run(series.id, series.source, series.subject.externalId, series.metric,
        series.source === "google_trends" ? series.geography : "",
        series.source === "google_trends" ? series.normalizationContextId : "",
        series.source === "npm_registry" || series.source === "pypi" ? series.ecosystem : "",
        series.source === "npm_registry" || series.source === "pypi" ? series.subject.canonicalName : "",
        series.source === "npm_registry" || series.source === "pypi" ? series.startedAt : "",
        series.source === "npm_registry" || series.source === "pypi" ? series.endedAt : "",
        JSON.stringify(series));
    },
    get(id) { return parse(get.get(id) as { payload_json: string } | undefined); },
    list(filter) { return listQuantitative(db, "trend_series", filter); },
    delete(id) { remove.run(id); },
  };
}

export function createTrendEventRepository(db: DatabaseSync): TrendEventRepository {
  const insert = db.prepare("INSERT INTO trend_events (id, series_id, detected_at, payload_json) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING");
  const get = db.prepare("SELECT payload_json FROM trend_events WHERE id = ?");
  const list = db.prepare("SELECT payload_json FROM trend_events WHERE series_id = ? ORDER BY detected_at, id");
  const getSeries = db.prepare("SELECT payload_json FROM trend_series WHERE id = ?");
  const getObservation = db.prepare("SELECT payload_json FROM metric_observations WHERE id = ?");
  const removeBySeries = db.prepare("DELETE FROM trend_events WHERE series_id = ?");
  return {
    append(event) {
      const series = parse<TrendSeries>(getSeries.get(event.seriesId) as { payload_json: string } | undefined);
      if (!series) throw new Error(`TrendEvent ${event.id} references missing TrendSeries ${event.seriesId}`);
      if (event.detector === "search_momentum_v1") {
        if (series.source !== "google_trends") throw new Error(`TrendEvent ${event.id} requires a Google Trends series`);
        const observations = new Map(
          series.observationIds.map((id) => {
            const observation = parse<MetricObservation>(getObservation.get(id) as { payload_json: string } | undefined);
            if (!observation || observation.source !== "google_trends") {
              throw new Error(`TrendEvent ${event.id} references missing Google Trends observation ${id}`);
            }
            return [id, observation] as const;
          }),
        );
        const expected = classifySearchMomentum(series, observations, { detectedAt: event.detectedAt, rules: event.rules });
        assertIdempotent(expected, event, `TrendEvent ${event.id}`);
        insert.run(event.id, event.seriesId, event.detectedAt, JSON.stringify(event));
        assertIdempotent(parse(get.get(event.id) as { payload_json: string } | undefined), event, `TrendEvent ${event.id}`);
        return;
      }
      if (event.detector === "package_download_delta_v1") {
        if (series.source !== "npm_registry" && series.source !== "pypi") {
          throw new Error(`TrendEvent ${event.id} requires a package series`);
        }
        const observations = new Map(
          series.observationIds.map((id) => {
            const observation = parse<MetricObservation>(getObservation.get(id) as { payload_json: string } | undefined);
            if (!observation || (observation.source !== "npm_registry" && observation.source !== "pypi")) {
              throw new Error(`TrendEvent ${event.id} references missing package observation ${id}`);
            }
            return [id, observation] as const;
          }),
        );
        const expected = detectLatestPackageDownloadEvent(series, observations, {
          detectedAt: event.detectedAt,
          stableRelativeThreshold: event.stableRelativeThreshold,
        });
        if (!expected) throw new Error(`TrendEvent ${event.id} requires two package observations`);
        assertIdempotent(expected, event, `TrendEvent ${event.id}`);
        insert.run(event.id, event.seriesId, event.detectedAt, JSON.stringify(event));
        assertIdempotent(parse(get.get(event.id) as { payload_json: string } | undefined), event, `TrendEvent ${event.id}`);
        return;
      }
      if (series.source !== "github") throw new Error(`TrendEvent ${event.id} requires a GitHub series`);
      if (!series.observationIds.includes(event.previousObservationId) || !series.observationIds.includes(event.currentObservationId)) {
        throw new Error(`TrendEvent ${event.id} references observations outside TrendSeries ${event.seriesId}`);
      }
      const previous = parse<MetricObservation>(getObservation.get(event.previousObservationId) as { payload_json: string } | undefined);
      const current = parse<MetricObservation>(getObservation.get(event.currentObservationId) as { payload_json: string } | undefined);
      if (!previous || !current) {
        throw new Error(`TrendEvent ${event.id} references missing MetricObservation`);
      }
      const previousIndex = series.observationIds.indexOf(previous.id);
      const currentIndex = series.observationIds.indexOf(current.id);
      if (currentIndex !== previousIndex + 1) {
        throw new Error(`TrendEvent ${event.id} observations must be consecutive and ordered`);
      }
      const expected = detectLatestTrendEvent(
        { ...series, observationIds: [previous.id, current.id] },
        new Map([[previous.id, previous as GitHubMetricObservation], [current.id, current as GitHubMetricObservation]]),
        { detectedAt: event.detectedAt, stableRelativeThreshold: 0 },
      );
      if (!expected ||
        expected.id !== event.id ||
        expected.seriesId !== event.seriesId ||
        expected.kind !== event.kind ||
        expected.detectedAt !== event.detectedAt ||
        expected.previousObservationId !== event.previousObservationId ||
        expected.currentObservationId !== event.currentObservationId ||
        expected.previousValue !== event.previousValue ||
        expected.currentValue !== event.currentValue ||
        expected.absoluteDelta !== event.absoluteDelta ||
        expected.relativeDelta !== event.relativeDelta ||
        expected.detector !== event.detector) {
        throw new Error(`TrendEvent ${event.id} conflicts with referenced observations`);
      }
      insert.run(event.id, event.seriesId, event.detectedAt, JSON.stringify(event));
      assertIdempotent(parse(get.get(event.id) as { payload_json: string } | undefined), event, `TrendEvent ${event.id}`);
    },
    get(id) { return parse(get.get(id) as { payload_json: string } | undefined); },
    listBySeries(seriesId) {
      return (list.all(seriesId) as Array<{ payload_json: string }>).map((row) => JSON.parse(row.payload_json) as TrendEvent);
    },
    deleteBySeries(seriesId) { removeBySeries.run(seriesId); },
  };
}
