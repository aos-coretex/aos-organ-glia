const isProduction = process.env.NODE_ENV === 'production';

export const config = {
  port: parseInt(process.env.GLIA_PORT || (isProduction ? '3916' : '4016'), 10),
  dbPath: process.env.GLIA_DB_PATH || './data/glia.db',
  binding: '127.0.0.1',
};
