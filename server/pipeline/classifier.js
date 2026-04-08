/**
 * Classifier — L1 deterministic dispatch + L2 smart dispatch.
 *
 * L1: Pattern-match test_id against known handler mappings. If match found, dispatch directly.
 * L2: Send directed OTM to Lobe (port 4010) via Spine for probabilistic classification.
 *     120s timeout → human_required if no response.
 */

import { HANDLER_MAP } from './handlers.js';

function log(event, data = {}) {
  const entry = { timestamp: new Date().toISOString(), event, ...data };
  process.stdout.write(JSON.stringify(entry) + '\n');
}

export function createClassifier(db, config, fixer, escalator) {
  const { classificationTimeoutMs, maxConcurrentClassifications } = config;
  let activeClassifications = 0;
  const pendingTimeouts = new Map();

  const updateTicket = db.prepare(
    "UPDATE concepts SET data = ? WHERE urn = ?"
  );

  /**
   * Classify a ticket. L1 tries deterministic first, L2 falls back to Lobe via Spine.
   * @param {object} ticket
   * @param {object|null} spine
   */
  function classify(ticket, spine) {
    // L1: deterministic pattern match
    const handler = findHandler(ticket.test_id);
    if (handler) {
      log('l1_match', { test_id: ticket.test_id, handler: handler.name });
      ticket.state = 'dispatched';
      ticket.classification = 'operational';
      ticket.layer1_handler = handler.name;
      persistTicket(ticket);

      // Execute handler
      fixer.executeHandler(ticket, handler, spine);
      return;
    }

    // L2: smart dispatch via Spine to Lobe
    if (activeClassifications >= maxConcurrentClassifications) {
      log('l2_at_capacity', { test_id: ticket.test_id, active: activeClassifications });
      escalator.escalate(ticket, 'L2 classifier at capacity');
      return;
    }

    ticket.state = 'classifying';
    persistTicket(ticket);
    activeClassifications++;

    log('l2_dispatch', { test_id: ticket.test_id, urn: ticket.urn });

    if (spine && spine.isConnected()) {
      spine.send({
        to: 'Lobe',
        event_type: 'classify_ticket',
        payload: {
          ticket_urn: ticket.urn,
          test_id: ticket.test_id,
          detail: ticket.detail,
          source: 'Glia',
        },
      });
    }

    // Timeout fallback: if no classification arrives, escalate
    const timeout = setTimeout(() => {
      pendingTimeouts.delete(ticket.urn);
      activeClassifications = Math.max(0, activeClassifications - 1);

      // Check if still classifying
      const row = db.prepare('SELECT data FROM concepts WHERE urn = ?').get(ticket.urn);
      if (row) {
        const current = JSON.parse(row.data);
        if (current.state === 'classifying') {
          log('l2_timeout', { urn: ticket.urn, timeout_ms: classificationTimeoutMs });
          escalator.escalate(current, `L2 classification timed out after ${classificationTimeoutMs}ms`);
        }
      }
    }, classificationTimeoutMs);

    timeout.unref();
    pendingTimeouts.set(ticket.urn, timeout);
  }

  /**
   * Receive L2 classification result from Lobe.
   * @param {object} result - { ticket_urn, classification, reasoning, confidence, model }
   * @param {object|null} spine
   */
  function onClassifyResult(result, spine) {
    const { ticket_urn, classification, reasoning, confidence, model } = result;

    // Clear timeout
    const timeout = pendingTimeouts.get(ticket_urn);
    if (timeout) {
      clearTimeout(timeout);
      pendingTimeouts.delete(ticket_urn);
    }
    activeClassifications = Math.max(0, activeClassifications - 1);

    const row = db.prepare('SELECT data FROM concepts WHERE urn = ?').get(ticket_urn);
    if (!row) {
      log('l2_result_orphaned', { ticket_urn });
      return;
    }

    const ticket = JSON.parse(row.data);

    ticket.layer2_model = model || null;
    ticket.layer2_reasoning = reasoning || null;
    ticket.layer2_confidence = confidence || null;

    log('l2_result', { urn: ticket_urn, classification, confidence });

    if (confidence < 0.6) {
      escalator.escalate(ticket, `Low confidence: ${confidence}`);
      return;
    }

    switch (classification) {
      case 'operational':
        ticket.state = 'dispatched';
        ticket.classification = 'operational';
        persistTicket(ticket);
        // Find handler and execute
        const handler = findHandler(ticket.test_id);
        if (handler) {
          fixer.executeHandler(ticket, handler, spine);
        } else {
          escalator.escalate(ticket, 'Classified operational but no handler found');
        }
        break;

      case 'logic_bug':
        ticket.state = 'dispatched';
        ticket.classification = 'logic_bug';
        persistTicket(ticket);
        fixer.proposeFix(ticket, spine);
        break;

      case 'architectural_error':
        escalator.escalate(ticket, 'Architectural error — requires human review');
        break;

      default:
        escalator.escalate(ticket, `Unknown classification: ${classification}`);
    }
  }

  /**
   * Find a deterministic handler for a test_id via L1 pattern matching.
   * @param {string} testId
   * @returns {{ name: string, patterns: string[] }|null}
   */
  function findHandler(testId) {
    for (const handler of HANDLER_MAP) {
      for (const pattern of handler.patterns) {
        if (typeof pattern === 'string') {
          if (pattern.endsWith('*')) {
            if (testId.startsWith(pattern.slice(0, -1))) return handler;
          } else {
            if (testId === pattern) return handler;
          }
        }
      }
    }
    return null;
  }

  function persistTicket(ticket) {
    updateTicket.run(JSON.stringify(ticket), ticket.urn);
  }

  function shutdown() {
    for (const [, timeout] of pendingTimeouts) {
      clearTimeout(timeout);
    }
    pendingTimeouts.clear();
  }

  return { classify, onClassifyResult, findHandler, shutdown };
}
