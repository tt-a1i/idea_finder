import {
  applyCalibration,
  admitToLibrary,
  asId,
  completeValidationExperiment as applyValidationCompletion,
  computeMonitorDiff as buildMonitorDiff,
  createValidationExperiment as buildValidationExperiment,
  buildTrendSeries,
  buildGoogleTrendSeries,
  classifySearchMomentum,
  buildPackageDownloadSeries,
  canonicalizePackageName,
  createPackageDownloadObservation,
  detectLatestPackageDownloadEvent,
  buildExactDuplicateIndependenceIndex,
  buildMultiLaneSummary,
  buildResearchClaim,
  evaluateMultiLaneCandidate,
  proposeFollowUpHuntingTask,
  createGitHubMetricObservation,
  createGoogleTrendsObservation,
  detectLatestTrendEvent,
  DEFAULT_MONITOR_THRESHOLDS,
  startValidationExperiment as markValidationExperimentRunning,
} from "@idea-finder/core";
import { createGitHubQuantitativeConnector, createGoogleTrendsConnector, createNpmDownloadsConnector, createPyPiDownloadsConnector, GoogleTrendsSourceError, PackageDownloadsSourceError, type GoogleTrendsTransport, type PackageDownloadsConnector, type QuantitativeConnector } from "@idea-finder/connectors";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { openLocalStorage, type LocalStorage, type StoredMultiLaneReportRecord } from "@idea-finder/storage";
import type {
  ActorKind,
  CalibrationAction,
  CalibrationEvent,
  Chunk,
  EvidenceItem,
  HuntingTaskId,
  MonitorCadence,
  MonitorDiff,
  MonitorCoverageSnapshot,
  MonitorThresholds,
  MonitorSchedule,
  GitHubMetric,
  GitHubMetricObservation,
  GoogleTrendsMetricObservation,
  GoogleTrendsNormalizationContext,
  GoogleTrendsSeries,
  MetricObservation,
  PackageDownloadObservation,
  PackageDownloadSeries,
  PackageEcosystem,
  ResearchClaim,
  ResearchLane,
  MultiLaneCandidate,
  FollowUpHuntingTaskProposal,
  Opportunity,
  RawSignal,
  ResearchRunId,
  ValidationExperiment,
  ValidationExperimentType,
  ValidationOutcome,
  TrendEvent,
  TrendSeries,
} from "@idea-finder/core";
import type { ResearchRunner, ResearchRunExecution } from "./ports/research-runner.js";
import {
  createDefaultResearchRunner,
  createResearchRunFactory,
} from "./ports/runner-impl.js";
import {
  AgentTaskRunner,
  buildPlannedEffects,
} from "./agents/agent-task-service.js";
import type { WorkspacePaths } from "./storage/workspace-store.js";
import { createWorkspaceStore } from "./storage/workspace-store.js";
import type {
  AgentTask,
  HuntingBrief,
  InboxSignalSummary,
  StoredResearchRun,
  LibraryAdmissionRecord,
  ResearchSourceStatus,
  StoredResearchRunConfig,
  WorkspaceState,
} from "./types.js";
import { emptyWorkspaceState } from "./types.js";
import type { AgentKind, AgentPlannedEffect } from "@idea-finder/agents";

export interface WorkspaceServiceOptions {
  readonly paths: WorkspacePaths;
  readonly runner?: ResearchRunner;
  readonly runnerMode?: "fixture" | "orchestration";
}

const CONNECTOR_METRICS: Readonly<Record<string, GitHubMetric>> = {
  "github.repository.stars": "stars",
  "github.repository.forks": "forks",
  "github.repository.open_issues": "open_issues",
  "github.issue.opened": "issue_opened",
  "github.issue.closed": "issue_closed",
  "github.repository.contributors": "contributors",
};

function quantitativeSourceStatus(input: { id: string; source: string; status?: ResearchSourceStatus["status"]; itemCount?: number; reason?: string | null; startedAt: string; retryAt?: string | null; artifactIds?: readonly string[] }): ResearchSourceStatus {
  const status = input.status ?? "success";
  const reasonCode: ResearchSourceStatus["reasonCode"] = status === "success" ? (input.itemCount === 0 ? "zero_results" : "none") : status === "unauthorized" ? "unauthorized" : status === "throttled" ? "throttled" : status === "unavailable" ? "unavailable" : "failed";
  return { id: input.id, requestKey: input.id, source: input.source, status, itemCount: input.itemCount ?? 0, reasonCode, reason: input.reason ?? null, startedAt: input.startedAt, completedAt: new Date().toISOString(), retryAt: input.retryAt ?? null, artifactIds: input.artifactIds };
}

function failedQuantitativeSourceStatus(id: string, source: string, error: unknown, startedAt: string): ResearchSourceStatus {
  const reason = error instanceof Error ? error.message : String(error);
  const statusField = typeof error === "object" && error !== null && "status" in error
    ? String((error as { status?: unknown }).status ?? "")
    : "";
  const lower = `${reason} ${statusField}`.toLowerCase();
  const status: ResearchSourceStatus["status"] =
    /authoriz|credential|401|token required/.test(lower) ? "unauthorized"
      : /thrott|rate.?limit|429|retry-after/.test(lower) ? "throttled"
        : /unavailable|timeout|network|fetch failed|http 5\d\d|unavailable_history|incomplete coverage/.test(lower) ? "unavailable"
          : "failure";
  const retryAt = typeof error === "object" && error !== null ? ((error as { retryAt?: unknown; resetAt?: unknown }).retryAt ?? (error as { resetAt?: unknown }).resetAt) : null;
  return quantitativeSourceStatus({ id, source, status, reason, startedAt, retryAt: typeof retryAt === "string" ? retryAt : null });
}

function monitorCoverage(statuses: readonly ResearchSourceStatus[], expected: readonly ResearchSourceStatus[] = statuses): MonitorCoverageSnapshot {
  const byKey = new Map(statuses.map((status) => [status.requestKey ?? status.id, status]));
  const expectedByKey = new Map(expected.map((status) => [status.requestKey ?? status.id, status]));
  const sources = [...expectedByKey].map(([requestKey, expectedStatus]) => {
    const status = byKey.get(requestKey);
    return status
      ? { requestKey, source: status.source, status: status.status, reason: status.reason, itemCount: status.itemCount }
      : { requestKey, source: expectedStatus.source, status: "skipped" as const, reason: "Missing source execution status", itemCount: 0 };
  });
  const incompleteRequestKeys = sources.filter((status) => status.status !== "success").map((status) => status.requestKey).sort();
  return { complete: incompleteRequestKeys.length === 0, sources, incompleteRequestKeys };
}

function mergeMapsByRequestKey(...groups: Array<readonly ResearchSourceStatus[]>): ResearchSourceStatus[] {
  return [...new Map(groups.flat().map((status) => [status.requestKey ?? status.id, status])).values()];
}

interface RunSourceCheckpoint { readonly runId: ResearchRunId; readonly id: string; readonly source: string; readonly startedAt: string }

class QuantitativePersistenceError extends Error {
  constructor(readonly original: unknown) { super(original instanceof Error ? original.message : String(original)); }
}

function commitQuantitative(storage: LocalStorage, operation: () => void): void {
  try { storage.transaction(operation); }
  catch (error) { throw new QuantitativePersistenceError(error); }
}

function summarizeInbox(signals: readonly RawSignal[]): InboxSignalSummary[] {
  const byType = new Map<string, RawSignal[]>();
  for (const signal of signals) {
    const list = byType.get(signal.signalType) ?? [];
    list.push(signal);
    byType.set(signal.signalType, list);
  }
  return [...byType.entries()]
    .map(([signalType, items]) => ({
      signalType,
      count: items.length,
      sampleQuote: items[0]?.quoteVerbatim ?? "",
    }))
    .sort((a, b) => a.signalType.localeCompare(b.signalType));
}

/** Legacy-only flat projection; canonical entities remain fully run-scoped in StoredResearchRun arrays. */
function latestCompatibilityEntityRecord<T extends { readonly id: string }>(
  entities: readonly T[],
): Record<string, T> {
  const record: Record<string, T> = {};
  for (const entity of entities) {
    record[entity.id] = entity;
  }
  return record;
}

export class WorkspaceService {
  private readonly store;
  private readonly paths: WorkspacePaths;
  private readonly runner: ResearchRunner;
  private readonly runFactory = createResearchRunFactory();
  private readonly agentRunner = new AgentTaskRunner();

  constructor(options: WorkspaceServiceOptions) {
    this.paths = options.paths;
    this.store = createWorkspaceStore(options.paths);
    this.runner =
      options.runner ??
      createDefaultResearchRunner(
        options.runnerMode ?? "orchestration",
        options.paths.root,
      );
  }

  private openCanonical(): LocalStorage {
    return openLocalStorage({ dataDir: join(this.paths.root, "pipeline") });
  }

  private async migrateLegacyBriefs(): Promise<void> {
    const storage = this.openCanonical();
    try {
      const migrationId = "legacy-brief-json-v1";
      if (storage.compatibilityMigrations.get(migrationId)) return;
      const legacyBriefs = await this.store.listBriefs();
      storage.transaction(() => {
        const canonical = storage.huntingBriefs.list() as HuntingBrief[];
        for (const legacy of legacyBriefs) {
          const existing = canonical.find((brief) => brief.id === legacy.id || brief.slug === legacy.slug);
          if (!existing) {
            storage.huntingBriefs.save(legacy);
            canonical.push(legacy);
            continue;
          }
          if (JSON.stringify(existing) !== JSON.stringify(legacy)) {
            throw new Error(`Legacy Brief conflicts with canonical SQLite state: ${legacy.slug}`);
          }
        }
        storage.compatibilityMigrations.save({ id: migrationId, completedAt: new Date().toISOString() });
      });
    } finally {
      storage.close();
    }
  }

  private async migrateLegacyResearchState(): Promise<void> {
    const storage = this.openCanonical();
    try {
      const migrationId = "legacy-research-json-v1";
      if (storage.compatibilityMigrations.get(migrationId)) return;
      const legacy = await this.store.loadState();
      const saveLegacyEntities = <T extends { readonly id: string }>(
        label: string,
        runId: ResearchRunId,
        existing: readonly T[],
        incoming: readonly T[],
        save: (entity: T) => void,
      ): void => {
        const byId = new Map(existing.map((entity) => [entity.id, entity]));
        for (const entity of incoming) {
          const current = byId.get(entity.id);
          if (!current) {
            save(entity);
            continue;
          }
          if (JSON.stringify(current) !== JSON.stringify(entity)) {
            throw new Error(`Legacy ${label} conflicts with canonical SQLite state for ${runId}/${entity.id}`);
          }
        }
      };
      storage.transaction(() => {
        for (const stored of legacy.runs) {
          const canonicalRun = storage.researchRuns.get(stored.run.id);
          if (!canonicalRun) storage.researchRuns.save(stored.run);
          else if (JSON.stringify(canonicalRun) !== JSON.stringify(stored.run)) {
            throw new Error(`Legacy ResearchRun conflicts with canonical SQLite state: ${stored.run.id}`);
          }
          if (!storage.researchRunConfigs.get(stored.run.id)) {
            storage.researchRunConfigs.save({
              id: stored.run.id,
              effectiveConfig: { legacyImported: true, configHash: stored.run.configHash },
              execution: stored.execution ?? "new",
            });
          }
          saveLegacyEntities("document", stored.run.id, storage.rawDocuments.listByRun(stored.run.id), stored.documents ?? [], (entity) => storage.rawDocuments.save(stored.run.id, entity));
          saveLegacyEntities("chunk", stored.run.id, storage.chunks.listByRun(stored.run.id), stored.chunks, (entity) => storage.chunks.save(stored.run.id, entity));
          saveLegacyEntities("signal", stored.run.id, storage.rawSignals.listByRun(stored.run.id), stored.signals, (entity) => storage.rawSignals.save(stored.run.id, entity));
          saveLegacyEntities("evidence", stored.run.id, storage.evidenceItems.listByRun(stored.run.id), stored.evidence, (entity) => storage.evidenceItems.save(stored.run.id, entity));
          saveLegacyEntities("draft", stored.run.id, storage.opportunityDrafts.listByRun(stored.run.id), stored.drafts, (entity) => storage.opportunityDrafts.save(stored.run.id, entity));
          const existingAdmissions = new Set(
            storage.libraryAdmissionResults.listByRun(stored.run.id).map((result) => result.id),
          );
          const rejectedByDraft = new Map(stored.rejected.map((entry) => [entry.draftId, entry]));
          for (const draft of stored.drafts) {
            const opportunity = legacy.opportunities[`opp_${draft.id}`];
            if (opportunity) {
              const canonicalOpportunity = storage.opportunities.get(stored.run.id, opportunity.id);
              if (!canonicalOpportunity) storage.opportunities.save(stored.run.id, opportunity);
              else if (JSON.stringify(canonicalOpportunity) !== JSON.stringify(opportunity)) {
                throw new Error(`Legacy opportunity conflicts with canonical SQLite state for ${stored.run.id}/${opportunity.id}`);
              }
            }
            if (existingAdmissions.has(draft.id)) continue;
            const rejection = rejectedByDraft.get(draft.id);
            storage.libraryAdmissionResults.save(stored.run.id, {
              id: draft.id,
              decision: opportunity ? "admitted" : "rejected",
              opportunityId: opportunity?.id ?? null,
              issues: rejection?.issues ?? [],
            });
          }
          if (storage.sourceStatuses.listByRun(stored.run.id).length === 0) {
            storage.sourceStatuses.save(stored.run.id, {
              id: "legacy-json",
              source: "legacy-json",
              status: "success",
              itemCount: stored.chunks.length,
              reason: "Imported from legacy workspace JSON; raw documents were not represented there",
              completedAt: stored.run.completedAt ?? stored.run.startedAt ?? new Date().toISOString(),
            });
          }
        }
        storage.compatibilityMigrations.save({ id: migrationId, completedAt: new Date().toISOString() });
      });
    } finally {
      storage.close();
    }
  }

  private latestOpportunityOccurrence(
    storage: LocalStorage,
    opportunityId: string,
  ): { runId: ResearchRunId; opportunity: Opportunity } | null {
    const matches = storage.researchRuns.list().flatMap((run) =>
      storage.opportunities.listByRun(run.id)
        .filter((opportunity) => opportunity.id === opportunityId)
        .map((opportunity) => ({ runId: run.id, opportunity })),
    );
    return matches.at(-1) ?? null;
  }

  private legacyOpportunityOccurrence(
    storage: LocalStorage,
    legacy: WorkspaceState,
    opportunityId: string,
  ): { runId: ResearchRunId; opportunity: Opportunity } {
    const matches = legacy.runs.flatMap((stored) => {
      const represented = (stored.opportunities?.some((item) => item.id === opportunityId) ?? false)
        || stored.drafts.some((draft) => `opp_${draft.id}` === opportunityId);
      if (!represented) return [];
      const opportunity = storage.opportunities.get(stored.run.id, opportunityId);
      if (!opportunity) {
        throw new Error(`Legacy decision references a missing canonical Opportunity: ${stored.run.id}/${opportunityId}`);
      }
      return [{ runId: stored.run.id, opportunity }];
    });
    if (matches.length > 1) {
      throw new Error(`Legacy decision has ambiguous ResearchRun provenance: ${opportunityId}`);
    }
    if (matches.length === 1) return matches[0]!;
    throw new Error(`Legacy decision has no ResearchRun provenance: ${opportunityId}`);
  }

  private async migrateLegacyDecisionState(): Promise<void> {
    const storage = this.openCanonical();
    try {
      const migrationId = "legacy-decision-json-v2";
      if (storage.compatibilityMigrations.get(migrationId)) return;
      const legacy = await this.store.loadState();
      storage.transaction(() => {
        for (const value of Object.values(legacy.opportunities)) {
          if (!value || typeof value !== "object" || !("id" in value)) {
            throw new Error("Legacy workspace contains an invalid Opportunity record");
          }
          const opportunity = value as Opportunity;
          const occurrence = this.legacyOpportunityOccurrence(storage, legacy, opportunity.id);
          if (JSON.stringify(occurrence.opportunity) !== JSON.stringify(opportunity)) {
            storage.opportunities.save(occurrence.runId, opportunity);
          }
        }
        for (const event of legacy.calibrationEvents) {
          const occurrence = this.legacyOpportunityOccurrence(storage, legacy, event.opportunityId);
          const existing = storage.calibrationEvents.get(occurrence.runId, event.id);
          if (existing && JSON.stringify(existing) !== JSON.stringify(event)) {
            throw new Error(`Legacy CalibrationEvent conflicts with canonical SQLite state: ${event.id}`);
          }
          if (!existing) storage.calibrationEvents.append(occurrence.runId, event);
        }
        for (const experiment of Object.values(legacy.validationExperiments)) {
          const occurrence = this.legacyOpportunityOccurrence(storage, legacy, experiment.opportunityId);
          const existing = storage.validationExperiments.get(experiment.id);
          const record = { id: experiment.id, runId: occurrence.runId, experiment };
          if (existing && JSON.stringify(existing) !== JSON.stringify(record)) {
            throw new Error(`Legacy ValidationExperiment conflicts with canonical SQLite state: ${experiment.id}`);
          }
          if (!existing) storage.validationExperiments.save(record);
        }
        for (const schedule of Object.values(legacy.monitorSchedules)) {
          const brief = storage.huntingBriefs.get(schedule.briefId);
          if (!brief) {
            throw new Error(`Legacy MonitorSchedule references a missing Brief: ${schedule.id}/${schedule.briefId}`);
          }
          if (schedule.lastComparedRunId) {
            const run = storage.researchRuns.get(schedule.lastComparedRunId);
            if (!run || run.huntingTaskId !== schedule.briefId) {
              throw new Error(`Legacy MonitorSchedule references a missing run for its Brief: ${schedule.id}/${schedule.lastComparedRunId}`);
            }
          }
          const existing = storage.monitorSchedules.get(schedule.id);
          if (existing && JSON.stringify(existing) !== JSON.stringify(schedule)) {
            throw new Error(`Legacy MonitorSchedule conflicts with canonical SQLite state: ${schedule.id}`);
          }
          if (!existing) storage.monitorSchedules.save(schedule);
        }
        for (const task of Object.values(legacy.agentTasks)) {
          if (task.opportunityId && !this.latestOpportunityOccurrence(storage, task.opportunityId)) {
            throw new Error(`Legacy AgentTask references a missing Opportunity: ${task.id}/${task.opportunityId}`);
          }
          for (const evidenceId of task.evidenceIds) {
            const exists = storage.researchRuns.list().some((run) => storage.evidenceItems.get(run.id, evidenceId));
            if (!exists) {
              throw new Error(`Legacy AgentTask references missing Evidence: ${task.id}/${evidenceId}`);
            }
          }
          const existing = storage.agentTasks.get(task.id);
          if (existing && JSON.stringify(existing) !== JSON.stringify(task)) {
            throw new Error(`Legacy AgentTask conflicts with canonical SQLite state: ${task.id}`);
          }
          if (!existing) storage.agentTasks.save(task);
        }
        storage.compatibilityMigrations.save({ id: migrationId, completedAt: new Date().toISOString() });
      });
    } finally {
      storage.close();
    }
  }

  private canonicalResearchState(): Pick<
    WorkspaceState,
    "runs" | "opportunities" | "evidenceById" | "chunksById" | "signalsById"
  > {
    const storage = this.openCanonical();
    try {
      const runs: StoredResearchRun[] = storage.researchRuns.list().map((run) => {
        const admissionResults = storage.libraryAdmissionResults.listByRun(run.id) as LibraryAdmissionRecord[];
        const rejected = admissionResults
          .filter((result) => result.decision === "rejected")
          .map((result) => ({
            draftId: result.id as never,
            draft: storage.opportunityDrafts.listByRun(run.id).find((draft) => draft.id === result.id)!,
            issues: [...result.issues],
          }));
        const signals = storage.rawSignals.listByRun(run.id);
        const config = storage.researchRunConfigs.get(run.id) as StoredResearchRunConfig | null;
        return {
          execution: config?.execution ?? "new",
          run,
          briefId: run.huntingTaskId,
          documents: storage.rawDocuments.listByRun(run.id),
          chunks: storage.chunks.listByRun(run.id),
          signals,
          evidence: storage.evidenceItems.listByRun(run.id),
          drafts: storage.opportunityDrafts.listByRun(run.id),
          opportunities: storage.opportunities.listByRun(run.id),
          rejected,
          admissionResults,
          sourceStatuses: storage.sourceStatuses.listByRun(run.id) as ResearchSourceStatus[],
          admittedCount: admissionResults.filter((result) => result.decision === "admitted").length,
          inbox: summarizeInbox(signals),
        };
      });
      return {
        runs,
        opportunities: latestCompatibilityEntityRecord(runs.flatMap((stored) => stored.opportunities)),
        evidenceById: latestCompatibilityEntityRecord(runs.flatMap((stored) => stored.evidence)),
        chunksById: latestCompatibilityEntityRecord(runs.flatMap((stored) => stored.chunks)),
        signalsById: latestCompatibilityEntityRecord(runs.flatMap((stored) => stored.signals)),
      };
    } finally {
      storage.close();
    }
  }

  async createBrief(input: {
    slug: string;
    title: string;
    description: string;
    lenses?: string[];
    sourcesEnabled?: string[];
    successCriteria?: string;
    queryPlan?: HuntingBrief["queryPlan"];
    origin?: HuntingBrief["origin"];
  }): Promise<HuntingBrief> {
    const brief: HuntingBrief = {
      id: asId<HuntingTaskId>(`task_${input.slug}`),
      slug: input.slug,
      title: input.title,
      description: input.description,
      lenses: input.lenses ?? ["pain", "workaround", "wtp"],
      sourcesEnabled: input.sourcesEnabled ?? ["manual"],
      successCriteria: input.successCriteria ?? "3+ cross-source corroborated signals",
      createdAt: new Date().toISOString(),
      queryPlan: input.queryPlan,
      origin: input.origin,
    };
    await this.migrateLegacyBriefs();
    const storage = this.openCanonical();
    try {
      const conflict = (storage.huntingBriefs.list() as HuntingBrief[]).find(
        (existing) => existing.id === brief.id || existing.slug === brief.slug,
      );
      if (conflict) throw new Error(`Brief already exists: ${input.slug}`);
      storage.huntingBriefs.save(brief);
    } finally {
      storage.close();
    }
    return brief;
  }

  async listBriefs(): Promise<HuntingBrief[]> {
    await this.migrateLegacyBriefs();
    const storage = this.openCanonical();
    try {
      return (storage.huntingBriefs.list() as HuntingBrief[]).sort((a, b) => a.slug.localeCompare(b.slug));
    } finally {
      storage.close();
    }
  }

  async getBrief(slugOrId: string): Promise<HuntingBrief | null> {
    const briefs = await this.listBriefs();
    return briefs.find((brief) => brief.slug === slugOrId || brief.id === slugOrId) ?? null;
  }

  async runResearch(
    slugOrId: string,
    options?: {
      readonly runner?: ResearchRunner;
      readonly execution?: ResearchRunExecution;
      readonly runId?: ResearchRunId;
    },
  ): Promise<StoredResearchRun> {
    const brief = await this.getBrief(slugOrId);
    if (!brief) {
      throw new Error(`Brief not found: ${slugOrId}`);
    }
    await this.migrateLegacyResearchState();
    await this.migrateLegacyDecisionState();

    const runner = options?.runner ?? this.runner;
    const execution = options?.execution ?? "new";
    const pendingRun = this.runFactory.createResearchRun(brief);
    const runId = execution === "new"
      ? pendingRun.id
      : options?.runId;
    if (!runId) {
      throw new Error(`${execution} requires a ResearchRun ID`);
    }
    const output = await runner.run(brief, { runId, taskId: brief.id, execution });
    const run = output.run;

    const prior = execution === "new" ? null : this.openCanonical();
    const mergeById = <T extends { id: string }>(before: readonly T[], after: readonly T[]): T[] => [...new Map([...before, ...after].map((item) => [item.id, item])).values()];
    const documents = mergeById(prior?.rawDocuments.listByRun(run.id) ?? [], output.documents);
    const chunks = mergeById(prior?.chunks.listByRun(run.id) ?? [], output.chunks);
    const signals = mergeById(prior?.rawSignals.listByRun(run.id) ?? [], output.signals);
    const evidence = mergeById(prior?.evidenceItems.listByRun(run.id) ?? [], output.evidence);
    const drafts = mergeById(prior?.opportunityDrafts.listByRun(run.id) ?? [], output.drafts);
    const opportunities = mergeById(prior?.opportunities.listByRun(run.id) ?? [], output.opportunities);
    const admissionResults = mergeById(prior?.libraryAdmissionResults.listByRun(run.id) as LibraryAdmissionRecord[] ?? [], output.admissionResults);
    const sourceStatuses = mergeById(prior?.sourceStatuses.listByRun(run.id) as ResearchSourceStatus[] ?? [], output.sourceStatuses);
    prior?.close();

    const storage = this.openCanonical();
    try {
      storage.researchRuns.save(run);
      storage.researchRunConfigs.save(output.config);
      for (const document of documents) storage.rawDocuments.save(run.id, document);
      for (const chunk of chunks) storage.chunks.save(run.id, chunk);
      for (const signal of signals) storage.rawSignals.save(run.id, signal);
      for (const item of evidence) storage.evidenceItems.save(run.id, item);
      for (const draft of drafts) storage.opportunityDrafts.save(run.id, draft);
      for (const opportunity of opportunities) storage.opportunities.save(run.id, opportunity);
      for (const result of admissionResults) storage.libraryAdmissionResults.save(run.id, result);
      for (const status of sourceStatuses) storage.sourceStatuses.save(run.id, status);
    } finally {
      storage.close();
    }

    const rejected = admissionResults
      .filter((result) => result.decision === "rejected")
      .map((result) => ({
        draftId: result.id as never,
        draft: drafts.find((draft) => draft.id === result.id)!,
        issues: [...result.issues],
      }));

    const completedRun: StoredResearchRun = {
      execution: output.execution,
      run,
      briefId: brief.id,
      documents, chunks, signals, evidence, drafts, opportunities,
      rejected,
      admissionResults, sourceStatuses,
      admittedCount: opportunities.length,
      inbox: summarizeInbox(signals),
    };
    return completedRun;
  }

  async getState(): Promise<WorkspaceState> {
    await this.migrateLegacyResearchState();
    await this.migrateLegacyDecisionState();
    const canonical = this.canonicalResearchState();
    const storage = this.openCanonical();
    try {
      const base = emptyWorkspaceState();
      const calibrationEvents = storage.researchRuns.list().flatMap((run) => storage.calibrationEvents.listByRun(run.id));
      const validationExperiments = Object.fromEntries(
        storage.validationExperiments.list().map((record) => {
          const typed = record as { id: string; experiment: ValidationExperiment };
          return [typed.id, typed.experiment];
        }),
      );
      return {
        ...base,
        ...canonical,
        calibrationEvents,
        validationExperiments,
        monitorSchedules: Object.fromEntries((storage.monitorSchedules.list() as MonitorSchedule[]).map((item) => [item.id, item])),
        agentTasks: Object.fromEntries((storage.agentTasks.list() as AgentTask[]).map((item) => [item.id, item])),
      };
    } finally {
      storage.close();
    }
  }

  async getInboxSummary(briefSlugOrId?: string): Promise<{
    runId: string | null;
    inbox: InboxSignalSummary[];
  }> {
    const state = await this.getState();
    let runs = [...state.runs];
    if (briefSlugOrId) {
      const brief = await this.getBrief(briefSlugOrId);
      if (!brief) throw new Error(`Brief not found: ${briefSlugOrId}`);
      runs = runs.filter((r) => r.briefId === brief.id);
    }
    const latest = runs.at(-1);
    return {
      runId: latest?.run.id ?? null,
      inbox: latest ? [...latest.inbox] : [],
    };
  }

  async listOpportunities(briefSlugOrId?: string): Promise<Opportunity[]> {
    const entries = await this.listOpportunityEntries(briefSlugOrId);
    const latestById = new Map<string, Opportunity>();
    for (const entry of entries) latestById.set(entry.opportunity.id, entry.opportunity);
    return [...latestById.values()].sort((a, b) => a.demandStatement.localeCompare(b.demandStatement));
  }

  async listOpportunityEntries(briefSlugOrId?: string): Promise<Array<{
    runId: ResearchRunId;
    opportunity: Opportunity;
  }>> {
    await this.migrateLegacyResearchState();
    let briefId: HuntingTaskId | null = null;
    if (briefSlugOrId) {
      const brief = await this.getBrief(briefSlugOrId);
      if (!brief) throw new Error(`Brief not found: ${briefSlugOrId}`);
      briefId = brief.id;
    }

    const storage = this.openCanonical();
    try {
      const runs = briefId === null ? storage.researchRuns.list() : storage.researchRuns.listByTask(briefId);
      return runs.flatMap((run) => storage.opportunities.listByRun(run.id).map((opportunity) => ({
        runId: run.id,
        opportunity,
      })));
    } finally {
      storage.close();
    }
  }

  async inspectOpportunity(opportunityId: string, requestedRunId?: ResearchRunId): Promise<{
    opportunity: Opportunity;
    runId: ResearchRunId;
    evidence: readonly EvidenceItem[];
    chunks: readonly Chunk[];
    signals: readonly RawSignal[];
    calibrationEvents: readonly CalibrationEvent[];
  }> {
    await this.migrateLegacyResearchState();
    await this.migrateLegacyDecisionState();
    const storage = this.openCanonical();
    try {
      const matches = storage.researchRuns.list()
        .filter((run) => !requestedRunId || run.id === requestedRunId)
        .flatMap((run) => storage.opportunities.listByRun(run.id)
          .filter((item) => item.id === opportunityId)
          .map((opportunity) => ({ run, opportunity })));
      const selected = requestedRunId ? matches[0] : matches.at(-1);
      for (const { run, opportunity } of selected ? [selected] : []) {
        const evidenceById = new Map(storage.evidenceItems.listByRun(run.id).map((item) => [item.id, item]));
        return {
          opportunity,
          runId: run.id,
          evidence: opportunity.evidenceItemIds.flatMap((id) => evidenceById.get(id) ?? []),
          chunks: storage.chunks.listByRun(run.id),
          signals: storage.rawSignals.listByRun(run.id),
          calibrationEvents: storage.calibrationEvents.listByRun(run.id).filter((event) => event.opportunityId === opportunity.id),
        };
      }
    } finally {
      storage.close();
    }
    throw new Error(`Opportunity not found: ${opportunityId}`);
  }

  async listAdmissionResults(runId: ResearchRunId): Promise<readonly LibraryAdmissionRecord[]> {
    await this.migrateLegacyResearchState();
    const storage = this.openCanonical();
    try {
      if (!storage.researchRuns.get(runId)) throw new Error(`ResearchRun not found: ${runId}`);
      return storage.libraryAdmissionResults.listByRun(runId) as LibraryAdmissionRecord[];
    } finally {
      storage.close();
    }
  }

  async applyBoardCalibration(input: {
    opportunityId: string;
    action: CalibrationAction;
    note?: string | null;
    actor?: ActorKind;
    runId?: ResearchRunId;
  }): Promise<{ opportunity: Opportunity; event: CalibrationEvent }> {
    await this.migrateLegacyDecisionState();
    const inspection = await this.inspectOpportunity(input.opportunityId, input.runId);
    const opportunity = inspection.opportunity;
    if (!opportunity) {
      throw new Error(`Opportunity not found: ${input.opportunityId}`);
    }

    const validationContext = {
      evidenceById: new Map(inspection.evidence.map((item) => [item.id, item])),
      chunksById: new Map(inspection.chunks.map((item) => [item.id, item])),
      signalsById: new Map(inspection.signals.map((item) => [item.id, item])),
    };

    const result = applyCalibration(
      opportunity,
      input.action,
      input.note ?? null,
      input.actor ?? "user",
      undefined,
      input.action === "promote" ? validationContext : undefined,
    );

    const storage = this.openCanonical();
    try {
      storage.transaction(() => {
        storage.opportunities.save(inspection.runId, result.opportunity);
        storage.calibrationEvents.append(inspection.runId, result.event);
      });
      await storage.audit.append({
        at: result.event.occurredAt,
        actor: result.event.actor,
        action: `opportunity.${result.event.action}`,
        resource: result.opportunity.id,
        payload: { runId: inspection.runId, eventId: result.event.id, note: result.event.note },
      });
    } finally {
      storage.close();
    }
    return result;
  }

  async listAgentTasks(): Promise<AgentTask[]> {
    await this.migrateLegacyDecisionState();
    const storage = this.openCanonical();
    try {
      return (storage.agentTasks.list() as AgentTask[]).sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt),
      );
    } finally {
      storage.close();
    }
  }

  async getAgentTask(taskId: string): Promise<AgentTask | null> {
    await this.migrateLegacyDecisionState();
    const storage = this.openCanonical();
    try {
      return storage.agentTasks.get(taskId) as AgentTask | null;
    } finally {
      storage.close();
    }
  }

  async createAgentTask(input: {
    kind: AgentKind;
    intent: string;
    opportunityId?: string | null;
    evidenceIds?: readonly string[];
    dryRun?: boolean;
    domainWrite?: boolean;
    plannedEffects?: readonly AgentPlannedEffect[];
  }): Promise<AgentTask> {
    const now = new Date().toISOString();
    const taskId = `agent_${input.kind}_${randomUUID()}`;
    const task: AgentTask = {
      id: taskId,
      kind: input.kind,
      intent: input.intent,
      status: "pending",
      opportunityId: input.opportunityId ?? null,
      evidenceIds: input.evidenceIds ?? [],
      dryRun: input.dryRun ?? false,
      plannedEffects: buildPlannedEffects({
        kind: input.kind,
        opportunityId: input.opportunityId,
        domainWrite: input.domainWrite,
        plannedEffects: input.plannedEffects,
      }),
      createdAt: now,
      updatedAt: now,
      invocations: [],
    };

    await this.migrateLegacyDecisionState();
    const storage = this.openCanonical();
    try {
      storage.agentTasks.save(task);
    } finally {
      storage.close();
    }
    return task;
  }

  async runAgentTask(taskId: string): Promise<AgentTask> {
    await this.migrateLegacyDecisionState();
    const storage = this.openCanonical();
    try {
      const existing = storage.agentTasks.get(taskId) as AgentTask | null;
      if (!existing) throw new Error(`Agent task not found: ${taskId}`);
      const running: AgentTask = {
        ...existing,
        status: "running",
        updatedAt: new Date().toISOString(),
      };
      storage.agentTasks.save(running);
      const { task: completed } = await this.agentRunner.runTask(running);
      storage.agentTasks.save(completed);
      return completed;
    } finally {
      storage.close();
    }
  }

  async createValidationExperiment(input: {
    opportunityId: string;
    runId?: ResearchRunId;
    type: ValidationExperimentType;
    hypothesis: string;
    start?: boolean;
  }): Promise<ValidationExperiment> {
    await this.migrateLegacyDecisionState();
    const canonical = await this.inspectOpportunity(input.opportunityId, input.runId);
    const opportunity = canonical.opportunity;
    if (!opportunity) {
      throw new Error(`Opportunity not found: ${input.opportunityId}`);
    }

    let experiment = buildValidationExperiment({
      opportunity,
      type: input.type,
      hypothesis: input.hypothesis,
    });
    if (input.start) {
      experiment = markValidationExperimentRunning(experiment);
    }

    const storage = this.openCanonical();
    try {
      storage.validationExperiments.save({ id: experiment.id, runId: canonical.runId, experiment });
    } finally {
      storage.close();
    }
    return experiment;
  }

  async listValidationExperiments(opportunityId?: string): Promise<ValidationExperiment[]> {
    await this.migrateLegacyDecisionState();
    const storage = this.openCanonical();
    let items: ValidationExperiment[];
    try {
      items = storage.validationExperiments.list().map((record) => (record as { experiment: ValidationExperiment }).experiment);
    } finally {
      storage.close();
    }
    const filtered = opportunityId
      ? items.filter((e) => e.opportunityId === opportunityId)
      : items;
    return filtered.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async completeValidationExperiment(input: {
    experimentId: string;
    outcome: ValidationOutcome;
    summary: string;
    actor?: ActorKind;
  }): Promise<{ experiment: ValidationExperiment; opportunity: Opportunity }> {
    await this.migrateLegacyDecisionState();
    const storage = this.openCanonical();
    try {
      const record = storage.validationExperiments.get(input.experimentId) as { id: string; runId: ResearchRunId; experiment: ValidationExperiment } | null;
      const experiment = record?.experiment;
      if (!record || !experiment) {
        throw new Error(`Validation experiment not found: ${input.experimentId}`);
      }

      const canonical = await this.inspectOpportunity(experiment.opportunityId as string, record.runId);
      const opportunity = canonical.opportunity;
      if (!opportunity) {
        throw new Error(`Opportunity not found: ${experiment.opportunityId}`);
      }

      const result = applyValidationCompletion(opportunity, {
        experiment,
        outcome: input.outcome,
        summary: input.summary,
        recordedBy: input.actor ?? "user",
      });

      storage.transaction(() => {
        storage.validationExperiments.save({ ...record, experiment: result.experiment });
        storage.opportunities.save(record.runId, result.opportunity);
      });
      return result;
    } finally {
      storage.close();
    }
  }

  async collectGithubMetrics(input: {
    subject: string;
    since?: string;
    apiBase?: string;
    connector?: QuantitativeConnector;
    runSource?: RunSourceCheckpoint;
  }): Promise<{
    observations: readonly MetricObservation[];
    series: readonly TrendSeries[];
    events: readonly TrendEvent[];
  }> {
    const connector = input.connector ?? createGitHubQuantitativeConnector({ baseUrl: input.apiBase });
    const subjectExternalId = input.subject.replace(/^github:/, "").toLowerCase();
    try {
      const health = await connector.healthcheck();
      if (!health.ok) throw new Error(health.message ?? "GitHub quantitative connector healthcheck failed");
      const collected = await connector.collect({ subject: input.subject, since: input.since });
      const observations = collected.map((item) => {
        const metric = CONNECTOR_METRICS[item.metric];
        if (!metric) throw new Error(`Unsupported GitHub quantitative metric: ${item.metric}`);
        return createGitHubMetricObservation({
          id: asId(item.id),
          subject: { kind: "repository", externalId: subjectExternalId, url: `https://github.com/${subjectExternalId}` },
          metric,
          geography: item.geography,
          observedAt: item.observedAt,
          rawValue: item.rawValue,
          normalizedValue: item.normalizedValue,
          provenance: {
            collector: "idea-finder-github",
            collectorVersion: "1",
            interface: "github_rest_api",
            sourceRef: item.provenance.url,
            collectedAt: item.provenance.retrievedAt,
          },
        });
      });
      const storage = this.openCanonical();
      try {
        const series: TrendSeries[] = [];
        const events: TrendEvent[] = [];
        commitQuantitative(storage, () => {
          for (const observation of observations) storage.metricObservations.save(observation);
          for (const metric of [...new Set(observations.map((item) => item.metric))]) {
            const all = storage.metricObservations.list({ source: "github", subjectExternalId, metric })
              .filter((item): item is GitHubMetricObservation => item.source === "github");
            const subjectKey = createHash("sha256").update(subjectExternalId).digest("hex").slice(0, 20);
            const built = buildTrendSeries(asId(`trend_github_${subjectKey}_${metric}`), all);
            storage.trendSeries.save(built.series);
            series.push(built.series);
            const event = detectLatestTrendEvent(
              built.series,
              new Map(built.observations.map((item) => [item.id, item])),
              { detectedAt: observations[0]?.provenance.collectedAt ?? new Date().toISOString(), stableRelativeThreshold: 0 },
            );
            if (event) {
              storage.trendEvents.append(event);
              events.push(event);
            }
          }
          storage.quantitativeSourceStatuses.save({
            id: `github:${subjectExternalId}`,
            source: "github",
            subjectExternalId,
            status: "success",
            itemCount: observations.length,
            reason: null,
            checkedAt: observations[0]?.provenance.collectedAt ?? new Date().toISOString(),
          });
          if (input.runSource) storage.sourceStatuses.save(input.runSource.runId, quantitativeSourceStatus({ ...input.runSource, itemCount: observations.length, artifactIds: [...series.map((item) => item.id), ...observations.map((item) => item.id)] }));
        });
        return { observations, series, events };
      } finally {
        storage.close();
      }
    } catch (error) {
      if (error instanceof QuantitativePersistenceError) throw error;
      const storage = this.openCanonical();
      try {
        commitQuantitative(storage, () => {
        storage.quantitativeSourceStatuses.save({
          id: `github:${subjectExternalId}`,
          source: "github",
          subjectExternalId,
          status: "failure",
          itemCount: 0,
          reason: error instanceof Error ? error.message : String(error),
          checkedAt: new Date().toISOString(),
        });
        if (input.runSource) storage.sourceStatuses.save(input.runSource.runId, failedQuantitativeSourceStatus(input.runSource.id, input.runSource.source, error, input.runSource.startedAt));
        });
      } finally {
        storage.close();
      }
      throw error;
    }
  }

  async collectGoogleTrends(input: {
    subject: string;
    geography: string;
    from: string;
    to: string;
    granularity: "day" | "week";
    category?: string;
    property?: "web" | "news" | "images" | "youtube" | "shopping";
    transport?: GoogleTrendsTransport;
    runSource?: RunSourceCheckpoint;
  }): Promise<{ context: GoogleTrendsNormalizationContext; observations: readonly GoogleTrendsMetricObservation[]; series: GoogleTrendsSeries; event: TrendEvent }> {
    if (!input.subject.trim()) throw new Error("Google Trends subject must not be empty");
    if (!/^(?:[A-Za-z]{2}|WORLDWIDE)$/.test(input.geography)) throw new Error("Google Trends geography must be an ISO-3166 alpha-2 code or WORLDWIDE");
    if (Number.isNaN(Date.parse(input.from)) || Number.isNaN(Date.parse(input.to)) || Date.parse(input.from) >= Date.parse(input.to)) throw new Error("Google Trends requires a valid from < to window");
    const sourceKey = [input.subject.trim().toLowerCase(), input.geography.toUpperCase(), input.from, input.to, input.granularity].join("|");
    const statusId = `google_trends:${createHash("sha256").update(sourceKey).digest("hex").slice(0, 24)}`;
    try {
      const result = await createGoogleTrendsConnector({ transport: input.transport }).collect({ ...input, category: input.category ?? "all", property: input.property ?? "web" });
      const canonicalWithoutId: Omit<GoogleTrendsNormalizationContext, "id"> = {
        source: "google_trends",
        method: "relative_interest_0_100_v1",
        geography: result.normalizationContext.geography,
        window: { startAt: result.normalizationContext.from, endAt: result.normalizationContext.to, resolution: result.normalizationContext.granularity, timezone: "UTC" },
        comparisonSubjects: [...result.normalizationContext.comparisonSet],
        anchor: result.normalizationContext.anchor,
        category: result.normalizationContext.category,
        property: result.normalizationContext.property,
        scale: { min: 0, max: 100 },
        includesPartialBucket: result.normalizationContext.containsPartialData,
      };
      const contextId = asId(`norm_${createHash("sha256").update(JSON.stringify(canonicalWithoutId)).digest("hex").slice(0, 24)}`);
      const context: GoogleTrendsNormalizationContext = { id: contextId, ...canonicalWithoutId };
      const subjectId = input.subject.trim();
      const observations = result.observations.map((item) => createGoogleTrendsObservation({
        id: asId(`metric_${createHash("sha256").update(`${context.id}|${subjectId}|${item.observedAt}`).digest("hex").slice(0, 24)}`),
        subject: { kind: "search_term", externalId: subjectId, url: item.provenance.sourceRef },
        context,
        observedAt: item.observedAt,
        rawValue: item.rawValue,
        normalizedValue: item.normalizedValue,
        partial: item.partial,
        provenance: {
          collector: item.provenance.transport,
          collectorVersion: item.provenance.transportVersion,
          interface: item.provenance.authorizedInterface === "authorized_api" ? "google_trends_authorized_api"
            : item.provenance.authorizedInterface === "public_dataset" ? "google_trends_public_dataset" : "recorded_fixture",
          sourceRef: item.provenance.sourceRef,
          collectedAt: item.provenance.retrievedAt,
        },
      }));
      const seriesId = asId(`trend_google_${createHash("sha256").update(`${context.id}|${subjectId}`).digest("hex").slice(0, 24)}`);
      const built = buildGoogleTrendSeries(seriesId, context, observations);
      const event = classifySearchMomentum(built.series, new Map(built.observations.map((item) => [item.id, item])), { detectedAt: result.provenance.retrievedAt });
      const storage = this.openCanonical();
      try {
        commitQuantitative(storage, () => {
          storage.normalizationContexts.save(context);
          for (const observation of observations) storage.metricObservations.save(observation);
          storage.trendSeries.save(built.series);
          storage.trendEvents.append(event);
          storage.quantitativeSourceStatuses.save({ id: statusId, source: "google_trends", subjectExternalId: subjectId, status: "success", itemCount: observations.length, reason: null, checkedAt: result.provenance.retrievedAt, geography: context.geography, from: context.window.startAt, to: context.window.endAt, provenance: result.provenance });
          if (input.runSource) storage.sourceStatuses.save(input.runSource.runId, quantitativeSourceStatus({ ...input.runSource, itemCount: observations.length, artifactIds: [built.series.id, ...observations.map((item) => item.id)] }));
        });
      } finally {
        storage.close();
      }
      return { context, observations, series: built.series, event };
    } catch (error) {
      if (error instanceof QuantitativePersistenceError) throw error;
      const status = error instanceof GoogleTrendsSourceError ? error.status : "response_drift";
      const storage = this.openCanonical();
      try {
        commitQuantitative(storage, () => {
        storage.quantitativeSourceStatuses.save({ id: statusId, source: "google_trends", subjectExternalId: input.subject.trim(), status, itemCount: 0, reason: error instanceof Error ? error.message : String(error), checkedAt: new Date().toISOString(), geography: input.geography, from: input.from, to: input.to, retryAt: error instanceof GoogleTrendsSourceError ? error.retryAt : null });
        if (input.runSource) storage.sourceStatuses.save(input.runSource.runId, failedQuantitativeSourceStatus(input.runSource.id, input.runSource.source, error, input.runSource.startedAt));
        });
      } finally {
        storage.close();
      }
      throw error;
    }
  }

  async collectPackageDownloads(input: {
    ecosystem: PackageEcosystem;
    packageName: string;
    from: string;
    to: string;
    connector?: PackageDownloadsConnector;
    runSource?: RunSourceCheckpoint;
    now?: () => Date;
  }): Promise<{ observations: PackageDownloadObservation[]; series: PackageDownloadSeries; event: TrendEvent | null; missingDays: readonly string[]; coverageComplete: boolean }> {
    const canonicalName = canonicalizePackageName(input.ecosystem, input.packageName);
    const connector = input.connector ?? (input.ecosystem === "npm" ? createNpmDownloadsConnector() : createPyPiDownloadsConnector());
    const statusId = `package:${createHash("sha256").update(`${input.ecosystem}|${canonicalName}|${input.from}|${input.to}`).digest("hex").slice(0, 24)}`;
    const clock = input.now ?? (() => new Date());
    try {
      const collected = await connector.collect({ package: input.packageName, from: input.from, to: input.to });
      const missingDays = collected.missingDays ?? [];
      const coverageComplete = collected.coverageComplete ?? missingDays.length === 0;
      const observations = collected.buckets.map((item) => {
        const startAt = new Date(`${item.day}T00:00:00.000Z`);
        const endAt = new Date(startAt.getTime() + 86_400_000);
        const incomplete = endAt.getTime() > clock().getTime();
        return createPackageDownloadObservation({
          id: asId(`metric_${createHash("sha256").update(`${item.ecosystem}|${collected.package}|${startAt.toISOString()}|${endAt.toISOString()}|bucket_count_to_daily_rate_v1`).digest("hex").slice(0, 24)}`),
          ecosystem: item.ecosystem,
          packageName: collected.package,
          bucket: { startAt: startAt.toISOString(), endAt: endAt.toISOString(), resolution: "day", timezone: "UTC", coverageDays: 1, partial: incomplete },
          downloads: item.downloads,
          provenance: {
            collector: item.provenance.provider,
            collectorVersion: "1",
            interface: item.provenance.interface === "recorded_fixture" ? "recorded_fixture" : item.provenance.provider === "npm" ? "npm_downloads_api" : "pypistats_public_api",
            sourceRef: item.provenance.sourceRef,
            collectedAt: item.provenance.retrievedAt,
            caveat: [
              item.provenance.caveat,
              incomplete ? `Incomplete UTC day ${item.day}; excluded from momentum until the bucket ends` : null,
            ].filter(Boolean).join("; ") || null,
          },
        });
      });
      const subject = observations[0]!.subject;
      const storage = this.openCanonical();
      try {
        const existing = storage.metricObservations.list({ ecosystem: input.ecosystem, packageName: subject.canonicalName })
          .filter((item): item is PackageDownloadObservation => item.source === "npm_registry" || item.source === "pypi");
        const byId = new Map(observations.map((item) => [item.id, item]));
        for (const item of existing) byId.set(item.id, item);
        const ordered = [...byId.values()].sort((a, b) => a.bucket.startAt.localeCompare(b.bucket.startAt));
        const groups: PackageDownloadObservation[][] = [];
        for (const item of ordered) {
          const group = groups.at(-1);
          if (!group || group.at(-1)!.bucket.endAt !== item.bucket.startAt) groups.push([item]);
          else group.push(item);
        }
        const builtSeries = groups.map((group) => buildPackageDownloadSeries(
          asId(`trend_package_${createHash("sha256").update(`${subject.externalId}|day|UTC|${group[0]!.bucket.startAt}`).digest("hex").slice(0, 24)}`),
          group,
        ));
        const currentIds = new Set(observations.map((item) => item.id));
        const built = builtSeries.find((candidate) => candidate.observations.some((item) => currentIds.has(item.id)))!;
        const detectedAt = built.observations.map((item) => item.provenance.collectedAt).sort().at(-1) ?? collected.provenance.retrievedAt;
        const event = detectLatestPackageDownloadEvent(built.series, new Map(built.observations.map((item) => [item.id, item])), { detectedAt });
        const previousSeries = storage.trendSeries.list({ ecosystem: input.ecosystem, packageName: subject.canonicalName })
          .filter((item): item is PackageDownloadSeries => item.source === "npm_registry" || item.source === "pypi");
        const nextSeriesIds = new Set(builtSeries.map((item) => item.series.id));
        const coverageReason = missingDays.length > 0 ? `Incomplete coverage; missing days: ${missingDays.join(", ")}` : null;
        commitQuantitative(storage, () => {
          for (const observation of observations) storage.metricObservations.save(observation);
          for (const stale of previousSeries.filter((item) => !nextSeriesIds.has(item.id))) {
            storage.trendEvents.deleteBySeries(stale.id);
            storage.trendSeries.delete(stale.id);
          }
          for (const candidate of builtSeries) storage.trendSeries.save(candidate.series);
          if (event) storage.trendEvents.append(event);
          storage.quantitativeSourceStatuses.save({
            id: statusId,
            source: input.ecosystem === "npm" ? "npm_registry" : "pypi",
            subjectExternalId: subject.externalId,
            status: coverageComplete ? "success" : "partial",
            itemCount: observations.length,
            reason: coverageReason,
            checkedAt: collected.provenance.retrievedAt,
            ecosystem: input.ecosystem,
            packageName: subject.canonicalName,
            from: collected.from,
            to: collected.to,
            provenance: collected.provenance,
          });
          if (input.runSource) {
            storage.sourceStatuses.save(input.runSource.runId, quantitativeSourceStatus({
              ...input.runSource,
              status: coverageComplete ? "success" : "unavailable",
              itemCount: observations.length,
              reason: coverageReason,
              artifactIds: [built.series.id, ...built.series.observationIds],
            }));
          }
        });
        return { observations, series: built.series, event, missingDays, coverageComplete };
      } finally {
        storage.close();
      }
    } catch (error) {
      // Persistence failures must not erase connector-level diagnosis; callers may still salvage a partial report.
      if (error instanceof QuantitativePersistenceError) throw error;
      const status = error instanceof PackageDownloadsSourceError ? error.status : "response_drift";
      const storage = this.openCanonical();
      try {
        commitQuantitative(storage, () => {
        storage.quantitativeSourceStatuses.save({ id: statusId, source: input.ecosystem === "npm" ? "npm_registry" : "pypi", subjectExternalId: `${input.ecosystem}:${canonicalName}`, status, itemCount: 0, reason: error instanceof Error ? error.message : String(error), checkedAt: new Date().toISOString(), ecosystem: input.ecosystem, packageName: canonicalName, from: input.from, to: input.to, retryAt: error instanceof PackageDownloadsSourceError ? error.retryAt : null });
        if (input.runSource) storage.sourceStatuses.save(input.runSource.runId, failedQuantitativeSourceStatus(input.runSource.id, input.runSource.source, error, input.runSource.startedAt));
        });
      } finally {
        storage.close();
      }
      throw error;
    }
  }

  inspectPackageDownloads(input: { ecosystem: PackageEcosystem; packageName: string; from?: string; to?: string }): { observations: PackageDownloadObservation[]; series: PackageDownloadSeries[]; events: TrendEvent[]; sourceHealth: unknown[] } {
    const storage = this.openCanonical();
    try {
      const canonicalName = canonicalizePackageName(input.ecosystem, input.packageName);
      const fromAt = input.from ? new Date(`${input.from}T00:00:00.000Z`).toISOString() : null;
      const toExclusive = input.to ? new Date(Date.parse(`${input.to}T00:00:00.000Z`) + 86_400_000).toISOString() : null;
      const observations = storage.metricObservations.list({ ecosystem: input.ecosystem, packageName: canonicalName })
        .filter((item): item is PackageDownloadObservation => (item.source === "npm_registry" || item.source === "pypi") && (!fromAt || item.bucket.startAt >= fromAt) && (!toExclusive || item.bucket.endAt <= toExclusive));
      const canonicalSeries = storage.trendSeries.list({ ecosystem: input.ecosystem, packageName: canonicalName })
        .filter((item): item is PackageDownloadSeries => (item.source === "npm_registry" || item.source === "pypi") && (!fromAt || item.startedAt <= fromAt && item.endedAt > fromAt) && (!toExclusive || item.startedAt < toExclusive && item.endedAt >= toExclusive));
      const observationIds = new Set(observations.map((item) => item.id));
      const series = canonicalSeries.map((item) => buildPackageDownloadSeries(item.id, observations.filter((observation) => item.observationIds.includes(observation.id))).series);
      const events = canonicalSeries.flatMap((item) => storage.trendEvents.listBySeries(item.id)).filter((event) =>
        event.detector === "package_download_delta_v1" && observationIds.has(event.previousObservationId) && observationIds.has(event.currentObservationId),
      );
      return { observations, series, events, sourceHealth: storage.quantitativeSourceStatuses.list().filter((item) => item.ecosystem === input.ecosystem && item.packageName === canonicalName) };
    } finally {
      storage.close();
    }
  }

  async runMultiLaneResearch(briefRef: string, options: { fixtureSet?: "representative" | "google-throttled" | "github-unauthorized" | "npm-unavailable"; execution?: ResearchRunExecution; runId?: ResearchRunId; googleTrendsTransport?: GoogleTrendsTransport } = {}): Promise<StoredMultiLaneReportRecord> {
    const brief = await this.getBrief(briefRef);
    if (!brief) throw new Error(`Brief not found: ${briefRef}`);
    const stored = await this.runResearch(briefRef, { execution: options.execution, runId: options.runId });
    const fixture = options.fixtureSet !== undefined;
    const plan = brief.queryPlan?.quantitative ?? {};

    const independence = buildExactDuplicateIndependenceIndex(stored.documents.map((document) => ({
      documentId: document.id,
      content: document.rawBody,
      platform: document.platform,
      url: document.url,
    })));
    const groupByDocument = independence.independenceGroupByDocumentId;
    const admission = admitToLibrary(
      stored.drafts,
      new Map(stored.evidence.map((item) => [item.id, item])),
      new Map(stored.chunks.map((item) => [item.id, item])),
      new Map(stored.signals.map((item) => [item.id, item])),
      { independenceGroupByDocumentId: groupByDocument },
    );
    const canonicalAdmission = this.openCanonical();
    const retracted: Opportunity[] = [];
    try {
      canonicalAdmission.transaction(() => {
        canonicalAdmission.evidenceIndependence.saveIndex(stored.run.id, independence.records);
        const admittedIds = new Set(admission.admitted.map((item) => item.id));
        for (const existing of canonicalAdmission.opportunities.listByRun(stored.run.id)) {
          if (!admittedIds.has(existing.id)) retracted.push(existing);
          canonicalAdmission.opportunities.delete(stored.run.id, existing.id);
        }
        for (const opportunity of admission.admitted) canonicalAdmission.opportunities.save(stored.run.id, opportunity);
        for (const draft of stored.drafts) {
          const opportunity = admission.admitted.find((item) => item.id === `opp_${draft.id}`);
          const rejection = admission.rejected.find((item) => item.draftId === draft.id);
          canonicalAdmission.libraryAdmissionResults.save(stored.run.id, { id: draft.id, decision: opportunity ? "admitted" : "rejected", opportunityId: opportunity?.id ?? null, issues: rejection?.issues ?? [] });
        }
      });
      for (const opportunity of retracted) await canonicalAdmission.audit.append({
        at: new Date().toISOString(), actor: "system", action: "opportunity.reject", resource: opportunity.id,
        payload: { runId: stored.run.id, reason: "independence_recalculation", corrective: true },
      });
    } finally { canonicalAdmission.close(); }
    const previousStorage = this.openCanonical();
    const previousReport = previousStorage.multiLaneReports.getByRun(stored.run.id);
    const previousFollowUps = previousStorage.followUpProposals.listByRun(stored.run.id);
    previousStorage.close();
    const claims: ResearchClaim[] = [];
    const claimBuildFailures: string[] = [];
    for (const evidence of stored.evidence) {
      const lane: ResearchLane = evidence.supportsClaim === "wtp" ? "commercial_intent" : evidence.supportsClaim === "disconfirming" ? "contradictory_evidence" : "qualitative_demand";
      const document = stored.documents.find((item) => item.id === evidence.documentId);
      const url = (evidence.url?.trim() || document?.url?.trim() || "");
      if (!url || !evidence.chunkId?.trim()) {
        claimBuildFailures.push(`${evidence.id}: missing chunk/URL for text quote claim`);
        continue;
      }
      try {
        claims.push(buildResearchClaim({
          id: `claim_${stored.run.id}_${evidence.id}`,
          lane,
          statement: evidence.quoteVerbatim,
          status: lane === "contradictory_evidence" ? "contradicted" : "validated",
          evidenceRefs: [{ kind: "text_quote", evidenceItemId: evidence.id, chunkId: evidence.chunkId, documentId: evidence.documentId, url }],
          independentSourceGroupIds: groupByDocument.get(evidence.documentId) ? [groupByDocument.get(evidence.documentId)!] : [],
          limitations: evidence.url?.trim() ? [] : ["Claim URL recovered from source document because evidence.url was empty"],
        }));
      } catch (error) {
        claimBuildFailures.push(`${evidence.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    claims.push(...(previousReport?.claims.filter((claim) => !claim.evidenceRefs.some((ref) => ref.kind === "text_quote")) ?? []));
    const quantitativeSeries: TrendSeries[] = [...(previousReport?.seriesSnapshots ?? [])];
    const quantitativeObservations: MetricObservation[] = [...(previousReport?.observationSnapshots ?? [])];
    const githubStarObservations: Array<{ repository: string; observation: GitHubMetricObservation }> = [];
    const followUps: FollowUpHuntingTaskProposal[] = [...previousFollowUps];
    const sourceStatuses = new Map((stored.sourceStatuses ?? []).map((status) => [status.id, status]));
    if (claimBuildFailures.length > 0) {
      sourceStatuses.set("claim:build", quantitativeSourceStatus({
        id: "claim:build",
        source: "qualitative_claims",
        status: "unavailable",
        itemCount: claims.filter((claim) => claim.evidenceRefs.some((ref) => ref.kind === "text_quote")).length,
        reason: `Skipped ${claimBuildFailures.length} qualitative claim(s): ${claimBuildFailures.slice(0, 3).join("; ")}`,
        startedAt: stored.run.startedAt ?? new Date().toISOString(),
      }));
    }
    const previousArtifactIds = new Set<string>([...(previousReport?.seriesSnapshots.map((item) => item.id) ?? []), ...(previousReport?.observationSnapshots.map((item) => item.id) ?? [])]);
    const hasReportedCheckpoint = (requestKey: string): boolean => {
      const status = sourceStatuses.get(requestKey);
      return status?.status === "success" && (status.artifactIds?.length ?? 0) > 0 && status.artifactIds!.every((id) => previousArtifactIds.has(id));
    };
    const addObservations = (items: readonly MetricObservation[]): void => { for (const item of items) if (!quantitativeObservations.some((existing) => existing.id === item.id)) quantitativeObservations.push(item); };
    const addSeries = (series: TrendSeries): void => {
      if (!quantitativeSeries.some((item) => item.id === series.id)) quantitativeSeries.push(series);
      const snapshotStorage = this.openCanonical();
      try { addObservations(series.observationIds.flatMap((id) => snapshotStorage.metricObservations.get(id) ?? [])); }
      finally { snapshotStorage.close(); }
    };
    const addClaim = (claim: ResearchClaim): void => { if (!claims.some((item) => item.id === claim.id)) claims.push(claim); };
    const addFollowUp = (proposal: FollowUpHuntingTaskProposal): void => { if (!followUps.some((item) => item.id === proposal.id)) followUps.push(proposal); };

    for (const [index, request] of (plan.googleTrends ?? []).entries()) {
      const requestKey = `quant:google:${index}`;
      if (previousReport && hasReportedCheckpoint(requestKey)) continue;
      const startedAt = new Date().toISOString();
      try {
      const transport: GoogleTrendsTransport | undefined = fixture ? {
        async query(query) {
          if (options.fixtureSet === "google-throttled") throw new GoogleTrendsSourceError("throttled", "Recorded Google Trends throttling", "2026-01-11T00:00:00.000Z");
          const values = [10, 15, 22, 35, 55, 80];
          const start = Date.parse(query.from);
          const step = query.granularity === "week" ? 7 * 86_400_000 : 86_400_000;
          return { payload: { rows: values.map((value, index) => ({ time: new Date(start + index * step).toISOString(), value, partial: false })), comparisonSet: [query.subject], anchor: null }, provenance: { transport: "representative-fixture", transportVersion: "1", authorizedInterface: "recorded_fixture", sourceRef: "fixture://multi-lane/google", retrievedAt: query.to } };
        },
      } : options.googleTrendsTransport;
      const result = await this.collectGoogleTrends({ ...request, transport, runSource: { runId: stored.run.id, id: requestKey, source: "google_trends", startedAt } });
      addSeries(result.series); addObservations(result.observations);
      addClaim(buildResearchClaim({ id: `claim_${stored.run.id}_${result.series.id}`, lane: "trend_momentum", statement: `${request.subject}: ${result.event.kind}`, status: "unvalidated", evidenceRefs: [{ kind: "observation_series", seriesId: result.series.id, observationIds: result.series.observationIds }], independentSourceGroupIds: [], limitations: ["Search momentum is not validated demand"] }));
      if (["spike", "sustained_growth"].includes(result.event.kind)) addFollowUp(proposeFollowUpHuntingTask({ triggerEventId: result.event.id, triggerSeriesId: result.series.id, triggerKind: result.event.kind as "spike" | "sustained_growth", subject: request.subject }));
      sourceStatuses.set(requestKey, quantitativeSourceStatus({ id: requestKey, source: "google_trends", itemCount: result.observations.length, startedAt, artifactIds: [result.series.id, ...result.observations.map((item) => item.id)] }));
      } catch (error) {
        // Lane-level persistence failures must not abort the multi-lane report: record the
        // failed status and continue so successful lanes remain inspectable.
        const cause = error instanceof QuantitativePersistenceError ? error.original : error;
        sourceStatuses.set(requestKey, failedQuantitativeSourceStatus(requestKey, "google_trends", cause, startedAt));
      }
    }
    for (const [index, request] of (plan.github ?? []).entries()) {
      const requestKey = `quant:github:${index}`;
      if (previousReport && hasReportedCheckpoint(requestKey)) continue;
      const startedAt = new Date().toISOString();
      try {
      const connector: QuantitativeConnector | undefined = fixture ? {
        source: "github", async healthcheck() { return options.fixtureSet === "github-unauthorized" ? { ok: false, message: "401 unauthorized GitHub fixture" } : { ok: true }; }, async collect() {
          const observedAt = "2026-01-10T00:00:00.000Z";
          const provenance = { url: `https://api.github.com/repos/${request.repository}`, endpoint: "/repos/{owner}/{repo}", apiVersion: "2022-11-28", retrievedAt: observedAt };
          return [["github.repository.stars", 120], ["github.repository.forks", 18], ["github.repository.open_issues", 7], ["github.issue.opened", 4], ["github.issue.closed", 3], ["github.repository.contributors", 12]].map(([metric, value]) => ({ id: `metric_fixture_${String(metric).replace(/\W/g, "_")}`, subject: `github:${request.repository}`, source: "github", metric: String(metric), geography: null, observedAt, rawValue: Number(value), normalizedValue: Number(value), unit: "count" as const, collectionMethod: "authorized_public_api" as const, provenance }));
        },
      } : undefined;
      const result = await this.collectGithubMetrics({ subject: request.repository, since: request.since, connector, runSource: { runId: stored.run.id, id: requestKey, source: "github", startedAt } });
      addObservations(result.observations);
      const starObservation = result.observations.find((item): item is GitHubMetricObservation => item.source === "github" && item.metric === "stars");
      if (starObservation) githubStarObservations.push({ repository: request.repository, observation: starObservation });
      for (const series of result.series) {
        addSeries(series);
        addClaim(buildResearchClaim({ id: `claim_${stored.run.id}_${series.id}`, lane: "supply_competition", statement: `${request.repository} ${series.metric}: ${series.observationIds.length} observations`, status: "unvalidated", evidenceRefs: [{ kind: "observation_series", seriesId: series.id, observationIds: series.observationIds }], independentSourceGroupIds: [], limitations: ["GitHub popularity is not validated demand"] }));
      }
      sourceStatuses.set(requestKey, quantitativeSourceStatus({ id: requestKey, source: "github", itemCount: result.observations.length, startedAt, artifactIds: [...result.series.map((item) => item.id), ...result.observations.map((item) => item.id)] }));
      } catch (error) {
        const cause = error instanceof QuantitativePersistenceError ? error.original : error;
        sourceStatuses.set(requestKey, failedQuantitativeSourceStatus(requestKey, "github", cause, startedAt));
      }
    }
    const rankingUniverse = githubStarObservations.map((item) => item.repository).sort();
    try {
      for (const [index, item] of [...githubStarObservations].sort((a, b) => b.observation.normalizedValue - a.observation.normalizedValue || a.repository.localeCompare(b.repository)).entries()) {
        const rank = index + 1;
        const observation = createGitHubMetricObservation({
          id: asId(`metric_${stored.run.id}_${item.repository.replace(/\W/g, "_")}_brief_rank`),
          subject: { kind: "repository", externalId: `${item.repository.toLowerCase()}#brief:${stored.run.id}`, url: `https://github.com/${item.repository}` },
          metric: "trending_rank", geography: null, observedAt: item.observation.observedAt, rawValue: rank, normalizedValue: rank,
          provenance: { collector: "idea-finder-github-brief-ranking", collectorVersion: "1", interface: "github_rest_api", sourceRef: item.observation.provenance.sourceRef, collectedAt: item.observation.provenance.collectedAt },
        });
        const series = buildTrendSeries(asId(`trend_${stored.run.id}_${item.repository.replace(/\W/g, "_")}_brief_rank`), [observation]).series;
        const rankingStorage = this.openCanonical();
        try { rankingStorage.transaction(() => { rankingStorage.metricObservations.save(observation); rankingStorage.trendSeries.save(series); }); } finally { rankingStorage.close(); }
        addObservations([observation]); addSeries(series);
        addClaim(buildResearchClaim({
          id: `claim_${stored.run.id}_${series.id}_ranking`, lane: "supply_competition",
          statement: `${item.repository} star rank: ${rank} of ${rankingUniverse.length} in Brief comparison universe [${rankingUniverse.join(", ")}]`,
          status: "unvalidated", evidenceRefs: [{ kind: "ranking_snapshot", observationId: observation.id, sourceUrl: observation.provenance.sourceRef }],
          independentSourceGroupIds: [], limitations: ["Brief-relative star ranking is supply evidence, not validated demand"],
        }));
      }
    } catch (error) {
      sourceStatuses.set("quant:github:ranking", failedQuantitativeSourceStatus("quant:github:ranking", "github", error, new Date().toISOString()));
    }
    for (const [index, request] of (plan.packages ?? []).entries()) {
      const requestKey = `quant:${request.ecosystem}:${index}`;
      if (previousReport && hasReportedCheckpoint(requestKey)) continue;
      const startedAt = new Date().toISOString();
      try {
      const connector: PackageDownloadsConnector | undefined = fixture ? {
        ecosystem: request.ecosystem, async collect(query) {
          if (options.fixtureSet === "npm-unavailable" && request.ecosystem === "npm") throw new PackageDownloadsSourceError("unavailable_history", "Recorded npm unavailable history");
          const start = Date.parse(`${query.from}T00:00:00.000Z`); const end = Date.parse(`${query.to}T00:00:00.000Z`);
          const provenance = { provider: "fixture" as const, interface: "recorded_fixture" as const, sourceRef: `fixture://multi-lane/${request.ecosystem}`, retrievedAt: "2026-01-10T00:00:00.000Z", caveat: "Recorded representative fixture" };
          const days = Array.from({ length: Math.floor((end - start) / 86_400_000) + 1 }, (_, index) => new Date(start + index * 86_400_000).toISOString().slice(0, 10));
          return {
            ecosystem: request.ecosystem,
            package: query.package,
            from: query.from,
            to: query.to,
            provenance,
            buckets: days.map((day) => ({ id: `fixture_${request.ecosystem}_${day}`, ecosystem: request.ecosystem, package: query.package, subject: `${request.ecosystem}:${query.package}`, day, downloads: Number(day.slice(-2)) * 100, provenance })),
            missingDays: [],
            coverageComplete: true,
          };
        },
      } : undefined;
      const result = await this.collectPackageDownloads({
        ecosystem: request.ecosystem,
        packageName: request.package,
        from: request.from,
        to: request.to,
        connector,
        runSource: { runId: stored.run.id, id: requestKey, source: request.ecosystem, startedAt },
        now: fixture ? () => new Date("2026-01-11T00:00:00.000Z") : undefined,
      });
      addSeries(result.series); addObservations(result.observations);
      addClaim(buildResearchClaim({ id: `claim_${stored.run.id}_${result.series.id}`, lane: "supply_competition", statement: `${request.ecosystem}:${request.package} download momentum`, status: "unvalidated", evidenceRefs: [{ kind: "observation_series", seriesId: result.series.id, observationIds: result.series.observationIds }], independentSourceGroupIds: [], limitations: ["Download momentum is not validated demand", ...(request.ecosystem === "pypi" ? ["pypistats is a third-party public API"] : []), ...(result.missingDays.length ? [`Incomplete coverage; missing days: ${result.missingDays.join(", ")}`] : [])] }));
      sourceStatuses.set(requestKey, quantitativeSourceStatus({
        id: requestKey,
        source: request.ecosystem,
        status: result.coverageComplete ? "success" : "unavailable",
        itemCount: result.observations.length,
        reason: result.missingDays.length ? `Incomplete coverage; missing days: ${result.missingDays.join(", ")}` : null,
        startedAt,
        artifactIds: [result.series.id, ...result.series.observationIds],
      }));
      } catch (error) {
        const cause = error instanceof QuantitativePersistenceError ? error.original : error;
        sourceStatuses.set(requestKey, failedQuantitativeSourceStatus(requestKey, request.ecosystem, cause, startedAt));
      }
    }

    const candidateFor = (kind: string, selected: ResearchClaim[], series: TrendSeries[]): MultiLaneCandidate => evaluateMultiLaneCandidate({ id: `candidate_${stored.run.id}_${kind}`, subject: brief.title, claims: selected, qualitativeEvidenceItemIds: [], quantitativeSeriesIds: series.map((item) => item.id), independentQualitativeSourceGroupIds: [] });
    const trendClaims = claims.filter((claim) => claim.lane === "trend_momentum");
    const rankingClaims = claims.filter((claim) => claim.evidenceRefs.some((ref) => ref.kind === "ranking_snapshot"));
    const starClaims = claims.filter((claim) => claim.statement.includes(" stars:"));
    const downloadClaims = claims.filter((claim) => claim.statement.includes("download momentum"));
    const candidates = [
      candidateFor("trend_only", trendClaims, quantitativeSeries.filter((series) => series.source === "google_trends")),
      candidateFor("ranking_only", rankingClaims, []),
      candidateFor("star_only", starClaims, quantitativeSeries.filter((series) => series.source === "github" && series.metric === "stars")),
      candidateFor("download_only", downloadClaims, quantitativeSeries.filter((series) => series.source === "npm_registry" || series.source === "pypi")),
    ];
    const summary = buildMultiLaneSummary({ briefId: brief.id, runId: stored.run.id, claims, candidates, followUpProposalIds: followUps.map((item) => item.id) });
    const report: StoredMultiLaneReportRecord = { id: stored.run.id, runId: stored.run.id, briefId: brief.id, summary, claims, candidateIds: candidates.map((item) => item.id), seriesSnapshots: quantitativeSeries, observationSnapshots: quantitativeObservations };
    const canonical = this.openCanonical();
    try {
      canonical.transaction(() => {
        for (const status of sourceStatuses.values()) canonical.sourceStatuses.save(stored.run.id, status);
        const incompleteStatuses = [...sourceStatuses.values()].filter((status) => status.status !== "success");
        // Preserve qualitative pipeline failure; quantitative lane outcomes must not
        // silently promote a failed ResearchRun to partial/completed.
        const nextStatus = stored.run.status === "failed"
          ? "failed"
          : incompleteStatuses.length > 0 ? "partial" : "completed";
        const nextError = stored.run.status === "failed"
          ? stored.run.errorMessage
          : incompleteStatuses.length > 0
            ? incompleteStatuses.map((status) => `${status.source}: ${status.reason ?? status.reasonCode}`).join("; ")
            : null;
        canonical.researchRuns.save({ ...stored.run, status: nextStatus, completedAt: new Date().toISOString(), errorMessage: nextError });
        for (const proposal of followUps) if (!canonical.followUpProposals.get(stored.run.id, proposal.id)) canonical.followUpProposals.save(stored.run.id, proposal);
        canonical.multiLaneReports.save(report);
      });
    } finally { canonical.close(); }
    return report;
  }

  listResearchSourceStatuses(runId: ResearchRunId): ResearchSourceStatus[] {
    const storage = this.openCanonical();
    try { return storage.sourceStatuses.listByRun(runId) as ResearchSourceStatus[]; }
    finally { storage.close(); }
  }

  inspectMultiLaneResearch(runId: ResearchRunId, claimId?: string): { report: StoredMultiLaneReportRecord; claims: ResearchClaim[]; details: unknown[]; independence: unknown[]; proposals: FollowUpHuntingTaskProposal[] } {
    const storage = this.openCanonical();
    try {
      const report = storage.multiLaneReports.getByRun(runId);
      if (!report) throw new Error(`Multi-lane report not found: ${runId}`);
      const claims = claimId ? report.claims.filter((claim) => claim.id === claimId) : [...report.claims];
      if (claimId && claims.length === 0) throw new Error(`Research claim not found: ${claimId}`);
      const details = claims.flatMap((claim) => claim.evidenceRefs.map((ref) => {
        if (ref.kind === "text_quote") return { claimId: claim.id, ref, evidence: storage.evidenceItems.get(runId, ref.evidenceItemId), chunk: storage.chunks.get(runId, ref.chunkId), document: storage.rawDocuments.get(runId, ref.documentId) };
        if (ref.kind === "observation_series") return { claimId: claim.id, ref, series: report.seriesSnapshots.find((item) => item.id === ref.seriesId) ?? null, observations: ref.observationIds.map((id) => report.observationSnapshots.find((item) => item.id === id) ?? null) };
        if (ref.kind === "ranking_snapshot") return { claimId: claim.id, ref, observation: report.observationSnapshots.find((item) => item.id === ref.observationId) ?? null };
        return { claimId: claim.id, ref };
      }));
      return { report, claims, details, independence: storage.evidenceIndependence.listByRun(runId), proposals: storage.followUpProposals.listByRun(runId) };
    } finally { storage.close(); }
  }

  async createFollowUpBrief(runId: ResearchRunId, proposalId: string, slug: string): Promise<HuntingBrief> {
    await this.migrateLegacyBriefs();
    const storage = this.openCanonical();
    try {
      const proposal = storage.followUpProposals.get(runId, proposalId);
      if (!proposal) throw new Error(`Follow-up proposal not found: ${proposalId}`);
      if (proposal.status === "created") {
        const existing = storage.huntingBriefs.get(proposal.createdBriefId! as string) as HuntingBrief | null;
        if (!existing || existing.slug !== slug) throw new Error(`Follow-up proposal already created as ${proposal.createdBriefId}`);
        return existing;
      }
      const brief: HuntingBrief = {
        id: asId<HuntingTaskId>(`task_${slug}`), slug, title: `Follow-up: ${proposal.subject}`,
        description: `Investigate demand behind trend anomaly for ${proposal.subject}`,
        lenses: [...proposal.suggestedLenses], sourcesEnabled: ["hn", "stack_exchange"],
        successCriteria: "Independent qualitative pain, workaround, competition, and commercial-intent evidence",
        createdAt: new Date().toISOString(),
        queryPlan: { harvestMode: "l0", searches: [
          { platform: "hn", terms: [proposal.subject, "pain", "workaround", "alternative"] },
          { platform: "stack_exchange", terms: [proposal.subject, "problem", "tool"] },
        ] },
        origin: { kind: "trend_anomaly", parentRunId: runId, trendEventId: proposal.triggerEventId, trendSeriesId: proposal.triggerSeriesId },
      };
      const createdProposal: FollowUpHuntingTaskProposal = { ...proposal, status: "created", createdBriefId: brief.id, createdAt: brief.createdAt };
      storage.transaction(() => {
        if (storage.huntingBriefs.list().some((item) => item.id === brief.id || item.slug === brief.slug)) throw new Error(`Brief already exists: ${slug}`);
        storage.huntingBriefs.save(brief);
        storage.followUpProposals.save(runId, createdProposal);
      });
      return brief;
    } finally { storage.close(); }
  }

  listMetricObservations(subjectExternalId?: string, metric?: GitHubMetric): MetricObservation[] {
    const storage = this.openCanonical();
    try {
      return storage.metricObservations.list({ subjectExternalId, metric });
    } finally {
      storage.close();
    }
  }

  listTrendSeries(subjectExternalId?: string, metric?: GitHubMetric): TrendSeries[] {
    const storage = this.openCanonical();
    try {
      return storage.trendSeries.list({ subjectExternalId, metric });
    } finally {
      storage.close();
    }
  }

  listTrendEvents(subjectExternalId?: string, metric?: GitHubMetric): TrendEvent[] {
    const storage = this.openCanonical();
    try {
      return storage.trendSeries.list({ subjectExternalId, metric })
        .flatMap((series) => storage.trendEvents.listBySeries(series.id));
    } finally {
      storage.close();
    }
  }

  listQuantitativeSourceStatuses(): unknown[] {
    const storage = this.openCanonical();
    try {
      return storage.quantitativeSourceStatuses.list();
    } finally {
      storage.close();
    }
  }

  inspectGoogleTrends(input: { subject?: string; geography?: string; from?: string; to?: string } = {}): {
    contexts: GoogleTrendsNormalizationContext[];
    observations: GoogleTrendsMetricObservation[];
    series: GoogleTrendsSeries[];
    events: TrendEvent[];
    sourceHealth: unknown[];
  } {
    const storage = this.openCanonical();
    try {
      const contexts = storage.normalizationContexts.list().filter((context) =>
        (!input.geography || context.geography === input.geography.toUpperCase())
        && (!input.from || context.window.startAt === new Date(input.from).toISOString())
        && (!input.to || context.window.endAt === new Date(input.to).toISOString()),
      );
      const contextIds = new Set(contexts.map((context) => context.id));
      const observations = storage.metricObservations.list({ source: "google_trends", subjectExternalId: input.subject, geography: input.geography?.toUpperCase() })
        .filter((item): item is GoogleTrendsMetricObservation => item.source === "google_trends" && contextIds.has(item.normalizationContextId));
      const series = storage.trendSeries.list({ source: "google_trends", subjectExternalId: input.subject, geography: input.geography?.toUpperCase() })
        .filter((item): item is GoogleTrendsSeries => item.source === "google_trends" && contextIds.has(item.normalizationContextId));
      return {
        contexts,
        observations,
        series,
        events: series.flatMap((item) => storage.trendEvents.listBySeries(item.id)),
        sourceHealth: storage.quantitativeSourceStatuses.list().filter((status) => status.source === "google_trends" && (!input.subject || status.subjectExternalId === input.subject)),
      };
    } finally {
      storage.close();
    }
  }

  opportunitiesForRun(state: WorkspaceState, runId: ResearchRunId): Opportunity[] {
    const run = state.runs.find((r) => r.run.id === runId);
    if (!run) return [];
    if (run.opportunities) return [...run.opportunities];
    const ids = new Set(run.drafts.map((draft) => `opp_${draft.id}`));
    return Object.values(state.opportunities).filter((opportunity) => ids.has(opportunity.id));
  }

  async compareMonitorDiff(input: {
    briefSlugOrId: string;
    baselineRunId: ResearchRunId;
    compareRunId: ResearchRunId;
  }): Promise<MonitorDiff> {
    await this.migrateLegacyDecisionState();
    const brief = await this.getBrief(input.briefSlugOrId);
    if (!brief) {
      throw new Error(`Brief not found: ${input.briefSlugOrId}`);
    }

    const state = await this.getState();
    const baselineRun = state.runs.find((r) => r.run.id === input.baselineRunId);
    const compareRun = state.runs.find((r) => r.run.id === input.compareRunId);
    if (!baselineRun || baselineRun.briefId !== brief.id) {
      throw new Error(`Baseline run not found for brief: ${input.baselineRunId}`);
    }
    if (!compareRun || compareRun.briefId !== brief.id) {
      throw new Error(`Compare run not found for brief: ${input.compareRunId}`);
    }

    const expectedSourceStatuses = mergeMapsByRequestKey(baselineRun.sourceStatuses ?? [], compareRun.sourceStatuses ?? []);
    const diff = buildMonitorDiff({
      baselineRunId: input.baselineRunId,
      compareRunId: input.compareRunId,
      baselineOpportunities: this.opportunitiesForRun(state, input.baselineRunId),
      compareOpportunities: this.opportunitiesForRun(state, input.compareRunId),
      baselineEvidence: new Map(baselineRun.evidence.map((item) => [item.id, item])),
      compareEvidence: new Map(compareRun.evidence.map((item) => [item.id, item])),
      baselineCoverage: monitorCoverage(baselineRun.sourceStatuses ?? [], expectedSourceStatuses),
      compareCoverage: monitorCoverage(compareRun.sourceStatuses ?? [], expectedSourceStatuses),
      thresholds: (await this.getMonitorSchedule(input.briefSlugOrId))?.thresholds ?? DEFAULT_MONITOR_THRESHOLDS,
    });

    const storage = this.openCanonical();
    try {
      const comparison = {
        id: `moncmp_${randomUUID()}`,
        briefId: brief.id,
        baselineRunId: input.baselineRunId,
        compareRunId: input.compareRunId,
        diff,
        createdAt: new Date().toISOString(),
      };
      storage.monitorComparisons.save(comparison);
    } finally {
      storage.close();
    }

    return diff;
  }

  async invokeMonitor(input: {
    briefSlugOrId: string;
    fixtureSet?: "representative" | "google-throttled" | "github-unauthorized" | "npm-unavailable";
    googleTrendsTransport?: GoogleTrendsTransport;
  }): Promise<{ schedule: MonitorSchedule; run: StoredResearchRun; baselineRunId: ResearchRunId | null; comparison: { id: string; diff: MonitorDiff } | null; sourceStatuses: readonly ResearchSourceStatus[] }> {
    const brief = await this.getBrief(input.briefSlugOrId);
    if (!brief) throw new Error(`Brief not found: ${input.briefSlugOrId}`);
    const schedule = await this.getMonitorSchedule(brief.id);
    if (!schedule) throw new Error(`Monitor schedule not found for brief: ${input.briefSlugOrId}`);
    if (!schedule.enabled) throw new Error(`Monitor schedule disabled for brief: ${input.briefSlugOrId}`);
    const baselineRunId = schedule.lastComparedRunId;
    const hasQuantitativePlan = Boolean(brief.queryPlan?.quantitative);
    const freshRunId = hasQuantitativePlan
      ? (await this.runMultiLaneResearch(brief.id, { fixtureSet: input.fixtureSet, execution: "new", googleTrendsTransport: input.googleTrendsTransport })).runId
      : (await this.runResearch(brief.id, { execution: "new" })).run.id;
    if (freshRunId === baselineRunId) throw new Error("Monitor invocation must create a distinct ResearchRun");
    const state = await this.getState();
    const freshRun = state.runs.find((item) => item.run.id === freshRunId)!;
    const baselineRun = baselineRunId ? state.runs.find((item) => item.run.id === baselineRunId) : null;
    if (baselineRunId && (!baselineRun || baselineRun.briefId !== brief.id)) throw new Error(`Monitor baseline run not found for brief: ${baselineRunId}`);
    const expectedSourceStatuses = baselineRun ? mergeMapsByRequestKey(baselineRun.sourceStatuses ?? [], freshRun.sourceStatuses ?? []) : [];
    const diff = baselineRun ? buildMonitorDiff({
      baselineRunId: baselineRun.run.id, compareRunId: freshRun.run.id,
      baselineOpportunities: baselineRun.opportunities, compareOpportunities: freshRun.opportunities,
      baselineEvidence: new Map(baselineRun.evidence.map((item) => [item.id, item])),
      compareEvidence: new Map(freshRun.evidence.map((item) => [item.id, item])),
      baselineCoverage: monitorCoverage(baselineRun.sourceStatuses ?? [], expectedSourceStatuses), compareCoverage: monitorCoverage(freshRun.sourceStatuses ?? [], expectedSourceStatuses),
      thresholds: schedule.thresholds ?? DEFAULT_MONITOR_THRESHOLDS,
    }) : null;
    const comparison = diff ? { id: `moncmp_${randomUUID()}`, diff } : null;
    const invokedAt = new Date().toISOString();
    const storage = this.openCanonical();
    let nextSchedule: MonitorSchedule;
    try {
      storage.transaction(() => {
        const current = storage.monitorSchedules.get(schedule.id) as MonitorSchedule | null;
        if (!current || current.lastComparedRunId !== baselineRunId) throw new Error(`Monitor schedule cursor conflict for ${schedule.id}`);
        nextSchedule = { ...current, lastComparedRunId: freshRun.run.id, lastInvokedAt: invokedAt, updatedAt: invokedAt, thresholds: current.thresholds ?? DEFAULT_MONITOR_THRESHOLDS };
        if (comparison) storage.monitorComparisons.save({ id: comparison.id, briefId: brief.id, baselineRunId: baselineRunId!, compareRunId: freshRun.run.id, diff, createdAt: invokedAt });
        storage.monitorSchedules.save(nextSchedule);
      });
    } finally { storage.close(); }
    return { schedule: nextSchedule!, run: freshRun, baselineRunId, comparison, sourceStatuses: freshRun.sourceStatuses ?? [] };
  }

  async getMonitorSchedule(briefSlugOrId: string): Promise<MonitorSchedule | null> {
    await this.migrateLegacyDecisionState();
    const brief = await this.getBrief(briefSlugOrId);
    if (!brief) return null;
    const storage = this.openCanonical();
    try {
      return storage.monitorSchedules.get(asId(`mon_${brief.id}`)) as MonitorSchedule | null;
    } finally {
      storage.close();
    }
  }

  async setMonitorSchedule(input: {
    briefSlugOrId: string;
    cadence: MonitorCadence;
    enabled?: boolean;
    thresholds?: Partial<MonitorThresholds>;
  }): Promise<MonitorSchedule> {
    await this.migrateLegacyDecisionState();
    const brief = await this.getBrief(input.briefSlugOrId);
    if (!brief) {
      throw new Error(`Brief not found: ${input.briefSlugOrId}`);
    }
    if (input.thresholds && Object.values(input.thresholds).some((value) => value !== undefined && (!Number.isInteger(value) || value <= 0))) throw new Error("Monitor thresholds must be positive integers");

    const scheduleId = asId(`mon_${brief.id}`);
    const storage = this.openCanonical();
    try {
      const existing = storage.monitorSchedules.get(scheduleId) as MonitorSchedule | null;
      const schedule: MonitorSchedule = {
        id: scheduleId,
        briefId: brief.id,
        cadence: input.cadence,
        lastComparedRunId: existing?.lastComparedRunId ?? null,
        enabled: input.enabled ?? existing?.enabled ?? true,
        createdAt: existing?.createdAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastInvokedAt: existing?.lastInvokedAt ?? null,
        thresholds: { ...DEFAULT_MONITOR_THRESHOLDS, ...(existing?.thresholds ?? {}), ...(input.thresholds ?? {}) },
      };
      storage.monitorSchedules.save(schedule);
      return schedule;
    } finally {
      storage.close();
    }
  }
}
