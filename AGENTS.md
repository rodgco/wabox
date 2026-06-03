# AGENTS.md

Guidance for AI coding agents working in this repo. Humans: see
[README.md](README.md) (usage) and [CONTRIBUTING.md](CONTRIBUTING.md) (process).

## What this is

**wabox** — a bridge between WhatsApp and the filesystem. It connects to WhatsApp
via [Baileys](https://github.com/WhiskeySockets/Baileys), writes incoming
messages (text + media) to an `inbox/` folder, and watches an `outbox/` folder
for jobs to send back. Shipped as a global npm CLI (`wabox`) with a per-OS
background service.

ESM, Node >= 18, **dependency-light** — prefer `node:` built-ins over new deps;
justify any new runtime dependency.

## Module map

| Path             | Responsibility                                                  |
| ---------------- | --------------------------------------------------------------- |
| `bin/cli.js`     | CLI dispatch (`config`/`run`/`pair`/`allow`/`update`/`status`/`uninstall`) |
| `src/paths.js`   | Cross-platform paths + the `APP` / `DISPLAY_NAME` constants. Pure, no I/O. |
| `config.js`      | Resolves settings: env var > `config.json` > defaults           |
| `src/gateway.js` | `startGateway()` (run loop) and `pair()` (one-shot pairing)     |
| `src/whatsapp.js`| Baileys connection, QR, reconnect logic                        |
| `src/inbox.js`   | Save incoming → inbox; `watchInbox()` → read receipts on delete |
| `src/outbox.js`  | Watch outbox → send text/files/replies/reactions               |
| `src/service.js` | Per-OS service manager (systemd/launchd/schtasks) + `none`      |
| `src/setup.js`   | Interactive `wabox config` flow                                 |
| `src/allow.js`   | Manage the allow list by phone number (offline)                |
| `src/update.js`  | `wabox update` — npm update + service restart                   |
| `scripts/release.mjs` | Release automation (dev only, not shipped)                |
| `scripts/build-skill.mjs` | Generates `skills/wabox/SKILL.md` from `INTEGRATION.md` |
| `INTEGRATION.md` | Canonical consumer contract; source for the skill              |

## Invariants & gotchas (read before editing)

- **The project name lives in one place:** `APP` and `DISPLAY_NAME` in
  `src/paths.js`. Derive from them — never hardcode `"wabox"`/`"Wabox"` in other
  files. (Folders, service name, log file, and CLI strings all flow from these.)
- **`config.js` reads `config.json` at import time.** So `bin/cli.js` must NOT
  statically import `config.js` or anything that pulls it in (gateway, logger,
  etc.) before setup may have written the file — it uses dynamic `import()` after
  config exists. `src/paths.js` is side-effect-free and safe to import early.
- **Only one Baileys connection per linked device.** Opening a second socket with
  the same creds knocks the running service offline. Anything that needs WhatsApp
  data (e.g. resolving a number→JID) must happen *inside* the running gateway —
  never spawn a second connection. This is why `wabox allow` is purely offline.
- **Pairing emits stream error 515 ("restart required")** right after the QR
  scan; the socket must reconnect to finish login. `whatsapp.js` reconnects on
  `DisconnectReason.restartRequired` even when `autoReconnect` is false. Don't
  "simplify" that away.
- **Two loggers:** `logger` (app, level `LOG_LEVEL`/`info`) and `baileysLogger`
  (Baileys internals, `BAILEYS_LOG_LEVEL`/`warn`). Baileys is noisy; keep its
  logs on the quieter logger. App-state resync / init-query (408) errors from
  Baileys are harmless.
- **Inbox cleanup is the consumer's job.** wabox never deletes inbox files;
  removing a message's `.json` is the signal to send a WhatsApp read receipt
  (blue ticks) via `watchInbox` → `sock.readMessages`.
- **Never commit `auth/`** (WhatsApp session credentials). It's gitignored.
- **Watchers rebind to the live socket** on reconnect (see `onReady` in
  `gateway.js`); module-level state (e.g. inbox key cache) persists across rebinds.
- **`skills/wabox/SKILL.md` is generated** from `INTEGRATION.md` by
  `scripts/build-skill.mjs` (frontmatter from `skills/wabox/skill.meta.json`).
  Never edit the skill by hand — edit `INTEGRATION.md` and run
  `npm run build:skill`. `npm run check:skill` fails if it's stale (the release
  regenerates it automatically).
- **Allow-list matching is by phone number.** When a chat is routed via a LID
  (`@lid`), the real number arrives in `m.key.senderPn` / `participantPn` —
  `allowed()` checks all of those, not just `remoteJid`. Don't regress this back
  to matching `remoteJid` only.

## Run & verify

There is **no automated test suite** and **no build step**. Verify manually:

```bash
# syntax-check everything
for f in bin/cli.js config.js index.js src/*.js scripts/*.mjs; do node --check "$f"; done

# show resolved paths + service state
node bin/cli.js status

# run end to end without touching real config/data: point XDG at a temp dir
XDG_CONFIG_HOME=/tmp/wabox-test/config XDG_DATA_HOME=/tmp/wabox-test/data \
  node bin/cli.js run
```

When testing anything that calls `getService()` (allow/update/status), beware:
`status()`/`restart()` query the **real** systemd/launchd, so a test can restart
the user's live service. Stub the service binary on `PATH` or assert on logic only.

Adding real tests (and an `npm test` script) is welcome.

## Releasing

`package.json` stays at the **last published** version; accumulate changes under
`## [Unreleased]` in `CHANGELOG.md`. Release with:

```bash
npm run release -- <patch|minor|major|x.y.z>   # add --dry-run to preview
```

It moves `[Unreleased]` to a dated version, bumps `package.json`, commits, tags
`vX.Y.Z` (annotated), publishes to npm (interactive OTP), then pushes.

## Commits

Present-tense summary; conventional prefixes (`feat:`/`fix:`/`docs:`/`chore:`)
appreciated. Mark AI-assisted commits with a `Co-Authored-By:` trailer.
