import makeWASocket, {
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  DisconnectReason,
} from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import { config } from '../config.js';
import { logger, baileysLogger } from './logger.js';
import { DISPLAY_NAME } from './paths.js';
import {
  initSentCache,
  putSentMessage,
  getSentMessage,
} from './sentCache.js';
import { useAtomicAuthState } from './authState.js';

// Opens (and keeps open) a WhatsApp connection.
//   onMessage(sock, m)  — every fresh incoming message
//   onReady(sock)       — fires the moment the socket opens (safe to send)
//   onSynced(sock)      — fires once the initial offline batch has been replayed
//                         (`receivedPendingNotifications: true`). This is the
//                         authoritative "fully synced" signal — `pair()` uses it
//                         so the CLI doesn't return before WhatsApp on the phone
//                         finishes finalising the link.
export async function connectWhatsApp({
  onMessage,
  onReady,
  onSynced,
  autoReconnect = true,
}) {
  await initSentCache();
  // useAtomicAuthState is a drop-in replacement for Baileys'
  // useMultiFileAuthState that writes via tmp+rename. The vanilla helper
  // truncates-in-place, so a SIGKILL mid-write (dev `node --watch`, hot
  // restart) tears a session-<jid>.json — and once that's null on next start,
  // the recipient permanently sticks on "Waiting for this message".
  const { state, saveCreds } = await useAtomicAuthState(config.authDir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      // Wrapping the file-backed signal store in an in-memory cache prevents
      // lost writes mid-transaction when signal events burst, which is one of
      // the upstream causes of session desync (and "Waiting for this message").
      keys: makeCacheableSignalKeyStore(state.keys, baileysLogger),
    },
    logger: baileysLogger,
    browser: [DISPLAY_NAME, 'Chrome', '1.0.0'],
    // Don't take over presence — keep WhatsApp's push notifications flowing to
    // the user's phone while wabox is running.
    markOnlineOnConnect: false,
    // We're a message gateway; we don't care about old history. Skipping the
    // sync makes `receivedPendingNotifications` land in seconds instead of
    // minutes on busy accounts.
    shouldSyncHistoryMessage: () => false,
    // Skip the post-open `fetchProps / fetchBlocklist / fetchPrivacySettings`
    // batch — those exist for WhatsApp Web UI parity (blocklist UI, privacy
    // toggles) and nothing in this gateway uses them. They fire-and-forget
    // after 'open' and log a 408 "Timed Out" when WhatsApp's IQ endpoint is
    // slow, which is just noise here.
    fireInitQueries: false,
    // When a recipient asks for a retry, Baileys calls this to fetch the
    // original plaintext so it can re-encrypt with the fresh session. Without
    // it, retries are dropped and the recipient is stuck on
    // "Waiting for this message. This may take a while."
    getMessage: async (key) => (await getSentMessage(key)) || undefined,
  });

  sock.ev.on('creds.update', saveCreds);

  // Capture our own outbound messages into the sentCache so getMessage above
  // can serve retry-receipts. Hooking messages.upsert covers everything the
  // outbox sends (text, captions, files, reactions, quoted replies) without
  // needing to touch outbox.js.
  //
  // IMPORTANT: do NOT filter on `type === 'notify'`. Baileys emits our own
  // sends via `upsertMessage(fullMsg, 'append')` (messages-send.js:705), so a
  // `type === 'notify'` filter silently drops every outbound message and the
  // cache stays empty. `fromMe === true` is the only filter we need.
  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const m of messages) {
      if (m?.key?.fromMe && m.message) {
        await putSentMessage(m.key, m.message);
      }
    }
  });

  let reconnectDelayMs = 1000;
  const MAX_RECONNECT_DELAY_MS = 30_000;

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr, receivedPendingNotifications } =
      update;

    if (qr) {
      logger.info('scan the QR code below with WhatsApp > Linked Devices');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      logger.info('WhatsApp connection open');
      reconnectDelayMs = 1000; // reset backoff on a healthy open
      onReady?.(sock);
    }

    if (receivedPendingNotifications) {
      logger.info('WhatsApp initial sync complete');
      onSynced?.(sock);
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      // 515 = "restart required": WhatsApp sends this right after QR pairing
      // completes and the socket MUST be reopened to finish logging in. It's
      // part of the normal pairing handshake, so honor it even during one-shot
      // pairing (autoReconnect=false).
      const restartRequired = code === DisconnectReason.restartRequired;
      if (loggedOut) {
        logger.error(
          'logged out by WhatsApp — delete the auth dir and re-pair',
        );
        return;
      }
      if (!autoReconnect && !restartRequired) {
        logger.info('connection closed');
        return;
      }
      const delay = restartRequired ? 0 : reconnectDelayMs;
      logger.info(
        { code, delayMs: delay },
        restartRequired
          ? 'restart required, reconnecting...'
          : 'connection closed, reconnecting...',
      );
      const next = () =>
        connectWhatsApp({
          onMessage,
          onReady,
          onSynced,
          autoReconnect,
        }).catch((err) => logger.error({ err }, 'reconnect failed'));
      if (delay > 0) {
        setTimeout(next, delay);
        reconnectDelayMs = Math.min(reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS);
      } else {
        next();
      }
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
