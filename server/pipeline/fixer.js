/**
 * Fixer — L3 fix execution and code fix proposals.
 *
 * For 'operational' classifications: execute the deterministic handler, re-verify.
 * For 'logic_bug' classifications: send fix proposal request to Lobe via Spine.
 * All code fixes require human approval before applying.
 */

import { getHandlerFn } from './handlers.js';

function log(event, data = {}) {
  const entry = { timestamp: new Date().toISOString(), event, ...data };
  process.stdout.write(JSON.stringify(entry) + '\n');
}

export function createFixer(db, escalator) {
  const updateTicket = db.prepare(
    "UPDATE concepts SET data = ? WHERE urn = ?"
  );

  // Cooldown tracking: handler_name → last_execution_timestamp
  const cooldowns = new Map();

  /**
   * Execute a deterministic handler for an operational ticket.
   * @param {object} ticket
   * @param {{ name: string, fn: Function, cooldown_ms: number }} handler
   * @param {object|null} spine
   */
  async function executeHandler(ticket, handler, spine) {
    const now = Date.now();
    const lastRun = cooldowns.get(handler.name) || 0;

    if (now - lastRun < handler.cooldown_ms) {
      log('handler_cooldown', { handler: handler.name, remaining_ms: handler.cooldown_ms - (now - lastRun) });
      escalator.escalate(ticket, `Handler ${handler.name} in cooldown`);
      return;
    }

    ticket.state = 'healing';
    ticket.layer3_method = 'handler';
    persistTicket(ticket);
    cooldowns.set(handler.name, now);

    log('handler_executing', { urn: ticket.urn, handler: handler.name });

    const fn = handler.fn || getHandlerFn(handler.name);
    if (!fn) {
      escalator.escalate(ticket, `No handler function for: ${handler.name}`);
      return;
    }

    try {
      const result = await fn();
      ticket.layer3_outcome = result.detail;

      if (result.success) {
        ticket.state = 'solved';
        ticket.resolved_at = new Date().toISOString();
        persistTicket(ticket);
        log('handler_success', { urn: ticket.urn, handler: handler.name, detail: result.detail });

        // Emit resolution event via Spine
        if (spine && spine.isConnected()) {
          spine.send({
            to: 'broadcast',
            event_type: 'autoheal_resolved',
            payload: { ticket_urn: ticket.urn, test_id: ticket.test_id, handler: handler.name },
          });
        }
      } else {
        escalator.escalate(ticket, `Handler failed: ${result.detail}`);
      }
    } catch (err) {
      log('handler_error', { urn: ticket.urn, handler: handler.name, error: err.message });
      escalator.escalate(ticket, `Handler exception: ${err.message}`);
    }
  }

  /**
   * Request a code fix proposal from Lobe for a logic_bug ticket.
   * @param {object} ticket
   * @param {object|null} spine
   */
  function proposeFix(ticket, spine) {
    ticket.state = 'healing';
    ticket.layer3_method = 'code_fix';
    persistTicket(ticket);

    log('l3_fix_proposal_requested', { urn: ticket.urn, test_id: ticket.test_id });

    if (spine && spine.isConnected()) {
      spine.send({
        to: 'Lobe',
        event_type: 'fix_proposal_request',
        payload: {
          ticket_urn: ticket.urn,
          test_id: ticket.test_id,
          detail: ticket.detail,
          classification: ticket.classification,
          reasoning: ticket.layer2_reasoning,
          source: 'Glia',
        },
      });
    } else {
      escalator.escalate(ticket, 'Spine disconnected — cannot request fix proposal');
    }
  }

  /**
   * Receive fix proposal from Lobe.
   * @param {object} result - { ticket_urn, proposed_fix, reasoning }
   */
  function onFixResult(result) {
    const { ticket_urn, proposed_fix, reasoning } = result;

    const row = db.prepare('SELECT data FROM concepts WHERE urn = ?').get(ticket_urn);
    if (!row) {
      log('fix_result_orphaned', { ticket_urn });
      return;
    }

    const ticket = JSON.parse(row.data);
    ticket.proposed_fix = proposed_fix;
    ticket.layer3_outcome = reasoning || 'Fix proposal received';
    persistTicket(ticket);

    log('l3_fix_proposal_received', { urn: ticket_urn, has_fix: !!proposed_fix });
    // Ticket remains in 'healing' — awaits human approval via /approve endpoint
  }

  function persistTicket(ticket) {
    updateTicket.run(JSON.stringify(ticket), ticket.urn);
  }

  return { executeHandler, proposeFix, onFixResult };
}
