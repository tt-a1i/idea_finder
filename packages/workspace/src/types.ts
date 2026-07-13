import type {
  CalibrationEvent,
  Chunk,
  EvidenceItem,
  HuntingTaskId,
  MonitorSchedule,
  Opportunity,
  OpportunityDraft,
  RawSignal,
  ResearchRun,
  RawDocument,
  ValidationExperiment,
} from "@idea-finder/core";
import type { DraftRejection } from "@idea-finder/core";
import type {
  AgentInvocationStatus,
  AgentKind,
  AgentPlannedEffect,
  PolicyDenial,
} from "@idea-finder/agents";
import type { ResearchRunExecution } from "./ports/research-runner.js";

export type ResearchStopReason =
  | "budget_exhausted"
  | "budget_exhausted_partial"
  | "saturated"
  | "continue";

export interface ResearchRoundSummary {
  readonly round: number;
  readonly queryIds: readonly string[];
  readonly newDocumentCount: number;
  readonly newEvidenceCount: number;
  readonly newClusterCount: number;
  readonly coverageIncomplete: boolean;
}

export interface ResearchLedger {
  readonly rounds: readonly ResearchRoundSummary[];
  readonly stopReason: ResearchStopReason;
  readonly lastCheckpoint?: {
    readonly round: number;
    readonly phase: "harvested" | "round_complete";
    /** Document count before this round's harvest; required when phase is harvested. */
    readonly docsBefore?: number;
    /** Evidence count before this round's harvest; required when phase is harvested. */
    readonly evidenceBefore?: number;
    /** Cluster ids known before this round's harvest; required when phase is harvested. */
    readonly knownClusterIds?: readonly string[];
  };
}

export interface StoredResearchRunConfig {
  readonly id: string;
  readonly effectiveConfig: Readonly<Record<string, unknown>>;
  readonly execution: ResearchRunExecution;
  readonly researchLedger?: ResearchLedger;
}

export interface LibraryAdmissionRecord {
  readonly id: string;
  readonly decision: "admitted" | "rejected";
  readonly opportunityId: string | null;
  readonly issues: readonly { readonly code: string; readonly message: string }[];
}

export interface ResearchSourceStatus {
  readonly id: string;
  readonly source: string;
  readonly requestKey: string;
  readonly status: "success" | "failure" | "skipped" | "unauthorized" | "throttled" | "unavailable";
  readonly itemCount: number;
  readonly reasonCode: "none" | "zero_results" | "unauthorized" | "throttled" | "unavailable" | "failed" | "connector_missing";
  readonly reason: string | null;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly retryAt: string | null;
  readonly artifactIds?: readonly string[];
}

export interface ManualImportConfig {
  readonly text: string;
  readonly url?: string;
  readonly title?: string;
}

export interface BriefSourceSearch {
  readonly platform: string;
  readonly terms: readonly string[];
  readonly limit?: number;
  readonly appId?: string;
  readonly stackExchangeSite?: string;
}

/** Optional harvest plan saved on the brief (manual imports and/or L0 searches). */
export interface BriefQueryPlan {
  readonly harvestMode?: "manual" | "l0";
  readonly searches?: readonly BriefSourceSearch[];
  readonly manualImports?: readonly ManualImportConfig[];
  readonly quantitative?: {
    readonly googleTrends?: readonly { readonly subject: string; readonly geography: string; readonly from: string; readonly to: string; readonly granularity: "day" | "week" }[];
    readonly github?: readonly { readonly repository: string; readonly since?: string }[];
    readonly packages?: readonly { readonly ecosystem: "npm" | "pypi"; readonly package: string; readonly from: string; readonly to: string }[];
  };
}

export type ResearchLens =
  | "topic_synonym"
  | "persona"
  | "scenario"
  | "pain_failure"
  | "workaround"
  | "alternative_seeking"
  | "commercial_intent"
  | "competitor_dissatisfaction"
  | "contradiction"
  | "language"
  | "source";

export interface SearchQueryVariant {
  readonly id: string;
  readonly queryText: string;
  readonly language: string;
  readonly source: string;
  readonly lens: ResearchLens;
  readonly round: number;
  readonly parentQueryId?: string | null;
  readonly triggerEvidenceId?: string | null;
  readonly status: "pending" | "success" | "failure" | "partial" | "skipped";
  readonly itemCount: number;
  readonly error?: string | null;
}

/** Confirmed or proposed broad research plan (canonical SQLite entity). */
export interface SearchPlan {
  readonly id: string;
  readonly version: number;
  readonly status: "proposed" | "confirmed";
  readonly topic: string;
  readonly personas: readonly string[];
  readonly scenarios: readonly string[];
  readonly languages: readonly string[];
  readonly geography: string;
  readonly timeWindow: { readonly from: string; readonly to: string };
  readonly sourceFamilies: readonly string[];
  readonly researchLenses: readonly ResearchLens[];
  readonly budgets: { readonly queries: number; readonly documents: number; readonly rounds: number };
  readonly confirmation: {
    readonly mode: "explicit" | "start_now";
    readonly confirmedAt: string | null;
    readonly defaultsApplied: boolean;
  };
  readonly queries: readonly SearchQueryVariant[];
  readonly briefId?: string | null;
  readonly briefSlug?: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Local hunting brief — config for a demand research workspace slice. */
export interface HuntingBrief {
  readonly id: HuntingTaskId;
  readonly slug: string;
  readonly title: string;
  readonly description: string;
  readonly lenses: readonly string[];
  readonly sourcesEnabled: readonly string[];
  readonly successCriteria: string;
  readonly createdAt: string;
  readonly queryPlan?: BriefQueryPlan;
  readonly searchPlanId?: string;
  readonly searchPlanVersion?: number;
  readonly origin?: { readonly kind: "trend_anomaly"; readonly parentRunId: string; readonly trendEventId: string; readonly trendSeriesId: string };
}

export interface InboxSignalSummary {
  readonly signalType: string;
  readonly count: number;
  readonly sampleQuote: string;
}

export type AgentTaskStatus =
  | "pending"
  | "running"
  | "blocked"
  | "succeeded"
  | "failed";

export interface AgentTaskInvocation {
  readonly invocationId: string;
  readonly requestedAt: string;
  readonly completedAt: string | null;
  readonly policyAllowed: boolean;
  readonly policyDenials: readonly PolicyDenial[];
  readonly resultStatus: AgentInvocationStatus | null;
  readonly dryRun: boolean;
  readonly structured?: Readonly<Record<string, unknown>>;
}

export interface AgentTask {
  readonly id: string;
  readonly kind: AgentKind;
  readonly intent: string;
  readonly status: AgentTaskStatus;
  readonly opportunityId: string | null;
  readonly evidenceIds: readonly string[];
  readonly dryRun: boolean;
  readonly plannedEffects: readonly AgentPlannedEffect[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly invocations: readonly AgentTaskInvocation[];
}

export interface StoredResearchRun {
  readonly execution: ResearchRunExecution;
  readonly run: ResearchRun;
  readonly briefId: HuntingTaskId;
  readonly documents: readonly RawDocument[];
  readonly chunks: readonly Chunk[];
  readonly signals: readonly RawSignal[];
  readonly evidence: readonly EvidenceItem[];
  readonly drafts: readonly OpportunityDraft[];
  readonly opportunities: readonly Opportunity[];
  readonly rejected: readonly DraftRejection[];
  readonly admissionResults?: readonly LibraryAdmissionRecord[];
  readonly sourceStatuses?: readonly ResearchSourceStatus[];
  readonly admittedCount: number;
  readonly inbox: readonly InboxSignalSummary[];
}

export interface WorkspaceState {
  readonly version: 1;
  readonly runs: readonly StoredResearchRun[];
  readonly opportunities: Readonly<Record<string, Opportunity>>;
  readonly calibrationEvents: readonly CalibrationEvent[];
  readonly evidenceById: Readonly<Record<string, EvidenceItem>>;
  readonly chunksById: Readonly<Record<string, Chunk>>;
  readonly signalsById: Readonly<Record<string, RawSignal>>;
  readonly agentTasks: Readonly<Record<string, AgentTask>>;
  readonly validationExperiments: Readonly<Record<string, ValidationExperiment>>;
  readonly monitorSchedules: Readonly<Record<string, MonitorSchedule>>;
}

export function emptyWorkspaceState(): WorkspaceState {
  return {
    version: 1,
    runs: [],
    opportunities: {},
    calibrationEvents: [],
    evidenceById: {},
    chunksById: {},
    signalsById: {},
    agentTasks: {},
    validationExperiments: {},
    monitorSchedules: {},
  };
}
