import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type { AuditEvent, AuditLog } from "../ports/audit-log.js";

export function createSqliteAuditLog(db: DatabaseSync): AuditLog {
  const insertStmt = db.prepare(
    `INSERT INTO audit_events (id, at, actor, action, resource, payload_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );

  return {
    async append(event: Omit<AuditEvent, "id">) {
      const record: AuditEvent = { id: randomUUID(), ...event };
      insertStmt.run(
        record.id,
        record.at,
        record.actor,
        record.action,
        record.resource,
        JSON.stringify(record.payload),
      );
      return record;
    },
  };
}
