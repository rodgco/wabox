// `wabox update`: updates the globally-installed npm package, then restarts the
// background service so the new version takes effect.
//
// Assumes a global npm install (`npm install -g wabox`). The currently-running
// process keeps executing the old code in memory while npm swaps the files;
// the service restart at the end is what actually picks up the new version.
import { execFileSync } from 'node:child_process';
import { APP } from './paths.js';
import { getService } from './service.js';

export async function runUpdate({ version = 'latest' } = {}) {
  const spec = `${APP}@${version}`;

  console.log(`==> Updating ${spec} (npm install -g)…`);
  try {
    execFileSync('npm', ['install', '-g', spec], { stdio: 'inherit' });
  } catch (err) {
    console.error(`⚠ npm install failed: ${err.message}`);
    console.error(`  Try manually: npm install -g ${spec}`);
    throw err;
  }

  const svc = getService();
  if (svc.kind === 'none' || !svc.available()) {
    console.log(
      `\n✓ Updated. No service manager here — run '${APP} run' to use the new version.`,
    );
    return;
  }

  console.log(`\n==> Restarting service (${svc.label})…`);
  try {
    svc.restart();
    console.log(`✓ Updated and restarted. Logs: ${svc.logsHint}`);
  } catch (err) {
    console.error(`⚠ Restart failed: ${err.message}`);
    console.log(
      `  The package was updated; restart manually: ${svc.restartHint}`,
    );
    console.log(`  (If the service isn't installed yet, run '${APP} config'.)`);
  }
}
