import type { DatabaseSync } from "node:sqlite";
import type { JsonEntityRepository } from "../ports/repositories.js";

export function createJsonEntityRepository<T extends { readonly id: string }>(
  db: DatabaseSync,
  table: string,
): JsonEntityRepository<T> {
  const getStmt = db.prepare(`SELECT payload_json FROM ${table} WHERE id = ?`);
  const listStmt = db.prepare(`SELECT payload_json FROM ${table} ORDER BY rowid`);
  const upsertStmt = db.prepare(
    `INSERT INTO ${table} (id, payload_json) VALUES (?, ?)
     ON CONFLICT(id) DO UPDATE SET payload_json = excluded.payload_json`,
  );
  return {
    get(id) {
      const row = getStmt.get(id) as { payload_json: string } | undefined;
      return row ? JSON.parse(row.payload_json) as T : null;
    },
    list() {
      return (listStmt.all() as Array<{ payload_json: string }>).map((row) => JSON.parse(row.payload_json) as T);
    },
    save(entity) {
      upsertStmt.run(entity.id, JSON.stringify(entity));
    },
  };
}
