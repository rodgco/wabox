// Cross-platform background-service abstraction.
//
//   Linux + systemd : systemd --user unit
//   Linux (no systemd): none -> caller prints manual instructions
//   macOS           : launchd LaunchAgent (runs at login)
//   Windows         : Task Scheduler task (runs at logon)
//
// getService() returns an object:
//   kind        'systemd' | 'launchd' | 'schtasks' | 'none'
//   label       human description
//   name        unit / agent / task name
//   available() boolean — is the manager usable on this machine?
//   install({cliPath, execPath})  -> Promise<string|null>  writes the unit file
//   enable()    register + start now (sync, may print)
//   status()    -> string
//   uninstall() -> Promise<string|null>  stop + remove
//   restartHint / logsHint  strings for the user
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { APP, DISPLAY_NAME, home, platform, dataDir, logFile } from './paths.js';

function probe(bin, args) {
  try {
    execFileSync(bin, args, { stdio: 'ignore' });
    return true;
  } catch (err) {
    // Tool exists but exited non-zero -> still "available". Only a missing
    // binary (ENOENT) means the manager isn't there.
    return err.code !== 'ENOENT';
  }
}

function systemdService() {
  const xdgConfig =
    process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  const dir = path.join(xdgConfig, 'systemd', 'user');
  const name = `${APP}.service`;
  const file = path.join(dir, name);
  return {
    kind: 'systemd',
    label: 'systemd user service',
    name,
    available: () => probe('systemctl', ['--user', 'is-system-running']),
    async install({ cliPath, execPath }) {
      const unit = `[Unit]
Description=${DISPLAY_NAME} WhatsApp gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${execPath} ${cliPath} run
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(file, unit);
      try {
        execFileSync('systemctl', ['--user', 'daemon-reload'], {
          stdio: 'ignore',
        });
      } catch {
        /* non-fatal */
      }
      return file;
    },
    enable() {
      execFileSync('systemctl', ['--user', 'enable', '--now', name], {
        stdio: 'inherit',
      });
    },
    status() {
      try {
        return execFileSync('systemctl', ['--user', 'is-active', name], {
          encoding: 'utf8',
        }).trim();
      } catch (err) {
        return (err.stdout || '').toString().trim() || 'inactive';
      }
    },
    async uninstall() {
      try {
        execFileSync('systemctl', ['--user', 'disable', '--now', name], {
          stdio: 'ignore',
        });
      } catch {
        /* not running */
      }
      await fs.rm(file, { force: true });
      try {
        execFileSync('systemctl', ['--user', 'daemon-reload'], {
          stdio: 'ignore',
        });
      } catch {
        /* ignore */
      }
      return file;
    },
    restartHint: `systemctl --user restart ${name}`,
    logsHint: `journalctl --user -u ${name} -f`,
  };
}

function launchdService() {
  const name = APP; // launchd Label
  const dir = path.join(home, 'Library', 'LaunchAgents');
  const file = path.join(dir, `${name}.plist`);
  const domain = () => `gui/${process.getuid()}`;
  return {
    kind: 'launchd',
    label: 'launchd user agent (starts at login)',
    name,
    available: () => probe('launchctl', ['help']),
    async install({ cliPath, execPath }) {
      const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${name}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${execPath}</string>
    <string>${cliPath}</string>
    <string>run</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${logFile}</string>
  <key>StandardErrorPath</key>
  <string>${logFile}</string>
</dict>
</plist>
`;
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(file, plist);
      return file;
    },
    enable() {
      // Modern API first, fall back to legacy load for older macOS.
      try {
        execFileSync('launchctl', ['bootstrap', domain(), file], {
          stdio: 'inherit',
        });
      } catch {
        execFileSync('launchctl', ['load', '-w', file], { stdio: 'inherit' });
      }
      try {
        execFileSync('launchctl', ['enable', `${domain()}/${name}`], {
          stdio: 'ignore',
        });
      } catch {
        /* best effort */
      }
    },
    status() {
      try {
        const out = execFileSync('launchctl', ['list'], { encoding: 'utf8' });
        return out.split('\n').some((l) => l.includes(name))
          ? 'loaded'
          : 'not loaded';
      } catch {
        return 'unknown';
      }
    },
    async uninstall() {
      try {
        execFileSync('launchctl', ['bootout', `${domain()}/${name}`], {
          stdio: 'ignore',
        });
      } catch {
        try {
          execFileSync('launchctl', ['unload', '-w', file], {
            stdio: 'ignore',
          });
        } catch {
          /* not loaded */
        }
      }
      await fs.rm(file, { force: true });
      return file;
    },
    restartHint: `launchctl kickstart -k gui/$(id -u)/${name}`,
    logsHint: `tail -f "${logFile}"`,
  };
}

function schtasksService() {
  const name = APP; // task name
  const wrapper = path.join(dataDir, 'run.cmd');
  return {
    kind: 'schtasks',
    label: 'Windows scheduled task (starts at logon)',
    name,
    available: () => probe('schtasks', ['/Query', '/?']),
    async install({ cliPath, execPath }) {
      // Task Scheduler can't redirect output, so run via a tiny wrapper that
      // appends to the log file.
      await fs.mkdir(dataDir, { recursive: true });
      const cmd = `@echo off\r\n"${execPath}" "${cliPath}" run >> "${logFile}" 2>&1\r\n`;
      await fs.writeFile(wrapper, cmd);
      return wrapper;
    },
    enable() {
      execFileSync(
        'schtasks',
        [
          '/Create',
          '/TN',
          name,
          '/TR',
          `"${wrapper}"`,
          '/SC',
          'ONLOGON',
          '/RL',
          'LIMITED',
          '/F',
        ],
        { stdio: 'inherit' },
      );
      try {
        execFileSync('schtasks', ['/Run', '/TN', name], { stdio: 'inherit' });
      } catch {
        /* will start at next logon */
      }
    },
    status() {
      try {
        execFileSync('schtasks', ['/Query', '/TN', name], { stdio: 'ignore' });
        return 'registered';
      } catch {
        return 'not registered';
      }
    },
    async uninstall() {
      try {
        execFileSync('schtasks', ['/Delete', '/TN', name, '/F'], {
          stdio: 'ignore',
        });
      } catch {
        /* not registered */
      }
      await fs.rm(wrapper, { force: true });
      return wrapper;
    },
    restartHint: `schtasks /End /TN ${name} & schtasks /Run /TN ${name}`,
    logsHint: `type "${logFile}"`,
  };
}

function noService() {
  return {
    kind: 'none',
    label: 'no supported service manager',
    name: APP,
    available: () => false,
    async install() {
      return null;
    },
    enable() {
      throw new Error('no service manager available');
    },
    status() {
      return 'n/a';
    },
    async uninstall() {
      return null;
    },
    restartHint: `${APP} run`,
    logsHint: `run in the foreground with: ${APP} run`,
  };
}

export function getService() {
  if (platform === 'darwin') return launchdService();
  if (platform === 'win32') return schtasksService();
  // Linux / other Unix: prefer systemd, otherwise no service.
  const s = systemdService();
  return s.available() ? s : noService();
}
