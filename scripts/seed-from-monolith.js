import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { initDatabase } from '../server/db/init.js';

const sourcePath = resolve(process.env.SOURCE_DB_PATH || '/Library/AI/AI-Datastore/AI-KB-DB/ai-kb.db');
const targetPath = resolve(process.env.GLIA_DB_PATH || './data/glia.db');

function log(event, data = {}) {
  const entry = { timestamp: new Date().toISOString(), event, ...data };
  process.stdout.write(JSON.stringify(entry) + '\n');
}

try {
  const startMs = Date.now();

  log('seed_start', { source: sourcePath, target: targetPath });

  // Open source in read-only mode
  const sourceDb = new Database(sourcePath, { readonly: true });

  // Initialize target database (creates schema if needed)
  const targetDb = initDatabase(targetPath);

  // Query autoheal_ticket concepts from source
  const ticketRows = sourceDb.prepare(
    "SELECT urn, data, created_at FROM concepts WHERE json_extract(data, '$.type') = 'autoheal_ticket'"
  ).all();

  // Query remediation_result concepts from source
  const remediationRows = sourceDb.prepare(
    "SELECT urn, data, created_at FROM concepts WHERE json_extract(data, '$.type') = 'remediation_result'"
  ).all();

  log('seed_query_complete', {
    autoheal_tickets_found: ticketRows.length,
    remediation_results_found: remediationRows.length,
  });

  // Insert into target with INSERT OR IGNORE (idempotent)
  const insert = targetDb.prepare(
    'INSERT OR IGNORE INTO concepts (urn, data, created_at) VALUES (?, ?, ?)'
  );

  let ticketsMigrated = 0;
  let remediationMigrated = 0;
  let skipped = 0;

  const transaction = targetDb.transaction(() => {
    for (const row of ticketRows) {
      const result = insert.run(row.urn, row.data, row.created_at);
      if (result.changes > 0) {
        ticketsMigrated++;
      } else {
        skipped++;
      }
    }
    for (const row of remediationRows) {
      const result = insert.run(row.urn, row.data, row.created_at);
      if (result.changes > 0) {
        remediationMigrated++;
      } else {
        skipped++;
      }
    }
  });
  transaction();

  const elapsedMs = Date.now() - startMs;

  log('seed_complete', {
    tickets_migrated: ticketsMigrated,
    remediation_results_migrated: remediationMigrated,
    skipped,
    total_source_rows: ticketRows.length + remediationRows.length,
    elapsed_ms: elapsedMs,
  });

  sourceDb.close();
  targetDb.close();

  process.exit(0);
} catch (err) {
  log('seed_error', { error: err.message });
  process.exit(1);
}
