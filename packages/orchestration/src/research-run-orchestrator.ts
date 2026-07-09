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
}

export interface RunPipelineOptions {
  readonly queryPlan: QueryPlan;
}

export interface ResearchRunOrchestrator {
  createOrGetRun(request: CreateRunRequest): ResearchRun;
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
    createOrGetRun(request) {
      const existing = stores.researchRuns.findByTaskAndConfig(
        request.huntingTaskId,
        request.configHash,
      );
      if (existing) {
        return existing;
      }

      const run: ResearchRun = {
        id: asId(`run_${randomUUID()}`),
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

      if (run.status === "pending") {
        run = {
          ...run,
          status: "running",
          startedAt: new Date().toISOString(),
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
          admitRunToLibrary(runId, stores);
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

function admitRunToLibrary(runId: ResearchRunId, stores: OrchestratorStores): void {
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

  if (rejected.length > 0) {
    void stores.audit.append({
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
