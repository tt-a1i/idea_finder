import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveWorkspacePaths } from "../src/storage/workspace-store.js";
import { WorkspaceService } from "../src/workspace-service.js";
import type { PackageDownloadsConnector } from "@idea-finder/connectors";

describe("multi-lane demand research", () => {
  it("builds a run-scoped five-lane report with traceable refs, duplicate independence, unvalidated quantitative candidate, and follow-up", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "idea-finder-multi-lane-"));
    try {
      const service = new WorkspaceService({ paths: resolveWorkspacePaths(root) });
      await service.createBrief({
        slug: "agent-demand", title: "Agent demand", description: "Agent coding workflows",
        queryPlan: {
          harvestMode: "manual",
          manualImports: [
            { text: "I manually reconcile agent coding runs every day and this workaround is painful.", url: "https://example.test/a" },
            { text: "Mirror header — I manually reconcile agent coding runs every day and this workaround is painful. — republished", url: "https://mirror.test/a" },
            { text: "I would pay $30 per month to stop reconciling failed agent runs.", url: "https://example.test/wtp" },
            { text: "Our current agent workflow works fine and needs no replacement.", url: "https://example.test/no" },
          ],
          quantitative: {
            googleTrends: [{ subject: "agent coding", geography: "US", from: "2026-01-01T00:00:00Z", to: "2026-01-10T00:00:00Z", granularity: "day" }],
            github: [{ repository: "owner/repo" }],
            packages: [{ ecosystem: "npm", package: "agent-tool", from: "2026-01-01", to: "2026-01-03" }, { ecosystem: "pypi", package: "agent-tool", from: "2026-01-01", to: "2026-01-03" }],
          },
        },
      });
      const report = await service.runMultiLaneResearch("agent-demand", { fixtureSet: "representative" });
      expect(report.summary.schemaVersion).toBe("1");
      expect(report.summary).not.toHaveProperty("score");
      expect(Object.keys(report.summary.lanes)).toEqual(expect.arrayContaining(["qualitative_demand", "trend_momentum", "supply_competition", "commercial_intent", "contradictory_evidence"]));
      expect(report.summary.lanes.trend_momentum.totalClaims).toBeGreaterThan(0);
      expect(report.summary.lanes.supply_competition.totalClaims).toBeGreaterThan(0);
      expect(report.summary.candidates).toHaveLength(4);
      expect(report.summary.candidates.map((item) => item.id)).toEqual(expect.arrayContaining([expect.stringContaining("trend_only"), expect.stringContaining("ranking_only"), expect.stringContaining("star_only"), expect.stringContaining("download_only")]));
      expect(report.summary.candidates.every((item) => item.status === "unvalidated" && item.admissionOutcome === "rejected" && item.validationIssues.some((issue) => issue.code === "candidate.qualitative_demand_missing"))).toBe(true);
      const rankingClaim = report.claims.find((claim) => claim.evidenceRefs.some((ref) => ref.kind === "ranking_snapshot"));
      const rankingRef = rankingClaim?.evidenceRefs.find((ref) => ref.kind === "ranking_snapshot");
      const rankingObservation = report.observationSnapshots.find((item) => item.id === (rankingRef?.kind === "ranking_snapshot" ? rankingRef.observationId : ""));
      expect(rankingClaim?.statement).toContain("star rank: 1 of 1 in Brief comparison universe");
      expect(rankingObservation).toMatchObject({ metric: "trending_rank", normalizedValue: 1, unit: "rank" });

      const inspected = service.inspectMultiLaneResearch(report.runId as never);
      expect(inspected.details.length).toBe(report.claims.reduce((sum, claim) => sum + claim.evidenceRefs.length, 0));
      expect(inspected.details).toEqual(expect.arrayContaining([expect.objectContaining({ evidence: expect.any(Object), document: expect.any(Object) }), expect.objectContaining({ series: expect.any(Object), observations: expect.any(Array) })]));
      expect((inspected.independence as Array<{ relation: string }>).some((item) => item.relation === "syndicated")).toBe(true);
      expect(inspected.proposals).toHaveLength(1);
      const child = await service.createFollowUpBrief(report.runId as never, inspected.proposals[0]!.id, "agent-demand-followup");
      expect(child.origin).toMatchObject({ kind: "trend_anomaly", parentRunId: report.runId, trendEventId: inspected.proposals[0]!.triggerEventId });
      expect(child.lenses).toEqual(["pain", "workaround", "competition", "commercial_intent"]);
      expect(child.queryPlan?.searches?.length).toBeGreaterThan(0);
      expect(service.inspectMultiLaneResearch(report.runId as never).proposals[0]).toMatchObject({ status: "created", createdBriefId: child.id });
      await expect(service.createFollowUpBrief(report.runId as never, inspected.proposals[0]!.id, "agent-demand-followup")).resolves.toEqual(child);

      const connector: PackageDownloadsConnector = { ecosystem: "npm", async collect(request) {
        const provenance = { provider: "fixture" as const, interface: "recorded_fixture" as const, sourceRef: "fixture://later", retrievedAt: "2026-01-11T00:00:00.000Z", caveat: "Later collection" };
        return { ecosystem: "npm", package: request.package, from: request.from, to: request.to, provenance, buckets: ["2026-01-04", "2026-01-05", "2026-01-06"].map((day, index) => ({ id: `later_${index}`, ecosystem: "npm" as const, package: request.package, subject: `npm:${request.package}`, day, downloads: 500 + index * 100, provenance })) };
      } };
      await service.collectPackageDownloads({ ecosystem: "npm", packageName: "agent-tool", from: "2026-01-04", to: "2026-01-06", connector });
      expect(service.inspectMultiLaneResearch(report.runId as never).details.filter((detail: any) => detail.ref.kind === "observation_series").every((detail: any) => detail.series && detail.observations.every(Boolean))).toBe(true);

      const partial = await service.runMultiLaneResearch("agent-demand", { fixtureSet: "google-throttled" });
      const partialStatuses = service.listResearchSourceStatuses(partial.runId as never);
      expect(partialStatuses).toEqual(expect.arrayContaining([expect.objectContaining({ source: "google_trends", status: "throttled", retryAt: "2026-01-11T00:00:00.000Z" }), expect.objectContaining({ source: "github", status: "success" }), expect.objectContaining({ source: "npm", status: "success" })]));
      expect((await service.getState()).runs.find((item) => item.run.id === partial.runId)?.run.status).toBe("partial");
      expect(service.inspectMultiLaneResearch(partial.runId as never).claims.length).toBeGreaterThan(0);
      const retainedIds = partial.observationSnapshots.map((item) => item.id);
      const recovered = await service.runMultiLaneResearch("agent-demand", { fixtureSet: "representative", execution: "retried", runId: partial.runId as never });
      expect(service.listResearchSourceStatuses(recovered.runId as never).every((status) => status.status === "success")).toBe(true);
      expect((await service.getState()).runs.find((item) => item.run.id === recovered.runId)?.run.status).toBe("completed");
      expect(recovered.observationSnapshots.map((item) => item.id)).toEqual(expect.arrayContaining(retainedIds));
      expect(new Set(recovered.observationSnapshots.map((item) => item.id)).size).toBe(recovered.observationSnapshots.length);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps ResearchRun failed when qualitative pipeline fails before quantitative lanes succeed", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "idea-finder-multi-lane-failed-"));
    try {
      const service = new WorkspaceService({
        paths: resolveWorkspacePaths(root),
        runner: {
          async run(brief, request) {
            const now = new Date().toISOString();
            return {
              execution: request.execution,
              run: {
                id: request.runId,
                huntingTaskId: request.taskId,
                status: "failed",
                startedAt: now,
                completedAt: now,
                configHash: `cfg_${brief.slug}`,
                errorMessage: "transient intelligence failure",
              },
              documents: [],
              chunks: [],
              signals: [],
              evidence: [],
              drafts: [],
              opportunities: [],
              admissionResults: [],
              sourceStatuses: [{
                id: "search:0:manual",
                requestKey: "search:0:manual",
                source: "manual_import",
                status: "success",
                itemCount: 1,
                reasonCode: "none",
                reason: null,
                startedAt: now,
                completedAt: now,
                retryAt: null,
              }],
              config: { id: request.runId, effectiveConfig: { fixture: true }, execution: request.execution },
            };
          },
        },
      });
      await service.createBrief({
        slug: "failed-qual",
        title: "Failed qualitative",
        description: "Intelligence boom",
        queryPlan: {
          harvestMode: "manual",
          manualImports: [{ text: "painful agent reconciliation every day", url: "https://example.test/a" }],
          quantitative: {
            googleTrends: [{ subject: "agent coding", geography: "US", from: "2026-01-01T00:00:00Z", to: "2026-01-10T00:00:00Z", granularity: "day" }],
            github: [{ repository: "owner/repo" }],
            packages: [{ ecosystem: "npm", package: "agent-tool", from: "2026-01-01", to: "2026-01-03" }],
          },
        },
      });
      const report = await service.runMultiLaneResearch("failed-qual", { fixtureSet: "representative" });
      const run = (await service.getState()).runs.find((item) => item.run.id === report.runId)?.run;
      expect(run).toMatchObject({ status: "failed", errorMessage: "transient intelligence failure" });
      expect(service.listResearchSourceStatuses(report.runId as never).some((status) => status.source === "github" && status.status === "success")).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
