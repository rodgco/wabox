# Contributing to wabox

Thanks for your interest in improving wabox! This is a small project — a bridge
between WhatsApp and the filesystem — so the process is light. Bug reports,
docs fixes, and features are all welcome.

## Getting started

```bash
git clone git@github.com:wabox-app/wabox.git
cd wabox
npm install

# run the gateway from the checkout (prints a QR on first run)
npm start            # = node bin/cli.js run

# or exercise the interactive setup
npm run config
```

Requires **Node.js >= 18**. wabox runs on Linux, macOS and Windows.

> Using an AI coding agent? [AGENTS.md](https://github.com/wabox-app/wabox/blob/main/AGENTS.md) documents the architecture and
> the project's key invariants and gotchas — worth a read before any change.

## Project layout

| Path             | What it does                                                     |
| ---------------- | --------------------------------------------------------------- |
| `bin/cli.js`     | CLI entry / command dispatch (`config`, `run`, `pair`, …)        |
| `src/paths.js`   | Cross-platform paths + the `APP` / `DISPLAY_NAME` constants      |
| `config.js`      | Resolves settings (env > config file > defaults)                 |
| `src/gateway.js` | Wires the WhatsApp connection to inbox/outbox; `pair()`          |
| `src/whatsapp.js`| Baileys connection, QR, reconnect                               |
| `src/inbox.js`   | Saves incoming messages + media to the inbox                     |
| `src/outbox.js`  | Watches the outbox and sends text/files/replies/reactions       |
| `src/service.js` | Background-service install per OS (systemd/launchd/schtasks)     |
| `src/setup.js`   | Interactive `wabox config` flow                                  |

The project name lives in one place — `APP` / `DISPLAY_NAME` in `src/paths.js`.
Don't hardcode it elsewhere; derive from those constants.

`skills/wabox/SKILL.md` is **generated** from `INTEGRATION.md` (the canonical
consumer guide). Edit `INTEGRATION.md`, then run `npm run build:skill`;
`npm run check:skill` verifies the two are in sync.

## Making changes

- **Style**: match the surrounding code. ES modules, 2-space indent, small
  focused functions, comments that explain *why* (not *what*).
- **Keep it dependency-light.** Prefer Node built-ins (`node:*`) over adding a
  package. New runtime dependencies should be justified in the PR.
- **No secrets in the repo.** Never commit anything under `auth/` (WhatsApp
  session credentials) — it's already in `.gitignore`.

## Verifying your change

There's no automated test suite yet, so please verify manually:

```bash
# 1. syntax-check every module
for f in bin/cli.js config.js index.js src/*.js; do node --check "$f"; done

# 2. check resolved paths / service detection
node bin/cli.js status

# 3. run against a test WhatsApp number and confirm the behavior you changed
#    (incoming -> inbox/, outbox/ job -> sent message)
```

To test without touching your real config/data, point the XDG vars at a temp
dir:

```bash
XDG_CONFIG_HOME=/tmp/wabox-test/config XDG_DATA_HOME=/tmp/wabox-test/data \
  node bin/cli.js status
```

Adding tests is very welcome — if you set up a runner, wire it to an `npm test`
script.

## Commits & pull requests

- Write clear, present-tense commit messages (a short summary line, then a body
  if needed). Conventional-commit prefixes (`feat:`, `fix:`, `docs:`) are
  appreciated but not required.
- Keep PRs focused; one logical change per PR is easier to review.
- Describe what you changed and how you verified it.

## AI-assisted contributions

AI coding assistants are welcome here — wabox itself was built with one. We just
ask for honesty and care:

- **Disclose meaningful AI assistance** in your PR description (e.g. "drafted
  the launchd support with an assistant, reviewed and tested by me"). Trivial
  autocomplete doesn't need a note.
- **You are responsible for your code.** Understand it, test it, and don't
  submit anything you can't explain.
- **Mark AI-assisted commits** with a `Co-Authored-By:` trailer for the tool.
- **Don't paste in code you don't have the right to license** under MIT — the
  same rule as any other contribution.

## Releasing (maintainers)

Releases are automated by `scripts/release.mjs`. From a clean `main`:

```bash
npm run release -- patch        # or: minor | major | an explicit x.y.z
npm run release -- patch --dry-run   # preview without writing/publishing
```

It moves `CHANGELOG.md`'s `[Unreleased]` entries under a new dated version,
bumps `package.json`, commits + tags `vX.Y.Z`, runs `npm publish` (OTP is
prompted), then pushes. Keep `package.json` at the last published version and
record changes under `[Unreleased]` between releases.

## Reporting bugs / requesting features

Open an issue: https://github.com/wabox-app/wabox/issues — include your OS,
Node version, and steps to reproduce. For anything involving message handling, a
redacted example of the inbox/outbox JSON is very helpful.

## License

By contributing, you agree that your contributions are licensed under the
project's [MIT License](https://github.com/wabox-app/wabox/blob/main/LICENSE).
