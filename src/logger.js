import pino from 'pino';
import { config } from '../config.js';

export const logger = pino({
  level: config.logLevel,
  transport: {
    target: 'pino/file',
    options: { destination: 1 }, // stdout
  },
});

// Baileys is very chatty — it logs app-state resync and init-query timeouts that
// are harmless for a message gateway. Give it its own, quieter logger (default
// 'warn') so that noise doesn't flood the journal. Tune with BAILEYS_LOG_LEVEL.
export const baileysLogger = pino({
  level: config.baileysLogLevel,
  transport: {
    target: 'pino/file',
    options: { destination: 1 },
  },
});
