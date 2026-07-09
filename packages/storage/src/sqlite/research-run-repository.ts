import type { DatabaseSync } from "node:sqlite";

import type { ResearchRun } from "@idea-finder/core";

import type { ResearchRunRepository } from "../ports/repositories.js";

export function createResearchRunRepository(db: DatabaseSync): ResearchRunRepository {
  const getStmt = db.prepare(
    `SELECT id, hunting_task_id, status, started_at, completed_at, config_hash, error_message
     FROM research_runs WHERE id = ?`,
  );
  const findStmt = db.prepare(
    `SELECT id, hunting_task_id, status, started_at, completed_at, config_hash, error_message
     FROM research_runs WHERE hunting_task_id = ? AND config_hash = ?`,
  );
  const upsertStmt = db.prepare(
    `INSERT INTO research_runs
      (id, hunting_task_id, status, started_at, completed_at, config_hash, error_message)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
      hunting_task_id = excluded.hunting_task_id,
      status = excluded.status,
      started_at = excluded.started_at,
      completed_at = excluded.completed_at,
      config_hash = excluded.config_hash,
      error_message = excluded.error_message`,
  );

  return {
    get(id) {
      const row = getStmt.get(id) as Row | undefined;
      return row ? rowToRun(row) : null;
    },
    findByTaskAndConfig(huntingTaskId, configHash) {
      const row = findStmt.get(huntingTaskId, configHash) as Row | undefined;
      return row ? rowToRun(row) : null;
    },
    save(run) {
      upsertStmt.run(
        run.id,
        run.huntingTaskId,
        run.status,
        run.startedAt,
        run.completedAt,
        run.configHash,
        run.errorMessage,
      );
    },
  };
}

interface Row {
  id: string;
  hunting_task_id: string;
  status: ResearchRun["status"];
  started_at: string | null;
  completed_at: string | null;
  config_hash: string;
  error_message: string | null;
}

function rowToRun(row: Row): ResearchRun {
  return {
    id: row.id as ResearchRun["id"],
    huntingTaskId: row.hunting_task_id as ResearchRun["huntingTaskId"],
    status: row.status,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    configHash: row.config_hash,
    errorMessage: row.error_message,
  };
}
