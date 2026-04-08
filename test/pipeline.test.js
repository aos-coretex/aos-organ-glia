/**
 * Tests for the Glia autoheal pipeline:
 * - Intake: ticket creation, deduplication, repeat failure escalation
 * - Classifier: L1 pattern matching, L2 dispatch
 * - Fixer: handler execution, cooldown
 * - Escalator: state transition
 * - Message handlers: directed message dispatch
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { initDatabase } from '../server/db/init.js';
import { createIntake } from '../server/pipeline/intake.js';
import { createClassifier } from '../server/pipeline/classifier.js';
import { createFixer } from '../server/pipeline/fixer.js';
import { createEscalator } from '../server/pipeline/escalator.js';
import { HANDLER_MAP } from '../server/pipeline/handlers.js';
import { handleDirectedMessage } from '../server/handlers/messages.js';

describe('Pipeline — Intake', () => {
  let db, intake, classifier, fixer, escalator;

  before(() => {
    db = initDatabase(':memory:');
    escalator = createEscalator(db);
    fixer = createFixer(db, escalator);
    classifier = createClassifier(db, {
      classificationTimeoutMs: 500,
      maxConcurrentClassifications: 2,
    }, fixer, escalator);
    intake = createIntake(db, {
      repeatFailureThreshold: 2,
      repeatFailureWindowDays: 7,
    }, classifier, escalator);
  });

  after(() => {
    classifier.shutdown();
    db.close();
  });

  it('1. should create ticket from verification failure', () => {
    const result = intake.onFailure({ test_id: 'test-intake-1', status: 'fail', detail: 'DB down' }, null);
    assert.equal(result.action, 'created');
    assert.ok(result.urn.startsWith('urn:autoheal:ticket:'));
    assert.equal(result.ticket.test_id, 'test-intake-1');
    // Note: state may have been advanced by classifier already (L1 match or L2 dispatch)
  });

  it('2. should deduplicate open tickets for same test_id', () => {
    const first = intake.onFailure({ test_id: 'test-intake-dedup', status: 'fail', detail: 'fail 1' }, null);
    const second = intake.onFailure({ test_id: 'test-intake-dedup', status: 'fail', detail: 'fail 2' }, null);
    assert.equal(second.action, 'deduplicated');
    assert.equal(second.urn, first.urn);
  });

  it('3. should escalate on repeat failure threshold', () => {
    // Create and resolve tickets to build history
    const testId = 'test-repeat-escalation';
    for (let i = 0; i < 2; i++) {
      const now = new Date().toISOString();
      const urn = `urn:autoheal:ticket:${now}-${testId}-${i}`;
      db.prepare('INSERT INTO concepts (urn, data, created_at) VALUES (?, ?, ?)').run(
        urn,
        JSON.stringify({
          type: 'autoheal_ticket',
          test_id: testId,
          state: 'solved',
          resolved_at: now,
        }),
        now
      );
    }

    const result = intake.onFailure({ test_id: testId, status: 'fail', detail: 'again' }, null);
    assert.equal(result.action, 'escalated_repeat');
    assert.equal(result.ticket.state, 'human_required');
    assert.ok(result.ticket.escalation_reason.includes('Repeat failure'));
  });

  it('4. should skip failures without test_id', () => {
    const result = intake.onFailure({ status: 'fail', detail: 'no id' }, null);
    assert.equal(result, null);
  });
});

describe('Pipeline — Classifier L1', () => {
  let db, classifier, fixer, escalator;

  before(() => {
    db = initDatabase(':memory:');
    escalator = createEscalator(db);
    fixer = createFixer(db, escalator);
    classifier = createClassifier(db, {
      classificationTimeoutMs: 500,
      maxConcurrentClassifications: 2,
    }, fixer, escalator);
  });

  after(() => {
    classifier.shutdown();
    db.close();
  });

  it('5. should match capture-unprocessed to capture_processor handler', () => {
    const handler = classifier.findHandler('capture-unprocessed');
    assert.ok(handler);
    assert.equal(handler.name, 'capture_processor');
  });

  it('6. should match symlinks-resolve via wildcard', () => {
    const handler = classifier.findHandler('symlinks-resolve');
    assert.ok(handler);
    assert.equal(handler.name, 'symlink_redeploy');
  });

  it('7. should match db-radiant-online to pg_restart', () => {
    const handler = classifier.findHandler('db-radiant-online');
    assert.ok(handler);
    assert.equal(handler.name, 'pg_restart');
  });

  it('8. should return null for unknown test_id', () => {
    const handler = classifier.findHandler('totally-unknown-test');
    assert.equal(handler, null);
  });
});

describe('Pipeline — Escalator', () => {
  let db, escalator;

  before(() => {
    db = initDatabase(':memory:');
    escalator = createEscalator(db);
  });

  after(() => {
    db.close();
  });

  it('9. should transition ticket to human_required', () => {
    const now = new Date().toISOString();
    const urn = 'urn:autoheal:ticket:test-escalator';
    db.prepare('INSERT INTO concepts (urn, data, created_at) VALUES (?, ?, ?)').run(
      urn,
      JSON.stringify({ urn, type: 'autoheal_ticket', state: 'classifying', test_id: 'esc-1' }),
      now
    );

    const ticket = { urn, state: 'classifying', test_id: 'esc-1' };
    escalator.escalate(ticket, 'Test escalation');

    assert.equal(ticket.state, 'human_required');
    assert.ok(ticket.resolved_at);
    assert.equal(ticket.escalation_reason, 'Test escalation');

    // Verify persistence
    const row = db.prepare('SELECT data FROM concepts WHERE urn = ?').get(urn);
    const persisted = JSON.parse(row.data);
    assert.equal(persisted.state, 'human_required');
  });
});

describe('Pipeline — Message Handlers', () => {
  let db, classifier, fixer, escalator;

  before(() => {
    db = initDatabase(':memory:');
    escalator = createEscalator(db);
    fixer = createFixer(db, escalator);
    classifier = createClassifier(db, {
      classificationTimeoutMs: 500,
      maxConcurrentClassifications: 2,
    }, fixer, escalator);
  });

  after(() => {
    classifier.shutdown();
    db.close();
  });

  it('10. should handle query_tickets message', () => {
    // Insert a ticket
    const now = new Date().toISOString();
    db.prepare('INSERT INTO concepts (urn, data, created_at) VALUES (?, ?, ?)').run(
      'urn:autoheal:ticket:msg-1',
      JSON.stringify({ type: 'autoheal_ticket', state: 'pending', test_id: 'msg-test' }),
      now
    );

    const response = handleDirectedMessage(
      { event_type: 'query_tickets', payload: { state: 'pending' } },
      db,
      { classifier, fixer, escalator, spine: null }
    );

    assert.equal(response.event_type, 'query_tickets_response');
    assert.ok(response.count >= 1);
  });

  it('11. should return null for unknown message type', () => {
    const response = handleDirectedMessage(
      { event_type: 'some_unknown', payload: {} },
      db,
      { classifier, fixer, escalator, spine: null }
    );
    assert.equal(response, null);
  });

  it('12. should handle approve_fix with proposed_fix present', () => {
    const now = new Date().toISOString();
    const urn = 'urn:autoheal:ticket:approve-test';
    db.prepare('INSERT INTO concepts (urn, data, created_at) VALUES (?, ?, ?)').run(
      urn,
      JSON.stringify({ urn, type: 'autoheal_ticket', state: 'healing', test_id: 'fix-1', proposed_fix: 'patch content' }),
      now
    );

    const response = handleDirectedMessage(
      { event_type: 'approve_fix', payload: { ticket_urn: urn } },
      db,
      { classifier, fixer, escalator, spine: null }
    );

    assert.equal(response.event_type, 'approve_fix_ack');
    assert.equal(response.status, 'approved');

    const row = db.prepare('SELECT data FROM concepts WHERE urn = ?').get(urn);
    const ticket = JSON.parse(row.data);
    assert.equal(ticket.state, 'solved');
  });
});

describe('Pipeline — Handler Map', () => {
  it('13. should have 8 handlers defined', () => {
    assert.equal(HANDLER_MAP.length, 8);
  });

  it('14. should have unique handler names', () => {
    const names = HANDLER_MAP.map((h) => h.name);
    const unique = new Set(names);
    assert.equal(unique.size, names.length);
  });
});
