// Cross-platform config/data locations. Pure (no I/O, no side effects) so it
// can be imported from the CLI before any config file exists.
//
//   Linux   : XDG — config ~/.config/wabox, data ~/.local/share/wabox
//   macOS   : ~/Library/Application Support/wabox (config + data)
//   Windows : config %APPDATA%\wabox, data %LOCALAPPDATA%\wabox
import path from 'node:path';
import os from 'node:os';

export const APP = 'wabox';
export const DISPLAY_NAME = 'Wabox';
export const home = os.homedir();
export const platform = process.platform; // 'linux' | 'darwin' | 'win32' | ...

function linuxDirs() {
  const cfg = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  const data = process.env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  return { configDir: path.join(cfg, APP), dataDir: path.join(data, APP) };
}

function macDirs() {
  const base = path.join(home, 'Library', 'Application Support', APP);
  return { configDir: base, dataDir: base };
}

function winDirs() {
  const roaming = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const local =
    process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  return { configDir: path.join(roaming, APP), dataDir: path.join(local, APP) };
}

const dirs =
  platform === 'darwin'
    ? macDirs()
    : platform === 'win32'
      ? winDirs()
      : linuxDirs();

export const configDir = dirs.configDir;
export const dataDir = dirs.dataDir;
export const configFile = path.join(configDir, 'config.json');
export const logFile = path.join(dataDir, `${APP}.log`);

// Built-in defaults (used when neither env var nor config file provides a value).
export const defaults = {
  authDir: path.join(dataDir, 'auth'),
  inboxDir: path.join(dataDir, 'inbox'),
  outboxDir: path.join(dataDir, 'outbox'),
  logLevel: 'info',
  allowFrom: [],
  ignoreFromMe: true,
};

export function expandHome(p) {
  if (!p) return p;
  if (p === '~') return home;
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(home, p.slice(2));
  }
  return p;
}

// Resolve a (relative / ~-prefixed / absolute) path against the data root.
export function resolveData(p) {
  const e = expandHome(p);
  return path.isAbsolute(e) ? e : path.join(dataDir, e);
}
