import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { asId } from "@idea-finder/core";
import { resolveWorkspacePaths } from "../src/storage/workspace-store.js";
import { emptyWorkspaceState, type AgentTask } from "../src/types.js";
import { WorkspaceService } from "../src/workspace-service.js";

describe("canonical decision state", () => {
  it("migrates supported legacy JSON once and survives restart and JSON removal", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "idea-finder-decision-migration-"));
    try {
      const service = new WorkspaceService({ paths: resolveWorkspacePaths(root), runnerMode: "fixture" });
      const brief = await service.createBrief({ slug: "legacy-decisions", title: "Legacy decisions", description: "fixture" });
      const run = await service.runResearch(brief.slug);
      const base = run.opportunities[0]!;
      const promoted = {
        ...base,
        status: "promoted" as const,
        provenance: { ...base.provenance, promotedBy: "user" as const },
      };
      const event = {
        id: asId("cal_legacy"),
        opportunityId: promoted.id,
        actor: "user" as const,
        action: "promote" as const,
        note: "legacy promotion",
        occurredAt: "2026-07-11T00:00:00.000Z",
      };
      const experiment = {
        id: asId("vexp_legacy"),
        opportunityId: promoted.id,
        type: "mom_test" as const,
        hypothesis: "legacy hypothesis",
        status: "completed" as const,
        result: {
          outcome: "validated" as const,
          summary: "legacy outcome",
          recordedAt: "2026-07-11T00:00:02.000Z",
          recordedBy: "user" as const,
        },
        artifacts: [],
        createdAt: "2026-07-11T00:00:01.000Z",
        updatedAt: "2026-07-11T00:00:02.000Z",
      };
      const schedule = {
        id: asId(`mon_${brief.id}`),
        briefId: brief.id,
        cadence: "weekly" as const,
        lastComparedRunId: run.run.id,
        enabled: true,
        createdAt: "2026-07-11T00:00:03.000Z",
      };
      const task: AgentTask = {
        id: "agent_legacy",
        kind: "research",
        intent: "legacy task",
        status: "succeeded",
        opportunityId: promoted.id,
        evidenceIds: [],
        dryRun: false,
        plannedEffects: [],
        createdAt: "2026-07-11T00:00:04.000Z",
        updatedAt: "2026-07-11T00:00:04.000Z",
        invocations: [],
      };

      const db = new DatabaseSync(path.join(root, "pipeline", "idea_finder.db"));
      db.exec(`
        DELETE FROM compatibility_migrations WHERE id = 'legacy-decision-json-v2';
        DELETE FROM calibration_events;
        DELETE FROM validation_experiments;
        DELETE FROM monitor_schedules;
        DELETE FROM agent_tasks;
      `);
      db.close();
      await writeFile(path.join(root, "state.json"), `${JSON.stringify({
        ...emptyWorkspaceState(),
        runs: [run],
        opportunities: { [promoted.id]: promoted },
        calibrationEvents: [event],
        validationExperiments: { [experiment.id]: experiment },
        monitorSchedules: { [schedule.id]: schedule },
        agentTasks: { [task.id]: task },
      }, null, 2)}\n`, "utf8");

      const migrating = new WorkspaceService({ paths: resolveWorkspacePaths(root) });
      const migrated = await migrating.getState();
      expect(migrated.opportunities[promoted.id]?.status).toBe("promoted");
      expect(migrated.calibrationEvents).toEqual([event]);
      expect(migrated.validationExperiments[experiment.id]).toEqual(experiment);
      expect(migrated.monitorSchedules[schedule.id]).toEqual(schedule);
      expect(migrated.agentTasks[task.id]).toEqual(task);

      await rm(path.join(root, "state.json"));
      const restarted = new WorkspaceService({ paths: resolveWorkspacePaths(root) });
      expect((await restarted.inspectOpportunity(promoted.id, run.run.id)).opportunity.status).toBe("promoted");
      expect(await restarted.listValidationExperiments(promoted.id)).toEqual([experiment]);
      expect(await restarted.getMonitorSchedule(brief.slug)).toEqual(schedule);
      expect(await restarted.getAgentTask(task.id)).toEqual(task);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps calibration events append-only", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "idea-finder-calibration-append-"));
    try {
      const service = new WorkspaceService({ paths: resolveWorkspacePaths(root), runnerMode: "fixture" });
      await service.createBrief({ slug: "append", title: "Append", description: "fixture" });
      const run = await service.runResearch("append");
      const opportunity = run.opportunities[0]!;
      await expect(service.applyBoardCalibration({ opportunityId: opportunity.id, runId: run.run.id, action: "promote", actor: "browser_agent" })).rejects.toThrow("cannot calibrate");
      await expect(service.applyBoardCalibration({ opportunityId: opportunity.id, runId: run.run.id, action: "promote", actor: "computer_agent" })).rejects.toThrow("cannot calibrate");
      const first = await service.applyBoardCalibration({ opportunityId: opportunity.id, runId: run.run.id, action: "park" });
      const moreEvidence = await service.applyBoardCalibration({ opportunityId: opportunity.id, runId: run.run.id, action: "needs_more_evidence" });
      const rejected = await service.applyBoardCalibration({ opportunityId: opportunity.id, runId: run.run.id, action: "reject" });
      const promoted = await service.applyBoardCalibration({ opportunityId: opportunity.id, runId: run.run.id, action: "promote" });
      expect([first.opportunity.status, moreEvidence.opportunity.status, rejected.opportunity.status, promoted.opportunity.status])
        .toEqual(["parked", "hypothesis", "rejected", "promoted"]);
      const inspected = await service.inspectOpportunity(opportunity.id, run.run.id);
      expect(inspected.calibrationEvents).toEqual([first.event, moreEvidence.event, rejected.event, promoted.event]);
      const db = new DatabaseSync(path.join(root, "pipeline", "idea_finder.db"));
      expect(() => db.prepare(
        "INSERT INTO calibration_events (id, research_run_id, payload_json) VALUES (?, ?, ?)",
      ).run(first.event.id, run.run.id, JSON.stringify({ ...first.event, note: "overwrite" }))).toThrow();
      db.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed and rolls back legacy decision migration with orphan references", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "idea-finder-decision-orphan-"));
    try {
      const service = new WorkspaceService({ paths: resolveWorkspacePaths(root), runnerMode: "fixture" });
      const brief = await service.createBrief({ slug: "orphan", title: "Orphan", description: "fixture" });
      const run = await service.runResearch(brief.slug);
      const opportunity = run.opportunities[0]!;
      const event = {
        id: asId("cal_before_orphan"), opportunityId: opportunity.id, actor: "user" as const,
        action: "park" as const, note: "must roll back", occurredAt: "2026-07-11T02:00:00.000Z",
      };
      const db = new DatabaseSync(path.join(root, "pipeline", "idea_finder.db"));
      db.exec("DELETE FROM compatibility_migrations WHERE id = 'legacy-decision-json-v2'; DELETE FROM calibration_events;");
      db.close();
      await writeFile(path.join(root, "state.json"), `${JSON.stringify({
        ...emptyWorkspaceState(),
        runs: [run],
        opportunities: { [opportunity.id]: opportunity },
        calibrationEvents: [event],
        monitorSchedules: {
          mon_orphan: {
            id: "mon_orphan", briefId: "task_missing", cadence: "weekly",
            lastComparedRunId: run.run.id, enabled: true, createdAt: "2026-07-11T02:00:01.000Z",
          },
        },
      })}\n`, "utf8");

      await expect(new WorkspaceService({ paths: resolveWorkspacePaths(root) }).getState())
        .rejects.toThrow("references a missing Brief");
      const rolledBack = new DatabaseSync(path.join(root, "pipeline", "idea_finder.db"));
      expect((rolledBack.prepare("SELECT COUNT(*) AS count FROM calibration_events").get() as { count: number }).count).toBe(0);
      expect((rolledBack.prepare("SELECT COUNT(*) AS count FROM compatibility_migrations WHERE id = 'legacy-decision-json-v2'").get() as { count: number }).count).toBe(0);
      rolledBack.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed when deterministic Opportunity IDs make legacy run provenance ambiguous", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "idea-finder-decision-ambiguous-"));
    try {
      const service = new WorkspaceService({ paths: resolveWorkspacePaths(root), runnerMode: "fixture" });
      const brief = await service.createBrief({ slug: "ambiguous", title: "Ambiguous", description: "fixture" });
      const first = await service.runResearch(brief.slug);
      const second = await service.runResearch(brief.slug);
      const opportunity = first.opportunities[0]!;
      expect(second.opportunities.some((item) => item.id === opportunity.id)).toBe(true);
      const db = new DatabaseSync(path.join(root, "pipeline", "idea_finder.db"));
      db.exec("DELETE FROM compatibility_migrations WHERE id = 'legacy-decision-json-v2'; DELETE FROM calibration_events;");
      db.close();
      await writeFile(path.join(root, "state.json"), `${JSON.stringify({
        ...emptyWorkspaceState(),
        runs: [first, second],
        opportunities: { [opportunity.id]: opportunity },
        calibrationEvents: [{
          id: "cal_ambiguous", opportunityId: opportunity.id, actor: "user", action: "park",
          note: "unknown run", occurredAt: "2026-07-11T03:00:00.000Z",
        }],
      })}\n`, "utf8");

      await expect(new WorkspaceService({ paths: resolveWorkspacePaths(root) }).getState())
        .rejects.toThrow("ambiguous ResearchRun provenance");
      const rolledBack = new DatabaseSync(path.join(root, "pipeline", "idea_finder.db"));
      expect((rolledBack.prepare("SELECT COUNT(*) AS count FROM calibration_events").get() as { count: number }).count).toBe(0);
      expect((rolledBack.prepare("SELECT COUNT(*) AS count FROM compatibility_migrations WHERE id = 'legacy-decision-json-v2'").get() as { count: number }).count).toBe(0);
      rolledBack.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
