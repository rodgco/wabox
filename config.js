// Runtime configuration. Resolution order for every value:
//   environment variable > config file > built-in default
//
//   config file: ~/.config/wabox/config.json
//   data root:   ~/.local/share/wabox/
//
// Paths in the config file may be absolute, relative (to the data root) or
// ~-prefixed. See src/paths.js for the XDG resolution.
import { readFileSync } from 'node:fs';
import { configDir, configFile, dataDir, defaults, resolveData } from './src/paths.js';

let fileConfig = {};
try {
  fileConfig = JSON.parse(readFileSync(configFile, 'utf8'));
} catch (err) {
  if (err.code !== 'ENOENT') {
    console.error(`warning: could not read ${configFile}: ${err.message}`);
  }
}

function pick(envKey, fileKey, fallback) {
  const env = process.env[envKey];
  if (env !== undefined && env !== '') return env;
  if (fileConfig[fileKey] !== undefined) return fileConfig[fileKey];
  return fallback;
}

let allowFrom = pick('ALLOW_FROM', 'allowFrom', defaults.allowFrom);
if (typeof allowFrom === 'string') allowFrom = allowFrom.split(',');
allowFrom = allowFrom.map((s) => String(s).trim()).filter(Boolean);

const ignoreFromMe =
  String(pick('IGNORE_FROM_ME', 'ignoreFromMe', defaults.ignoreFromMe)) !==
  'false';

export const config = {
  configDir,
  configFile,
  dataDir,

  authDir: resolveData(pick('AUTH_DIR', 'authDir', defaults.authDir)),
  inboxDir: resolveData(pick('INBOX_DIR', 'inboxDir', defaults.inboxDir)),
  outboxDir: resolveData(pick('OUTBOX_DIR', 'outboxDir', defaults.outboxDir)),

  logLevel: pick('LOG_LEVEL', 'logLevel', defaults.logLevel),
  baileysLogLevel: pick('BAILEYS_LOG_LEVEL', 'baileysLogLevel', 'warn'),
  allowFrom,
  ignoreFromMe,
};
