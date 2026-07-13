import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { asId } from "@idea-finder/core";
import type { SourceConnector } from "@idea-finder/connectors";
import { CLI_EXIT_CODES } from "../src/cli/contract.js";
import { runCli } from "../src/cli/main.js";
import { createOrchestrationResearchRunner } from "../src/orchestration/orchestration-runner.js";
import { resolveWorkspacePaths } from "../src/storage/workspace-store.js";
import { WorkspaceService } from "../src/workspace-service.js";

describe("multi-round research CLI export", () => {
  const leftovers: string[] = [];

  afterEach(async () => {
    await Promise.all(leftovers.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("export reads persisted round ledger instead of inferring saturated", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "idea-finder-export-rounds-"));
    leftovers.push(root);

    let call = 0;
    const connector = (platform: string): SourceConnector => ({
      platform,
      async healthcheck() { return { ok: true }; },
      async *search(query) {
        call += 1;
        yield {
          id: asId(`doc_${platform}_${call}`),
          runId: asId("run_placeholder"),
          platform,
          url: `https://example.test/${platform}/${call}`,
          title: `${query.queryText ?? query.terms[0]}`,
          rawBody: call % 2 === 0
            ? "Manual spreadsheet workaround for agent handoff every sprint"
            : "Agent handoff notes get lost between coding agents on Monday",
          fetchedAt: "2026-07-11T00:00:00.000Z",
          fetchMethod: "test",
          language: "en",
          metadata: {},
        };
      },
      async fetch() { throw new Error("not used"); },
    });

    const runner = createOrchestrationResearchRunner({
      workspaceRoot: root,
      harvestMode: "l0",
      connectors: [connector("hn"), connector("stack_exchange"), connector("github_issues")],
    });
    const service = new WorkspaceService({
      paths: resolveWorkspacePaths(root),
      runner,
    });

    const proposed = await service.proposeSearchPlan({
      topic: "agent handoff pain",
      languages: ["en"],
      sourceFamilies: ["hn", "github_issues"],
      budgets: { queries: 6, documents: 30, rounds: 3 },
    });
    const { brief } = await service.confirmSearchPlan({
      planId: proposed.id,
      mode: "start_now",
      slug: "handoff",
    });
    expect(brief).toBeTruthy();

    await service.runResearch(brief!.slug);

    const exportOut: string[] = [];
    const code = await runCli(["export", brief!.slug, "--json"], {
      workspaceDir: root,
      stdout: (line) => exportOut.push(line),
    });
    expect(code).toBe(CLI_EXIT_CODES.success);
    const envelope = JSON.parse(exportOut.join("\n")) as {
      data: {
        painMap: {
          stats: { roundCount: number; stopReason: string };
          partial: readonly string[];
        };
      };
    };
    const painMap = envelope.data.painMap;
    expect(painMap.stats.roundCount).toBeGreaterThanOrEqual(2);
    expect(painMap.stats.stopReason).not.toBe("unknown");
    expect(["saturated", "budget_exhausted", "budget_exhausted_partial"]).toContain(painMap.stats.stopReason);

    const plan = await service.getSearchPlan(proposed.id);
    expect(plan?.queries.some((query) => query.status === "success")).toBe(true);
    expect(plan?.queries.every((query) => query.status === "pending")).toBe(false);
  });
});
