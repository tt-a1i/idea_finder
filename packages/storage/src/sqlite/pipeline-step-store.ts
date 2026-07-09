import type { DatabaseSync } from "node:sqlite";

import type { ResearchRunId } from "@idea-finder/core";

import type { PipelineStepStore } from "../ports/repositories.js";

export function createPipelineStepStore(db: DatabaseSync): PipelineStepStore {
  const getStmt = db.prepare(
    `SELECT 1 FROM pipeline_steps WHERE research_run_id = ? AND step = ?`,
  );
  const insertStmt = db.prepare(
    `INSERT OR IGNORE INTO pipeline_steps (research_run_id, step, completed_at)
     VALUES (?, ?, ?)`,
  );

  return {
    isComplete(runId: ResearchRunId, step: string) {
      return getStmt.get(runId, step) !== undefined;
    },
    markComplete(runId: ResearchRunId, step: string) {
      insertStmt.run(runId, step, new Date().toISOString());
    },
  };
}
