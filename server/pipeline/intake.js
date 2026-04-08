/**
 * Intake — receives verification_result failures, creates autoheal tickets.
 *
 * Deduplication: if an open ticket exists for the same test_id, returns existing.
 * Repeat failure check: if resolved tickets for the same test_id exceed threshold
 * within the sliding window, escalates immediately.
 */

function log(event, data = {}) {
  const entry = { timestamp: new Date().toISOString(), event, ...data };
  process.stdout.write(JSON.stringify(entry) + '\n');
}

export function createIntake(db, config, classifier, escalator) {
  const { repeatFailureThreshold, repeatFailureWindowDays } = config;

  const findOpenTicket = db.prepare(
    "SELECT urn, data FROM concepts WHERE json_extract(data, '$.type') = 'autoheal_ticket' AND json_extract(data, '$.test_id') = ? AND json_extract(data, '$.state') NOT IN ('solved', 'human_required') LIMIT 1"
  );

  const countRecentResolved = db.prepare(
    "SELECT COUNT(*) as count FROM concepts WHERE json_extract(data, '$.type') = 'autoheal_ticket' AND json_extract(data, '$.test_id') = ? AND json_extract(data, '$.state') = 'solved' AND json_extract(data, '$.resolved_at') > ?"
  );

  const insertTicket = db.prepare(
    'INSERT INTO concepts (urn, data, created_at) VALUES (?, ?, ?)'
  );

  /**
   * Handle an incoming verification failure.
   * @param {object} failure - { test_id, status, detail, ... }
   * @param {object|null} spine - Spine client for emitting events
   * @returns {object} - { urn, action, ticket }
   */
  function onFailure(failure, spine) {
    const testId = failure.test_id;
    if (!testId) {
      log('intake_skip_no_test_id', { failure });
      return null;
    }

    // Deduplication: check for open ticket
    const existing = findOpenTicket.get(testId);
    if (existing) {
      log('intake_deduplicated', { test_id: testId, urn: existing.urn });
      return { urn: existing.urn, action: 'deduplicated', ticket: JSON.parse(existing.data) };
    }

    // Repeat failure check
    const windowStart = new Date(Date.now() - repeatFailureWindowDays * 24 * 60 * 60 * 1000).toISOString();
    const recentCount = countRecentResolved.get(testId, windowStart).count;

    if (recentCount >= repeatFailureThreshold) {
      log('intake_repeat_escalation', { test_id: testId, repeat_count: recentCount, threshold: repeatFailureThreshold });
      const ticket = createTicketConcept(testId, failure);
      ticket.state = 'human_required';
      ticket.resolved_at = new Date().toISOString();
      ticket.escalation_reason = `Repeat failure: ${recentCount} resolved in ${repeatFailureWindowDays}d (threshold: ${repeatFailureThreshold})`;
      persistTicket(ticket);
      return { urn: ticket.urn, action: 'escalated_repeat', ticket };
    }

    // Create new ticket in pending state
    const ticket = createTicketConcept(testId, failure);
    persistTicket(ticket);
    log('intake_ticket_created', { urn: ticket.urn, test_id: testId });

    // Dispatch to L1 classifier
    classifier.classify(ticket, spine);

    return { urn: ticket.urn, action: 'created', ticket };
  }

  function createTicketConcept(testId, failure) {
    const now = new Date().toISOString();
    return {
      urn: `urn:autoheal:ticket:${now}-${testId}`,
      type: 'autoheal_ticket',
      test_id: testId,
      state: 'pending',
      detail: failure.detail || '',
      source: 'spine_broadcast',
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
  }

  function persistTicket(ticket) {
    const now = new Date().toISOString();
    insertTicket.run(ticket.urn, JSON.stringify(ticket), now);
  }

  return { onFailure };
}
