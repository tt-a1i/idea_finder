import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CLI_EXIT_CODES } from "../src/cli/contract.js";
import { runCli } from "../src/cli/main.js";

async function machine(args: string[], root: string) {
  const lines: string[] = [];
  const code = await runCli([...args, "--workspace", root, "--json"], { stdout: (line) => lines.push(line) });
  return { code, envelope: JSON.parse(lines[0]!) };
}

describe("npm and PyPI package adoption lane", () => {
  it("persists both ecosystems with explicit non-conflated identity and restart inspection", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "idea-finder-package-downloads-"));
    try {
      for (const [ecosystem, name] of [["npm", "requests"], ["pypi", "Requests"]] as const) {
        const collected = await machine(["trends", "collect", ecosystem, name, "--from", "2026-01-01", "--to", "2026-01-03", "--fixture"], root);
        expect(collected.code).toBe(0);
        expect(collected.envelope).toMatchObject({ data: { observations: expect.any(Array), event: { kind: "momentum_up", detector: "package_download_delta_v1" }, sourceHealth: [expect.objectContaining({ status: "success", ecosystem })] } });
        expect(collected.envelope.data.observations).toHaveLength(3);
        expect(collected.envelope.data.observations[0]).toMatchObject({ ecosystem, lane: "developer_adoption", normalizedValue: 100, provenance: { interface: "recorded_fixture" } });
      }
      expect((await machine(["trends", "collect", "npm", "requests", "--from", "2026-01-04", "--to", "2026-01-06", "--fixture"], root)).code).toBe(0);
      expect((await machine(["trends", "collect", "npm", "requests", "--from", "2026-01-08", "--to", "2026-01-09", "--fixture"], root)).code).toBe(0);
      expect((await machine(["trends", "collect", "npm", "requests", "--from", "2026-01-07", "--to", "2026-01-07", "--fixture"], root)).code).toBe(0);
      expect((await machine(["trends", "collect", "npm", "requests", "--from", "2026-01-02", "--to", "2026-01-04", "--fixture"], root)).code).toBe(0);
      const npm = await machine(["trends", "inspect", "package", "--ecosystem", "npm", "--package", "requests", "--from", "2026-01-01", "--to", "2026-01-06"], root);
      const npmAll = await machine(["trends", "inspect", "package", "--ecosystem", "npm", "--package", "requests"], root);
      const npmFirstWindow = await machine(["trends", "inspect", "package", "--ecosystem", "npm", "--package", "requests", "--from", "2026-01-01", "--to", "2026-01-03"], root);
      const pypi = await machine(["trends", "inspect", "package", "--ecosystem", "pypi", "--package", "Requests"], root);
      expect(npm.envelope.data.observations).toHaveLength(6);
      expect(npm.envelope.data.series).toHaveLength(1);
      expect(npm.envelope.data.series[0].observationIds).toHaveLength(6);
      expect(npmFirstWindow.envelope.data.observations).toHaveLength(3);
      expect(npmFirstWindow.envelope.data.series).toHaveLength(1);
      expect(npmFirstWindow.envelope.data.series[0].observationIds).toHaveLength(3);
      expect(npmFirstWindow.envelope.data.events.every((event: { currentValue: number }) => event.currentValue <= 300)).toBe(true);
      expect(npmAll.envelope.data.observations).toHaveLength(9);
      expect(npmAll.envelope.data.series).toHaveLength(1);
      expect(npmAll.envelope.data.series[0].observationIds).toHaveLength(9);
      expect(pypi.envelope.data.observations).toHaveLength(3);
      expect(npm.envelope.data.observations[0].subject.externalId).toBe("npm:requests");
      expect(pypi.envelope.data.observations[0].subject.externalId).toBe("pypi:requests");
      expect(npm.envelope.data.observations.every((item: { ecosystem: string }) => item.ecosystem === "npm")).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    ["npm", "rate_limited", CLI_EXIT_CODES.partialResult],
    ["npm", "missing_package", CLI_EXIT_CODES.missingResource],
    ["npm", "unavailable_history", CLI_EXIT_CODES.partialResult],
    ["npm", "response_drift", CLI_EXIT_CODES.partialResult],
    ["pypi", "unavailable_history", CLI_EXIT_CODES.partialResult],
  ] as const)("persists structured %s %s without a partial batch", async (ecosystem, failure, exit) => {
    const root = await mkdtemp(path.join(os.tmpdir(), `idea-finder-package-${failure}-`));
    try {
      const result = await machine(["trends", "collect", ecosystem, "fixture-package", "--from", "2026-01-01", "--to", "2026-01-03", "--fixture", "--fixture-failure", failure], root);
      expect(result.code).toBe(exit);
      expect(result.envelope).toMatchObject({ errors: [{ code: `package_downloads.${failure}` }], data: { sourceHealth: [expect.objectContaining({ status: failure, itemCount: 0 })] } });
      if (failure === "rate_limited") expect(result.envelope.data.retryAt).toBe("2026-02-01T00:00:00.000Z");
      const inspected = await machine(["trends", "inspect", "package", "--ecosystem", ecosystem, "--package", "fixture-package"], root);
      expect(inspected.envelope.data.observations).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("retains partial PyPI history with an explicit coverage gap and excludes unfinished buckets from momentum", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "idea-finder-package-partial-coverage-"));
    try {
      const { resolveWorkspacePaths } = await import("../src/storage/workspace-store.js");
      const { WorkspaceService } = await import("../src/workspace-service.js");
      const service = new WorkspaceService({ paths: resolveWorkspacePaths(root) });
      const connector = {
        ecosystem: "pypi" as const,
        async collect() {
          const provenance = { provider: "pypistats" as const, interface: "pypistats_public_api" as const, sourceRef: "https://pypistats.test/partial", retrievedAt: "2026-07-12T12:00:00.000Z", caveat: "partial" };
          return {
            ecosystem: "pypi" as const,
            package: "tool",
            from: "2026-07-10",
            to: "2026-07-12",
            provenance,
            buckets: [
              { id: "a", ecosystem: "pypi" as const, package: "tool", subject: "pypi:tool", day: "2026-07-10", downloads: 100, provenance },
              { id: "b", ecosystem: "pypi" as const, package: "tool", subject: "pypi:tool", day: "2026-07-11", downloads: 200, provenance },
              { id: "c", ecosystem: "pypi" as const, package: "tool", subject: "pypi:tool", day: "2026-07-12", downloads: 0, provenance },
            ],
            missingDays: [] as string[],
            coverageComplete: true,
          };
        },
      };
      const result = await service.collectPackageDownloads({
        ecosystem: "pypi",
        packageName: "tool",
        from: "2026-07-10",
        to: "2026-07-12",
        connector,
        now: () => new Date("2026-07-12T12:00:00.000Z"),
      });
      expect(result.observations).toHaveLength(3);
      expect(result.observations.at(-1)?.bucket.partial).toBe(true);
      expect(result.event?.kind).toBe("momentum_up");
      expect(result.event?.kind).not.toBe("momentum_down");

      const incomplete = await service.collectPackageDownloads({
        ecosystem: "pypi",
        packageName: "gap-tool",
        from: "2026-07-01",
        to: "2026-07-03",
        connector: {
          ecosystem: "pypi",
          async collect() {
            const provenance = { provider: "pypistats" as const, interface: "pypistats_public_api" as const, sourceRef: "https://pypistats.test/gap", retrievedAt: "2026-07-04T00:00:00.000Z", caveat: null };
            return {
              ecosystem: "pypi" as const,
              package: "gap-tool",
              from: "2026-07-01",
              to: "2026-07-03",
              provenance,
              buckets: [
                { id: "d1", ecosystem: "pypi" as const, package: "gap-tool", subject: "pypi:gap-tool", day: "2026-07-01", downloads: 10, provenance },
                { id: "d3", ecosystem: "pypi" as const, package: "gap-tool", subject: "pypi:gap-tool", day: "2026-07-03", downloads: 30, provenance },
              ],
              missingDays: ["2026-07-02"],
              coverageComplete: false,
            };
          },
        },
        now: () => new Date("2026-07-04T00:00:00.000Z"),
      });
      expect(incomplete.observations).toHaveLength(2);
      expect(incomplete.coverageComplete).toBe(false);
      expect(incomplete.missingDays).toEqual(["2026-07-02"]);
      expect(service.listQuantitativeSourceStatuses().some((item) => item.packageName === "gap-tool" && item.status === "partial" && item.itemCount === 2)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
