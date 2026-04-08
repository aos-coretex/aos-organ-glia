import { resolve } from 'node:path';
import { createOrgan } from '@coretex/organ-boot';
import { config } from './config.js';
import { initDatabase } from './db/init.js';
import { createTicketsRouter } from './routes/tickets.js';
import { createIntake } from './pipeline/intake.js';
import { createClassifier } from './pipeline/classifier.js';
import { createFixer } from './pipeline/fixer.js';
import { createEscalator } from './pipeline/escalator.js';
import { handleDirectedMessage } from './handlers/messages.js';

function log(event, data = {}) {
  const entry = { timestamp: new Date().toISOString(), event, ...data };
  process.stdout.write(JSON.stringify(entry) + '\n');
}

// Initialize database (fail fast)
const dbPath = resolve(config.dbPath);
const db = initDatabase(dbPath);

const conceptCount = db.prepare('SELECT COUNT(*) as count FROM concepts').get().count;
log('db_initialized', { path: dbPath, concepts: conceptCount });

// Build pipeline components
const escalator = createEscalator(db);
const fixer = createFixer(db, escalator);
const classifier = createClassifier(db, config, fixer, escalator);
const intake = createIntake(db, config, classifier, escalator);

// Spine reference — set after organ boots
let spineRef = null;

// Boot organ
const organ = await createOrgan({
  name: 'Glia',
  port: config.port,
  binding: config.binding,
  spineUrl: config.spineUrl,

  routes: (app) => {
    app.use('/tickets', createTicketsRouter(db));
  },

  onMessage: (envelope) => handleDirectedMessage(envelope, db, { classifier, fixer, escalator, spine: spineRef }),

  onBroadcast: (envelope) => {
    // Intake: listen for verification_result failures
    if (envelope.event_type === 'verification_result') {
      const payload = envelope.payload || envelope;
      if (payload.status === 'fail') {
        intake.onFailure(payload, spineRef);
      }
    }
  },

  subscriptions: [
    { event_type: 'verification_result' },
  ],

  dependencies: ['Spine'],

  healthCheck: async () => {
    let dbConnected = true;
    let openTickets = 0;
    try {
      const row = db.prepare(
        "SELECT COUNT(*) as count FROM concepts WHERE json_extract(data, '$.type') = 'autoheal_ticket' AND json_extract(data, '$.state') NOT IN ('solved', 'human_required')"
      ).get();
      openTickets = row.count;
    } catch {
      dbConnected = false;
    }
    return {
      db_connected: dbConnected,
      open_tickets: openTickets,
      pipeline_active: true,
    };
  },

  introspectCheck: async () => {
    const totalTickets = db.prepare(
      "SELECT COUNT(*) as count FROM concepts WHERE json_extract(data, '$.type') = 'autoheal_ticket'"
    ).get().count;

    const states = {};
    const rows = db.prepare(
      "SELECT json_extract(data, '$.state') as state, COUNT(*) as count FROM concepts WHERE json_extract(data, '$.type') = 'autoheal_ticket' GROUP BY json_extract(data, '$.state')"
    ).all();
    for (const row of rows) {
      states[row.state] = row.count;
    }

    const schemaVersion = db.prepare(
      "SELECT value FROM op_config WHERE key = 'schema_version'"
    ).get();

    return {
      total_tickets: totalTickets,
      tickets_by_state: states,
      schema_version: schemaVersion ? schemaVersion.value : null,
      db_path: db.name,
      classify_timeout_ms: config.classificationTimeoutMs,
      max_concurrent_classifications: config.maxConcurrentClassifications,
    };
  },

  onStartup: async ({ spine }) => {
    spineRef = spine;
    log('pipeline_initialized', {
      repeat_threshold: config.repeatFailureThreshold,
      repeat_window_days: config.repeatFailureWindowDays,
      classify_timeout_ms: config.classificationTimeoutMs,
      lobe_url: config.lobeUrl,
    });
  },

  onShutdown: async () => {
    classifier.shutdown();
    db.close();
  },
});
