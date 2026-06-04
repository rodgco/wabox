// Disk-backed LRU cache for messages we have sent. Baileys calls getMessage(key)
// to fetch the original message bytes when a recipient could not decrypt one of
// our outbound messages and asks for a retry — without this cache, the recipient
// is stuck on "Waiting for this message. This may take a while." indefinitely.
//
// Layout under dir:
//   <id>.bin      protobuf-encoded proto.Message (raw wire bytes, no JSON)
//   index.json    { order: ["id1", "id2", ...] }   — LRU insertion order
import fs from 'node:fs/promises';
import path from 'node:path';
import { proto } from '@whiskeysockets/baileys';
import { config } from '../config.js';
import { logger } from './logger.js';

const DIR = path.join(config.dataDir, 'sent-cache');
const INDEX = path.join(DIR, 'index.json');
const CAP = 1000;

// In-memory LRU mirror of what's on disk. Keys are message ids; values are
// unused (the disk holds the payload). Map preserves insertion order, which is
// our LRU order.
const order = new Map();
let loaded = false;

function safeId(id) {
  // WhatsApp ids are already [A-Za-z0-9_-]; this guards against odd inputs.
  return String(id).replace(/[^A-Za-z0-9._-]/g, '_');
}

function fileFor(id) {
  return path.join(DIR, `${safeId(id)}.bin`);
}

async function persistIndex() {
  const tmp = `${INDEX}.tmp`;
  await fs.writeFile(tmp, JSON.stringify({ order: [...order.keys()] }));
  await fs.rename(tmp, INDEX);
}

export async function initSentCache() {
  if (loaded) return;
  await fs.mkdir(DIR, { recursive: true });
  try {
    const raw = await fs.readFile(INDEX, 'utf8');
    const parsed = JSON.parse(raw);
    for (const id of parsed.order || []) order.set(id, true);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      logger.warn({ err }, 'sentCache: could not read index, starting empty');
    }
  }
  loaded = true;
  logger.info({ dir: DIR, size: order.size }, 'sentCache ready');
}

export async function putSentMessage(key, message) {
  if (!loaded) await initSentCache();
  const id = key?.id;
  if (!id || !message) return;
  try {
    const buf = proto.Message.encode(message).finish();
    await fs.writeFile(fileFor(id), buf);
    // Re-insert to move to the end of the LRU order.
    if (order.has(id)) order.delete(id);
    order.set(id, true);
    while (order.size > CAP) {
      const oldest = order.keys().next().value;
      order.delete(oldest);
      await fs.rm(fileFor(oldest), { force: true });
    }
    await persistIndex();
  } catch (err) {
    logger.error({ err, id }, 'sentCache: failed to persist message');
  }
}

export async function getSentMessage(key) {
  if (!loaded) await initSentCache();
  const id = key?.id;
  if (!id) return undefined;
  try {
    const buf = await fs.readFile(fileFor(id));
    return proto.Message.decode(buf);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      logger.warn({ err, id }, 'sentCache: failed to read message');
    }
    return undefined;
  }
}
