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
