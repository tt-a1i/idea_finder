import type { DatabaseSync } from "node:sqlite";

const RESEARCH_RUNS_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS research_runs (
  id TEXT PRIMARY KEY,
  hunting_task_id TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  config_hash TEXT NOT NULL,
  error_message TEXT
);
CREATE INDEX IF NOT EXISTS idx_research_runs_task_config
  ON research_runs (hunting_task_id, config_hash);
`;

const LEGACY_RUN_SCOPED_TABLES = [
  "raw_documents",
  "chunks",
  "raw_signals",
  "evidence_items",
  "opportunity_drafts",
  "opportunities",
  "calibration_events",
] as const;

export const SCHEMA_SQL = `
${RESEARCH_RUNS_SCHEMA_SQL}

CREATE TABLE IF NOT EXISTS hunting_briefs (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  payload_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS research_run_configs (
  id TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS compatibility_migrations (
  id TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS raw_documents (
  id TEXT NOT NULL,
  research_run_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (research_run_id, id)
);
CREATE INDEX IF NOT EXISTS idx_raw_documents_run ON raw_documents (research_run_id);

CREATE TABLE IF NOT EXISTS chunks (
  id TEXT NOT NULL,
  research_run_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (research_run_id, id)
);
CREATE INDEX IF NOT EXISTS idx_chunks_run ON chunks (research_run_id);

CREATE TABLE IF NOT EXISTS raw_signals (
  id TEXT NOT NULL,
  research_run_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (research_run_id, id)
);
CREATE INDEX IF NOT EXISTS idx_raw_signals_run ON raw_signals (research_run_id);

CREATE TABLE IF NOT EXISTS evidence_items (
  id TEXT NOT NULL,
  research_run_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (research_run_id, id)
);
CREATE INDEX IF NOT EXISTS idx_evidence_items_run ON evidence_items (research_run_id);

CREATE TABLE IF NOT EXISTS opportunity_drafts (
  id TEXT NOT NULL,
  research_run_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (research_run_id, id)
);
CREATE INDEX IF NOT EXISTS idx_opportunity_drafts_run ON opportunity_drafts (research_run_id);

CREATE TABLE IF NOT EXISTS opportunities (
  id TEXT NOT NULL,
  research_run_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (research_run_id, id)
);
CREATE INDEX IF NOT EXISTS idx_opportunities_run ON opportunities (research_run_id);

CREATE TABLE IF NOT EXISTS calibration_events (
  id TEXT NOT NULL,
  research_run_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (research_run_id, id)
);
CREATE INDEX IF NOT EXISTS idx_calibration_events_run ON calibration_events (research_run_id);

CREATE TABLE IF NOT EXISTS library_admission_results (
  id TEXT NOT NULL,
  research_run_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (research_run_id, id)
);
CREATE INDEX IF NOT EXISTS idx_library_admission_results_run ON library_admission_results (research_run_id);

CREATE TABLE IF NOT EXISTS source_statuses (
  id TEXT NOT NULL,
  research_run_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (research_run_id, id)
);
CREATE INDEX IF NOT EXISTS idx_source_statuses_run ON source_statuses (research_run_id);

CREATE TABLE IF NOT EXISTS pipeline_steps (
  research_run_id TEXT NOT NULL,
  step TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  PRIMARY KEY (research_run_id, step)
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  queue TEXT NOT NULL DEFAULT 'default',
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  run_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  scheduled_at TEXT,
  locked_at TEXT,
  locked_by TEXT,
  error TEXT
);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  resource TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
`;

export function initSchema(db: DatabaseSync): void {
  const existing = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'research_runs'",
  ).get() as { sql?: string } | undefined;
  if (existing?.sql?.toUpperCase().includes("UNIQUE (HUNTING_TASK_ID, CONFIG_HASH)")) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(`
        ALTER TABLE research_runs RENAME TO research_runs_legacy_identity;
        ${RESEARCH_RUNS_SCHEMA_SQL}
        INSERT INTO research_runs
          (id, hunting_task_id, status, started_at, completed_at, config_hash, error_message)
        SELECT id, hunting_task_id, status, started_at, completed_at, config_hash, error_message
        FROM research_runs_legacy_identity;
        DROP TABLE research_runs_legacy_identity;
        COMMIT;
      `);
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  for (const table of LEGACY_RUN_SCOPED_TABLES) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; pk: number }>;
    const idColumn = columns.find((column) => column.name === "id");
    const runColumn = columns.find((column) => column.name === "research_run_id");
    if (idColumn?.pk === 1 && runColumn?.pk === 0) {
      const legacyTable = `${table}_legacy_global_id`;
      const indexName = `idx_${table}_run`;
      db.exec("BEGIN IMMEDIATE");
      try {
        db.exec(`
          ALTER TABLE ${table} RENAME TO ${legacyTable};
          DROP INDEX IF EXISTS ${indexName};
          CREATE TABLE ${table} (
            id TEXT NOT NULL,
            research_run_id TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            PRIMARY KEY (research_run_id, id)
          );
          INSERT INTO ${table} (id, research_run_id, payload_json)
          SELECT id, research_run_id, payload_json FROM ${legacyTable};
          DROP TABLE ${legacyTable};
          CREATE INDEX ${indexName} ON ${table} (research_run_id);
          COMMIT;
        `);
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }
  }
  db.exec(SCHEMA_SQL);
}
