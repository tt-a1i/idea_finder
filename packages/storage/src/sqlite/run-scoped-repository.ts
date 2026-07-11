import type { DatabaseSync } from "node:sqlite";

import type { ResearchRunId } from "@idea-finder/core";

import type { RunScopedRepository } from "../ports/repositories.js";

export function createRunScopedRepository<T extends { id: string }>(
  db: DatabaseSync,
  table: string,
): RunScopedRepository<T> {
  const getStmt = db.prepare(`SELECT payload_json FROM ${table} WHERE research_run_id = ? AND id = ?`);
  const listStmt = db.prepare(
    `SELECT payload_json FROM ${table} WHERE research_run_id = ? ORDER BY id`,
  );
  const upsertStmt = db.prepare(
    `INSERT INTO ${table} (id, research_run_id, payload_json)
     VALUES (?, ?, ?)
     ON CONFLICT(research_run_id, id) DO UPDATE SET
       payload_json = excluded.payload_json`,
  );

  return {
    save(runId: ResearchRunId, entity: T) {
      upsertStmt.run(entity.id, runId, JSON.stringify(entity));
    },
    get(runId: ResearchRunId, id: string) {
      const row = getStmt.get(runId, id) as { payload_json: string } | undefined;
      return row ? (JSON.parse(row.payload_json) as T) : null;
    },
    listByRun(runId: ResearchRunId) {
      const rows = listStmt.all(runId) as { payload_json: string }[];
      return rows.map((row) => JSON.parse(row.payload_json) as T);
    },
  };
}
