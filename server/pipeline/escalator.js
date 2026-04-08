/**
 * Escalator — transitions tickets to human_required state.
 *
 * Called when: repeat failure threshold exceeded, L2 timeout,
 * handler failure, low confidence, architectural errors.
 */

function log(event, data = {}) {
  const entry = { timestamp: new Date().toISOString(), event, ...data };
  process.stdout.write(JSON.stringify(entry) + '\n');
}

export function createEscalator(db) {
  const updateTicket = db.prepare(
    "UPDATE concepts SET data = ? WHERE urn = ?"
  );

  /**
   * Escalate a ticket to human_required.
   * @param {object} ticket - ticket concept
   * @param {string} reason - escalation reason
   */
  function escalate(ticket, reason) {
    ticket.state = 'human_required';
    ticket.resolved_at = new Date().toISOString();
    ticket.escalation_reason = reason;
    updateTicket.run(JSON.stringify(ticket), ticket.urn);
    log('ticket_escalated', { urn: ticket.urn, test_id: ticket.test_id, reason });
  }

  return { escalate };
}
