import { asId } from "@idea-finder/core";
import type { HuntingTaskId, ResearchRunId } from "@idea-finder/core";
import type { ResearchRun } from "@idea-finder/core";
import { invoicingFixture } from "../fixtures/invoicing-fixture.js";
import { createOrchestrationResearchRunner } from "../orchestration/orchestration-runner.js";
import type { HuntingBrief } from "../types.js";
import type {
  ResearchRunOutput,
  ResearchRunner,
  ResearchRunnerFactory,
} from "./research-runner.js";

/** Fixture-backed runner — no live connectors or LLM. */
export function createFixtureResearchRunner(): ResearchRunner {
  return {
    async run(brief, runId, taskId): Promise<ResearchRunOutput> {
      const now = new Date().toISOString();
      return {
        run: {
          id: runId,
          huntingTaskId: taskId,
          status: "completed",
          startedAt: now,
          completedAt: now,
          configHash: `cfg_${brief.slug}`,
          errorMessage: null,
        },
        chunks: [...invoicingFixture.chunks],
        signals: [...invoicingFixture.signals],
        evidence: [...invoicingFixture.evidence],
        drafts: [...invoicingFixture.drafts],
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
        id: asId<ResearchRunId>(`run_${brief.slug}_${Date.now()}`),
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
