import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/main.js";
import { createOrchestrationResearchRunner } from "../src/orchestration/orchestration-runner.js";
import { resolveWorkspacePaths } from "../src/storage/workspace-store.js";
import { WorkspaceService } from "../src/workspace-service.js";

const LIVE = process.env.IDEA_FINDER_LIVE_ACCEPTANCE === "1";

describeLive("dual-source live acceptance", () => {
  const leftovers: string[] = [];

  afterEach(async () => {
    await Promise.all(leftovers.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("requires HN and GitHub Issues success with real URLs, ledger rounds, and shared run id", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "idea-finder-live-accept-"));
    leftovers.push(root);

    // Default L0 pack (no fixture injection) — closest to production CLI path.
    const service = new WorkspaceService({
      paths: resolveWorkspacePaths(root),
      runner: createOrchestrationResearchRunner({
        workspaceRoot: root,
        harvestMode: "l0",
      }),
    });

    const proposed = await service.proposeSearchPlan({
      topic: "coding agent context handoff",
      languages: ["en"],
      sourceFamilies: ["hn", "github_issues"],
      budgets: { queries: 8, documents: 200, rounds: 2 },
    });
    const { brief } = await service.confirmSearchPlan({
      planId: proposed.id,
      mode: "start_now",
      slug: "live-handoff",
    });
    const stored = await service.runResearch(brief!.slug);
    const runId = stored.run.id;

    const planOut: string[] = [];
    expect(await runCli(["plan", "inspect", proposed.id, "--json"], {
      workspaceDir: root,
      stdout: (line) => planOut.push(line),
    })).toBe(0);

    const exportOut: string[] = [];
    const exportCode = await runCli(["export", brief!.slug, "--json"], {
      workspaceDir: root,
      stdout: (line) => exportOut.push(line),
    });
    // partialResult (6) is acceptable when some source legs are incomplete; success (0) preferred.
    expect([0, 6]).toContain(exportCode);
    const exported = JSON.parse(exportOut.join("\n")) as {
      data: {
        runId: string;
        painMap: { stats: { roundCount: number; documentCount: number; stopReason: string } };
        markdown?: string;
      };
    };

    expect(exported.data.runId).toBe(runId);
    expect(exported.data.painMap.stats.roundCount).toBeGreaterThanOrEqual(2);
    expect(exported.data.painMap.stats.documentCount).toBeGreaterThan(0);
    expect(exported.data.painMap.stats.stopReason).not.toBe("unknown");
    expect(["saturated", "budget_exhausted", "budget_exhausted_partial"]).toContain(exported.data.painMap.stats.stopReason);

    const ledger = service.getResearchRunConfig(runId)?.researchLedger;
    expect(ledger?.rounds.length).toBeGreaterThanOrEqual(2);
    expect(ledger?.stopReason).toBe(exported.data.painMap.stats.stopReason);

    const statuses = service.listResearchSourceStatuses(runId);
    const hnOk = statuses.some((status) => status.source === "hn" && status.status === "success" && status.itemCount > 0);
    const ghOk = statuses.some((status) => status.source === "github_issues" && status.status === "success" && status.itemCount > 0);
    expect(hnOk).toBe(true);
    expect(ghOk).toBe(true);

    const docs = stored.documents.filter((doc) => doc.platform === "hn" || doc.platform === "github_issues");
    expect(docs.some((doc) => doc.platform === "hn")).toBe(true);
    expect(docs.some((doc) => doc.platform === "github_issues")).toBe(true);
    expect(docs.every((doc) => typeof doc.url === "string" && doc.url.startsWith("http"))).toBe(true);
    expect(docs.every((doc) => doc.fetchMethod !== "fixture" && !doc.url.includes("fixture"))).toBe(true);

    const artifactDir = process.env.IDEA_FINDER_LIVE_ACCEPTANCE_OUT;
    if (artifactDir) {
      await writeFile(path.join(artifactDir, "export-summary.json"), JSON.stringify({
        runId,
        stopReason: exported.data.painMap.stats.stopReason,
        roundCount: exported.data.painMap.stats.roundCount,
        documentCount: exported.data.painMap.stats.documentCount,
        hnOk,
        ghOk,
        sampleUrls: docs.slice(0, 6).map((doc) => ({ platform: doc.platform, url: doc.url })),
      }, null, 2));
      if (exported.data.markdown) {
        await writeFile(path.join(artifactDir, "export.md"), exported.data.markdown);
      }
    }
  }, 180_000);
});

function describeLive(name: string, fn: () => void) {
  if (LIVE) describe(name, fn);
  else describe.skip(name, fn);
}
