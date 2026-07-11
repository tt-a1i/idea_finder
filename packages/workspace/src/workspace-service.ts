import {
  applyCalibration,
  asId,
  completeValidationExperiment as applyValidationCompletion,
  computeMonitorDiff as buildMonitorDiff,
  createValidationExperiment as buildValidationExperiment,
  startValidationExperiment as markValidationExperimentRunning,
} from "@idea-finder/core";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openLocalStorage, type LocalStorage } from "@idea-finder/storage";
import type {
  ActorKind,
  CalibrationAction,
  CalibrationEvent,
  Chunk,
  EvidenceItem,
  HuntingTaskId,
  MonitorCadence,
  MonitorDiff,
  MonitorSchedule,
  Opportunity,
  RawSignal,
  ResearchRunId,
  ValidationExperiment,
  ValidationExperimentType,
  ValidationOutcome,
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

function mergeMaps<T extends { id: string }>(
  existing: Readonly<Record<string, T>>,
  items: readonly T[],
): Record<string, T> {
  const next = { ...existing };
  for (const item of items) {
    next[item.id] = item;
  }
  return next;
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

function toEvidenceMap(
  record: Readonly<Record<string, EvidenceItem>>,
): ReadonlyMap<EvidenceItem["id"], EvidenceItem> {
  return new Map(Object.entries(record) as [EvidenceItem["id"], EvidenceItem][]);
}

function toChunkMap(
  record: Readonly<Record<string, Chunk>>,
): ReadonlyMap<Chunk["id"], Chunk> {
  return new Map(Object.entries(record) as [Chunk["id"], Chunk][]);
}

function toSignalMap(
  record: Readonly<Record<string, RawSignal>>,
): ReadonlyMap<RawSignal["id"], RawSignal> {
  return new Map(Object.entries(record) as [RawSignal["id"], RawSignal][]);
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

    const storage = this.openCanonical();
    try {
      storage.researchRuns.save(run);
      storage.researchRunConfigs.save(output.config);
      for (const document of output.documents) storage.rawDocuments.save(run.id, document);
      for (const chunk of output.chunks) storage.chunks.save(run.id, chunk);
      for (const signal of output.signals) storage.rawSignals.save(run.id, signal);
      for (const evidence of output.evidence) storage.evidenceItems.save(run.id, evidence);
      for (const draft of output.drafts) storage.opportunityDrafts.save(run.id, draft);
      for (const opportunity of output.opportunities) storage.opportunities.save(run.id, opportunity);
      for (const result of output.admissionResults) storage.libraryAdmissionResults.save(run.id, result);
      for (const status of output.sourceStatuses) storage.sourceStatuses.save(run.id, status);
    } finally {
      storage.close();
    }

    const rejected = output.admissionResults
      .filter((result) => result.decision === "rejected")
      .map((result) => ({
        draftId: result.id as never,
        draft: output.drafts.find((draft) => draft.id === result.id)!,
        issues: [...result.issues],
      }));

    const completedRun: StoredResearchRun = {
      execution: output.execution,
      run,
      briefId: brief.id,
      documents: output.documents,
      chunks: output.chunks,
      signals: output.signals,
      evidence: output.evidence,
      drafts: output.drafts,
      opportunities: output.opportunities,
      rejected,
      admissionResults: output.admissionResults,
      sourceStatuses: output.sourceStatuses,
      admittedCount: output.opportunities.length,
      inbox: summarizeInbox(output.signals),
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

    const diff = buildMonitorDiff({
      baselineRunId: input.baselineRunId,
      compareRunId: input.compareRunId,
      baselineOpportunities: this.opportunitiesForRun(state, input.baselineRunId),
      compareOpportunities: this.opportunitiesForRun(state, input.compareRunId),
    });

    const scheduleId = asId(`mon_${brief.id}`);
    const storage = this.openCanonical();
    try {
      const existing = storage.monitorSchedules.get(scheduleId) as MonitorSchedule | null;
      const schedule: MonitorSchedule = existing ?? {
        id: scheduleId,
        briefId: brief.id,
        cadence: "manual",
        lastComparedRunId: input.compareRunId,
        enabled: true,
        createdAt: new Date().toISOString(),
      };
      const nextSchedule = { ...schedule, lastComparedRunId: input.compareRunId };
      const comparison = {
        id: `moncmp_${randomUUID()}`,
        briefId: brief.id,
        baselineRunId: input.baselineRunId,
        compareRunId: input.compareRunId,
        diff,
        createdAt: new Date().toISOString(),
      };
      storage.transaction(() => {
        storage.monitorSchedules.save(nextSchedule);
        storage.monitorComparisons.save(comparison);
      });
    } finally {
      storage.close();
    }

    return diff;
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
  }): Promise<MonitorSchedule> {
    await this.migrateLegacyDecisionState();
    const brief = await this.getBrief(input.briefSlugOrId);
    if (!brief) {
      throw new Error(`Brief not found: ${input.briefSlugOrId}`);
    }

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
      };
      storage.monitorSchedules.save(schedule);
      return schedule;
    } finally {
      storage.close();
    }
  }
}
