import fs from 'node:fs/promises';
import path from 'node:path';
import chokidar from 'chokidar';
import { downloadMediaMessage } from '@whiskeysockets/baileys';
import { config } from '../config.js';
import { logger, baileysLogger } from './logger.js';

// Maps an inbox `.json` path -> the WhatsApp message key needed to send a read
// receipt. Populated when a message is saved (and when the watcher first sees a
// file), consumed when the consumer deletes the file from the inbox.
const pendingReads = new Map();

function keyFromRecord(rec) {
  if (!rec?.id || !rec?.from) return null;
  const key = { remoteJid: rec.from, id: rec.id, fromMe: false };
  if (rec.participant) key.participant = rec.participant;
  return key;
}

// Maps the media message keys Baileys exposes to a friendly type label.
const MEDIA_KEYS = {
  imageMessage: 'image',
  videoMessage: 'video',
  audioMessage: 'audio',
  documentMessage: 'document',
  stickerMessage: 'sticker',
};

// Minimal mimetype -> extension fallbacks for when no filename is provided.
const MIME_EXT = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'application/pdf': 'pdf',
};

// Some messages are wrapped (disappearing / view-once). Peel them.
function unwrap(message) {
  if (!message) return message;
  if (message.ephemeralMessage) return unwrap(message.ephemeralMessage.message);
  if (message.viewOnceMessage) return unwrap(message.viewOnceMessage.message);
  if (message.viewOnceMessageV2) return unwrap(message.viewOnceMessageV2.message);
  if (message.documentWithCaptionMessage)
    return unwrap(message.documentWithCaptionMessage.message);
  return message;
}

function extractText(message) {
  if (!message) return '';
  return (
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    message.documentMessage?.caption ||
    ''
  );
}

function findMedia(message) {
  for (const [key, type] of Object.entries(MEDIA_KEYS)) {
    if (message?.[key]) return { type, key, node: message[key] };
  }
  return null;
}

function extFor(node, type) {
  if (node.fileName) {
    const e = path.extname(node.fileName).replace('.', '');
    if (e) return e;
  }
  if (node.mimetype && MIME_EXT[node.mimetype.split(';')[0]]) {
    return MIME_EXT[node.mimetype.split(';')[0]];
  }
  return type === 'audio' ? 'ogg' : 'bin';
}

// Make a filesystem-safe stem like 20260603-031200_5511999998888_3EB0ABC
function stemFor(m) {
  const ts = Number(m.messageTimestamp) * 1000 || Date.now();
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  const stamp =
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const sender = (m.key.remoteJid || 'unknown').replace(/[^0-9a-zA-Z]/g, '');
  const id = (m.key.id || '').slice(-8);
  return `${stamp}_${sender}_${id}`;
}

// Local part of a JID, without the @server or :device suffix.
// "5511983426258:2@s.whatsapp.net" -> "5511983426258"
function bare(jid) {
  return (jid || '').split('@')[0].split(':')[0];
}

// The sender's real phone number. When remoteJid is a LID (@lid), WhatsApp still
// sends the phone-number identity in senderPn / participantPn.
function senderNumber(m) {
  const k = m.key || {};
  const pn =
    k.senderPn ||
    k.participantPn ||
    (k.remoteJid?.endsWith('@s.whatsapp.net') ? k.remoteJid : null) ||
    (k.participant?.endsWith('@s.whatsapp.net') ? k.participant : null);
  return pn ? bare(pn) : null;
}

// Match the allow list against every identity the sender carries — phone number
// (senderPn/participantPn), LID, and chat JID — so a LID-routed message from an
// allowed number still passes.
function allowed(m) {
  if (config.allowFrom.length === 0) return true;
  const k = m.key || {};
  const candidates = new Set(
    [k.remoteJid, k.senderPn, k.senderLid, k.participant, k.participantPn]
      .filter(Boolean)
      .map(bare),
  );
  return config.allowFrom.some((a) => candidates.has(bare(a)));
}

export async function saveIncoming(sock, m) {
  if (!m.message) return; // status/empty notifications
  if (config.ignoreFromMe && m.key.fromMe) return;

  const jid = m.key.remoteJid;
  if (jid === 'status@broadcast') return;
  const number = senderNumber(m);
  if (!allowed(m)) {
    // Visible by default so you can see who tried to reach a restricted inbox
    // (and spot numbers you may want to add via `wabox allow add`).
    logger.info(
      { number: number || bare(jid), name: m.pushName || null },
      'message rejected — sender not in allow list',
    );
    return;
  }

  const message = unwrap(m.message);
  const text = extractText(message);
  const media = findMedia(message);

  const stem = stemFor(m);
  const record = {
    id: m.key.id,
    from: jid,
    // The sender's real phone number (resolved from senderPn when `from` is a
    // LID). Use this to reply by number.
    number: number || null,
    // In groups this is the actual sender's JID; null in 1:1 chats. Needed to
    // quote-reply correctly. See replyTo in the outbox contract.
    participant: m.key.participant || null,
    pushName: m.pushName || null,
    fromMe: !!m.key.fromMe,
    timestamp: new Date((Number(m.messageTimestamp) || 0) * 1000).toISOString(),
    text,
    media: null,
  };

  if (media) {
    try {
      const buffer = await downloadMediaMessage(
        m,
        'buffer',
        {},
        { logger: baileysLogger, reuploadRequest: sock.updateMediaMessage },
      );
      const ext = extFor(media.node, media.type);
      const fileName = media.node.fileName || `${stem}.${ext}`;
      const diskName = `${stem}.${ext}`;
      await fs.writeFile(path.join(config.inboxDir, diskName), buffer);
      record.media = {
        type: media.type,
        file: diskName,
        originalName: media.node.fileName || null,
        mimetype: media.node.mimetype || null,
      };
      logger.info({ jid, file: diskName, type: media.type }, 'saved media');
    } catch (err) {
      logger.error({ err, jid }, 'failed to download media');
      record.media = { type: media.type, error: String(err) };
    }
  }

  const jsonPath = path.join(config.inboxDir, `${stem}.json`);
  const tmpPath = path.join(config.inboxDir, `.${stem}.json.tmp`);

  // Register the read-receipt key BEFORE the envelope becomes visible. A fast
  // consumer (inotify-based scripts react in milliseconds) can move the file
  // out before we'd otherwise finish bookkeeping, so the map needs to be ready
  // the instant the rename below lands.
  const key = keyFromRecord(record);
  if (key) pendingReads.set(jsonPath, key);

  // Publish atomically: write to a hidden temp name in the same dir, then
  // rename. The rename is a single FS op, so the watcher sees the envelope
  // appear complete — no need for awaitWriteFinish stabilization, which would
  // race with consumers that delete the file inside that 500ms window.
  await fs.writeFile(tmpPath, JSON.stringify(record, null, 2));
  await fs.rename(tmpPath, jsonPath);

  logger.info(
    { jid, hasMedia: !!media, preview: text.slice(0, 60) },
    'saved message',
  );
}

// Watches the inbox. The consumer owns cleanup: when it finishes processing a
// message it deletes the `.json` from the inbox, and that removal is our signal
// to mark the message read on WhatsApp (native blue checkmarks).
export function watchInbox(sock) {
  const watcher = chokidar.watch(config.inboxDir, {
    depth: 0, // top level only
    ignoreInitial: false,
    // No awaitWriteFinish: envelopes are published via atomic rename in
    // processIncomingMessage, so they appear complete in a single FS event.
    // Stabilization would only delay the `add` and cause chokidar to drop the
    // `unlink` when a fast consumer removes the file before the 500ms window.
  });

  // Cache the message key for any `.json` we see (covers files written by us,
  // pre-existing files on startup, and files dropped in by other tools).
  const cache = async (filePath) => {
    if (!filePath.endsWith('.json')) return;
    if (pendingReads.has(filePath)) return;
    try {
      const rec = JSON.parse(await fs.readFile(filePath, 'utf8'));
      const key = keyFromRecord(rec);
      if (key) pendingReads.set(filePath, key);
    } catch {
      /* partial write or non-JSON — ignore */
    }
  };

  watcher.on('add', cache);
  watcher.on('change', cache);

  watcher.on('unlink', async (filePath) => {
    if (!filePath.endsWith('.json')) return;
    const key = pendingReads.get(filePath);
    if (!key) return; // a media file, or one we never cached
    pendingReads.delete(filePath);
    try {
      await sock.readMessages([key]);
      logger.info(
        { jid: key.remoteJid, id: key.id },
        'message processed → marked read (blue ticks)',
      );
    } catch (err) {
      logger.error(
        { err, jid: key.remoteJid },
        'failed to send read receipt',
      );
    }
  });

  logger.info({ dir: config.inboxDir }, 'watching inbox for processed messages');
  return watcher;
}
