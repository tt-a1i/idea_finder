import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { asId } from "@idea-finder/core";
import type { ResearchRun } from "@idea-finder/core";

import { openLocalStorage } from "./index.js";

function tempDataDir(): string {
  return mkdtempSync(join(tmpdir(), "idea-finder-storage-"));
}

const sampleRun = (): ResearchRun => ({
  id: asId("run_test_1"),
  huntingTaskId: asId("task_test_1"),
  status: "pending",
  startedAt: null,
  completedAt: null,
  configHash: "cfg_test_v1",
  errorMessage: null,
});

describe("@idea-finder/storage local persistence", () => {
  it("round-trips ResearchRun and is idempotent on schema init", () => {
    const dataDir = tempDataDir();
    try {
      const storage1 = openLocalStorage({ dataDir });
      storage1.researchRuns.save(sampleRun());
      storage1.close();

      const storage2 = openLocalStorage({ dataDir });
      const loaded = storage2.researchRuns.get(asId("run_test_1"));
      expect(loaded).toEqual(sampleRun());
      storage2.close();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("finds runs by huntingTaskId + configHash", () => {
    const dataDir = tempDataDir();
    try {
      const storage = openLocalStorage({ dataDir });
      storage.researchRuns.save(sampleRun());
      const found = storage.researchRuns.findByTaskAndConfig(
        asId("task_test_1"),
        "cfg_test_v1",
      );
      expect(found?.id).toBe(asId("run_test_1"));
      storage.close();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("round-trips run-scoped entities", () => {
    const dataDir = tempDataDir();
    const runId = asId("run_entities");
    try {
      const storage = openLocalStorage({ dataDir });

      const doc = {
        id: asId("doc_1"),
        sourceTier: "L1" as const,
        platform: "hn",
        externalId: null,
        url: "https://example.com/1",
        fetchedAt: "2026-07-09T00:00:00.000Z",
        fetchMethod: "api" as const,
        fetchAgentRunId: null,
        contentType: "post" as const,
        rawBody: "body",
        huntingTaskId: asId("task_1"),
        retentionClass: "standard" as const,
        legalBasis: "public_api_tos" as const,
      };

      storage.rawDocuments.save(runId, doc);
      expect(storage.rawDocuments.get(asId("doc_1"))).toEqual(doc);
      expect(storage.rawDocuments.listByRun(runId)).toEqual([doc]);

      storage.close();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("stores blobs content-addressed under data/blobs", async () => {
    const dataDir = tempDataDir();
    try {
      const storage = openLocalStorage({ dataDir });
      const content = new TextEncoder().encode("blob-content");
      const ref1 = await storage.blobs.put(content);
      const ref2 = await storage.blobs.put(content);

      expect(ref1.hash).toBe(ref2.hash);
      expect(ref1.path).toContain(join("blobs"));
      expect(await storage.blobs.get(ref1)).toEqual(content);
      storage.close();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("enqueues jobs idempotently", async () => {
    const dataDir = tempDataDir();
    try {
      const storage = openLocalStorage({ dataDir });
      const job1 = await storage.jobs.enqueue("harvest", { runId: "r1" }, "key-1");
      const job2 = await storage.jobs.enqueue("harvest", { runId: "r1" }, "key-1");
      expect(job1.id).toBe(job2.id);
      storage.close();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("tracks pipeline steps for idempotent orchestration", () => {
    const dataDir = tempDataDir();
    const runId = asId("run_steps");
    try {
      const storage = openLocalStorage({ dataDir });
      expect(storage.pipelineSteps.isComplete(runId, "harvest")).toBe(false);
      storage.pipelineSteps.markComplete(runId, "harvest");
      expect(storage.pipelineSteps.isComplete(runId, "harvest")).toBe(true);
      storage.pipelineSteps.markComplete(runId, "harvest");
      expect(storage.pipelineSteps.isComplete(runId, "harvest")).toBe(true);
      storage.close();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
