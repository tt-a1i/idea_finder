import { mkdtemp, rm } from "node:fs/promises";
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
