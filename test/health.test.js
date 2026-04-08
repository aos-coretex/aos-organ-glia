import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { initDatabase } from '../server/db/init.js';
import { createHealthRouter } from '../server/routes/health.js';
import { createTicketsRouter } from '../server/routes/tickets.js';

describe('Health and Introspect API', () => {
  let db;
  let app;
  let baseUrl;
  let server;

  before(async () => {
    db = initDatabase(':memory:');
    app = express();
    app.use(express.json());

    const startTime = Date.now();
    app.use('/tickets', createTicketsRouter(db));
    app.use('/', createHealthRouter(db, startTime));

    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    db.close();
  });

  it('1. GET /health returns ok with zero open tickets', async () => {
    const res = await fetch(`${baseUrl}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.db_connected, true);
    assert.equal(body.open_tickets, 0);
    assert.ok(typeof body.uptime_s === 'number');
  });

  it('2. GET /health reflects open ticket count', async () => {
    // Create a ticket (state: pending = open)
    await fetch(`${baseUrl}/tickets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ test_id: 'health-test-1', detail: 'test', source: 'cv' }),
    });

    const res = await fetch(`${baseUrl}/health`);
    const body = await res.json();
    assert.equal(body.open_tickets, 1);
  });

  it('3. GET /introspect returns diagnostics', async () => {
    const res = await fetch(`${baseUrl}/introspect`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(typeof body.total_tickets === 'number');
    assert.ok(body.tickets_by_state);
    assert.equal(body.schema_version, '1.0.0');
    assert.ok(body.db_path !== undefined);
  });

  it('4. GET /introspect shows correct ticket counts by state', async () => {
    // Create another ticket and resolve it
    const createRes = await fetch(`${baseUrl}/tickets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ test_id: 'health-test-2', detail: 'test', source: 'cv' }),
    });
    const { ticket_urn } = await createRes.json();
    const encoded = encodeURIComponent(ticket_urn);

    // Drive to solved
    await fetch(`${baseUrl}/tickets/${encoded}/dispatch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ classification: 'operational' }),
    });
    await fetch(`${baseUrl}/tickets/${encoded}/heal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'handler' }),
    });
    await fetch(`${baseUrl}/tickets/${encoded}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outcome: 'solved' }),
    });

    const res = await fetch(`${baseUrl}/introspect`);
    const body = await res.json();
    assert.equal(body.total_tickets, 2);
    assert.ok(body.tickets_by_state.pending >= 1 || body.tickets_by_state.solved >= 1);
  });

  it('5. GET /introspect shows last_ticket_ts', async () => {
    const res = await fetch(`${baseUrl}/introspect`);
    const body = await res.json();
    assert.ok(body.last_ticket_ts);
  });

  it('6. GET /health open_tickets excludes solved and human_required', async () => {
    // Resolve the remaining open ticket
    const queueRes = await fetch(`${baseUrl}/tickets/queue?state=pending`);
    const queue = await queueRes.json();

    for (const ticket of queue.tickets) {
      const encoded = encodeURIComponent(ticket.ticket_urn);
      await fetch(`${baseUrl}/tickets/${encoded}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ outcome: 'human_required', reason: 'Test cleanup' }),
      });
    }

    const res = await fetch(`${baseUrl}/health`);
    const body = await res.json();
    assert.equal(body.open_tickets, 0);
  });
});
