import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir } from "node:fs/promises";
import path from "node:path";

import type { ActorKind, CalibrationAction } from "@idea-finder/core";
import {
  createFixtureResearchRunner,
  createOrchestrationResearchRunnerFromWorkspace,
  resolveHarvestMode,
  resolveWorkspacePaths,
  type StoredResearchRun,
  WorkspaceService,
} from "@idea-finder/workspace";

export type WebRunnerMode = "fixture" | "orchestration";
export type WebHarvestMode = "manual" | "l0";

export interface WebApiConfig {
  runnerMode: WebRunnerMode;
  harvestMode: WebHarvestMode;
}

export interface RunResearchResponse {
  readonly result: StoredResearchRun;
  readonly runnerMode: WebRunnerMode;
  readonly harvestMode: WebHarvestMode;
  readonly admittedCount: number;
  readonly rejectedCount: number;
  readonly error: string | null;
}

export interface WebSettingsResponse extends WebApiConfig {
  readonly workspaceDir: string;
  readonly version: number;
}

export interface ApiServerOptions {
  readonly workspaceDir: string;
  readonly port?: number;
  readonly seedFixture?: boolean;
  readonly runnerMode?: WebRunnerMode;
  readonly harvestMode?: WebHarvestMode;
}

export interface ApiServer {
  readonly service: WorkspaceService;
  getConfig(): WebApiConfig;
  listen(): Promise<{ port: number; close: () => Promise<void> }>;
  handle(
    method: string,
    pathname: string,
    searchParams: URLSearchParams,
    body?: unknown,
  ): Promise<{ status: number; body: unknown }>;
}

const DEFAULT_MANUAL_IMPORTS = [
  {
    text: "I invoice from a Google Sheet every month — painful workaround reconciling Stripe payouts.",
  },
  {
    text: "Would pay $30/mo for lightweight solo SaaS invoicing with Stripe sync.",
  },
  {
    text: "Need something simpler than QuickBooks for month-end invoicing.",
  },
  {
    text: "QuickBooks works fine for enterprise — not a problem for us.",
  },
] as const;

export function resolveWebApiConfig(
  options: Pick<ApiServerOptions, "runnerMode" | "harvestMode">,
): WebApiConfig {
  const runnerMode =
    options.runnerMode ??
    (process.env.WEB_RUNNER_MODE === "fixture" ? "fixture" : "orchestration");
  const harvestMode =
    options.harvestMode ??
    (process.env.WEB_HARVEST_MODE === "l0" ? "l0" : "manual");
  return { runnerMode, harvestMode };
}

function createRunnerForConfig(
  config: WebApiConfig,
  workspaceRoot: string,
) {
  if (config.runnerMode === "fixture") {
    return createFixtureResearchRunner();
  }
  return createOrchestrationResearchRunnerFromWorkspace({
    workspaceRoot,
    harvestMode: config.harvestMode,
  });
}

export function createApiServer(options: ApiServerOptions): ApiServer {
  const paths = resolveWorkspacePaths(options.workspaceDir);
  let config = resolveWebApiConfig(options);

  let service = new WorkspaceService({
    paths,
    runner: createRunnerForConfig(config, paths.root),
  });

  function rebuildService(): void {
    service = new WorkspaceService({
      paths,
      runner: createRunnerForConfig(config, paths.root),
    });
  }

  async function seedIfEmpty(): Promise<void> {
    const briefs = await service.listBriefs();
    if (briefs.length > 0) {
      return;
    }
    const brief = await service.createBrief({
      slug: "invoicing",
      title: "Solo SaaS invoicing",
      description: "Lightweight Stripe-sync invoicing demand",
      lenses: ["pain", "workaround", "wtp"],
      sourcesEnabled: ["manual"],
      successCriteria: "3+ cross-source corroborated signals",
      queryPlan: {
        harvestMode: "manual",
        manualImports: [...DEFAULT_MANUAL_IMPORTS],
      },
    });
    await runResearchWithMeta(brief.slug, config);
  }

  async function runResearchWithMeta(
    slug: string,
    runConfig: WebApiConfig,
  ): Promise<RunResearchResponse> {
    const runner = createRunnerForConfig(runConfig, paths.root);
    try {
      const result = await service.runResearch(slug, { runner });
      return {
        result,
        runnerMode: runConfig.runnerMode,
        harvestMode:
          runConfig.runnerMode === "orchestration"
            ? runConfig.harvestMode
            : "manual",
        admittedCount: result.admittedCount,
        rejectedCount: result.rejected.length,
        error: result.run.errorMessage,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(message);
    }
  }

  async function handle(
    method: string,
    pathname: string,
    searchParams: URLSearchParams,
    body?: unknown,
  ): Promise<{ status: number; body: unknown }> {
    try {
      if (method === "GET" && pathname === "/api/health") {
        return { status: 200, body: { ok: true } };
      }

      if (method === "GET" && pathname === "/api/briefs") {
        return { status: 200, body: await service.listBriefs() };
      }

      if (method === "POST" && pathname === "/api/briefs") {
        const input = body as {
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
        };
        const brief = await service.createBrief(input);
        return { status: 201, body: brief };
      }

      const briefMatch = pathname.match(/^\/api\/briefs\/([^/]+)$/);
      if (method === "GET" && briefMatch) {
        const brief = await service.getBrief(briefMatch[1]!);
        if (!brief) {
          return { status: 404, body: { error: "Brief not found" } };
        }
        return {
          status: 200,
          body: {
            ...brief,
            harvestMode: resolveHarvestMode(brief),
          },
        };
      }

      const runMatch = pathname.match(/^\/api\/briefs\/([^/]+)\/run$/);
      if (method === "POST" && runMatch) {
        const runBody = (body ?? {}) as {
          runnerMode?: WebRunnerMode;
          harvestMode?: WebHarvestMode;
        };
        const runConfig: WebApiConfig = {
          runnerMode: runBody.runnerMode ?? config.runnerMode,
          harvestMode: runBody.harvestMode ?? config.harvestMode,
        };
        const response = await runResearchWithMeta(runMatch[1]!, runConfig);
        return { status: 200, body: response };
      }

      if (method === "GET" && pathname === "/api/inbox") {
        const brief = searchParams.get("brief") ?? undefined;
        return { status: 200, body: await service.getInboxSummary(brief) };
      }

      if (method === "GET" && pathname === "/api/opportunities") {
        const brief = searchParams.get("brief") ?? undefined;
        return { status: 200, body: await service.listOpportunities(brief) };
      }

      if (method === "GET" && pathname === "/api/state") {
        return { status: 200, body: await service.getState() };
      }

      if (method === "POST" && pathname === "/api/board/calibrate") {
        const input = body as {
          opportunityId: string;
          action: CalibrationAction;
          note?: string | null;
          actor?: ActorKind;
        };
        const result = await service.applyBoardCalibration(input);
        return { status: 200, body: result };
      }

      if (method === "GET" && pathname === "/api/agent-tasks") {
        return { status: 200, body: await service.listAgentTasks() };
      }

      const agentTaskMatch = pathname.match(/^\/api\/agent-tasks\/([^/]+)$/);
      if (method === "GET" && agentTaskMatch) {
        const task = await service.getAgentTask(agentTaskMatch[1]!);
        if (!task) {
          return { status: 404, body: { error: "Agent task not found" } };
        }
        return { status: 200, body: task };
      }

      if (method === "POST" && pathname === "/api/agent-tasks") {
        const input = body as {
          kind: "research" | "browser" | "computer" | "coding";
          intent: string;
          opportunityId?: string | null;
          evidenceIds?: string[];
          dryRun?: boolean;
          domainWrite?: boolean;
        };
        const task = await service.createAgentTask(input);
        return { status: 201, body: task };
      }

      const agentRunMatch = pathname.match(/^\/api\/agent-tasks\/([^/]+)\/run$/);
      if (method === "POST" && agentRunMatch) {
        const task = await service.runAgentTask(agentRunMatch[1]!);
        return { status: 200, body: task };
      }

      if (method === "GET" && pathname === "/api/settings") {
        return {
          status: 200,
          body: {
            workspaceDir: options.workspaceDir,
            runnerMode: config.runnerMode,
            harvestMode: config.harvestMode,
            version: 1,
          } satisfies WebSettingsResponse,
        };
      }

      if (method === "PATCH" && pathname === "/api/settings") {
        const input = body as Partial<WebApiConfig>;
        if (input.runnerMode) {
          config = { ...config, runnerMode: input.runnerMode };
        }
        if (input.harvestMode) {
          config = { ...config, harvestMode: input.harvestMode };
        }
        rebuildService();
        return {
          status: 200,
          body: {
            workspaceDir: options.workspaceDir,
            runnerMode: config.runnerMode,
            harvestMode: config.harvestMode,
            version: 1,
          } satisfies WebSettingsResponse,
        };
      }

      return { status: 404, body: { error: "Not found" } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { status: 500, body: { error: message } };
    }
  }

  return {
    get service() {
      return service;
    },
    getConfig: () => ({ ...config }),
    async listen() {
      await mkdir(options.workspaceDir, { recursive: true });
      if (options.seedFixture !== false) {
        await seedIfEmpty();
      }

      const port = options.port ?? 4177;
      const server = createServer(async (req, res) => {
        await dispatch(req, res);
      });

      await new Promise<void>((resolve) => {
        server.listen(port, "127.0.0.1", resolve);
      });

      return {
        port,
        close: () =>
          new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
          }),
      };
    },
    handle,
  };

  async function dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const host = req.headers.host ?? "127.0.0.1";
    const url = new URL(req.url ?? "/", `http://${host}`);
    let body: unknown;
    if (req.method === "POST" || req.method === "PUT" || req.method === "PATCH") {
      body = await readJson(req);
    }

    const result = await handle(req.method ?? "GET", url.pathname, url.searchParams, body);
    sendJson(res, result.status, result.body);
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) {
    return undefined;
  }
  return JSON.parse(text) as unknown;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
  });
  res.end(JSON.stringify(body));
}

export function defaultWorkspaceDir(): string {
  return path.resolve(process.cwd(), "../../data/web-workspace");
}
