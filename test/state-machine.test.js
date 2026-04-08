import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { initDatabase } from '../server/db/init.js';
import { createTicketsRouter } from '../server/routes/tickets.js';

// Helper to create a ticket and drive it to a target state
async function createTicketInState(baseUrl, testId, targetState) {
  // Create
  const createRes = await fetch(`${baseUrl}/tickets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ test_id: testId, detail: `Test for ${targetState}`, source: 'cv' }),
  });
  const { ticket_urn } = await createRes.json();
  const encoded = encodeURIComponent(ticket_urn);

  if (targetState === 'pending') return ticket_urn;

  if (targetState === 'classifying') {
    await fetch(`${baseUrl}/tickets/${encoded}/classify`, { method: 'POST' });
    return ticket_urn;
  }

  if (targetState === 'dispatched') {
    await fetch(`${baseUrl}/tickets/${encoded}/dispatch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ classification: 'operational' }),
    });
    return ticket_urn;
  }

  if (targetState === 'healing') {
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
    return ticket_urn;
  }

  if (targetState === 'solved') {
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
    return ticket_urn;
  }

  if (targetState === 'human_required') {
    await fetch(`${baseUrl}/tickets/${encoded}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outcome: 'human_required', reason: 'Escalation test' }),
    });
    return ticket_urn;
  }

  throw new Error(`Unknown target state: ${targetState}`);
}

describe('State Machine — Valid Transitions', () => {
  let db, app, baseUrl, server;
  let seq = 0;

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

  function nextTestId() { return `sm-valid-${++seq}`; }

  it('1. pending → classifying', async () => {
    const urn = await createTicketInState(baseUrl, nextTestId(), 'pending');
    const encoded = encodeURIComponent(urn);
    const res = await fetch(`${baseUrl}/tickets/${encoded}/classify`, { method: 'POST' });
    assert.equal(res.status, 202);
    const body = await res.json();
    assert.equal(body.state, 'classifying');
  });

  it('2. pending → dispatched (L1 direct)', async () => {
    const urn = await createTicketInState(baseUrl, nextTestId(), 'pending');
    const encoded = encodeURIComponent(urn);
    const res = await fetch(`${baseUrl}/tickets/${encoded}/dispatch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ classification: 'operational', handler: 'handler_capture_processor' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.state, 'dispatched');
  });

  it('3. classifying → dispatched (L2 result)', async () => {
    const urn = await createTicketInState(baseUrl, nextTestId(), 'classifying');
    const encoded = encodeURIComponent(urn);
    const res = await fetch(`${baseUrl}/tickets/${encoded}/dispatch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        classification: 'logic_bug',
        model: 'claude-sonnet-4-5-20250514',
        reasoning: 'Test handler has stale assertion',
        confidence: 0.85,
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.state, 'dispatched');

    // Verify L2 metadata was stored
    const getRes = await fetch(`${baseUrl}/tickets/${encoded}`);
    const ticket = await getRes.json();
    assert.equal(ticket.classification, 'logic_bug');
    assert.equal(ticket.layer2_model, 'claude-sonnet-4-5-20250514');
    assert.equal(ticket.layer2_reasoning, 'Test handler has stale assertion');
  });

  it('4. classifying → human_required (L2 ambiguous)', async () => {
    const urn = await createTicketInState(baseUrl, nextTestId(), 'classifying');
    const encoded = encodeURIComponent(urn);
    const res = await fetch(`${baseUrl}/tickets/${encoded}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outcome: 'human_required', reason: 'L2 confidence below threshold' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.state, 'human_required');
  });

  it('5. dispatched → healing', async () => {
    const urn = await createTicketInState(baseUrl, nextTestId(), 'dispatched');
    const encoded = encodeURIComponent(urn);
    const res = await fetch(`${baseUrl}/tickets/${encoded}/heal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'handler' }),
    });
    assert.equal(res.status, 202);
    const body = await res.json();
    assert.equal(body.state, 'healing');
  });

  it('6. healing → solved', async () => {
    const urn = await createTicketInState(baseUrl, nextTestId(), 'healing');
    const encoded = encodeURIComponent(urn);
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

  it('7. healing → human_required', async () => {
    const urn = await createTicketInState(baseUrl, nextTestId(), 'healing');
    const encoded = encodeURIComponent(urn);
    const res = await fetch(`${baseUrl}/tickets/${encoded}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outcome: 'human_required', reason: 'Handler execution failed' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.state, 'human_required');
  });

  it('8. pending → human_required (escalation)', async () => {
    const urn = await createTicketInState(baseUrl, nextTestId(), 'pending');
    const encoded = encodeURIComponent(urn);
    const res = await fetch(`${baseUrl}/tickets/${encoded}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outcome: 'human_required', reason: 'Repeat failure threshold' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.state, 'human_required');
  });

  it('9. dispatched → human_required (escalation)', async () => {
    const urn = await createTicketInState(baseUrl, nextTestId(), 'dispatched');
    const encoded = encodeURIComponent(urn);
    const res = await fetch(`${baseUrl}/tickets/${encoded}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outcome: 'human_required', reason: 'Manual escalation' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.state, 'human_required');
  });

  it('10. solved → human_required (escalation escape hatch)', async () => {
    const urn = await createTicketInState(baseUrl, nextTestId(), 'solved');
    const encoded = encodeURIComponent(urn);
    const res = await fetch(`${baseUrl}/tickets/${encoded}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outcome: 'human_required', reason: 'Fix was incorrect' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.state, 'human_required');
  });
});

describe('State Machine — Invalid Transitions', () => {
  let db, app, baseUrl, server;
  let seq = 0;

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

  function nextTestId() { return `sm-invalid-${++seq}`; }

  it('11. classifying cannot be classified again', async () => {
    const urn = await createTicketInState(baseUrl, nextTestId(), 'classifying');
    const encoded = encodeURIComponent(urn);
    const res = await fetch(`${baseUrl}/tickets/${encoded}/classify`, { method: 'POST' });
    assert.equal(res.status, 409);
  });

  it('12. dispatched cannot be classified', async () => {
    const urn = await createTicketInState(baseUrl, nextTestId(), 'dispatched');
    const encoded = encodeURIComponent(urn);
    const res = await fetch(`${baseUrl}/tickets/${encoded}/classify`, { method: 'POST' });
    assert.equal(res.status, 409);
  });

  it('13. healing cannot be dispatched', async () => {
    const urn = await createTicketInState(baseUrl, nextTestId(), 'healing');
    const encoded = encodeURIComponent(urn);
    const res = await fetch(`${baseUrl}/tickets/${encoded}/dispatch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ classification: 'operational' }),
    });
    assert.equal(res.status, 409);
  });

  it('14. pending cannot be healed', async () => {
    const urn = await createTicketInState(baseUrl, nextTestId(), 'pending');
    const encoded = encodeURIComponent(urn);
    const res = await fetch(`${baseUrl}/tickets/${encoded}/heal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'handler' }),
    });
    assert.equal(res.status, 409);
  });

  it('15. classifying cannot be healed', async () => {
    const urn = await createTicketInState(baseUrl, nextTestId(), 'classifying');
    const encoded = encodeURIComponent(urn);
    const res = await fetch(`${baseUrl}/tickets/${encoded}/heal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'handler' }),
    });
    assert.equal(res.status, 409);
  });

  it('16. pending cannot be resolved as solved', async () => {
    const urn = await createTicketInState(baseUrl, nextTestId(), 'pending');
    const encoded = encodeURIComponent(urn);
    const res = await fetch(`${baseUrl}/tickets/${encoded}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outcome: 'solved' }),
    });
    assert.equal(res.status, 409);
  });

  it('17. dispatched cannot be resolved as solved', async () => {
    const urn = await createTicketInState(baseUrl, nextTestId(), 'dispatched');
    const encoded = encodeURIComponent(urn);
    const res = await fetch(`${baseUrl}/tickets/${encoded}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outcome: 'solved' }),
    });
    assert.equal(res.status, 409);
  });

  it('18. human_required cannot transition further', async () => {
    const urn = await createTicketInState(baseUrl, nextTestId(), 'human_required');
    const encoded = encodeURIComponent(urn);

    // Cannot classify
    const r1 = await fetch(`${baseUrl}/tickets/${encoded}/classify`, { method: 'POST' });
    assert.equal(r1.status, 409);

    // Cannot dispatch
    const r2 = await fetch(`${baseUrl}/tickets/${encoded}/dispatch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ classification: 'operational' }),
    });
    assert.equal(r2.status, 409);

    // Cannot heal
    const r3 = await fetch(`${baseUrl}/tickets/${encoded}/heal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'handler' }),
    });
    assert.equal(r3.status, 409);

    // Cannot escalate again (already human_required)
    const r4 = await fetch(`${baseUrl}/tickets/${encoded}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outcome: 'human_required', reason: 'Double escalation' }),
    });
    assert.equal(r4.status, 409);
  });

  it('19. solved cannot be classified/dispatched/healed', async () => {
    const urn = await createTicketInState(baseUrl, nextTestId(), 'solved');
    const encoded = encodeURIComponent(urn);

    const r1 = await fetch(`${baseUrl}/tickets/${encoded}/classify`, { method: 'POST' });
    assert.equal(r1.status, 409);

    const r2 = await fetch(`${baseUrl}/tickets/${encoded}/dispatch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ classification: 'operational' }),
    });
    assert.equal(r2.status, 409);

    const r3 = await fetch(`${baseUrl}/tickets/${encoded}/heal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'handler' }),
    });
    assert.equal(r3.status, 409);
  });
});

describe('State Machine — Approve/Reject', () => {
  let db, app, baseUrl, server;
  let seq = 0;

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

  function nextTestId() { return `sm-approve-${++seq}`; }

  it('20. approve requires proposed_fix', async () => {
    const urn = await createTicketInState(baseUrl, nextTestId(), 'healing');
    const encoded = encodeURIComponent(urn);
    const res = await fetch(`${baseUrl}/tickets/${encoded}/approve`, { method: 'POST' });
    assert.equal(res.status, 409);
  });

  it('21. approve succeeds when proposed_fix is present', async () => {
    const urn = await createTicketInState(baseUrl, nextTestId(), 'healing');
    const encoded = encodeURIComponent(urn);

    // Inject proposed_fix directly into DB
    const row = db.prepare('SELECT data FROM concepts WHERE urn = ?').get(urn);
    const data = JSON.parse(row.data);
    data.proposed_fix = {
      description: 'Fix threshold in test',
      files: [{ path: 'test/cv.sh', before: '6', after: '7' }],
    };
    db.prepare('UPDATE concepts SET data = ? WHERE urn = ?').run(JSON.stringify(data), urn);

    const res = await fetch(`${baseUrl}/tickets/${encoded}/approve`, { method: 'POST' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.state, 'solved');
    assert.ok(body.resolved_at);
  });

  it('22. reject transitions to human_required with reason', async () => {
    const urn = await createTicketInState(baseUrl, nextTestId(), 'healing');
    const encoded = encodeURIComponent(urn);
    const res = await fetch(`${baseUrl}/tickets/${encoded}/reject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'Fix addresses symptom, not root cause' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.state, 'human_required');
    assert.equal(body.reason, 'Fix addresses symptom, not root cause');
  });
});
