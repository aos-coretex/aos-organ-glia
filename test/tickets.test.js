import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { initDatabase } from '../server/db/init.js';
import { createTicketsRouter } from '../server/routes/tickets.js';

describe('Tickets API', () => {
  let db;
  let app;
  let baseUrl;
  let server;
  let createdUrn;

  before(async () => {
    db = initDatabase(':memory:');
    app = express();
    app.use(express.json());
    app.use('/tickets', createTicketsRouter(db));

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

  it('1. should create a ticket (POST /tickets)', async () => {
    const res = await fetch(`${baseUrl}/tickets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        test_id: 'symlinks-resolve',
        detail: 'Symlink check failed: 1/109 broken',
        source: 'cv',
      }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.test_id, 'symlinks-resolve');
    assert.equal(body.state, 'pending');
    assert.ok(body.ticket_urn.startsWith('urn:autoheal:ticket:'));
    assert.ok(body.created_at);
    createdUrn = body.ticket_urn;
  });

  it('2. should deduplicate open tickets for same test_id', async () => {
    const res = await fetch(`${baseUrl}/tickets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        test_id: 'symlinks-resolve',
        detail: 'Second attempt — same test',
        source: 'cv',
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ticket_urn, createdUrn);
    assert.equal(body.deduplicated, true);
  });

  it('3. should get a ticket by URN (GET /tickets/:urn)', async () => {
    const encoded = encodeURIComponent(createdUrn);
    const res = await fetch(`${baseUrl}/tickets/${encoded}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ticket_urn, createdUrn);
    assert.equal(body.test_id, 'symlinks-resolve');
    assert.equal(body.state, 'pending');
    assert.equal(body.classification, null);
    assert.equal(body.proposed_fix, null);
    assert.equal(body.layer1_handler, null);
    assert.equal(body.layer2_model, null);
    assert.equal(body.layer3_method, null);
    assert.equal(body.resolved_at, null);
  });

  it('4. should return 404 for non-existent ticket', async () => {
    const encoded = encodeURIComponent('urn:autoheal:ticket:nonexistent');
    const res = await fetch(`${baseUrl}/tickets/${encoded}`);
    assert.equal(res.status, 404);
  });

  it('5. should reject ticket creation with invalid source', async () => {
    const res = await fetch(`${baseUrl}/tickets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        test_id: 'test-1',
        detail: 'bad source',
        source: 'manual',
      }),
    });
    assert.equal(res.status, 400);
  });

  it('6. should reject ticket creation with missing fields', async () => {
    const res = await fetch(`${baseUrl}/tickets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ test_id: 'test-1' }),
    });
    assert.equal(res.status, 400);
  });

  it('7. should dispatch with classification data (L1 direct: pending → dispatched)', async () => {
    const encoded = encodeURIComponent(createdUrn);
    const res = await fetch(`${baseUrl}/tickets/${encoded}/dispatch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        classification: 'operational',
        handler: 'handler_symlink_redeploy',
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.state, 'dispatched');

    // Verify metadata merged
    const getRes = await fetch(`${baseUrl}/tickets/${encoded}`);
    const ticket = await getRes.json();
    assert.equal(ticket.classification, 'operational');
    assert.equal(ticket.layer1_handler, 'handler_symlink_redeploy');
  });

  it('8. should transition to healing (dispatched → healing)', async () => {
    const encoded = encodeURIComponent(createdUrn);
    const res = await fetch(`${baseUrl}/tickets/${encoded}/heal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'handler' }),
    });
    assert.equal(res.status, 202);
    const body = await res.json();
    assert.equal(body.state, 'healing');
  });

  it('9. should resolve as solved (healing → solved)', async () => {
    const encoded = encodeURIComponent(createdUrn);
    const res = await fetch(`${baseUrl}/tickets/${encoded}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outcome: 'solved' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.state, 'solved');
    assert.ok(body.resolved_at);
  });

  it('10. should allow new ticket for same test_id after resolution', async () => {
    const res = await fetch(`${baseUrl}/tickets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        test_id: 'symlinks-resolve',
        detail: 'New failure after resolution',
        source: 'cv',
      }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.notEqual(body.ticket_urn, createdUrn);
  });

  it('11. should return ticket queue with state summary', async () => {
    const res = await fetch(`${baseUrl}/tickets/queue`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.tickets));
    assert.ok(typeof body.count === 'number');
    assert.ok(body.states);
    assert.ok(typeof body.states.pending === 'number');
    assert.ok(typeof body.states.solved === 'number');
  });

  it('12. should filter queue by state', async () => {
    const res = await fetch(`${baseUrl}/tickets/queue?state=solved`);
    assert.equal(res.status, 200);
    const body = await res.json();
    for (const t of body.tickets) {
      assert.equal(t.state, 'solved');
    }
  });

  it('13. should filter queue by test_id', async () => {
    const res = await fetch(`${baseUrl}/tickets/queue?test_id=symlinks-resolve`);
    assert.equal(res.status, 200);
    const body = await res.json();
    for (const t of body.tickets) {
      assert.equal(t.test_id, 'symlinks-resolve');
    }
  });

  it('14. should reject dispatch with invalid classification', async () => {
    // Create a fresh ticket first
    const createRes = await fetch(`${baseUrl}/tickets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ test_id: 'validate-test', detail: 'test', source: 'cv' }),
    });
    const { ticket_urn } = await createRes.json();
    const encoded = encodeURIComponent(ticket_urn);

    const res = await fetch(`${baseUrl}/tickets/${encoded}/dispatch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ classification: 'unknown_type' }),
    });
    assert.equal(res.status, 400);
  });

  it('15. should reject heal with invalid method', async () => {
    const encoded = encodeURIComponent(createdUrn);
    const res = await fetch(`${baseUrl}/tickets/${encoded}/heal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'invalid' }),
    });
    assert.equal(res.status, 400);
  });

  it('16. should reject resolve with invalid outcome', async () => {
    const encoded = encodeURIComponent(createdUrn);
    const res = await fetch(`${baseUrl}/tickets/${encoded}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outcome: 'closed' }),
    });
    assert.equal(res.status, 400);
  });

  it('17. should reject reject without reason', async () => {
    const encoded = encodeURIComponent(createdUrn);
    const res = await fetch(`${baseUrl}/tickets/${encoded}/reject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
  });
});
