import { Router } from 'express';

export function createHealthRouter(db, startTime) {
  const router = Router();

  // GET /health — heartbeat
  router.get('/health', (_req, res) => {
    let dbConnected = true;
    let openTickets = 0;

    try {
      const row = db.prepare(
        "SELECT COUNT(*) as count FROM concepts WHERE json_extract(data, '$.type') = 'autoheal_ticket' AND json_extract(data, '$.state') NOT IN ('solved', 'human_required')"
      ).get();
      openTickets = row.count;
    } catch {
      dbConnected = false;
    }

    const uptimeS = Math.floor((Date.now() - startTime) / 1000);
    const status = dbConnected ? 'ok' : 'degraded';

    res.json({
      status,
      uptime_s: uptimeS,
      db_connected: dbConnected,
      open_tickets: openTickets,
    });
  });

  // GET /introspect — diagnostics
  router.get('/introspect', (_req, res) => {
    const totalTickets = db.prepare(
      "SELECT COUNT(*) as count FROM concepts WHERE json_extract(data, '$.type') = 'autoheal_ticket'"
    ).get().count;

    const stateRows = db.prepare(
      "SELECT json_extract(data, '$.state') as state, COUNT(*) as count FROM concepts WHERE json_extract(data, '$.type') = 'autoheal_ticket' GROUP BY json_extract(data, '$.state')"
    ).all();

    const ticketsByState = {};
    for (const row of stateRows) {
      ticketsByState[row.state] = row.count;
    }

    const lastTicketRow = db.prepare(
      "SELECT json_extract(data, '$.created_at') as ts FROM concepts WHERE json_extract(data, '$.type') = 'autoheal_ticket' ORDER BY created_at DESC LIMIT 1"
    ).get();

    const schemaVersion = db.prepare(
      "SELECT value FROM op_config WHERE key = 'schema_version'"
    ).get();

    res.json({
      total_tickets: totalTickets,
      tickets_by_state: ticketsByState,
      last_ticket_ts: lastTicketRow ? lastTicketRow.ts : null,
      schema_version: schemaVersion ? schemaVersion.value : null,
      db_path: db.name,
    });
  });

  return router;
}
