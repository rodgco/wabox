import fs from 'node:fs/promises';
import { config } from '../config.js';
import { logger } from './logger.js';
import { connectWhatsApp } from './whatsapp.js';
import { saveIncoming, watchInbox } from './inbox.js';
import { watchOutbox } from './outbox.js';

export async function ensureDirs() {
  await Promise.all([
    fs.mkdir(config.authDir, { recursive: true }),
    fs.mkdir(config.inboxDir, { recursive: true }),
    fs.mkdir(config.outboxDir, { recursive: true }),
  ]);
}

// Long-running gateway: receive -> inbox, watch outbox -> send. Used by `run`.
export async function startGateway() {
  await ensureDirs();
  logger.info(
    { inbox: config.inboxDir, outbox: config.outboxDir },
    'starting wabox',
  );

  let outboxWatcher;
  let inboxWatcher;
  await connectWhatsApp({
    onMessage: saveIncoming,
    onReady: async (sock) => {
      // Rebind the watchers to the live socket (a reconnect kills the old one).
      await outboxWatcher?.close();
      outboxWatcher = watchOutbox(sock);
      await inboxWatcher?.close();
      inboxWatcher = watchInbox(sock);
    },
  });

  const shutdown = async () => {
    logger.info('shutting down');
    await Promise.all([outboxWatcher?.close(), inboxWatcher?.close()]);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// One-shot pairing: connect (printing the QR if needed), wait until the session
// is open so creds are persisted, then close without reconnecting. Used by the
// `config` / `pair` commands.
export async function pair() {
  await ensureDirs();
  await new Promise((resolve, reject) => {
    let done = false;
    connectWhatsApp({
      autoReconnect: false,
      onMessage: async () => {},
      onReady: (sock) => {
        if (done) return;
        done = true;
        logger.info('paired — WhatsApp session is ready');
        // Give creds a moment to flush, then close cleanly.
        setTimeout(() => {
          try {
            sock.end(undefined);
          } catch {
            /* ignore */
          }
          resolve();
        }, 1500);
      },
    }).catch(reject);
  });
}
