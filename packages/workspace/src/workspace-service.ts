import {
  admitToLibrary,
  applyCalibration,
  asId,
  completeValidationExperiment as applyValidationCompletion,
  computeMonitorDiff as buildMonitorDiff,
  createValidationExperiment as buildValidationExperiment,
  startValidationExperiment as markValidationExperimentRunning,
} from "@idea-finder/core";
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
import type { ResearchRunner } from "./ports/research-runner.js";
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
  WorkspaceState,
} from "./types.js";
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
  private readonly runner: ResearchRunner;
  private readonly runFactory = createResearchRunFactory();
  private readonly agentRunner = new AgentTaskRunner();

  constructor(options: WorkspaceServiceOptions) {
    this.store = createWorkspaceStore(options.paths);
    this.runner =
      options.runner ??
      createDefaultResearchRunner(
        options.runnerMode ?? "fixture",
        options.paths.root,
      );
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
    await this.store.saveBrief(brief);
    return brief;
  }

  async listBriefs(): Promise<HuntingBrief[]> {
    return this.store.listBriefs();
  }

  async getBrief(slugOrId: string): Promise<HuntingBrief | null> {
    return this.store.getBrief(slugOrId);
  }

  async runResearch(
    slugOrId: string,
    options?: { readonly runner?: ResearchRunner },
  ): Promise<StoredResearchRun> {
    const brief = await this.store.getBrief(slugOrId);
    if (!brief) {
      throw new Error(`Brief not found: ${slugOrId}`);
    }

    const runner = options?.runner ?? this.runner;
    const pendingRun = this.runFactory.createResearchRun(brief);
    const output = await runner.run(brief, pendingRun.id, brief.id);
    const run = output.run;

    const evidenceById = new Map(output.evidence.map((e) => [e.id, e]));
    const chunksById = new Map(output.chunks.map((c) => [c.id, c]));
    const signalsById = new Map(output.signals.map((s) => [s.id, s]));

    const { admitted, rejected } = admitToLibrary(
      output.drafts,
      evidenceById,
      chunksById,
      signalsById,
    );

    const completedRun: StoredResearchRun = {
      run: {
        ...run,
        status: run.status === "completed" ? "completed" : "completed",
        completedAt: run.completedAt ?? new Date().toISOString(),
      },
      briefId: brief.id,
      chunks: output.chunks,
      signals: output.signals,
      evidence: output.evidence,
      drafts: output.drafts,
      rejected,
      admittedCount: admitted.length,
      inbox: summarizeInbox(output.signals),
    };

    const state = await this.store.loadState();
    const nextOpportunities = { ...state.opportunities };
    for (const opp of admitted) {
      nextOpportunities[opp.id] = opp;
    }

    const nextState: WorkspaceState = {
      ...state,
      runs: [...state.runs, completedRun],
      opportunities: nextOpportunities,
      evidenceById: mergeMaps(state.evidenceById, output.evidence),
      chunksById: mergeMaps(state.chunksById, output.chunks),
      signalsById: mergeMaps(state.signalsById, output.signals),
    };

    await this.store.saveState(nextState);
    return completedRun;
  }

  async getState(): Promise<WorkspaceState> {
    return this.store.loadState();
  }

  async getInboxSummary(briefSlugOrId?: string): Promise<{
    runId: string | null;
    inbox: InboxSignalSummary[];
  }> {
    const state = await this.store.loadState();
    let runs = [...state.runs];
    if (briefSlugOrId) {
      const brief = await this.store.getBrief(briefSlugOrId);
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
    const state = await this.store.loadState();
    let briefId: HuntingTaskId | null = null;
    if (briefSlugOrId) {
      const brief = await this.store.getBrief(briefSlugOrId);
      if (!brief) throw new Error(`Brief not found: ${briefSlugOrId}`);
      briefId = brief.id;
    }

    const runOppIds = new Set<string>();
    if (briefId) {
      for (const run of state.runs) {
        if (run.briefId !== briefId) continue;
        for (const draft of run.drafts) {
          runOppIds.add(`opp_${draft.id}`);
        }
      }
    }

    const opps = Object.values(state.opportunities);
    const filtered =
      briefId === null
        ? opps
        : opps.filter((o) => runOppIds.has(o.id) || state.runs.some(
            (r) =>
              r.briefId === briefId &&
              r.drafts.some((d) => `opp_${d.id}` === o.id),
          ));

    return filtered.sort((a, b) => a.demandStatement.localeCompare(b.demandStatement));
  }

  async applyBoardCalibration(input: {
    opportunityId: string;
    action: CalibrationAction;
    note?: string | null;
    actor?: ActorKind;
  }): Promise<{ opportunity: Opportunity; event: CalibrationEvent }> {
    const state = await this.store.loadState();
    const opportunity = state.opportunities[input.opportunityId];
    if (!opportunity) {
      throw new Error(`Opportunity not found: ${input.opportunityId}`);
    }

    const validationContext = {
      evidenceById: toEvidenceMap(state.evidenceById),
      chunksById: toChunkMap(state.chunksById),
      signalsById: toSignalMap(state.signalsById),
    };

    const result = applyCalibration(
      opportunity,
      input.action,
      input.note ?? null,
      input.actor ?? "user",
      undefined,
      input.action === "promote" ? validationContext : undefined,
    );

    const nextState: WorkspaceState = {
      ...state,
      opportunities: {
        ...state.opportunities,
        [result.opportunity.id]: result.opportunity,
      },
      calibrationEvents: [...state.calibrationEvents, result.event],
    };

    await this.store.saveState(nextState);
    return result;
  }

  async listAgentTasks(): Promise<AgentTask[]> {
    const state = await this.store.loadState();
    return Object.values(state.agentTasks ?? {}).sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt),
    );
  }

  async getAgentTask(taskId: string): Promise<AgentTask | null> {
    const state = await this.store.loadState();
    return state.agentTasks?.[taskId] ?? null;
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
    const taskId = `agent_${input.kind}_${Date.now()}`;
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

    const state = await this.store.loadState();
    const nextState: WorkspaceState = {
      ...state,
      agentTasks: {
        ...(state.agentTasks ?? {}),
        [task.id]: task,
      },
    };
    await this.store.saveState(nextState);
    return task;
  }

  async runAgentTask(taskId: string): Promise<AgentTask> {
    const state = await this.store.loadState();
    const existing = state.agentTasks?.[taskId];
    if (!existing) {
      throw new Error(`Agent task not found: ${taskId}`);
    }

    const running: AgentTask = {
      ...existing,
      status: "running",
      updatedAt: new Date().toISOString(),
    };
    await this.store.saveState({
      ...state,
      agentTasks: { ...(state.agentTasks ?? {}), [taskId]: running },
    });

    const { task: completed } = await this.agentRunner.runTask(running);
    const latest = await this.store.loadState();
    const nextState: WorkspaceState = {
      ...latest,
      agentTasks: {
        ...(latest.agentTasks ?? {}),
        [taskId]: completed,
      },
    };
    await this.store.saveState(nextState);
    return completed;
  }

  async createValidationExperiment(input: {
    opportunityId: string;
    type: ValidationExperimentType;
    hypothesis: string;
    start?: boolean;
  }): Promise<ValidationExperiment> {
    const state = await this.store.loadState();
    const opportunity = state.opportunities[input.opportunityId];
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

    const nextState: WorkspaceState = {
      ...state,
      validationExperiments: {
        ...state.validationExperiments,
        [experiment.id]: experiment,
      },
    };
    await this.store.saveState(nextState);
    return experiment;
  }

  async listValidationExperiments(opportunityId?: string): Promise<ValidationExperiment[]> {
    const state = await this.store.loadState();
    const items = Object.values(state.validationExperiments);
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
    const state = await this.store.loadState();
    const experiment = state.validationExperiments[input.experimentId];
    if (!experiment) {
      throw new Error(`Validation experiment not found: ${input.experimentId}`);
    }

    const opportunity = state.opportunities[experiment.opportunityId];
    if (!opportunity) {
      throw new Error(`Opportunity not found: ${experiment.opportunityId}`);
    }

    const result = applyValidationCompletion(opportunity, {
      experiment,
      outcome: input.outcome,
      summary: input.summary,
      recordedBy: input.actor ?? "user",
    });

    const nextState: WorkspaceState = {
      ...state,
      validationExperiments: {
        ...state.validationExperiments,
        [result.experiment.id]: result.experiment,
      },
      opportunities: {
        ...state.opportunities,
        [result.opportunity.id]: result.opportunity,
      },
    };
    await this.store.saveState(nextState);
    return result;
  }

  opportunitiesForRun(state: WorkspaceState, runId: ResearchRunId): Opportunity[] {
    const run = state.runs.find((r) => r.run.id === runId);
    if (!run) return [];
    const oppIds = new Set(run.drafts.map((d) => `opp_${d.id}`));
    return Object.values(state.opportunities).filter((o) => oppIds.has(o.id));
  }

  async compareMonitorDiff(input: {
    briefSlugOrId: string;
    baselineRunId: ResearchRunId;
    compareRunId: ResearchRunId;
  }): Promise<MonitorDiff> {
    const brief = await this.store.getBrief(input.briefSlugOrId);
    if (!brief) {
      throw new Error(`Brief not found: ${input.briefSlugOrId}`);
    }

    const state = await this.store.loadState();
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
    const existing = state.monitorSchedules[scheduleId];
    const schedule: MonitorSchedule = existing ?? {
      id: scheduleId,
      briefId: brief.id,
      cadence: "manual",
      lastComparedRunId: input.compareRunId,
      enabled: true,
      createdAt: new Date().toISOString(),
    };

    await this.store.saveState({
      ...state,
      monitorSchedules: {
        ...state.monitorSchedules,
        [scheduleId]: { ...schedule, lastComparedRunId: input.compareRunId },
      },
    });

    return diff;
  }

  async getMonitorSchedule(briefSlugOrId: string): Promise<MonitorSchedule | null> {
    const brief = await this.store.getBrief(briefSlugOrId);
    if (!brief) return null;
    const state = await this.store.loadState();
    return state.monitorSchedules[asId(`mon_${brief.id}`)] ?? null;
  }

  async setMonitorSchedule(input: {
    briefSlugOrId: string;
    cadence: MonitorCadence;
    enabled?: boolean;
  }): Promise<MonitorSchedule> {
    const brief = await this.store.getBrief(input.briefSlugOrId);
    if (!brief) {
      throw new Error(`Brief not found: ${input.briefSlugOrId}`);
    }

    const state = await this.store.loadState();
    const scheduleId = asId(`mon_${brief.id}`);
    const existing = state.monitorSchedules[scheduleId];
    const schedule: MonitorSchedule = {
      id: scheduleId,
      briefId: brief.id,
      cadence: input.cadence,
      lastComparedRunId: existing?.lastComparedRunId ?? null,
      enabled: input.enabled ?? existing?.enabled ?? true,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    };

    await this.store.saveState({
      ...state,
      monitorSchedules: {
        ...state.monitorSchedules,
        [scheduleId]: schedule,
      },
    });
    return schedule;
  }
}
