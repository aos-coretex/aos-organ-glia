/**
 * Spine directed message handler for Glia.
 *
 * Handles:
 * - classify_result: L2 classification response from Lobe
 * - fix_result: L3 fix proposal response from Lobe
 * - approve_fix: Human approval from Axon
 */

function log(event, data = {}) {
  const entry = { timestamp: new Date().toISOString(), event, ...data };
  process.stdout.write(JSON.stringify(entry) + '\n');
}

/**
 * Handle a directed OTM message.
 * @param {object} envelope
 * @param {object} db
 * @param {{ classifier, fixer, escalator, spine }} pipeline
 * @returns {object|null}
 */
export function handleDirectedMessage(envelope, db, pipeline) {
  const { event_type, payload } = envelope;

  switch (event_type) {
    case 'classify_result':
      pipeline.classifier.onClassifyResult(payload, pipeline.spine);
      return { event_type: 'classify_result_ack', status: 'received' };

    case 'fix_result':
      pipeline.fixer.onFixResult(payload);
      return { event_type: 'fix_result_ack', status: 'received' };

    case 'approve_fix':
      return handleApproveFix(payload, db, pipeline);

    case 'reject_fix':
      return handleRejectFix(payload, db, pipeline);

    case 'query_tickets':
      return handleQueryTickets(payload, db);

    default:
      log('unknown_message_type', { event_type });
      return null;
  }
}

function handleApproveFix(payload, db, pipeline) {
  const { ticket_urn } = payload;
  const row = db.prepare('SELECT data FROM concepts WHERE urn = ?').get(ticket_urn);
  if (!row) return { event_type: 'approve_fix_error', error: 'Ticket not found' };

  const ticket = JSON.parse(row.data);
  if (!ticket.proposed_fix) {
    return { event_type: 'approve_fix_error', error: 'No proposed fix to approve' };
  }

  ticket.state = 'solved';
  ticket.resolved_at = new Date().toISOString();
  ticket.layer3_outcome = 'Fix approved and applied';
  db.prepare('UPDATE concepts SET data = ? WHERE urn = ?').run(JSON.stringify(ticket), ticket.urn);

  log('fix_approved', { urn: ticket_urn, test_id: ticket.test_id });
  return { event_type: 'approve_fix_ack', ticket_urn, status: 'approved' };
}

function handleRejectFix(payload, db, pipeline) {
  const { ticket_urn, reason } = payload;
  const row = db.prepare('SELECT data FROM concepts WHERE urn = ?').get(ticket_urn);
  if (!row) return { event_type: 'reject_fix_error', error: 'Ticket not found' };

  const ticket = JSON.parse(row.data);
  pipeline.escalator.escalate(ticket, `Fix rejected: ${reason || 'no reason provided'}`);

  log('fix_rejected', { urn: ticket_urn, reason });
  return { event_type: 'reject_fix_ack', ticket_urn, status: 'rejected' };
}

function handleQueryTickets(payload, db) {
  const { state, test_id, limit } = payload || {};
  let query = "SELECT data FROM concepts WHERE json_extract(data, '$.type') = 'autoheal_ticket'";
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
  if (limit) {
    query += ' LIMIT ?';
    params.push(limit);
  }

  const rows = db.prepare(query).all(...params);
  const tickets = rows.map((r) => JSON.parse(r.data));

  return { event_type: 'query_tickets_response', tickets, count: tickets.length };
}
