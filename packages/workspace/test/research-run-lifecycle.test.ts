import { describe, expect, it } from "vitest";
import { asId } from "@idea-finder/core";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildQueryPlanFromBrief,
  effectiveResearchConfigHash,
} from "../src/orchestration/query-plan-builder.js";
import type { HuntingBrief } from "../src/types.js";
import { resolveWorkspacePaths } from "../src/storage/workspace-store.js";
import { WorkspaceService } from "../src/workspace-service.js";
import { emptyWorkspaceState } from "../src/types.js";
import { openLocalStorage } from "@idea-finder/storage";
import { createFixtureResearchRunner } from "../src/ports/runner-impl.js";

function brief(overrides: Partial<HuntingBrief> = {}): HuntingBrief {
  return {
    id: asId("task_lifecycle"),
    slug: "lifecycle",
    title: "Lifecycle",
    description: "Description is context, not imported evidence",
    lenses: ["pain"],
    sourcesEnabled: ["manual"],
    successCriteria: "explicit evidence only",
    createdAt: "2026-07-11T00:00:00.000Z",
    ...overrides,
  };
}

describe("ResearchRun configuration", () => {
  it("does not synthesize manual imports or demonstration evidence", () => {
    expect(buildQueryPlanFromBrief(brief(), asId("task_lifecycle"))).toEqual({
      huntingTaskId: asId("task_lifecycle"),
      searches: [],
      manualImports: [],
    });
  });

  it("retains only explicitly supplied manual imports", () => {
    const configured = brief({
      queryPlan: {
        harvestMode: "manual",
        manualImports: [{ text: "Explicit interview note", url: "https://example.test/note" }],
      },
    });
    expect(buildQueryPlanFromBrief(configured, configured.id).manualImports).toEqual([
      { text: "Explicit interview note", url: "https://example.test/note" },
    ]);
  });

  it("hashes effective configuration stably and detects meaningful changes", () => {
    const original = brief();
    expect(effectiveResearchConfigHash(original)).toBe(effectiveResearchConfigHash({ ...original }));
    expect(effectiveResearchConfigHash(original)).not.toBe(
      effectiveResearchConfigHash({ ...original, lenses: ["pain", "wtp"] }),
    );
    expect(effectiveResearchConfigHash(original)).not.toBe(
      effectiveResearchConfigHash({ ...original, description: "Changed research context" }),
    );
  });
});

describe("legacy Brief compatibility", () => {
  it("imports JSON Briefs into SQLite idempotently and survives source removal", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "idea-finder-legacy-brief-"));
    try {
      const legacy = brief({ slug: "legacy", id: asId("task_legacy") });
      const briefsDir = path.join(root, "briefs");
      await mkdir(briefsDir, { recursive: true });
      const legacyPath = path.join(briefsDir, "legacy.json");
      await writeFile(legacyPath, `${JSON.stringify(legacy, null, 2)}\n`, "utf8");

      const first = new WorkspaceService({ paths: resolveWorkspacePaths(root) });
      expect(await first.listBriefs()).toEqual([legacy]);
      await rm(legacyPath);

      const restarted = new WorkspaceService({ paths: resolveWorkspacePaths(root) });
      expect(await restarted.getBrief("legacy")).toEqual(legacy);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("runs legacy research import once and never lets later JSON overwrite SQLite", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "idea-finder-legacy-once-"));
    try {
      const service = new WorkspaceService({ paths: resolveWorkspacePaths(root), runnerMode: "fixture" });
      await service.createBrief({ slug: "once", title: "Once", description: "fixture", queryPlan: undefined });
      const result = await service.runResearch("once");
      const originalChunk = result.chunks[0]!;
      const poisoned = { ...originalChunk, text: "poisoned legacy text" };
      await writeFile(path.join(root, "state.json"), `${JSON.stringify({
        ...emptyWorkspaceState(),
        runs: [{ ...result, chunks: [poisoned, ...result.chunks.slice(1)] }],
      }, null, 2)}\n`, "utf8");

      const restarted = new WorkspaceService({ paths: resolveWorkspacePaths(root) });
      await restarted.getState();
      const storage = openLocalStorage({ dataDir: path.join(root, "pipeline") });
      expect(storage.chunks.get(result.run.id, originalChunk.id)).toEqual(originalChunk);
      storage.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("imports legacy research JSON into canonical SQLite before marking migration complete", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "idea-finder-legacy-research-"));
    try {
      const legacyBrief = brief({ slug: "legacy-research", id: asId("task_legacy_research") });
      const runner = createFixtureResearchRunner();
      const output = await runner.run(legacyBrief, {
        runId: asId("run_legacy_research"),
        taskId: legacyBrief.id,
        execution: "new",
      });
      const rejected = output.admissionResults.filter((result) => result.decision === "rejected").map((result) => ({
        draftId: result.id as never,
        draft: output.drafts.find((draft) => draft.id === result.id)!,
        issues: [...result.issues],
      }));
      await mkdir(path.join(root, "briefs"), { recursive: true });
      await writeFile(path.join(root, "briefs", "legacy-research.json"), `${JSON.stringify(legacyBrief)}\n`, "utf8");
      await writeFile(path.join(root, "state.json"), `${JSON.stringify({
        ...emptyWorkspaceState(),
        runs: [{
          execution: "new",
          run: output.run,
          briefId: legacyBrief.id,
          documents: output.documents,
          chunks: output.chunks,
          signals: output.signals,
          evidence: output.evidence,
          drafts: output.drafts,
          opportunities: output.opportunities,
          rejected,
          admissionResults: output.admissionResults,
          sourceStatuses: output.sourceStatuses,
          admittedCount: output.opportunities.length,
          inbox: [],
        }],
        opportunities: Object.fromEntries(output.opportunities.map((item) => [item.id, item])),
      }, null, 2)}\n`, "utf8");

      const service = new WorkspaceService({ paths: resolveWorkspacePaths(root) });
      expect((await service.listOpportunities("legacy-research")).length).toBeGreaterThan(0);
      await rm(path.join(root, "state.json"));
      const restarted = new WorkspaceService({ paths: resolveWorkspacePaths(root) });
      expect((await restarted.listAdmissionResults(output.run.id)).length).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps Library reads scoped when deterministic IDs repeat across runs", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "idea-finder-run-scoped-library-"));
    try {
      const service = new WorkspaceService({ paths: resolveWorkspacePaths(root), runnerMode: "fixture" });
      await service.createBrief({ slug: "scoped", title: "Scoped", description: "fixture" });
      const first = await service.runResearch("scoped");
      const second = await service.runResearch("scoped");
      const opportunities = await service.listOpportunities("scoped");
      expect(opportunities).toHaveLength(1);
      await expect(service.inspectOpportunity(opportunities[0]!.id)).resolves.toMatchObject({ runId: second.run.id });
      await expect(service.inspectOpportunity(opportunities[0]!.id, second.run.id)).resolves.toMatchObject({
        runId: second.run.id,
        opportunity: { id: opportunities[0]!.id },
      });
      expect(first.run.id).not.toBe(second.run.id);

      await service.createBrief({ slug: "other-brief", title: "Other", description: "fixture" });
      const other = await service.runResearch("other-brief");
      const scopedEntries = await service.listOpportunityEntries("scoped");
      expect(scopedEntries).toHaveLength(2);
      expect(scopedEntries.every((entry) => entry.runId !== other.run.id)).toBe(true);
      await expect(service.inspectOpportunity(scopedEntries[0]!.opportunity.id, scopedEntries[0]!.runId)).resolves.toMatchObject({
        runId: scopedEntries[0]!.runId,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
