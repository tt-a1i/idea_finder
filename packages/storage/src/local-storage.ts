import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  Chunk,
  EvidenceItem,
  Opportunity,
  OpportunityDraft,
  RawDocument,
  RawSignal,
} from "@idea-finder/core";

import { LocalFsBlobStore } from "./adapters/local-fs-blob-store.js";
import { createSqliteAuditLog } from "./adapters/sqlite-audit-log.js";
import { createSqliteJobQueue } from "./adapters/sqlite-job-queue.js";
import type { AuditLog } from "./ports/audit-log.js";
import type { BlobStore } from "./ports/blob-store.js";
import type { JobQueue } from "./ports/job-queue.js";
import type {
  CalibrationEventRepository,
  ChunkRepository,
  EvidenceItemRepository,
  JsonEntityRepository,
  OpportunityDraftRepository,
  OpportunityRepository,
  PipelineStepStore,
  RawDocumentRepository,
  RawSignalRepository,
  ResearchRunRepository,
  RunScopedRepository,
  MetricObservationRepository,
  TrendEventRepository,
  TrendSeriesRepository,
  NormalizationContextRepository,
  MultiLaneReportRepository,
  EvidenceIndependenceRepository,
  FollowUpProposalRepository,
} from "./ports/repositories.js";
import { createPipelineStepStore } from "./sqlite/pipeline-step-store.js";
import { createJsonEntityRepository } from "./sqlite/json-entity-repository.js";
import { createHuntingBriefRepository } from "./sqlite/hunting-brief-repository.js";
import { createCalibrationEventRepository } from "./sqlite/calibration-event-repository.js";
import { createResearchRunRepository } from "./sqlite/research-run-repository.js";
import { createRunScopedRepository } from "./sqlite/run-scoped-repository.js";
import { initSchema } from "./sqlite/schema.js";
import { createMetricObservationRepository, createNormalizationContextRepository, createTrendEventRepository, createTrendSeriesRepository } from "./sqlite/quantitative-repositories.js";
import { createEvidenceIndependenceRepository, createFollowUpProposalRepository, createMultiLaneReportRepository } from "./sqlite/multi-lane-repositories.js";

export interface LocalStorageOptions {
  /** Directory containing idea_finder.db and blobs/ (e.g. ./data). */
  readonly dataDir: string;
}

export interface StoredRunConfigRecord {
  readonly id: string;
  readonly effectiveConfig: unknown;
  readonly execution: string;
}

export interface StoredAdmissionResultRecord {
  readonly id: string;
  readonly decision: string;
  readonly opportunityId: string | null;
  readonly issues: readonly unknown[];
}

export interface StoredSourceStatusRecord {
  readonly id: string;
  readonly source: string;
  readonly status: string;
  readonly itemCount: number;
  readonly reason: string | null;
  readonly completedAt: string;
}

export interface StoredValidationExperimentRecord {
  readonly id: string;
  readonly runId: string;
  readonly experiment: unknown;
}

export interface StoredMonitorComparisonRecord {
  readonly id: string;
  readonly briefId: string;
  readonly baselineRunId: string;
  readonly compareRunId: string;
  readonly diff: unknown;
  readonly createdAt: string;
}

export interface StoredQuantitativeSourceStatusRecord {
  readonly id: string;
  readonly source: string;
  readonly subjectExternalId: string;
  readonly status: "success" | "failure" | "partial" | "rate_limited" | "missing_package" | "unavailable_history" | "authorization_required" | "throttled" | "unavailable" | "response_drift";
  readonly itemCount: number;
  readonly reason: string | null;
  readonly checkedAt: string;
  readonly [field: string]: unknown;
}

export interface LocalStorage {
  readonly huntingBriefs: JsonEntityRepository<{ readonly id: string; readonly slug: string }>;
  readonly researchRunConfigs: JsonEntityRepository<StoredRunConfigRecord>;
  readonly compatibilityMigrations: JsonEntityRepository<{ readonly id: string; readonly completedAt: string }>;
  readonly validationExperiments: JsonEntityRepository<StoredValidationExperimentRecord>;
  readonly monitorSchedules: JsonEntityRepository<{ readonly id: string }>;
  readonly monitorComparisons: JsonEntityRepository<StoredMonitorComparisonRecord>;
  readonly agentTasks: JsonEntityRepository<{ readonly id: string }>;
  readonly metricObservations: MetricObservationRepository;
  readonly normalizationContexts: NormalizationContextRepository;
  readonly trendSeries: TrendSeriesRepository;
  readonly trendEvents: TrendEventRepository;
  readonly quantitativeSourceStatuses: JsonEntityRepository<StoredQuantitativeSourceStatusRecord>;
  readonly multiLaneReports: MultiLaneReportRepository;
  readonly evidenceIndependence: EvidenceIndependenceRepository;
  readonly followUpProposals: FollowUpProposalRepository;
  readonly libraryAdmissionResults: RunScopedRepository<StoredAdmissionResultRecord>;
  readonly sourceStatuses: RunScopedRepository<StoredSourceStatusRecord>;
  readonly researchRuns: ResearchRunRepository;
  readonly rawDocuments: RawDocumentRepository;
  readonly chunks: ChunkRepository;
  readonly rawSignals: RawSignalRepository;
  readonly evidenceItems: EvidenceItemRepository;
  readonly opportunityDrafts: OpportunityDraftRepository;
  readonly opportunities: OpportunityRepository;
  readonly calibrationEvents: CalibrationEventRepository;
  readonly pipelineSteps: PipelineStepStore;
  readonly blobs: BlobStore;
  readonly jobs: JobQueue;
  readonly audit: AuditLog;
  transaction<T>(operation: () => T): T;
  close(): void;
}

export function openLocalStorage(options: LocalStorageOptions): LocalStorage {
  mkdirSync(options.dataDir, { recursive: true });
  const blobRoot = join(options.dataDir, "blobs");
  mkdirSync(blobRoot, { recursive: true });

  const db = new DatabaseSync(join(options.dataDir, "idea_finder.db"));
  initSchema(db);

  return {
    huntingBriefs: createHuntingBriefRepository(db),
    researchRunConfigs: createJsonEntityRepository(db, "research_run_configs"),
    compatibilityMigrations: createJsonEntityRepository(db, "compatibility_migrations"),
    validationExperiments: createJsonEntityRepository(db, "validation_experiments"),
    monitorSchedules: createJsonEntityRepository(db, "monitor_schedules"),
    monitorComparisons: createJsonEntityRepository(db, "monitor_comparisons"),
    agentTasks: createJsonEntityRepository(db, "agent_tasks"),
    metricObservations: createMetricObservationRepository(db),
    normalizationContexts: createNormalizationContextRepository(db),
    trendSeries: createTrendSeriesRepository(db),
    trendEvents: createTrendEventRepository(db),
    quantitativeSourceStatuses: createJsonEntityRepository(db, "quantitative_source_statuses"),
    multiLaneReports: createMultiLaneReportRepository(db),
    evidenceIndependence: createEvidenceIndependenceRepository(db),
    followUpProposals: createFollowUpProposalRepository(db),
    libraryAdmissionResults: createRunScopedRepository(db, "library_admission_results"),
    sourceStatuses: createRunScopedRepository(db, "source_statuses"),
    researchRuns: createResearchRunRepository(db),
    rawDocuments: createRunScopedRepository<RawDocument>(db, "raw_documents"),
    chunks: createRunScopedRepository<Chunk>(db, "chunks"),
    rawSignals: createRunScopedRepository<RawSignal>(db, "raw_signals"),
    evidenceItems: createRunScopedRepository<EvidenceItem>(db, "evidence_items"),
    opportunityDrafts: createRunScopedRepository<OpportunityDraft>(
      db,
      "opportunity_drafts",
    ),
    opportunities: createRunScopedRepository<Opportunity>(db, "opportunities"),
    calibrationEvents: createCalibrationEventRepository(db),
    pipelineSteps: createPipelineStepStore(db),
    blobs: new LocalFsBlobStore(blobRoot),
    jobs: createSqliteJobQueue(db),
    audit: createSqliteAuditLog(db),
    transaction<T>(operation: () => T): T {
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = operation();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    close() {
      db.close();
    },
  };
}
