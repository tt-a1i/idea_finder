import type { DatabaseSync, StatementSync } from "node:sqlite";

import {
  buildTrendSeries,
  classifyGitHubMetric,
  createGitHubMetricObservation,
  detectLatestTrendEvent,
  type MetricObservation,
  type TrendEvent,
  type TrendSeries,
} from "@idea-finder/core";
import type {
  MetricObservationRepository,
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

function assertValidObservation(observation: MetricObservation): void {
  if (!observation.id.trim()) throw new Error("MetricObservation id is required");
  if (observation.source !== "github" || observation.subject.kind !== "repository") {
    throw new Error(`MetricObservation ${observation.id} must describe a GitHub repository`);
  }
  if (classifyGitHubMetric(observation.metric) !== observation.lane) {
    throw new Error(`MetricObservation ${observation.id} lane conflicts with its metric`);
  }
  const validated = createGitHubMetricObservation({
    id: observation.id,
    subject: observation.subject,
    metric: observation.metric,
    geography: observation.geography,
    observedAt: observation.observedAt,
    rawValue: observation.rawValue,
    normalizedValue: observation.normalizedValue,
    provenance: observation.provenance,
  });
  if (
    validated.unit !== observation.unit ||
    validated.collectionMethod !== observation.collectionMethod
  ) {
    throw new Error(`MetricObservation ${observation.id} derived fields conflict with canonical values`);
  }
}

function sameSubject(left: MetricObservation["subject"], right: TrendSeries["subject"]): boolean {
  return left.kind === right.kind && left.externalId === right.externalId && left.url === right.url;
}

function listQuantitative<T>(
  statements: { all: StatementSync; subject: StatementSync; metric: StatementSync; both: StatementSync },
  filter: QuantitativeListFilter = {},
): T[] {
  const rows = filter.subjectExternalId && filter.metric
    ? statements.both.all(filter.subjectExternalId, filter.metric)
    : filter.subjectExternalId
      ? statements.subject.all(filter.subjectExternalId)
      : filter.metric
        ? statements.metric.all(filter.metric)
        : statements.all.all();
  return (rows as Array<{ payload_json: string }>).map((row) => JSON.parse(row.payload_json) as T);
}

export function createMetricObservationRepository(db: DatabaseSync): MetricObservationRepository {
  const insert = db.prepare(`INSERT INTO metric_observations
    (id, source, subject_kind, subject_external_id, metric, observed_at, collection_method, payload_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`);
  const get = db.prepare("SELECT payload_json FROM metric_observations WHERE id = ?");
  const getIdentity = db.prepare(`SELECT payload_json FROM metric_observations
    WHERE source = ? AND subject_kind = ? AND subject_external_id = ? AND metric = ? AND observed_at = ? AND collection_method = ?`);
  const lists = {
    all: db.prepare("SELECT payload_json FROM metric_observations ORDER BY observed_at, id"),
    subject: db.prepare("SELECT payload_json FROM metric_observations WHERE subject_external_id = ? ORDER BY observed_at, id"),
    metric: db.prepare("SELECT payload_json FROM metric_observations WHERE metric = ? ORDER BY observed_at, id"),
    both: db.prepare("SELECT payload_json FROM metric_observations WHERE subject_external_id = ? AND metric = ? ORDER BY observed_at, id"),
  };
  return {
    save(observation) {
      assertValidObservation(observation);
      insert.run(observation.id, observation.source, observation.subject.kind, observation.subject.externalId,
        observation.metric, observation.observedAt, observation.collectionMethod, JSON.stringify(observation));
      const byId = parse<MetricObservation>(get.get(observation.id) as { payload_json: string } | undefined);
      const byIdentity = parse<MetricObservation>(getIdentity.get(observation.source, observation.subject.kind,
        observation.subject.externalId, observation.metric, observation.observedAt, observation.collectionMethod) as { payload_json: string } | undefined);
      assertIdempotent(byId, observation, `MetricObservation ${observation.id}`);
      assertIdempotent(byIdentity, observation, `MetricObservation identity ${observation.subject.externalId}/${observation.metric}/${observation.observedAt}`);
    },
    get(id) { return parse(get.get(id) as { payload_json: string } | undefined); },
    list(filter) { return listQuantitative(lists, filter); },
  };
}

export function createTrendSeriesRepository(db: DatabaseSync): TrendSeriesRepository {
  const upsert = db.prepare(`INSERT INTO trend_series (id, source, subject_external_id, metric, payload_json)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET source=excluded.source,
    subject_external_id=excluded.subject_external_id, metric=excluded.metric, payload_json=excluded.payload_json`);
  const get = db.prepare("SELECT payload_json FROM trend_series WHERE id = ?");
  const getObservation = db.prepare("SELECT payload_json FROM metric_observations WHERE id = ?");
  const lists = {
    all: db.prepare("SELECT payload_json FROM trend_series ORDER BY id"),
    subject: db.prepare("SELECT payload_json FROM trend_series WHERE subject_external_id = ? ORDER BY id"),
    metric: db.prepare("SELECT payload_json FROM trend_series WHERE metric = ? ORDER BY id"),
    both: db.prepare("SELECT payload_json FROM trend_series WHERE subject_external_id = ? AND metric = ? ORDER BY id"),
  };
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
      const canonical = buildTrendSeries(series.id, observations).series;
      if (
        canonical.id !== series.id ||
        canonical.source !== series.source ||
        !sameSubject(canonical.subject, series.subject) ||
        canonical.metric !== series.metric ||
        canonical.lane !== series.lane ||
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
      upsert.run(series.id, series.source, series.subject.externalId, series.metric, JSON.stringify(series));
    },
    get(id) { return parse(get.get(id) as { payload_json: string } | undefined); },
    list(filter) { return listQuantitative(lists, filter); },
  };
}

export function createTrendEventRepository(db: DatabaseSync): TrendEventRepository {
  const insert = db.prepare("INSERT INTO trend_events (id, series_id, detected_at, payload_json) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING");
  const get = db.prepare("SELECT payload_json FROM trend_events WHERE id = ?");
  const list = db.prepare("SELECT payload_json FROM trend_events WHERE series_id = ? ORDER BY detected_at, id");
  const getSeries = db.prepare("SELECT payload_json FROM trend_series WHERE id = ?");
  const getObservation = db.prepare("SELECT payload_json FROM metric_observations WHERE id = ?");
  return {
    append(event) {
      const series = parse<TrendSeries>(getSeries.get(event.seriesId) as { payload_json: string } | undefined);
      if (!series) throw new Error(`TrendEvent ${event.id} references missing TrendSeries ${event.seriesId}`);
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
        new Map([[previous.id, previous], [current.id, current]]),
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
  };
}
