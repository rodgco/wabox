#!/usr/bin/env node
// wabox CLI. Subcommands:
//   config     interactive setup: config file, service, WhatsApp pairing
//   run        run the gateway in the foreground (what the service executes)
//   pair       (re)pair with WhatsApp by scanning a QR
//   status     show resolved paths and service status
//   uninstall  remove the systemd service (--purge also deletes config + data)
//   help       this message
//
// Nothing that imports config.js is loaded statically — config.js reads the
// config file at import time, so we import the gateway only after setup may have
// written it.
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { APP } from '../src/paths.js';

const CLI_PATH = fileURLToPath(import.meta.url);
const cmd = process.argv[2] || 'help';

function help() {
  console.log(`${APP} — a bridge between WhatsApp and your filesystem

Usage:
  ${APP} config       Interactive setup (config, service, pairing)
  ${APP} run          Run the gateway in the foreground
  ${APP} pair         (Re)pair with WhatsApp via QR code
  ${APP} status       Show paths and service status
  ${APP} uninstall    Remove the background service (--purge: also data/config)
  ${APP} help         Show this help

Typical install:
  npm install -g ${APP}
  ${APP} config
`);
}

async function status() {
  const { config } = await import('../config.js');
  const { getService } = await import('../src/service.js');
  const svc = getService();
  console.log('Paths:');
  console.log(`  config : ${config.configFile}`);
  console.log(`  inbox  : ${config.inboxDir}`);
  console.log(`  outbox : ${config.outboxDir}`);
  console.log(`  auth   : ${config.authDir}`);
  console.log('\nService:');
  console.log(`  manager: ${svc.label}`);
  console.log(`  ${svc.name}: ${svc.status()}`);
}

async function uninstall() {
  const { getService } = await import('../src/service.js');
  const { configDir, dataDir } = await import('../src/paths.js');
  const svc = getService();
  const file = await svc.uninstall();
  if (file) console.log(`✓ Serviço removido (${svc.label})`);
  if (process.argv.includes('--purge')) {
    fs.rmSync(configDir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
    console.log(`✓ Removidos config (${configDir}) e dados (${dataDir})`);
  } else {
    console.log('Config e dados mantidos. Use --purge para removê-los também.');
  }
}

async function main() {
  switch (cmd) {
    case 'config':
    case 'setup': {
      const { runConfig } = await import('../src/setup.js');
      await runConfig({ cliPath: CLI_PATH, execPath: process.execPath });
      break;
    }
    case 'run':
    case 'start': {
      const { startGateway } = await import('../src/gateway.js');
      await startGateway();
      break;
    }
    case 'pair': {
      const { pair } = await import('../src/gateway.js');
      console.log('Escaneie o QR em WhatsApp > Aparelhos conectados...\n');
      await pair();
      console.log('✓ Pareado.');
      process.exit(0);
      break;
    }
    case 'status':
      await status();
      break;
    case 'uninstall':
      await uninstall();
      break;
    case 'help':
    case '--help':
    case '-h':
      help();
      break;
    default:
      console.error(`Comando desconhecido: ${cmd}\n`);
      help();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(1);
});
