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
export type FixtureSourceScenario = "success" | "mixed" | "unauthorized" | "throttled" | "zero" | "partial-zero" | "pain-growth";

export function createFixtureResearchRunner(sourceScenario: FixtureSourceScenario = "success"): ResearchRunner {
  return {
    async run(brief, request): Promise<ResearchRunOutput> {
      const now = new Date().toISOString();
      const evidenceById = new Map(invoicingFixture.evidence.map((item) => [item.id, item]));
      const chunksById = new Map(invoicingFixture.chunks.map((item) => [item.id, item]));
      const signalsById = new Map(invoicingFixture.signals.map((item) => [item.id, item]));
      const admission = admitToLibrary(invoicingFixture.drafts, evidenceById, chunksById, signalsById);
      const rejectedByDraft = new Map(admission.rejected.map((item) => [item.draftId, item]));
      const effectiveConfig = effectiveResearchConfig(brief);
      const recovering = request.execution !== "new";
      const empty = sourceScenario === "zero" || sourceScenario === "partial-zero";
      const incompleteStatus = sourceScenario === "success" || sourceScenario === "zero" || sourceScenario === "pain-growth" ? null : sourceScenario === "partial-zero" ? "mixed" : sourceScenario;
      const extraPain = sourceScenario === "pain-growth" ? { ...invoicingFixture.evidence[0]!, id: asId("e_fixture_pain_growth"), supportsClaim: "pain" as const, strength: "supporting" as const, quoteVerbatim: "Repeated painful reconciliation blocks this workflow every day." } : null;
      const fixtureEvidence = extraPain ? [...invoicingFixture.evidence, extraPain] : [...invoicingFixture.evidence];
      const fixtureOpportunities = extraPain ? admission.admitted.map((item, index) => index === 0 ? { ...item, evidenceItemIds: [...item.evidenceItemIds, extraPain.id] } : item) : admission.admitted;
      const retainedStatus = { id: "fixture:retained", requestKey: "fixture:retained", source: "fixture_retained", status: "success" as const, itemCount: empty ? 0 : invoicingFixture.chunks.length, reasonCode: empty ? "zero_results" as const : "none" as const, reason: null, startedAt: now, completedAt: now, retryAt: null };
      const sourceStatuses = incompleteStatus ? [retainedStatus, {
        id: "fixture:recoverable", requestKey: "fixture:recoverable", source: "fixture_recoverable",
        status: incompleteStatus === "mixed" ? "unavailable" as const : incompleteStatus,
        itemCount: 0, reasonCode: incompleteStatus === "mixed" ? "unavailable" as const : incompleteStatus,
        reason: incompleteStatus === "mixed" ? "Recorded source unavailable" : `Recorded ${incompleteStatus} source`,
        startedAt: now, completedAt: now, retryAt: incompleteStatus === "throttled" ? "2026-07-11T00:01:00.000Z" : null,
      }] : [retainedStatus, { ...retainedStatus, id: "fixture:recoverable", requestKey: "fixture:recoverable", source: "fixture_recoverable" }];
      return {
        execution: request.execution,
        run: {
          id: request.runId,
          huntingTaskId: request.taskId,
          status: incompleteStatus ? "partial" : "completed",
          startedAt: now,
          completedAt: now,
          configHash: effectiveResearchConfigHash(brief),
          errorMessage: incompleteStatus ? sourceStatuses[1]!.reason : null,
        },
        documents: [],
        chunks: empty || recovering ? [] : [...invoicingFixture.chunks],
        signals: empty || recovering ? [] : [...invoicingFixture.signals],
        evidence: empty || recovering ? [] : fixtureEvidence,
        drafts: empty || recovering ? [] : [...invoicingFixture.drafts],
        opportunities: empty || recovering ? [] : fixtureOpportunities,
        admissionResults: (empty || recovering ? [] : invoicingFixture.drafts).map((draft) => ({
          id: draft.id,
          decision: admission.admitted.some((item) => item.id === `opp_${draft.id}`) ? "admitted" : "rejected",
          opportunityId: admission.admitted.find((item) => item.id === `opp_${draft.id}`)?.id ?? null,
          issues: rejectedByDraft.get(draft.id)?.issues ?? [],
        })),
        sourceStatuses: recovering ? [sourceStatuses.find((status) => status.id === "fixture:recoverable")!] : sourceStatuses,
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
