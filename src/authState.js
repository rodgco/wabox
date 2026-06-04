// Drop-in replacement for Baileys' `useMultiFileAuthState` that writes files
// atomically (write-to-tmp + rename) instead of truncate-and-write-in-place.
//
// Why: Baileys' vanilla helper does `fs.writeFile(path, json)` for every signal
// operation. Each outbound or inbound encrypted message rewrites the relevant
// `session-<jid>.json`. If the process is killed mid-write (`node --watch`
// SIGTERM+SIGKILL during dev, or systemd RestartSec=5 firing on a hot crash)
// the file is left torn — and Baileys' `readData` swallows the JSON.parse
// error as `null`. Baileys then treats the session as absent, our counters
// desync from the recipient's, and every subsequent message to that contact
// sticks on "Waiting for this message. This may take a while." until we
// re-pair the device.
//
// `fs.rename` is a single atomic FS operation, so a kill at any point leaves
// either the old file untouched or the new one fully in place — never a torn
// JSON.
import { Mutex } from 'async-mutex';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  proto,
  initAuthCreds,
  BufferJSON,
} from '@whiskeysockets/baileys';

// Per-file mutex map — same trick the vanilla helper uses (see
// WhiskeySockets/Baileys#794) to serialise overlapping async writes to the
// same key file.
const fileLocks = new Map();
function getFileLock(p) {
  let m = fileLocks.get(p);
  if (!m) {
    m = new Mutex();
    fileLocks.set(p, m);
  }
  return m;
}

const fixFileName = (file) =>
  file?.replace(/\//g, '__')?.replace(/:/g, '-');

export async function useAtomicAuthState(folder) {
  await fs.mkdir(folder, { recursive: true });

  const writeData = async (data, file) => {
    const filePath = path.join(folder, fixFileName(file));
    const tmpPath = `${filePath}.tmp`;
    const lock = getFileLock(filePath);
    const release = await lock.acquire();
    try {
      await fs.writeFile(tmpPath, JSON.stringify(data, BufferJSON.replacer));
      await fs.rename(tmpPath, filePath);
    } finally {
      release();
    }
  };

  const readData = async (file) => {
    const filePath = path.join(folder, fixFileName(file));
    const lock = getFileLock(filePath);
    const release = await lock.acquire();
    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(raw, BufferJSON.reviver);
    } catch {
      return null;
    } finally {
      release();
    }
  };

  const removeData = async (file) => {
    const filePath = path.join(folder, fixFileName(file));
    const lock = getFileLock(filePath);
    const release = await lock.acquire();
    try {
      await fs.unlink(filePath);
    } catch {
      /* already gone */
    } finally {
      release();
    }
  };

  const creds = (await readData('creds.json')) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await readData(`${type}-${id}.json`);
              if (type === 'app-state-sync-key' && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              data[id] = value;
            }),
          );
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const file = `${category}-${id}.json`;
              tasks.push(value ? writeData(value, file) : removeData(file));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: async () => writeData(creds, 'creds.json'),
  };
}
