const isProduction = process.env.NODE_ENV === 'production';

export const config = {
  port: parseInt(process.env.GLIA_PORT || (isProduction ? '3916' : '4016'), 10),
  dbPath: process.env.GLIA_DB_PATH || './data/glia.db',
  binding: '127.0.0.1',
  spineUrl: process.env.SPINE_URL || (isProduction ? 'http://127.0.0.1:3800' : 'http://127.0.0.1:3801'),
  lobeUrl: process.env.LOBE_URL || (isProduction ? 'http://127.0.0.1:3910' : 'http://127.0.0.1:4010'),
  repeatFailureThreshold: parseInt(process.env.GLIA_REPEAT_THRESHOLD || '3', 10),
  repeatFailureWindowDays: parseInt(process.env.GLIA_REPEAT_WINDOW_DAYS || '7', 10),
  classificationTimeoutMs: parseInt(process.env.GLIA_CLASSIFY_TIMEOUT_MS || '120000', 10),
  maxConcurrentClassifications: parseInt(process.env.GLIA_MAX_CONCURRENT_CLASSIFY || '2', 10),
};
