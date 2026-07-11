import type { DatabaseSync } from "node:sqlite";
import type { CalibrationEvent } from "@idea-finder/core";
import type { CalibrationEventRepository } from "../ports/repositories.js";

export function createCalibrationEventRepository(db: DatabaseSync): CalibrationEventRepository {
  const insert = db.prepare(
    "INSERT INTO calibration_events (id, research_run_id, payload_json) VALUES (?, ?, ?)",
  );
  const get = db.prepare(
    "SELECT payload_json FROM calibration_events WHERE research_run_id = ? AND id = ?",
  );
  const list = db.prepare(
    "SELECT payload_json FROM calibration_events WHERE research_run_id = ? ORDER BY rowid",
  );
  return {
    append(runId, event) {
      insert.run(event.id, runId, JSON.stringify(event));
    },
    get(runId, id) {
      const row = get.get(runId, id) as { payload_json: string } | undefined;
      return row ? JSON.parse(row.payload_json) as CalibrationEvent : null;
    },
    listByRun(runId) {
      return (list.all(runId) as Array<{ payload_json: string }>).map((row) => JSON.parse(row.payload_json) as CalibrationEvent);
    },
  };
}
