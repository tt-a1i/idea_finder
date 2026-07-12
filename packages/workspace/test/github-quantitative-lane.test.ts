import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CollectedMetricObservation, QuantitativeConnector } from "@idea-finder/connectors";
import { resolveWorkspacePaths } from "../src/storage/workspace-store.js";
import { WorkspaceService } from "../src/workspace-service.js";
import { runCli } from "../src/cli/main.js";

function connectorAt(observedAt: string, stars: number): QuantitativeConnector {
  const metrics = [
    ["github.repository.stars", stars, "developer_adoption"],
    ["github.repository.forks", 4, "developer_adoption"],
    ["github.repository.open_issues", 7, "developer_adoption"],
    ["github.issue.opened", 3, "developer_adoption"],
    ["github.issue.closed", 2, "developer_adoption"],
    ["github.repository.contributors", 5, "supply"],
  ] as const;
  return {
    source: "github",
    async healthcheck() { return { ok: true }; },
    async collect() {
      return metrics.map(([metric, value, evidenceClass]) => ({
        id: `metric_${metric.replace(/\W/g, "_")}_${observedAt}`,
        subject: "github:owner/repo", source: "github", metric, evidenceClass,
        geography: null, observedAt, rawValue: value, normalizedValue: value,
        unit: "count", collectionMethod: "authorized_public_api",
        provenance: { url: "https://api.github.com/repos/owner/repo", endpoint: "/repos/{owner}/{repo}", apiVersion: "2022-11-28", retrievedAt: observedAt },
      })) as CollectedMetricObservation[];
    },
  };
}

describe("GitHub quantitative evidence lane", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("persists observations, derived series/events, provenance and CLI inspection across restart", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "idea-finder-github-metrics-"));
    try {
      const service = new WorkspaceService({ paths: resolveWorkspacePaths(root) });
      await service.collectGithubMetrics({ subject: "owner/repo", connector: connectorAt("2026-07-10T00:00:00.000Z", 10) });
      const second = await service.collectGithubMetrics({ subject: "owner/repo", connector: connectorAt("2026-07-11T00:00:00.000Z", 20) });
      expect(second.observations).toHaveLength(6);
      expect(second.events.some((event) => event.kind === "momentum_up")).toBe(true);

      const restarted = new WorkspaceService({ paths: resolveWorkspacePaths(root) });
      expect(restarted.listMetricObservations("owner/repo", "stars")).toHaveLength(2);
      expect(restarted.listTrendSeries("owner/repo", "stars")[0]?.observationIds).toHaveLength(2);
      expect(restarted.listTrendEvents("owner/repo", "stars")[0]).toMatchObject({ kind: "momentum_up", detector: "two_point_delta_v1" });
      expect(restarted.listMetricObservations("owner/repo", "stars")[0]?.provenance.sourceRef).toContain("api.github.com");

      const lines: string[] = [];
      expect(await runCli(["trends", "observations", "--subject", "owner/repo", "--metric", "stars", "--workspace", root, "--json"], { stdout: (line) => lines.push(line) })).toBe(0);
      expect(JSON.parse(lines[0]!).data.observations).toHaveLength(2);
      for (const command of ["series", "events"] as const) {
        const output: string[] = [];
        expect(await runCli(["trends", command, "--subject", "owner/repo", "--metric", "stars", "--workspace", root, "--json"], { stdout: (line) => output.push(line) })).toBe(0);
        expect(JSON.parse(output[0]!).data[command]).toHaveLength(1);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("records source drift failure without a partial observation batch", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "idea-finder-github-drift-"));
    try {
      const service = new WorkspaceService({ paths: resolveWorkspacePaths(root) });
      const failing: QuantitativeConnector = {
        source: "github",
        async healthcheck() { return { ok: true }; },
        async collect() { throw new Error("GitHub API source drift: missing stargazers_count"); },
      };
      await expect(service.collectGithubMetrics({ subject: "owner/repo", connector: failing })).rejects.toThrow("source drift");
      expect(service.listMetricObservations()).toEqual([]);
      expect(service.listQuantitativeSourceStatuses()).toEqual([expect.objectContaining({ status: "failure", itemCount: 0 })]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("runs GitHub collection through the CLI using the public REST contract", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "idea-finder-github-cli-"));
    try {
      vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("/contributors")) return new Response(JSON.stringify([{ id: 1, contributions: 2 }]), { status: 200 });
        if (url.includes("/issues")) return new Response(JSON.stringify([{ id: 2, created_at: "2026-07-10T00:00:00Z", closed_at: null }]), { status: 200 });
        return new Response(JSON.stringify({ full_name: "owner/repo", stargazers_count: 10, forks_count: 2, open_issues_count: 1 }), { status: 200 });
      }));
      const output: string[] = [];
      expect(await runCli(["trends", "collect", "github", "owner/repo", "--workspace", root, "--json"], { stdout: (line) => output.push(line) })).toBe(0);
      expect(JSON.parse(output[0]!)).toMatchObject({ command: "trends collect", status: "success", data: { observations: expect.any(Array), sourceHealth: [expect.objectContaining({ status: "success" })] } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reuses GITHUB_TOKEN for Authorization without leaking it into CLI output, errors, or SQLite", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "idea-finder-github-token-leak-"));
    const secret = "ghs_cli_secret_token_must_never_appear";
    const previous = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = secret;
    try {
      const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        expect(headers.get("authorization")).toBe(`Bearer ${secret}`);
        const url = String(input);
        if (url.includes("/contributors")) return new Response(JSON.stringify([{ id: 1, contributions: 2 }]), { status: 200 });
        if (url.includes("/issues")) return new Response(JSON.stringify([{ id: 2, created_at: "2026-07-10T00:00:00Z", closed_at: null }]), { status: 200 });
        return new Response(JSON.stringify({ full_name: "owner/repo", stargazers_count: 10, forks_count: 2, open_issues_count: 1 }), { status: 200 });
      });
      vi.stubGlobal("fetch", fetchFn);
      const stdout: string[] = [];
      const stderr: string[] = [];
      expect(await runCli(["trends", "collect", "github", "owner/repo", "--workspace", root, "--json"], {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      })).toBe(0);
      const blob = [...stdout, ...stderr].join("\n");
      expect(blob).not.toContain(secret);
      expect(JSON.stringify(JSON.parse(stdout[0]!))).not.toContain(secret);

      const exportOut: string[] = [];
      await runCli(["brief", "create", "gh-leak", "--title", "gh leak", "--github-repo", "owner/repo", "--workspace", root, "--json"], { stdout: () => undefined });
      await runCli(["research", "run", "gh-leak", "--fixture-set", "representative", "--workspace", root, "--json"], { stdout: () => undefined });
      await runCli(["export", "gh-leak", "--workspace", root, "--json"], { stdout: (line) => exportOut.push(line) });
      expect(exportOut.join("\n")).not.toContain(secret);

      const { readFile } = await import("node:fs/promises");
      const db = await readFile(path.join(root, "pipeline", "idea_finder.db"));
      expect(db.includes(secret)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = previous;
      await rm(root, { recursive: true, force: true });
    }
  });
});
