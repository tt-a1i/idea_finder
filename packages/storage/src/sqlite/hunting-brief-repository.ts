import type { DatabaseSync } from "node:sqlite";
import type { JsonEntityRepository } from "../ports/repositories.js";

export function createHuntingBriefRepository<T extends { readonly id: string; readonly slug: string }>(
  db: DatabaseSync,
): JsonEntityRepository<T> {
  const getStmt = db.prepare("SELECT payload_json FROM hunting_briefs WHERE id = ?");
  const listStmt = db.prepare("SELECT payload_json FROM hunting_briefs ORDER BY slug");
  const insertStmt = db.prepare(
    "INSERT INTO hunting_briefs (id, slug, payload_json) VALUES (?, ?, ?)",
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
      insertStmt.run(entity.id, entity.slug, JSON.stringify(entity));
    },
  };
}
