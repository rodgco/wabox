// `wabox allow …` — manage the allow list by phone number.
//
// The list lives in config.json under `allowFrom`. Matching is by phone number:
// allowed() in inbox.js compares each entry against the local part of the
// sender's JID, so storing digits (e.g. "5511999998888") is enough — no need to
// know the @s.whatsapp.net JID.
//
// We deliberately do NOT resolve JIDs online: that needs a live Baileys socket,
// and WhatsApp allows only one session per linked device, so a second
// connection would knock the running service offline. This command is offline;
// it edits config.json and restarts the service so changes take effect.
import fs from 'node:fs';
import { APP, configFile, configDir } from './paths.js';
import { getService } from './service.js';

function readCfg() {
  try {
    return JSON.parse(fs.readFileSync(configFile, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}

function writeCfg(cfg) {
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(configFile, JSON.stringify(cfg, null, 2) + '\n');
}

// Strip everything but digits: "+55 (11) 99999-8888" -> "5511999998888".
function normalize(n) {
  return String(n).replace(/[^0-9]/g, '');
}

function currentList(cfg) {
  const a = cfg.allowFrom;
  if (Array.isArray(a)) return a.map(String);
  if (typeof a === 'string') return a.split(',').map((s) => s.trim()).filter(Boolean);
  return [];
}

function printList(list) {
  if (list.length === 0) {
    console.log('Allow list is empty — messages from ALL numbers are accepted.');
    return;
  }
  console.log('Allowed numbers:');
  for (const n of list) console.log(`  ${n}`);
}

function warnIfEnvOverrides() {
  if (process.env.ALLOW_FROM) {
    console.log(
      '⚠ ALLOW_FROM is set in the environment and overrides config.json at runtime.',
    );
  }
}

// Apply the change to the running service so it takes effect immediately.
function applyToService() {
  const svc = getService();
  if (svc.kind === 'none' || !svc.available()) return;
  const active = ['active', 'activating', 'loaded', 'registered'].includes(
    svc.status(),
  );
  if (!active) {
    console.log('• Service not running — changes apply on next start.');
    return;
  }
  try {
    svc.restart();
    console.log('✓ Service restarted — the allow list is now live.');
  } catch (err) {
    console.log(`• Saved. Restart to apply: ${svc.restartHint}`);
  }
}

export async function runAllow(args) {
  const [sub, ...rest] = args;
  const cfg = readCfg();
  let list = currentList(cfg);

  switch (sub) {
    case undefined:
    case 'list':
      printList(list);
      warnIfEnvOverrides();
      return;

    case 'add': {
      const nums = rest.map(normalize).filter(Boolean);
      if (nums.length === 0) {
        console.error('Usage: wabox allow add <number> [number…]');
        process.exitCode = 1;
        return;
      }
      const short = nums.filter((n) => n.length < 8);
      if (short.length) {
        console.log(
          `⚠ These look too short (missing country code?): ${short.join(', ')}`,
        );
      }
      const set = new Set(list);
      const added = [];
      for (const n of nums) {
        if (!set.has(n)) {
          set.add(n);
          added.push(n);
        }
      }
      list = [...set];
      cfg.allowFrom = list;
      writeCfg(cfg);
      console.log(added.length ? `✓ Added: ${added.join(', ')}` : 'Nothing new to add.');
      printList(list);
      applyToService();
      warnIfEnvOverrides();
      return;
    }

    case 'remove':
    case 'rm': {
      const nums = rest.map(normalize).filter(Boolean);
      if (nums.length === 0) {
        console.error('Usage: wabox allow remove <number> [number…]');
        process.exitCode = 1;
        return;
      }
      const toRemove = new Set(nums);
      const before = list.length;
      list = list.filter((n) => !toRemove.has(normalize(n)));
      cfg.allowFrom = list;
      writeCfg(cfg);
      console.log(`✓ Removed ${before - list.length} number(s).`);
      printList(list);
      applyToService();
      warnIfEnvOverrides();
      return;
    }

    case 'clear': {
      cfg.allowFrom = [];
      writeCfg(cfg);
      console.log('✓ Allow list cleared — all numbers are accepted now.');
      applyToService();
      warnIfEnvOverrides();
      return;
    }

    default:
      console.error(
        `Unknown subcommand: ${sub}\n` +
          `Usage: ${APP} allow [list|add|remove|clear] <number…>`,
      );
      process.exitCode = 1;
  }
}
