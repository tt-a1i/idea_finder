import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CLI_EXIT_CODES } from "../src/cli/contract.js";
import { runCli } from "../src/cli/main.js";
import type { GoogleTrendsTransport } from "@idea-finder/connectors";
import { resolveWorkspacePaths } from "../src/storage/workspace-store.js";
import { WorkspaceService } from "../src/workspace-service.js";

async function machine(args: string[], root: string) {
  const lines: string[] = [];
  const code = await runCli([...args, "--workspace", root, "--json"], { stdout: (line) => lines.push(line) });
  return { code, envelope: JSON.parse(lines[0]!) };
}

describe("Google Trends search momentum lane", () => {
  it("collects through an explicitly configured authorized HTTP transport", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "idea-finder-google-http-"));
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      expect(request.method).toBe("POST");
      expect(request.headers.authorization).toBe("Bearer test-alpha-token");
      const adapterRequest = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { subject: string };
      expect(adapterRequest).toMatchObject({
        geography: "US",
        granularity: "day",
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        payload: {
          rows: [10, 15, 22, 35, 55, 80].map((value, index) => ({
            time: new Date(Date.parse("2026-01-01T00:00:00Z") + index * 86_400_000).toISOString(),
            value,
            partial: false,
          })),
          comparisonSet: [adapterRequest.subject],
          anchor: null,
        },
        sourceRef: "google-trends-alpha://agent-coding",
      }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected HTTP server address");
    const previousToken = process.env.IDEA_FINDER_GOOGLE_TRENDS_TOKEN;
    process.env.IDEA_FINDER_GOOGLE_TRENDS_TOKEN = "test-alpha-token";
    try {
      const collected = await machine([
        "trends", "collect", "google", "agent coding",
        "--geo", "US",
        "--from", "2026-01-01T00:00:00Z",
        "--to", "2026-01-10T00:00:00Z",
        "--transport-url", `http://127.0.0.1:${address.port}/trends`,
      ], root);
      expect(collected.code).toBe(0);
      expect(collected.envelope.data.sourceHealth).toEqual([expect.objectContaining({ status: "success" })]);
      expect(collected.envelope.data.observations).toHaveLength(6);
      expect(collected.envelope.data.observations[0]).toMatchObject({
        provenance: {
          interface: "google_trends_authorized_api",
          sourceRef: "google-trends-alpha://agent-coding",
          collector: "authorized-http-adapter",
          collectorVersion: "1",
          collectedAt: expect.any(String),
        },
      });

      expect((await machine([
        "brief", "create", "authorized-google",
        "--title", "Authorized Google research",
        "--manual-import", "This repeated workaround is painful for agent developers.",
        "--google-subject", "agent workflows",
        "--google-geo", "US",
        "--from", "2026-01-01T00:00:00Z",
        "--to", "2026-01-10T00:00:00Z",
      ], root)).code).toBe(0);
      const research = await machine([
        "research", "run", "authorized-google",
        "--transport-url", `http://127.0.0.1:${address.port}/trends`,
      ], root);
      expect(research.code, JSON.stringify(research.envelope)).toBe(0);
      expect(research.envelope).toMatchObject({
        status: "success",
        data: {
          sourceStatuses: expect.arrayContaining([
            expect.objectContaining({ source: "google_trends", status: "success" }),
          ]),
        },
      });
    } finally {
      if (previousToken === undefined) delete process.env.IDEA_FINDER_GOOGLE_TRENDS_TOKEN;
      else process.env.IDEA_FINDER_GOOGLE_TRENDS_TOKEN = previousToken;
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await rm(root, { recursive: true, force: true });
    }
  });

  it("collects an explicit geo/window, persists normalization and inspects pattern across restart", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "idea-finder-google-trends-"));
    try {
      const collected = await machine(["trends", "collect", "google", "agent coding", "--geo", "US", "--from", "2026-01-01T00:00:00Z", "--to", "2026-01-10T00:00:00Z", "--granularity", "day", "--fixture", "--fixture-pattern", "sustained"], root);
      expect(collected.code).toBe(0);
      expect(collected.envelope).toMatchObject({ data: {
        context: { geography: "US", scale: { min: 0, max: 100 }, window: { resolution: "day" } },
        event: { kind: "sustained_growth", detector: "search_momentum_v1" },
        sourceHealth: [expect.objectContaining({ status: "success", geography: "US" })],
      } });
      expect(collected.envelope.data.observations).toHaveLength(6);
      expect(collected.envelope.data.observations[0]).toMatchObject({ lane: "search_momentum", provenance: { sourceRef: "fixture://google-trends" } });
      expect(collected.envelope.data.observations[0].normalizationContextId).toEqual(expect.any(String));
      const inspected = await machine(["trends", "inspect", "google", "agent coding", "--geo", "US", "--from", "2026-01-01T00:00:00Z", "--to", "2026-01-10T00:00:00Z"], root);
      expect(inspected.envelope.data).toMatchObject({ contexts: [expect.any(Object)], observations: expect.any(Array), series: [expect.any(Object)], events: [expect.objectContaining({ kind: "sustained_growth" })] });
      expect(inspected.envelope.data.observations).toHaveLength(6);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed with structured authorization source status when no transport is configured", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "idea-finder-google-auth-"));
    try {
      const result = await machine(["trends", "collect", "google", "agent coding", "--geo", "WORLDWIDE", "--from", "2026-01-01T00:00:00Z", "--to", "2026-01-10T00:00:00Z"], root);
      expect(result.code).toBe(CLI_EXIT_CODES.policy);
      expect(result.envelope).toMatchObject({ status: "error", errors: [{ code: "google_trends.authorization_required" }], data: { sourceHealth: [expect.objectContaining({ status: "authorization_required", itemCount: 0 })] } });
      const inspected = await machine(["trends", "inspect", "google", "agent coding"], root);
      expect(inspected.envelope.data.observations).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("classifies an invalid authorized transport URL as CLI validation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "idea-finder-google-transport-config-"));
    try {
      const result = await machine([
        "trends", "collect", "google", "agent coding",
        "--geo", "US",
        "--from", "2026-01-01T00:00:00Z",
        "--to", "2026-01-10T00:00:00Z",
        "--transport-url", "http://example.com/private",
      ], root);
      expect(result.code).toBe(CLI_EXIT_CODES.validation);
      expect(result.envelope.errors).toEqual([
        expect.objectContaining({ category: "validation", code: "google_trends.transport_invalid" }),
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects invalid geography as CLI validation without recording source health", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "idea-finder-google-input-"));
    try {
      const result = await machine(["trends", "collect", "google", "agent coding", "--geo", "USA", "--from", "2026-01-01T00:00:00Z", "--to", "2026-01-10T00:00:00Z"], root);
      expect(result.code).toBe(CLI_EXIT_CODES.validation);
      expect(result.envelope.errors[0]).toMatchObject({ category: "validation", code: "trends.geo_invalid" });
      expect((await machine(["trends", "inspect", "google", "agent coding"], root)).envelope.data.sourceHealth).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(["throttled", "unavailable", "response_drift"] as const)("persists structured %s status without a partial observation batch", async (failure) => {
    const root = await mkdtemp(path.join(os.tmpdir(), `idea-finder-google-${failure}-`));
    try {
      const result = await machine(["trends", "collect", "google", failure, "--geo", "US", "--from", "2026-01-01T00:00:00Z", "--to", "2026-01-10T00:00:00Z", "--fixture", "--fixture-failure", failure], root);
      expect(result.code).toBe(CLI_EXIT_CODES.partialResult);
      expect(result.envelope).toMatchObject({ errors: [{ code: `google_trends.${failure}` }], data: { sourceHealth: [expect.objectContaining({ status: failure, itemCount: 0 })] } });
      if (failure === "throttled") expect(result.envelope.data.retryAt).toBe("2026-01-11T00:00:00.000Z");
      const inspected = await machine(["trends", "inspect", "google", failure], root);
      expect(inspected.envelope.data.observations).toEqual([]);
      expect(inspected.envelope.data.sourceHealth).toEqual([expect.objectContaining({ status: failure })]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps observations from distinct normalization contexts in the same window", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "idea-finder-google-contexts-"));
    try {
      const transport = (anchor: string | null): GoogleTrendsTransport => ({
        async query(request) {
          return {
            payload: { rows: [10, 15, 22, 35, 55, 80].map((value, index) => ({ time: new Date(Date.parse(request.from) + index * 86_400_000).toISOString(), value, partial: false })), comparisonSet: [request.subject], anchor },
            provenance: { transport: "fixture", transportVersion: "1", authorizedInterface: "recorded_fixture", sourceRef: `fixture://${anchor ?? "none"}`, retrievedAt: request.to },
          };
        },
      });
      const service = new WorkspaceService({ paths: resolveWorkspacePaths(root) });
      const base = { subject: "agent coding", geography: "US", from: "2026-01-01T00:00:00Z", to: "2026-01-10T00:00:00Z", granularity: "day" as const };
      await service.collectGoogleTrends({ ...base, category: "all", transport: transport(null) });
      await service.collectGoogleTrends({ ...base, category: "technology", transport: transport("agent") });
      const inspected = service.inspectGoogleTrends({ subject: base.subject, geography: base.geography });
      expect(inspected.contexts).toHaveLength(2);
      expect(inspected.observations).toHaveLength(12);
      expect(new Set(inspected.observations.map((item) => item.id)).size).toBe(12);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
