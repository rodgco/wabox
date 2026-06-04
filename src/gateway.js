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

// One-shot pairing: connect (printing the QR if needed), wait until WhatsApp
// reports the initial offline batch has been processed, then close. Hooking
// `receivedPendingNotifications` (rather than the bare 'open' event) is what
// guarantees the phone's "Linking your device" UI has finished before the CLI
// returns. 30s cap so a stuck account still lets the CLI exit.
export async function pair() {
  await ensureDirs();
  await new Promise((resolve, reject) => {
    let done = false;
    let pairedSock;
    const finish = (reason) => {
      if (done) return;
      done = true;
      logger.info({ reason }, 'paired — WhatsApp session is ready');
      // creds.update -> saveCreds is async; let it flush before we tear down.
      setImmediate(() => {
        try {
          pairedSock?.end(undefined);
        } catch {
          /* ignore */
        }
        resolve();
      });
    };
    const timer = setTimeout(() => {
      logger.warn('pair: receivedPendingNotifications not seen in 30s — proceeding anyway');
      finish('timeout-30s');
    }, 30_000);
    connectWhatsApp({
      autoReconnect: false,
      onMessage: async () => {},
      onReady: (sock) => {
        pairedSock = sock;
      },
      onSynced: (sock) => {
        pairedSock = sock;
        clearTimeout(timer);
        finish('received-pending-notifications');
      },
    }).catch(reject);
  });
}
