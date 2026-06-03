import fs from 'node:fs/promises';
import path from 'node:path';
import chokidar from 'chokidar';
import { config } from '../config.js';
import { logger } from './logger.js';

const SENT_DIR = path.join(config.outboxDir, 'sent');
const FAILED_DIR = path.join(config.outboxDir, 'failed');

const EXT_MIME = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  ogg: 'audio/ogg',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  pdf: 'application/pdf',
};

function kindFor(ext) {
  if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)) return 'image';
  if (['mp4', 'mov', '3gp'].includes(ext)) return 'video';
  if (['ogg', 'mp3', 'm4a', 'wav'].includes(ext)) return 'audio';
  return 'document';
}

// Accept a bare number ("5511999998888"), a full user JID, or a group JID.
function normalizeJid(to) {
  if (!to) throw new Error('outbox message missing "to"');
  if (to.includes('@')) return to;
  const digits = to.replace(/[^0-9]/g, '');
  return `${digits}@s.whatsapp.net`;
}

function buildFileContent(filePath, caption) {
  const ext = path.extname(filePath).replace('.', '').toLowerCase();
  const kind = kindFor(ext);
  const mimetype = EXT_MIME[ext] || 'application/octet-stream';
  const base = { url: filePath };
  switch (kind) {
    case 'image':
      return { image: base, caption };
    case 'video':
      return { video: base, caption };
    case 'audio':
      return { audio: base, mimetype, ptt: false };
    default:
      return {
        document: base,
        mimetype,
        fileName: path.basename(filePath),
        caption,
      };
  }
}

// Reconstructs the minimal message stub Baileys needs to render a quote.
// `replyTo` may be a bare message id string, or { id, participant, text }.
function buildQuoted(jid, replyTo) {
  if (!replyTo) return undefined;
  const r = typeof replyTo === 'string' ? { id: replyTo } : replyTo;
  if (!r.id) throw new Error('replyTo is missing "id"');
  return {
    key: {
      remoteJid: jid,
      id: r.id,
      fromMe: r.fromMe ?? false,
      ...(r.participant ? { participant: r.participant } : {}),
    },
    // The preview text shown in the quote bubble. Optional — blank if omitted.
    message: { conversation: r.text || '' },
  };
}

// Builds the key Baileys needs to react to a specific message.
function reactionKey(jid, react) {
  const id = react.messageId || react.id;
  if (!id) throw new Error('react is missing "messageId"');
  return {
    remoteJid: jid,
    id,
    fromMe: react.fromMe ?? false,
    ...(react.participant ? { participant: react.participant } : {}),
  };
}

async function processFile(sock, filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  let job;
  try {
    job = JSON.parse(raw);
  } catch {
    throw new Error('invalid JSON');
  }

  const jid = normalizeJid(job.to);

  // A reaction can be the whole job, or ride alongside a text/file reply.
  if (job.react) {
    // emoji "" clears a previously sent reaction.
    const text = job.react.emoji ?? job.react.text ?? '';
    await sock.sendMessage(jid, {
      react: { text, key: reactionKey(jid, job.react) },
    });
    logger.info({ jid, emoji: text }, 'sent reaction');
  }

  const quoted = buildQuoted(jid, job.replyTo);
  const opts = quoted ? { quoted } : undefined;
  const files = job.files || (job.file ? [job.file] : []);

  // Send the text body on its own when there are no attachments.
  if (job.text && files.length === 0) {
    await sock.sendMessage(jid, { text: String(job.text) }, opts);
  }

  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const abs = path.isAbsolute(f) ? f : path.resolve(config.outboxDir, f);
    await fs.access(abs); // throws if missing -> job fails
    // Attach the text as the caption of the first file only.
    const caption = i === 0 ? job.text || undefined : undefined;
    const content = buildFileContent(abs, caption);
    await sock.sendMessage(jid, content, opts);
  }

  logger.info(
    { jid, files: files.length, hasText: !!job.text, replied: !!quoted },
    'sent outbox message',
  );
}

async function archive(filePath, destDir, errorText) {
  await fs.mkdir(destDir, { recursive: true });
  const base = `${Date.now()}_${path.basename(filePath)}`;
  await fs.rename(filePath, path.join(destDir, base));
  if (errorText) {
    await fs.writeFile(path.join(destDir, `${base}.error.txt`), errorText);
  }
}

export function watchOutbox(sock) {
  const watcher = chokidar.watch(config.outboxDir, {
    ignoreInitial: false,
    depth: 0, // top level only — ignore sent/ and failed/
    awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
  });

  watcher.on('add', async (filePath) => {
    if (!filePath.endsWith('.json')) return;
    logger.info({ file: path.basename(filePath) }, 'outbox job picked up');
    try {
      await processFile(sock, filePath);
      await archive(filePath, SENT_DIR);
    } catch (err) {
      logger.error({ err, file: filePath }, 'outbox job failed');
      try {
        await archive(filePath, FAILED_DIR, String(err?.stack || err));
      } catch (mvErr) {
        logger.error({ mvErr }, 'could not move failed job');
      }
    }
  });

  logger.info({ dir: config.outboxDir }, 'watching outbox');
  return watcher;
}
