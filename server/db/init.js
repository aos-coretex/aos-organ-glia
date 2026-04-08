import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function initDatabase(dbPath) {
  // Create parent directory if needed (skip for in-memory)
  if (dbPath !== ':memory:') {
    mkdirSync(dirname(dbPath), { recursive: true });
  }

  const db = new Database(dbPath);

  // Pragmas
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');

  // Core table — concepts (graph-native model, local to Glia)
  db.exec(`
    CREATE TABLE IF NOT EXISTS concepts (
      urn TEXT PRIMARY KEY,
      data TEXT NOT NULL CHECK(json_valid(data)),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Schema versioning
  db.exec(`
    CREATE TABLE IF NOT EXISTS op_config (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);
  db.exec(`INSERT OR IGNORE INTO op_config (key, value) VALUES ('schema_version', '1.0.0')`);

  // Indexes for query performance
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_concepts_type
      ON concepts(json_extract(data, '$.type'))
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_concepts_state
      ON concepts(json_extract(data, '$.state'))
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_concepts_test_id
      ON concepts(json_extract(data, '$.test_id'))
  `);

  return db;
}
