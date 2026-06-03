# wabox

[![npm version](https://img.shields.io/npm/v/wabox.svg)](https://www.npmjs.com/package/wabox)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](package.json)
[![Platforms](https://img.shields.io/badge/platform-Linux%20%7C%20macOS%20%7C%20Windows-blue.svg)](#install)

A bridge between **WhatsApp and your filesystem**. It connects to WhatsApp via
[Baileys](https://github.com/WhiskeySockets/Baileys), drops every incoming
message (text + media) into an `inbox/` folder, and watches an `outbox/` folder
for messages to send back.

The idea: point any process at these two folders. It reads new messages from
`inbox/`, and replies by writing job files to `outbox/` — no API to learn, just
files.

## Install

```bash
npm install -g wabox
wabox config
```

Works on **Linux, macOS and Windows.** `wabox config` is an interactive
setup that:

1. asks whether you want the defaults or to customize the folders,
2. writes `config.json` and creates the data folders (locations below),
3. installs a background service for your OS (systemd / launchd / Task Scheduler),
4. pairs with WhatsApp — scan the QR with **WhatsApp → Linked Devices**,
5. offers to enable + start the service.

That's it — it runs in the background and starts on login/boot.

### Per-OS locations

Each OS uses its native convention. Setting `XDG_CONFIG_HOME` / `XDG_DATA_HOME`
overrides them on any platform.

| OS      | Config                                  | Data (inbox/outbox/auth)                  | Service                                          |
| ------- | --------------------------------------- | ----------------------------------------- | ------------------------------------------------ |
| Linux   | `~/.config/wabox/`                 | `~/.local/share/wabox/`              | `~/.config/systemd/user/wabox.service`      |
| macOS   | `~/Library/Application Support/wabox/` | *(same as config)*                     | `~/Library/LaunchAgents/wabox.plist`        |
| Windows | `%APPDATA%\wabox\`                  | `%LOCALAPPDATA%\wabox\`              | Task Scheduler task `wabox` (runs at logon) |

Run `wabox status` any time to print the resolved paths and service state.

### Commands

```bash
wabox config       # interactive setup (config + service + pairing)
wabox run          # run the gateway in the foreground (what the service runs)
wabox pair         # (re)pair with WhatsApp via QR
wabox status       # show resolved paths + service state
wabox uninstall    # remove the service (--purge: also config + data)
```

### Managing the service directly

```bash
# Linux (systemd)
systemctl --user status|restart wabox.service
journalctl --user -u wabox.service -f
# keep running while logged out:
sudo loginctl enable-linger $USER

# macOS (launchd)
launchctl kickstart -k gui/$(id -u)/wabox     # restart
tail -f "~/Library/Application Support/wabox/wabox.log"

# Windows (Task Scheduler)
schtasks /Run /TN wabox                        # start now
type "%LOCALAPPDATA%\wabox\wabox.log"     # logs
```

> No systemd on Linux (e.g. minimal/container distros)? Setup still writes the
> config and pairs; run the gateway yourself with `wabox run` (under your
> own supervisor of choice).

### Running from a checkout (no global install)

```bash
npm install
npm run config      # same interactive setup
npm start           # = wabox run
```

### Putting the inbox/outbox somewhere else

Edit your `config.json` (see the table above for its location) and point the
folders anywhere:

```json
{
  "inboxDir": "~/whatsapp/inbox",
  "outboxDir": "~/whatsapp/outbox"
}
```

Relative paths resolve against the data dir; `~` is expanded. Then restart the
service (see "Managing the service directly").

## How it works

### Inbox (incoming)

Each incoming message produces a JSON file in `inbox/`, e.g.
`20260603-031200_5511999998888_3EB0ABCD.json`:

```json
{
  "id": "3EB0ABCD...",
  "from": "5511999998888@s.whatsapp.net",
  "pushName": "Alice",
  "fromMe": false,
  "timestamp": "2026-06-03T03:12:00.000Z",
  "text": "check out this photo",
  "media": {
    "type": "image",
    "file": "20260603-031200_5511999998888_3EB0ABCD.jpg",
    "originalName": null,
    "mimetype": "image/jpeg"
  }
}
```

Media (images, video, audio, documents, stickers) is downloaded next to the
JSON, with `media.file` pointing at it. Text-only messages just have
`"media": null`.

### Outbox (outgoing)

To send a message, write a `.json` file into `outbox/`:

```json
{
  "to": "5511999998888",
  "text": "Hello from Claude!",
  "files": ["reply.pdf", "/abs/path/photo.jpg"]
}
```

- `to` — a bare phone number (country code + number, no `+`) or a full JID
  (`...@s.whatsapp.net` for people, `...@g.us` for groups).
- `text` — optional. Sent on its own if there are no files, otherwise used as
  the caption of the first file.
- `files` — optional list. Relative paths resolve against `outbox/`. File type
  (image / video / audio / document) is inferred from the extension.
- `replyTo` — optional. Quote-reply to an incoming message. Either a bare
  message id string, or an object `{ "id", "participant", "text" }`. Copy `id`
  (and `participant` for groups) straight from the inbox JSON; `text` is just
  the preview shown in the quote bubble.
- `react` — optional. Add an emoji reaction to a message:
  `{ "emoji": "👍", "messageId": "3EB0...", "participant": null }`. An empty
  `emoji` removes a previously sent reaction. A reaction can be the whole job or
  ride along with `text`/`files`.

Reply + reaction example:

```json
{
  "to": "5511999998888",
  "text": "claro, segue o arquivo",
  "replyTo": { "id": "3EB0ABCD...", "participant": null },
  "react": { "emoji": "👍", "messageId": "3EB0ABCD..." },
  "files": ["doc.pdf"]
}
```

Once processed, the job file is moved to `outbox/sent/`. If it fails, it goes to
`outbox/failed/` with a `.error.txt` sidecar explaining why.

> Tip: write the file to a temp name first and rename it into `outbox/` (atomic),
> so the watcher never reads a half-written file. The watcher also waits for
> writes to settle, but rename is safest.

## Configuration

Settings come from (highest priority first): **environment variable** →
**`~/.config/wabox/config.json`** → **built-in default**.

| config.json key | Env var          | Default               | Purpose                                           |
| --------------- | ---------------- | --------------------- | ------------------------------------------------- |
| `inboxDir`      | `INBOX_DIR`      | `<data>/inbox`        | Where incoming messages/media are written.        |
| `outboxDir`     | `OUTBOX_DIR`     | `<data>/outbox`       | Watched for outgoing job files.                   |
| `authDir`       | `AUTH_DIR`       | `<data>/auth`         | WhatsApp session storage.                         |
| `allowFrom`     | `ALLOW_FROM`     | `[]` (all)            | Numbers/JIDs to accept (array, or CSV in env).    |
| `ignoreFromMe`  | `IGNORE_FROM_ME` | `true`                | Skip messages the bot itself sent.                |
| `logLevel`      | `LOG_LEVEL`      | `info`                | pino log level.                                   |

`<data>` is the per-OS data dir from the locations table above. Relative paths
in `config.json` resolve against `<data>`; `~` is expanded.

## Notes

- This uses the unofficial WhatsApp Web protocol via Baileys. Use a number you
  control and don't abuse it.
- Deleting `auth/` forces a fresh QR pairing.

## License

[MIT](LICENSE) © Rodrigo Couto
