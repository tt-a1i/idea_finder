import { randomUUID } from "node:crypto";

import { admitToLibrary, asId } from "@idea-finder/core";
import type {
  Chunk,
  EvidenceItem,
  HuntingTaskId,
  RawSignal,
  ResearchRun,
  ResearchRunId,
} from "@idea-finder/core";
import type { QueryPlan } from "@idea-finder/connectors";
import type { HarvestPipeline } from "@idea-finder/harvest";
import type { IntelligencePipeline } from "@idea-finder/intelligence";
import type { LocalStorage } from "@idea-finder/storage";

export const PIPELINE_STEPS = {
  harvest: "harvest",
  intelligence: "intelligence",
  libraryAdmission: "library_admission",
} as const;

export type PipelineStep = (typeof PIPELINE_STEPS)[keyof typeof PIPELINE_STEPS];

export type OrchestratorStores = Pick<
  LocalStorage,
  | "researchRuns"
  | "rawDocuments"
  | "chunks"
  | "rawSignals"
  | "evidenceItems"
  | "opportunityDrafts"
  | "opportunities"
  | "libraryAdmissionResults"
  | "calibrationEvents"
  | "pipelineSteps"
  | "audit"
>;

export interface ResearchRunOrchestratorDeps {
  readonly stores: OrchestratorStores;
  readonly harvest: HarvestPipeline;
  readonly intelligence: IntelligencePipeline;
}

export interface CreateRunRequest {
  readonly huntingTaskId: HuntingTaskId;
  readonly configHash: string;
  readonly runId?: ResearchRunId;
}

export interface RunPipelineOptions {
  readonly queryPlan: QueryPlan;
}

export interface ResearchRunOrchestrator {
  createRun(request: CreateRunRequest): ResearchRun;
  getRun(runId: ResearchRunId): ResearchRun | null;
  runPipeline(
    runId: ResearchRunId,
    options: RunPipelineOptions,
  ): Promise<ResearchRun>;
}

export function createResearchRunOrchestrator(
  deps: ResearchRunOrchestratorDeps,
): ResearchRunOrchestrator {
  const { stores, harvest, intelligence } = deps;

  return {
    createRun(request) {
      if (request.runId && stores.researchRuns.get(request.runId)) {
        throw new Error(`ResearchRun already exists: ${request.runId}`);
      }
      const run: ResearchRun = {
        id: request.runId ?? asId(`run_${randomUUID()}`),
        huntingTaskId: request.huntingTaskId,
        status: "pending",
        startedAt: null,
        completedAt: null,
        configHash: request.configHash,
        errorMessage: null,
      };
      stores.researchRuns.save(run);
      return run;
    },

    getRun(runId) {
      return stores.researchRuns.get(runId);
    },

    async runPipeline(runId, options) {
      let run = stores.researchRuns.get(runId);
      if (!run) {
        throw new Error(`ResearchRun not found: ${runId}`);
      }

      if (run.status === "completed") {
        return run;
      }

      if (run.status !== "running") {
        run = {
          ...run,
          status: "running",
          startedAt: run.startedAt ?? new Date().toISOString(),
          completedAt: null,
          errorMessage: null,
        };
        stores.researchRuns.save(run);
      }

      try {
        if (!stores.pipelineSteps.isComplete(runId, PIPELINE_STEPS.harvest)) {
          await harvest.runHarvest(runId, options.queryPlan);
          stores.pipelineSteps.markComplete(runId, PIPELINE_STEPS.harvest);
        }

        if (!stores.pipelineSteps.isComplete(runId, PIPELINE_STEPS.intelligence)) {
          await intelligence.run(runId);
          stores.pipelineSteps.markComplete(runId, PIPELINE_STEPS.intelligence);
        }

        if (
          !stores.pipelineSteps.isComplete(runId, PIPELINE_STEPS.libraryAdmission)
        ) {
          await admitRunToLibrary(runId, stores);
          stores.pipelineSteps.markComplete(
            runId,
            PIPELINE_STEPS.libraryAdmission,
          );
        }

        run = {
          ...run,
          status: "completed",
          completedAt: new Date().toISOString(),
          errorMessage: null,
        };
        stores.researchRuns.save(run);

        await stores.audit.append({
          at: new Date().toISOString(),
          actor: "pipeline",
          action: "opportunity.promote",
          resource: runId,
          payload: {
            step: "pipeline_complete",
            opportunityCount: stores.opportunities.listByRun(runId).length,
          },
        });

        return run;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        run = { ...run, status: "failed", errorMessage: message };
        stores.researchRuns.save(run);
        throw error;
      }
    },
  };
}

async function admitRunToLibrary(runId: ResearchRunId, stores: OrchestratorStores): Promise<void> {
  const drafts = stores.opportunityDrafts.listByRun(runId);
  const evidence = stores.evidenceItems.listByRun(runId);
  const chunks = stores.chunks.listByRun(runId);
  const signals = stores.rawSignals.listByRun(runId);

  const evidenceById = new Map<EvidenceItem["id"], EvidenceItem>(
    evidence.map((item) => [item.id, item]),
  );
  const chunksById = new Map<Chunk["id"], Chunk>(
    chunks.map((chunk) => [chunk.id, chunk]),
  );
  const signalsById = new Map<RawSignal["id"], RawSignal>(
    signals.map((signal) => [signal.id, signal]),
  );

  const { admitted, rejected } = admitToLibrary(
    drafts,
    evidenceById,
    chunksById,
    signalsById,
  );

  for (const opportunity of admitted) {
    stores.opportunities.save(runId, opportunity);
  }

  for (const draft of drafts) {
    const opportunity = admitted.find((item) => item.id === `opp_${draft.id}`);
    const rejection = rejected.find((entry) => entry.draftId === draft.id);
    stores.libraryAdmissionResults.save(runId, {
      id: draft.id,
      decision: opportunity ? "admitted" : "rejected",
      opportunityId: opportunity?.id ?? null,
      issues: rejection?.issues ?? [],
    });
  }

  if (rejected.length > 0) {
    await stores.audit.append({
      at: new Date().toISOString(),
      actor: "pipeline",
      action: "policy.denied",
      resource: runId,
      payload: {
        step: "library_admission",
        rejectedDraftIds: rejected.map((entry) => entry.draftId),
      },
    });
  }
}
