import type {
  AgentRunId,
  CalibrationEventId,
  ChunkId,
  EvidenceItemId,
  HuntingTaskId,
  OpportunityDraftId,
  OpportunityId,
  RawDocumentId,
  RawSignalId,
  ResearchRunId,
  SignalClusterId,
  ValidationExperimentId,
  MonitorScheduleId,
  MetricObservationId,
  TrendSeriesId,
  TrendEventId,
  NormalizationContextId,
} from "./ids.js";

export type SourceTier = "L0" | "L1" | "L2" | "L3";
export type FetchMethod = "api" | "rss" | "import" | "browser_agent";
export type RetentionClass = "ephemeral" | "standard" | "pinned";
export type LegalBasis = "personal_research" | "user_provided" | "public_api_tos";

export type SignalType =
  | "pain"
  | "workaround"
  | "alternative_seek"
  | "willingness_to_pay"
  | "competitor_dissatisfaction"
  | "feature_request"
  | "validation_negative"
  | "trend"
  | "noise";

export type SupportsClaim =
  | "pain"
  | "workaround"
  | "wtp"
  | "competitor_gap"
  | "disconfirming";

export type EvidenceStrength = "primary" | "supporting" | "weak";
export type LinkStatus = "ok" | "redirect" | "404" | "paywall" | "login_required";
export type ConfidenceLevel = "high" | "medium" | "low";

export type ActorKind =
  | "user"
  | "pipeline"
  | "browser_agent"
  | "computer_agent"
  | "import";

export type OpportunityStatus =
  | "draft"
  | "hypothesis"
  | "promoted"
  | "rejected"
  | "parked";

export type CalibrationAction =
  | "promote"
  | "reject"
  | "park"
  | "needs_more_evidence";

export type ResearchRunStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "partial"
  | "cancelled";

export interface RawDocument {
  id: RawDocumentId;
  sourceTier: SourceTier;
  platform: string;
  externalId: string | null;
  url: string;
  fetchedAt: string;
  fetchMethod: FetchMethod;
  fetchAgentRunId: AgentRunId | null;
  contentType: "post" | "comment" | "review" | "issue" | "video" | "page";
  rawBody: string;
  huntingTaskId: HuntingTaskId;
  retentionClass: RetentionClass;
  legalBasis: LegalBasis;
}

export interface Chunk {
  id: ChunkId;
  documentId: RawDocumentId;
  text: string;
  spanStart: number;
  spanEnd: number;
}

export interface RawSignal {
  id: RawSignalId;
  chunkId: ChunkId;
  documentId: RawDocumentId;
  signalType: SignalType;
  signalSubtype: string;
  quoteVerbatim: string;
  quoteHash: string;
  spanStart: number;
  spanEnd: number;
  confidenceRule: number;
  detector: "rule_v1" | "llm_v2";
  detectorVersion: string;
  extractedAt: string;
}

export interface EvidenceProvenance {
  createdBy: ActorKind;
  agentRunId: AgentRunId | null;
}

export interface EvidenceItem {
  id: EvidenceItemId;
  clusterId: SignalClusterId;
  opportunityId: OpportunityId | null;
  rawSignalId: RawSignalId;
  documentId: RawDocumentId;
  chunkId: ChunkId;
  platform: string;
  url: string;
  linkStatus: LinkStatus;
  quoteVerbatim: string;
  supportsClaim: SupportsClaim;
  strength: EvidenceStrength;
  userVerified: boolean;
  provenance: EvidenceProvenance;
  fetchedAt: string;
}

export interface ScoreVector {
  frequency: number;
  crossSource: number;
  recency: number;
  wtpStrength: number;
  workaroundDepth: number;
}

export interface OpportunityDraft {
  id: OpportunityDraftId;
  clusterId: SignalClusterId;
  demandStatement: string;
  persona: string;
  scenario: string;
  evidenceItemIds: EvidenceItemId[];
  disconfirmingSignalIds: RawSignalId[];
  pseudoDemandRisks: string[];
  scoreVector: ScoreVector;
  confidence: ConfidenceLevel;
  confidenceReasons: string[];
  llmModel: string;
  promptVersion: string;
  provenance: { createdBy: ActorKind };
}

export interface Opportunity {
  id: OpportunityId;
  clusterId: SignalClusterId;
  status: OpportunityStatus;
  demandStatement: string;
  persona: string;
  scenario: string;
  evidenceItemIds: EvidenceItemId[];
  disconfirmingEvidenceItemIds: EvidenceItemId[];
  pseudoDemandRisks: string[];
  scoreVector: ScoreVector;
  confidence: ConfidenceLevel;
  confidenceReasons: string[];
  provenance: { createdBy: ActorKind; promotedBy: ActorKind | null };
}

export interface CalibrationEvent {
  id: CalibrationEventId;
  opportunityId: OpportunityId;
  actor: ActorKind;
  action: CalibrationAction;
  note: string | null;
  occurredAt: string;
}

export interface ResearchRun {
  id: ResearchRunId;
  huntingTaskId: HuntingTaskId;
  status: ResearchRunStatus;
  startedAt: string | null;
  completedAt: string | null;
  configHash: string;
  errorMessage: string | null;
}

export type ValidationExperimentType =
  | "mom_test"
  | "landing"
  | "community_test"
  | "spike"
  | "custom";

export type ValidationExperimentStatus = "planned" | "running" | "completed" | "cancelled";

export type ValidationOutcome = "validated" | "invalidated" | "inconclusive" | "blocked";

export interface ValidationArtifact {
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  readonly value: string;
  readonly createdAt: string;
}

export interface ExperimentResultRecord {
  readonly outcome: ValidationOutcome;
  readonly summary: string;
  readonly recordedAt: string;
  readonly recordedBy: ActorKind;
}

export interface ValidationExperiment {
  readonly id: ValidationExperimentId;
  readonly opportunityId: OpportunityId;
  readonly type: ValidationExperimentType;
  readonly hypothesis: string;
  readonly status: ValidationExperimentStatus;
  readonly result: ExperimentResultRecord | null;
  readonly artifacts: readonly ValidationArtifact[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type MonitorCadence = "manual" | "daily" | "weekly";

export interface MonitorSchedule {
  readonly id: MonitorScheduleId;
  readonly briefId: HuntingTaskId;
  readonly cadence: MonitorCadence;
  readonly lastComparedRunId: ResearchRunId | null;
  readonly enabled: boolean;
  readonly createdAt: string;
}

export type MonitorDiffKind = "added" | "heated" | "cooled" | "unchanged";

export interface MonitorOpportunitySnapshot {
  readonly opportunityId: OpportunityId;
  readonly clusterId: SignalClusterId;
  readonly demandStatement: string;
  readonly status: OpportunityStatus;
  readonly confidence: ConfidenceLevel;
  readonly evidenceCount: number;
}

export interface MonitorDiffEntry {
  readonly kind: MonitorDiffKind;
  readonly opportunityId: OpportunityId;
  readonly clusterId: SignalClusterId;
  readonly demandStatement: string;
  readonly before: MonitorOpportunitySnapshot | null;
  readonly after: MonitorOpportunitySnapshot | null;
  readonly evidenceCountDelta: number;
}

export interface MonitorDiffSummary {
  readonly added: number;
  readonly heated: number;
  readonly cooled: number;
  readonly unchanged: number;
}

export interface MonitorDiff {
  readonly baselineRunId: ResearchRunId;
  readonly compareRunId: ResearchRunId;
  readonly computedAt: string;
  readonly entries: readonly MonitorDiffEntry[];
  readonly summary: MonitorDiffSummary;
}

/** Quantitative evidence is deliberately separate from qualitative RawSignal/EvidenceItem. */
export type QuantitativeEvidenceLane = "developer_adoption" | "supply" | "search_momentum";

export type GitHubMetric =
  | "stars"
  | "forks"
  | "contributors"
  | "issue_opened"
  | "issue_closed"
  | "open_issues"
  | "repository_count"
  | "trending_rank";

export type GoogleTrendsMetric = "relative_search_interest";

export interface MetricSubject {
  readonly kind: "repository" | "organization" | "topic" | "search_term";
  readonly externalId: string;
  readonly url: string;
}

export interface MetricObservationProvenance {
  readonly collector: string;
  readonly collectorVersion: string;
  readonly interface: "github_rest_api" | "github_graphql_api" | "github_public_dataset";
  readonly sourceRef: string;
  readonly collectedAt: string;
}

export interface GitHubMetricObservation {
  readonly id: MetricObservationId;
  readonly subject: MetricSubject;
  readonly source: "github";
  readonly metric: GitHubMetric;
  readonly lane: QuantitativeEvidenceLane;
  readonly geography: string | null;
  readonly observedAt: string;
  readonly rawValue: number;
  readonly normalizedValue: number;
  readonly unit: "count" | "rank";
  readonly collectionMethod: MetricObservationProvenance["interface"];
  readonly provenance: MetricObservationProvenance;
}

export interface ObservationWindow {
  readonly startAt: string;
  readonly endAt: string;
  readonly resolution: "hour" | "day" | "week" | "month";
  readonly timezone: string;
}

export interface GoogleTrendsNormalizationContext {
  readonly id: NormalizationContextId;
  readonly source: "google_trends";
  readonly method: "relative_interest_0_100_v1";
  readonly geography: string;
  readonly window: ObservationWindow;
  readonly comparisonSubjects: readonly string[];
  /** Optional provider-declared anchor used to normalize the comparison set. */
  readonly anchor: string | null;
  readonly category: string;
  readonly property: "web" | "news" | "images" | "youtube" | "shopping";
  readonly scale: { readonly min: 0; readonly max: 100 };
  readonly includesPartialBucket: boolean;
}

export interface GoogleTrendsObservationProvenance {
  readonly collector: string;
  readonly collectorVersion: string;
  readonly interface:
    | "google_trends_authorized_api"
    | "google_trends_public_dataset"
    | "recorded_fixture";
  readonly sourceRef: string;
  readonly collectedAt: string;
}

export interface GoogleTrendsMetricObservation {
  readonly id: MetricObservationId;
  readonly subject: MetricSubject & { readonly kind: "search_term" };
  readonly source: "google_trends";
  readonly metric: GoogleTrendsMetric;
  readonly lane: "search_momentum";
  readonly geography: string;
  readonly observedAt: string;
  readonly rawValue: number;
  readonly normalizedValue: number;
  readonly unit: "relative_interest_0_100";
  readonly collectionMethod: GoogleTrendsObservationProvenance["interface"];
  readonly normalizationContextId: NormalizationContextId;
  readonly partial: boolean;
  readonly provenance: GoogleTrendsObservationProvenance;
}

export type MetricObservation = GitHubMetricObservation | GoogleTrendsMetricObservation;

export interface GitHubTrendSeries {
  readonly id: TrendSeriesId;
  readonly subject: MetricSubject;
  readonly source: "github";
  readonly metric: GitHubMetric;
  readonly lane: QuantitativeEvidenceLane;
  readonly observationIds: readonly MetricObservationId[];
  readonly startedAt: string;
  readonly endedAt: string;
}

export interface GoogleTrendsSeries {
  readonly id: TrendSeriesId;
  readonly subject: MetricSubject & { readonly kind: "search_term" };
  readonly source: "google_trends";
  readonly metric: GoogleTrendsMetric;
  readonly lane: "search_momentum";
  readonly geography: string;
  readonly normalizationContextId: NormalizationContextId;
  readonly window: ObservationWindow;
  readonly observationIds: readonly MetricObservationId[];
  readonly startedAt: string;
  readonly endedAt: string;
}

export type TrendSeries = GitHubTrendSeries | GoogleTrendsSeries;

export type TrendEventKind = "momentum_up" | "momentum_down" | "stable";

export interface DeltaTrendEvent {
  readonly id: TrendEventId;
  readonly seriesId: TrendSeriesId;
  readonly kind: TrendEventKind;
  readonly detectedAt: string;
  readonly previousObservationId: MetricObservationId;
  readonly currentObservationId: MetricObservationId;
  readonly previousValue: number;
  readonly currentValue: number;
  readonly absoluteDelta: number;
  readonly relativeDelta: number | null;
  readonly detector: "two_point_delta_v1";
}

export type SearchMomentumPattern =
  | "spike"
  | "seasonal"
  | "sustained_growth"
  | "insufficient_history"
  | "no_pattern";

export interface SearchMomentumClassifierRules {
  readonly minHistoryBuckets: number;
  readonly spikeBaselineBuckets: number;
  readonly spikeMultiplier: number;
  readonly spikeReturnRatio: number;
  readonly seasonalPeriodBuckets: number;
  readonly seasonalMinPeriods: number;
  readonly seasonalCorrelationThreshold: number;
  readonly seasonalMaxLevelShiftRatio: number;
  readonly growthWindowBuckets: number;
  readonly growthMinRelativeIncrease: number;
  readonly growthMinPositiveStepRatio: number;
}

export interface SearchMomentumTrendEvent {
  readonly id: TrendEventId;
  readonly seriesId: TrendSeriesId;
  readonly kind: SearchMomentumPattern;
  readonly detectedAt: string;
  readonly observationIds: readonly MetricObservationId[];
  readonly normalizationContextId: NormalizationContextId;
  readonly detector: "search_momentum_v1";
  readonly rules: SearchMomentumClassifierRules;
}

export type TrendEvent = DeltaTrendEvent | SearchMomentumTrendEvent;
