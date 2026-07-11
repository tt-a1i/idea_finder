import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  CalibrationEvent,
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
} from "./ports/repositories.js";
import { createPipelineStepStore } from "./sqlite/pipeline-step-store.js";
import { createJsonEntityRepository } from "./sqlite/json-entity-repository.js";
import { createHuntingBriefRepository } from "./sqlite/hunting-brief-repository.js";
import { createResearchRunRepository } from "./sqlite/research-run-repository.js";
import { createRunScopedRepository } from "./sqlite/run-scoped-repository.js";
import { initSchema } from "./sqlite/schema.js";

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

export interface LocalStorage {
  readonly huntingBriefs: JsonEntityRepository<{ readonly id: string; readonly slug: string }>;
  readonly researchRunConfigs: JsonEntityRepository<StoredRunConfigRecord>;
  readonly compatibilityMigrations: JsonEntityRepository<{ readonly id: string; readonly completedAt: string }>;
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
    calibrationEvents: createRunScopedRepository<CalibrationEvent>(
      db,
      "calibration_events",
    ),
    pipelineSteps: createPipelineStepStore(db),
    blobs: new LocalFsBlobStore(blobRoot),
    jobs: createSqliteJobQueue(db),
    audit: createSqliteAuditLog(db),
    close() {
      db.close();
    },
  };
}
