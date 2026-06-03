import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
} from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import { config } from '../config.js';
import { logger } from './logger.js';
import { DISPLAY_NAME } from './paths.js';

// Opens (and keeps open) a WhatsApp connection. `onMessage(sock, m)` is called
// for every fresh incoming message. `onReady(sock)` fires once the socket is
// open and ready to send.
export async function connectWhatsApp({
  onMessage,
  onReady,
  autoReconnect = true,
}) {
  const { state, saveCreds } = await useMultiFileAuthState(config.authDir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger,
    browser: [DISPLAY_NAME, 'Chrome', '1.0.0'],
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      logger.info('scan the QR code below with WhatsApp > Linked Devices');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      logger.info('WhatsApp connection open');
      onReady?.(sock);
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      if (loggedOut) {
        logger.error(
          'logged out by WhatsApp — delete the auth dir and re-pair',
        );
        return;
      }
      if (!autoReconnect) {
        logger.info('connection closed');
        return;
      }
      logger.warn({ code }, 'connection closed, reconnecting...');
      // Re-establish; useMultiFileAuthState reloads the saved creds.
      connectWhatsApp({ onMessage, onReady, autoReconnect }).catch((err) =>
        logger.error({ err }, 'reconnect failed'),
      );
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return; // ignore history/append syncs
    for (const m of messages) {
      try {
        await onMessage(sock, m);
      } catch (err) {
        logger.error({ err }, 'error handling incoming message');
      }
    }
  });

  return sock;
}
