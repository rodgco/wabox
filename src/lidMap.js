// Persistent phone-number → LID JID mapping.
//
// WhatsApp routes 1:1 chats through two parallel identities for the same
// contact: the phone-number JID (`<number>@s.whatsapp.net`) and the LID
// (`<lid>@lid`). Each identity has its own Signal session chain. If the
// inbound message lands on `@lid` and the outbound reply goes to
// `@s.whatsapp.net`, the contact's phone — which internally treats both as
// the same person — advances its LID-side counter on our `@s.whatsapp.net`
// send, then encrypts the next inbound with the advanced counter; our LID
// session is still at the old counter, MAC verification fails, and the
// recipient gets stuck on "Waiting for this message".
//
// We avoid that by remembering the LID for each phone number we receive
// from, and rewriting outbox `to` so the reply uses the same identity the
// chat is already running on.
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { logger } from './logger.js';

const FILE = path.join(config.dataDir, 'lid-map.json');
const map = new Map();
let loaded = false;
let writeChain = Promise.resolve();

async function load() {
  if (loaded) return;
  try {
    const raw = await fs.readFile(FILE, 'utf8');
    const obj = JSON.parse(raw);
    for (const [num, lid] of Object.entries(obj)) map.set(num, lid);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      logger.warn({ err }, 'lidMap: could not read, starting empty');
    }
  }
  loaded = true;
  logger.info({ file: FILE, size: map.size }, 'lidMap ready');
}

async function persist() {
  const tmp = `${FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(Object.fromEntries(map), null, 2));
  await fs.rename(tmp, FILE);
}

// Normalise a remoteJid like "277880256909343:84@lid" (or already bare
// "277880256909343@lid") to the chat-level form "277880256909343@lid".
export function bareLidJid(jid) {
  if (!jid || typeof jid !== 'string') return null;
  if (!jid.endsWith('@lid')) return null;
  const local = jid.split('@')[0].split(':')[0];
  return `${local}@lid`;
}

export async function recordLid(number, lidJid) {
  if (!number || !lidJid) return;
  if (!loaded) await load();
  const bare = bareLidJid(lidJid);
  if (!bare) return;
  if (map.get(number) === bare) return;
  map.set(number, bare);
  // Serialise writes so concurrent calls don't race on the same file.
  writeChain = writeChain
    .then(() => persist())
    .catch((err) => logger.error({ err }, 'lidMap: persist failed'));
  await writeChain;
}

export async function lookupLid(number) {
  if (!loaded) await load();
  return map.get(number);
}
