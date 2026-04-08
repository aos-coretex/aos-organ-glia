import { Router } from 'express';

// Ticket state machine — strict transitions only
const VALID_TRANSITIONS = {
  pending:        ['classifying', 'dispatched', 'human_required'],
  classifying:    ['dispatched', 'human_required'],
  dispatched:     ['healing', 'human_required'],
  healing:        ['solved', 'human_required'],
  solved:         ['human_required'],
  human_required: [],
};

const TERMINAL_STATES = ['solved', 'human_required'];

function isValidTransition(from, to) {
  const allowed = VALID_TRANSITIONS[from];
  return allowed ? allowed.includes(to) : false;
}

function getTicket(db, urn) {
  const row = db.prepare('SELECT urn, data, created_at FROM concepts WHERE urn = ?').get(urn);
  if (!row) return null;
  return { urn: row.urn, ...JSON.parse(row.data) };
}

function updateTicketData(db, urn, patch) {
  const row = db.prepare('SELECT data FROM concepts WHERE urn = ?').get(urn);
  if (!row) return null;
  const data = { ...JSON.parse(row.data), ...patch };
  db.prepare('UPDATE concepts SET data = ? WHERE urn = ?').run(JSON.stringify(data), urn);
  return data;
}

function transitionTicket(db, urn, targetState, patch = {}) {
  const ticket = getTicket(db, urn);
  if (!ticket) return { error: 'Ticket not found', status: 404 };

  if (!isValidTransition(ticket.state, targetState)) {
    return {
      error: `Invalid transition: ${ticket.state} → ${targetState}`,
      status: 409,
      ticket,
    };
  }

  const updated = updateTicketData(db, urn, { state: targetState, ...patch });
  return { ticket: { ticket_urn: urn, ...updated }, status: null };
}

export function createTicketsRouter(db) {
  const router = Router();

  // GET /queue — ticket queue with state summary (MUST be before /:urn)
  router.get('/queue', (req, res) => {
    const { state, test_id } = req.query;

    let query = "SELECT urn, data FROM concepts WHERE json_extract(data, '$.type') = 'autoheal_ticket'";
    const params = [];

    if (state) {
      query += " AND json_extract(data, '$.state') = ?";
      params.push(state);
    }
    if (test_id) {
      query += " AND json_extract(data, '$.test_id') = ?";
      params.push(test_id);
    }

    query += ' ORDER BY created_at DESC';

    const rows = db.prepare(query).all(...params);
    const tickets = rows.map((row) => {
      const data = JSON.parse(row.data);
      return { ticket_urn: row.urn, ...data };
    });

    // State summary — always count all tickets regardless of filter
    const allRows = db.prepare(
      "SELECT json_extract(data, '$.state') as state FROM concepts WHERE json_extract(data, '$.type') = 'autoheal_ticket'"
    ).all();

    const states = { pending: 0, classifying: 0, dispatched: 0, healing: 0, solved: 0, human_required: 0 };
    for (const row of allRows) {
      if (states[row.state] !== undefined) {
        states[row.state]++;
      }
    }

    res.json({ tickets, count: tickets.length, states });
  });

  // POST / — create a heal ticket
  router.post('/', (req, res) => {
    const { test_id, detail, source } = req.body;

    if (!test_id || !detail || source !== 'cv') {
      return res.status(400).json({
        error: 'Missing or invalid fields. Required: test_id (string), detail (string), source ("cv")',
        status: 400,
      });
    }

    // Deduplication — check for open ticket on same test_id
    const existing = db.prepare(
      "SELECT urn, data FROM concepts WHERE json_extract(data, '$.type') = 'autoheal_ticket' AND json_extract(data, '$.test_id') = ? AND json_extract(data, '$.state') NOT IN ('solved', 'human_required')"
    ).get(test_id);

    if (existing) {
      const data = JSON.parse(existing.data);
      return res.status(200).json({
        ticket_urn: existing.urn,
        test_id: data.test_id,
        state: data.state,
        created_at: data.created_at,
        deduplicated: true,
      });
    }

    const now = new Date().toISOString();
    const urn = `urn:autoheal:ticket:${now}-${test_id}`;

    const data = {
      type: 'autoheal_ticket',
      test_id,
      state: 'pending',
      detail,
      source,
      classification: null,
      proposed_fix: null,
      layer1_repeat_count: 0,
      layer1_handler: null,
      layer2_model: null,
      layer2_reasoning: null,
      layer2_confidence: null,
      layer3_method: null,
      layer3_outcome: null,
      created_at: now,
      resolved_at: null,
    };

    db.prepare(
      'INSERT INTO concepts (urn, data, created_at) VALUES (?, ?, ?)'
    ).run(urn, JSON.stringify(data), now);

    res.status(201).json({
      ticket_urn: urn,
      test_id,
      state: 'pending',
      created_at: now,
    });
  });

  // GET /:urn — full ticket status
  router.get('/:urn', (req, res) => {
    const urn = req.params.urn;
    const ticket = getTicket(db, urn);

    if (!ticket) {
      return res.status(404).json({ error: 'Ticket not found', status: 404 });
    }

    res.json({
      ticket_urn: ticket.urn,
      test_id: ticket.test_id,
      state: ticket.state,
      detail: ticket.detail,
      classification: ticket.classification,
      proposed_fix: ticket.proposed_fix,
      layer1_repeat_count: ticket.layer1_repeat_count,
      layer1_handler: ticket.layer1_handler,
      layer2_model: ticket.layer2_model,
      layer2_reasoning: ticket.layer2_reasoning,
      layer3_method: ticket.layer3_method,
      layer3_outcome: ticket.layer3_outcome,
      created_at: ticket.created_at,
      resolved_at: ticket.resolved_at,
    });
  });

  // POST /:urn/classify — transition to classifying
  router.post('/:urn/classify', (req, res) => {
    const urn = req.params.urn;
    const ticket = getTicket(db, urn);

    if (!ticket) {
      return res.status(404).json({ error: 'Ticket not found', status: 404 });
    }

    if (ticket.state !== 'pending') {
      return res.status(409).json({
        error: `Cannot classify: ticket is in '${ticket.state}' state, must be 'pending'`,
        status: 409,
      });
    }

    updateTicketData(db, urn, { state: 'classifying' });

    res.status(202).json({
      ticket_urn: urn,
      state: 'classifying',
    });
  });

  // POST /:urn/dispatch — transition to dispatched with classification data
  router.post('/:urn/dispatch', (req, res) => {
    const urn = req.params.urn;
    const { classification, handler, model, reasoning, confidence } = req.body;

    if (!classification || !['operational', 'logic_bug', 'architectural_error'].includes(classification)) {
      return res.status(400).json({
        error: 'Missing or invalid classification (operational|logic_bug|architectural_error)',
        status: 400,
      });
    }

    const ticket = getTicket(db, urn);
    if (!ticket) {
      return res.status(404).json({ error: 'Ticket not found', status: 404 });
    }

    // Valid from pending (L1 direct) or classifying (L2 result)
    if (!['pending', 'classifying'].includes(ticket.state)) {
      return res.status(409).json({
        error: `Cannot dispatch: ticket is in '${ticket.state}' state, must be 'pending' or 'classifying'`,
        status: 409,
      });
    }

    const patch = {
      state: 'dispatched',
      classification,
    };
    if (handler !== undefined) patch.layer1_handler = handler;
    if (model !== undefined) patch.layer2_model = model;
    if (reasoning !== undefined) patch.layer2_reasoning = reasoning;
    if (confidence !== undefined) patch.layer2_confidence = confidence;

    updateTicketData(db, urn, patch);

    res.json({
      ticket_urn: urn,
      state: 'dispatched',
    });
  });

  // POST /:urn/heal — transition to healing
  router.post('/:urn/heal', (req, res) => {
    const urn = req.params.urn;
    const { method, handler } = req.body;

    if (!method || !['handler', 'code_fix'].includes(method)) {
      return res.status(400).json({
        error: 'Missing or invalid method (handler|code_fix)',
        status: 400,
      });
    }

    const ticket = getTicket(db, urn);
    if (!ticket) {
      return res.status(404).json({ error: 'Ticket not found', status: 404 });
    }

    if (ticket.state !== 'dispatched') {
      return res.status(409).json({
        error: `Cannot heal: ticket is in '${ticket.state}' state, must be 'dispatched'`,
        status: 409,
      });
    }

    const patch = { state: 'healing', layer3_method: method };
    if (handler !== undefined) patch.layer1_handler = handler;

    updateTicketData(db, urn, patch);

    res.status(202).json({
      ticket_urn: urn,
      state: 'healing',
    });
  });

  // POST /:urn/resolve — resolve a ticket
  router.post('/:urn/resolve', (req, res) => {
    const urn = req.params.urn;
    const { outcome, reason } = req.body;

    if (!outcome || !['solved', 'human_required'].includes(outcome)) {
      return res.status(400).json({
        error: 'Missing or invalid outcome (solved|human_required)',
        status: 400,
      });
    }

    const ticket = getTicket(db, urn);
    if (!ticket) {
      return res.status(404).json({ error: 'Ticket not found', status: 404 });
    }

    // solved: valid from healing only
    // human_required: valid from any state (escalation escape hatch)
    if (outcome === 'solved' && ticket.state !== 'healing') {
      return res.status(409).json({
        error: `Cannot resolve as solved: ticket is in '${ticket.state}' state, must be 'healing'`,
        status: 409,
      });
    }

    if (outcome === 'human_required' && ticket.state === 'human_required') {
      return res.status(409).json({
        error: 'Ticket is already in human_required state',
        status: 409,
      });
    }

    const now = new Date().toISOString();
    const patch = {
      state: outcome,
      layer3_outcome: outcome,
      resolved_at: now,
    };
    if (reason) patch.escalation_reason = reason;

    updateTicketData(db, urn, patch);

    res.json({
      ticket_urn: urn,
      state: outcome,
      resolved_at: now,
    });
  });

  // POST /:urn/approve — human approval for code fix
  router.post('/:urn/approve', (req, res) => {
    const urn = req.params.urn;
    const ticket = getTicket(db, urn);

    if (!ticket) {
      return res.status(404).json({ error: 'Ticket not found', status: 404 });
    }

    if (!ticket.proposed_fix) {
      return res.status(409).json({
        error: 'Cannot approve: no pending proposed_fix on this ticket',
        status: 409,
      });
    }

    if (!isValidTransition(ticket.state, 'solved')) {
      return res.status(409).json({
        error: `Cannot approve: ticket is in '${ticket.state}' state`,
        status: 409,
      });
    }

    const now = new Date().toISOString();
    updateTicketData(db, urn, {
      state: 'solved',
      layer3_outcome: 'solved',
      resolved_at: now,
    });

    res.json({
      ticket_urn: urn,
      state: 'solved',
      resolved_at: now,
    });
  });

  // POST /:urn/reject — human rejection
  router.post('/:urn/reject', (req, res) => {
    const urn = req.params.urn;
    const { reason } = req.body;

    if (!reason) {
      return res.status(400).json({
        error: 'Missing required field: reason',
        status: 400,
      });
    }

    const ticket = getTicket(db, urn);
    if (!ticket) {
      return res.status(404).json({ error: 'Ticket not found', status: 404 });
    }

    const now = new Date().toISOString();
    updateTicketData(db, urn, {
      state: 'human_required',
      layer3_outcome: 'human_required',
      escalation_reason: reason,
      resolved_at: now,
    });

    res.json({
      ticket_urn: urn,
      state: 'human_required',
      reason,
    });
  });

  return router;
}
