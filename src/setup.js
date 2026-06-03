// Interactive setup for `wabox config`:
//   1. ask defaults vs. advanced, build settings
//   2. write the config file + create data folders
//   3. install the platform background service (systemd/launchd/schtasks)
//   4. pair with WhatsApp (Baileys)
//   5. offer to enable + start the service
//
// This module deliberately avoids importing config.js / gateway.js at the top
// level so config.js doesn't cache an outdated config before we write it. The
// gateway is imported dynamically, after config.json exists.
import fs from 'node:fs/promises';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { APP, DISPLAY_NAME, configDir, configFile, defaults, resolveData } from './paths.js';
import { getService } from './service.js';

function makeAsk() {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  return {
    async text(question, def) {
      const hint = def ? ` [${def}]` : '';
      const a = (await rl.question(`${question}${hint}: `)).trim();
      return a || def || '';
    },
    async yesNo(question, def = true) {
      const hint = def ? ' [S/n]' : ' [s/N]';
      const a = (await rl.question(`${question}${hint}: `)).trim().toLowerCase();
      if (!a) return def;
      return ['s', 'sim', 'y', 'yes'].includes(a);
    },
    close() {
      rl.close();
    },
  };
}

async function collectSettings(ask) {
  const advanced = await ask.yesNo(
    'Configuração avançada? (senão usa as pastas padrão)',
    false,
  );

  if (!advanced) {
    return { ...defaults };
  }

  const inboxDir = await ask.text('Pasta de entrada (inbox)', defaults.inboxDir);
  const outboxDir = await ask.text('Pasta de saída (outbox)', defaults.outboxDir);
  const authDir = await ask.text('Pasta da sessão WhatsApp (auth)', defaults.authDir);
  const logLevel = await ask.text('Nível de log (trace/debug/info/warn/error)', defaults.logLevel);
  const allowRaw = await ask.text(
    'Aceitar só destes números/JIDs (vírgula, vazio = todos)',
    '',
  );
  const ignoreFromMe = await ask.yesNo('Ignorar mensagens enviadas por você mesmo?', true);

  return {
    inboxDir,
    outboxDir,
    authDir,
    logLevel,
    allowFrom: allowRaw
      ? allowRaw.split(',').map((s) => s.trim()).filter(Boolean)
      : [],
    ignoreFromMe,
  };
}

async function writeConfig(settings) {
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(configFile, JSON.stringify(settings, null, 2) + '\n');
  await Promise.all([
    fs.mkdir(resolveData(settings.inboxDir), { recursive: true }),
    fs.mkdir(resolveData(settings.outboxDir), { recursive: true }),
    fs.mkdir(resolveData(settings.authDir), { recursive: true }),
  ]);
  console.log(`\n✓ Config salva em ${configFile}`);
}

// cliPath: absolute path to bin/cli.js; execPath: node binary (process.execPath)
export async function runConfig({ cliPath, execPath }) {
  console.log(`— Configuração do ${DISPLAY_NAME} —\n`);

  const svc = getService();
  const canService = svc.kind !== 'none' && svc.available();

  let configExists = false;
  try {
    await fs.access(configFile);
    configExists = true;
  } catch {
    /* no config yet */
  }

  // --- Phase 1: ask everything up front (no async I/O between prompts, so
  // piped/non-TTY input doesn't trip the readline auto-close on EOF). ---
  const ask = makeAsk();
  let settings = null; // null = keep existing config

  if (configExists) {
    const overwrite = await ask.yesNo(
      `Já existe ${configFile}. Sobrescrever?`,
      false,
    );
    if (overwrite) settings = await collectSettings(ask);
  } else {
    settings = await collectSettings(ask);
  }

  const doPair = await ask.yesNo('Parear com o WhatsApp agora?', true);
  const doEnable = canService
    ? await ask.yesNo(`Habilitar e iniciar o serviço (${svc.label}) agora?`, true)
    : false;
  ask.close();

  // --- Phase 2: act on the answers. ---
  if (settings) await writeConfig(settings);
  else console.log('• Mantendo a config existente.');

  if (canService) {
    const file = await svc.install({ cliPath, execPath });
    console.log(`✓ Serviço instalado (${svc.label})${file ? `\n  ${file}` : ''}`);
  } else {
    console.log(
      `⚠ Nenhum gerenciador de serviço suportado neste sistema.\n` +
        `  Rode o gateway manualmente quando quiser: ${APP} run`,
    );
  }

  if (doPair) {
    console.log(
      '\nEscaneie o QR em WhatsApp > Aparelhos conectados > Conectar aparelho...\n',
    );
    const { pair } = await import('./gateway.js');
    await pair();
    console.log('\n✓ Pareado.');
  } else {
    console.log(`• Pareamento pulado. Rode depois: ${APP} pair`);
  }

  if (doEnable) {
    try {
      svc.enable();
      console.log(`\n✓ Serviço ativo. Logs: ${svc.logsHint}`);
    } catch (err) {
      console.error(`⚠ Falha ao iniciar o serviço: ${err.message}`);
    }
  } else if (canService) {
    console.log(`• Para iniciar depois, rode '${APP} config' de novo.`);
  }

  console.log('\nPronto. 🎉');
}
