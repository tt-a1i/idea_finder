import type {
  CalibrationEvent,
  EvidenceItem,
  Opportunity,
} from "@idea-finder/core";
import type {
  HuntingBrief,
  InboxSignalSummary,
  StoredResearchRun,
  WorkspaceState,
  AgentTask,
} from "@idea-finder/workspace";

export type {
  HuntingBrief,
  InboxSignalSummary,
  StoredResearchRun,
  WorkspaceState,
  Opportunity,
  EvidenceItem,
  CalibrationEvent,
  AgentTask,
};

export type WebRunnerMode = "fixture" | "orchestration";
export type WebHarvestMode = "manual" | "l0";

export interface SettingsInfo {
  workspaceDir: string;
  runnerMode: WebRunnerMode;
  harvestMode: WebHarvestMode;
  version: number;
}

export interface RunResearchResponse {
  readonly result: StoredResearchRun;
  readonly runnerMode: WebRunnerMode;
  readonly harvestMode: WebHarvestMode;
  readonly admittedCount: number;
  readonly rejectedCount: number;
  readonly error: string | null;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    ...init,
  });
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok) {
    throw new Error((body as { error?: string }).error ?? `HTTP ${response.status}`);
  }
  return body;
}

export const api = {
  health: () => request<{ ok: boolean }>("/api/health"),
  listBriefs: () => request<HuntingBrief[]>("/api/briefs"),
  getBrief: (slug: string) =>
    request<HuntingBrief & { harvestMode?: WebHarvestMode }>(`/api/briefs/${slug}`),
  createBrief: (input: {
    slug: string;
    title: string;
    description: string;
    lenses?: string[];
    sourcesEnabled?: string[];
    successCriteria?: string;
    queryPlan?: {
      harvestMode?: WebHarvestMode;
      manualImports?: { text: string }[];
    };
  }) =>
    request<HuntingBrief>("/api/briefs", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  runResearch: (
    slug: string,
    options?: { runnerMode?: WebRunnerMode; harvestMode?: WebHarvestMode },
  ) =>
    request<RunResearchResponse>(`/api/briefs/${slug}/run`, {
      method: "POST",
      body: JSON.stringify(options ?? {}),
    }),
  getInbox: (brief?: string) =>
    request<{ runId: string | null; inbox: InboxSignalSummary[] }>(
      brief ? `/api/inbox?brief=${encodeURIComponent(brief)}` : "/api/inbox",
    ),
  listOpportunities: (brief?: string) =>
    request<Opportunity[]>(
      brief
        ? `/api/opportunities?brief=${encodeURIComponent(brief)}`
        : "/api/opportunities",
    ),
  getState: () => request<WorkspaceState>("/api/state"),
  calibrate: (input: {
    opportunityId: string;
    action: "promote" | "reject" | "park" | "needs_more_evidence";
    note?: string | null;
  }) =>
    request<{ opportunity: Opportunity; event: CalibrationEvent }>(
      "/api/board/calibrate",
      { method: "POST", body: JSON.stringify(input) },
    ),
  getSettings: () => request<SettingsInfo>("/api/settings"),
  updateSettings: (input: Partial<Pick<SettingsInfo, "runnerMode" | "harvestMode">>) =>
    request<SettingsInfo>("/api/settings", {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  listAgentTasks: () => request<AgentTask[]>("/api/agent-tasks"),
  getAgentTask: (id: string) => request<AgentTask>(`/api/agent-tasks/${id}`),
  createAgentTask: (input: {
    kind: "research" | "browser" | "computer" | "coding";
    intent: string;
    opportunityId?: string | null;
    evidenceIds?: string[];
    dryRun?: boolean;
    domainWrite?: boolean;
  }) =>
    request<AgentTask>("/api/agent-tasks", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  runAgentTask: (id: string) =>
    request<AgentTask>(`/api/agent-tasks/${id}/run`, { method: "POST" }),
};
