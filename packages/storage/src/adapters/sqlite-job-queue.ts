import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type { Job, JobQueue } from "../ports/job-queue.js";

export function createSqliteJobQueue(db: DatabaseSync): JobQueue {
  const findStmt = db.prepare(`SELECT * FROM jobs WHERE idempotency_key = ?`);
  const insertStmt = db.prepare(
    `INSERT INTO jobs
      (id, queue, type, payload_json, idempotency_key, status, run_id, attempts, max_attempts)
     VALUES (?, 'default', ?, ?, ?, 'pending', NULL, 0, 3)`,
  );

  return {
    async enqueue(type, payload, idempotencyKey) {
      const existing = findStmt.get(idempotencyKey) as JobRow | undefined;
      if (existing) {
        return rowToJob(existing);
      }

      const id = randomUUID();
      insertStmt.run(id, type, JSON.stringify(payload), idempotencyKey);
      const row = findStmt.get(idempotencyKey) as JobRow | undefined;
      if (!row) {
        throw new Error(`Job insert failed for idempotency key: ${idempotencyKey}`);
      }
      return rowToJob(row);
    },
  };
}

interface JobRow {
  id: string;
  type: string;
  payload_json: string;
  idempotency_key: string;
  status: Job["status"];
}

function rowToJob<TPayload>(row: JobRow): Job<TPayload> {
  return {
    id: row.id,
    type: row.type,
    payload: JSON.parse(row.payload_json) as TPayload,
    idempotencyKey: row.idempotency_key,
    status: row.status,
  };
}
