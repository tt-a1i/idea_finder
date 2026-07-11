import { admitToLibrary, asId } from "@idea-finder/core";
import { randomUUID } from "node:crypto";
import type { HuntingTaskId, ResearchRunId } from "@idea-finder/core";
import type { ResearchRun } from "@idea-finder/core";
import { invoicingFixture } from "../fixtures/invoicing-fixture.js";
import { createOrchestrationResearchRunner } from "../orchestration/orchestration-runner.js";
import { effectiveResearchConfig, effectiveResearchConfigHash } from "../orchestration/query-plan-builder.js";
import type { HuntingBrief } from "../types.js";
import type {
  ResearchRunOutput,
  ResearchRunner,
  ResearchRunnerFactory,
} from "./research-runner.js";

/** Fixture-backed runner — no live connectors or LLM. */
export function createFixtureResearchRunner(): ResearchRunner {
  return {
    async run(brief, request): Promise<ResearchRunOutput> {
      if (request.execution !== "new") {
        throw new Error("Fixture mode only supports new ResearchRuns");
      }
      const now = new Date().toISOString();
      const evidenceById = new Map(invoicingFixture.evidence.map((item) => [item.id, item]));
      const chunksById = new Map(invoicingFixture.chunks.map((item) => [item.id, item]));
      const signalsById = new Map(invoicingFixture.signals.map((item) => [item.id, item]));
      const admission = admitToLibrary(invoicingFixture.drafts, evidenceById, chunksById, signalsById);
      const rejectedByDraft = new Map(admission.rejected.map((item) => [item.draftId, item]));
      const effectiveConfig = effectiveResearchConfig(brief);
      return {
        execution: request.execution,
        run: {
          id: request.runId,
          huntingTaskId: request.taskId,
          status: "completed",
          startedAt: now,
          completedAt: now,
          configHash: effectiveResearchConfigHash(brief),
          errorMessage: null,
        },
        documents: [],
        chunks: [...invoicingFixture.chunks],
        signals: [...invoicingFixture.signals],
        evidence: [...invoicingFixture.evidence],
        drafts: [...invoicingFixture.drafts],
        opportunities: admission.admitted,
        admissionResults: invoicingFixture.drafts.map((draft) => ({
          id: draft.id,
          decision: admission.admitted.some((item) => item.id === `opp_${draft.id}`) ? "admitted" : "rejected",
          opportunityId: admission.admitted.find((item) => item.id === `opp_${draft.id}`)?.id ?? null,
          issues: rejectedByDraft.get(draft.id)?.issues ?? [],
        })),
        sourceStatuses: [{ id: "fixture", source: "fixture", status: "success", itemCount: invoicingFixture.chunks.length, reason: null, completedAt: now }],
        config: { id: request.runId, effectiveConfig, execution: request.execution },
      };
    },
  };
}

export interface OrchestrationRunnerFactoryOptions {
  readonly workspaceRoot: string;
  readonly harvestMode?: "manual" | "l0";
}

/** Real local pipeline: storage → harvest → intelligence → library admission. */
export function createOrchestrationResearchRunnerFromWorkspace(
  options: OrchestrationRunnerFactoryOptions,
): ResearchRunner {
  return createOrchestrationResearchRunner({
    workspaceRoot: options.workspaceRoot,
    harvestMode: options.harvestMode,
  });
}

export function createDefaultResearchRunner(
  mode: "fixture" | "orchestration",
  workspaceRoot?: string,
): ResearchRunner {
  if (mode === "fixture") {
    return createFixtureResearchRunner();
  }
  if (!workspaceRoot) {
    throw new Error("workspaceRoot is required for orchestration runner");
  }
  return createOrchestrationResearchRunnerFromWorkspace({ workspaceRoot });
}

export function createResearchRunFactory(): ResearchRunnerFactory {
  return {
    createResearchRun(brief: HuntingBrief): ResearchRun {
      const now = new Date().toISOString();
      return {
        id: asId<ResearchRunId>(`run_${randomUUID()}`),
        huntingTaskId: brief.id as HuntingTaskId,
        status: "pending",
        startedAt: now,
        completedAt: null,
        configHash: `cfg_${brief.slug}`,
        errorMessage: null,
      };
    },
  };
}
