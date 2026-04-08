import express from 'express';
import { resolve } from 'node:path';
import { config } from './config.js';
import { initDatabase } from './db/init.js';
import { loggingMiddleware } from './middleware/logging.js';
import { createTicketsRouter } from './routes/tickets.js';
import { createHealthRouter } from './routes/health.js';

function log(event, data = {}) {
  const entry = { timestamp: new Date().toISOString(), event, ...data };
  process.stdout.write(JSON.stringify(entry) + '\n');
}

// Initialize database (fail fast)
const dbPath = resolve(config.dbPath);
const db = initDatabase(dbPath);

const conceptCount = db.prepare('SELECT COUNT(*) as count FROM concepts').get().count;
log('db_initialized', { path: dbPath, concepts: conceptCount });

// Create Express app
const app = express();
app.use(express.json());
app.use(loggingMiddleware);

// Mount routes
const startTime = Date.now();

app.use('/tickets', createTicketsRouter(db));
app.use('/', createHealthRouter(db, startTime));

// Start server
const server = app.listen(config.port, config.binding, () => {
  log('glia_started', {
    port: config.port,
    binding: config.binding,
    db_path: dbPath,
    concepts: conceptCount,
  });
});

// Graceful shutdown
function shutdown(signal) {
  log('glia_shutdown', { signal });
  server.close(() => {
    db.close();
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
