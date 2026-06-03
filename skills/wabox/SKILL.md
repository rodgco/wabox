---
name: wabox
description: Read and reply to WhatsApp messages through a wabox inbox/outbox folder pair. Use when a wabox gateway is running and you need to process incoming WhatsApp messages (text or media), reply, react with an emoji, quote-reply, or send files over WhatsApp via the filesystem.
---

# wabox — WhatsApp via the filesystem

[wabox](https://github.com/rodgco/wabox) bridges WhatsApp and the filesystem.
Incoming messages land as JSON files in an `inbox/` folder; you reply by writing
job files to an `outbox/` folder. **There is no API — only files.**

## Find the folders

Run `wabox status` to print the resolved paths. Defaults:

- Linux: `~/.local/share/wabox/{inbox,outbox}`
- macOS: `~/Library/Application Support/wabox/{inbox,outbox}`
- Windows: `%LOCALAPPDATA%\wabox\{inbox,outbox}`

## Lifecycle: read → remove → respond

1. A message appears as `inbox/<stem>.json` (plus a media file alongside it, if any).
2. **Capture it:** read the JSON (and any media bytes) into memory, or move the
   files into a working folder.
3. **Remove the `.json` from `inbox/` right away** (delete or move). This is the
   "I've read this" signal — wabox immediately marks the message **read** on
   WhatsApp (blue checkmarks).
4. **Process and respond:** do your work, then write a reply job to `outbox/`.

Remove on pickup (step 3) *before* processing (step 4), so the sender is
acknowledged fast even when the reply is slow. wabox never cleans the inbox —
removal is your job and is the only read signal. Capture the JSON **and** any
media before deleting (deletion removes the media file too); prefer **moving**
the files if you want to keep them while you work.

## Reading an inbox message

```json
{
  "id": "3A80DACFEEF3EEE1A448",
  "from": "277880256909343@lid",
  "number": "5511983426258",
  "participant": null,
  "pushName": "Alice",
  "fromMe": false,
  "timestamp": "2026-06-03T09:25:34.000Z",
  "text": "check this photo",
  "media": { "type": "image", "file": "20260603-...-A1B2.jpg", "mimetype": "image/jpeg" }
}
```

- `id` — message id; use it for `replyTo` / `react`.
- `from` — chat JID. `…@s.whatsapp.net` or `…@lid` = a person; `…@g.us` = a group.
- `number` — the sender's real phone number (digits); the best thing to reply to in DMs.
- `participant` — in groups, the sender's JID; `null` in 1:1 chats.
- `text` — message text or media caption (may be empty).
- `media` — `null`, or `{ type, file, originalName, mimetype }`. `type` is
  `image|video|audio|document|sticker`. The file sits next to the JSON; open
  `inbox/<media.file>` for its bytes.

## Replying: write an outbox job

Write a `.json` file into `outbox/` (any name ending in `.json`). **Write it
atomically** — create it under a temp name and `rename`/move it into `outbox/`,
so the watcher never reads a half-written file.

```json
{
  "to": "5511983426258",
  "text": "Got it — summary attached",
  "replyTo": { "id": "3A80DACFEEF3EEE1A448" },
  "react": { "emoji": "👍", "messageId": "3A80DACFEEF3EEE1A448" },
  "files": ["summary.pdf"]
}
```

- `to` (required) — **DM:** the inbox `number` (digits, country code, no `+`).
  **Group:** the inbox `from` (the `…@g.us` JID).
- `text` — body; sent on its own with no files, otherwise the caption of file #1.
- `files` — array of paths; relative paths resolve against `outbox/`, absolute ok.
- `replyTo` — quote-reply; a message id string or `{ id, participant, text }`
  (pass `participant` from the inbox JSON in groups).
- `react` — `{ emoji, messageId, participant }`; an empty `emoji` removes a
  reaction. Can be a job on its own or ride along with `text`/`files`.

Processed jobs move to `outbox/sent/`; failures move to `outbox/failed/` with a
`.error.txt` sidecar.

## What you can send

Text, image (jpg/png/gif/webp), video (mp4/mov/3gp), audio (ogg/mp3/m4a/wav),
any other file as a document, and emoji reactions. The kind is inferred from the
file extension. Multiple files = separate messages in order. Keep media within
WhatsApp's limits (~16 MB for image/audio/video; larger for documents); for long
text, send a document instead of a giant message.

## WhatsApp text formatting (not Markdown)

- `*bold*`, `_italic_`, `~strikethrough~`, and triple-backtick monospace blocks.
- Newlines are preserved.
- No Markdown headings (`#`) or links (`[text](url)`) — paste raw URLs; they auto-link.

## Etiquette

- Chat, don't essay — keep replies short; attach a document for long content.
- Acknowledge with a reaction (👀 / 👍) instead of a verbose "working on it".
- Match the sender's language.
- Remove the inbox file on pickup (it fires the read receipt); reply when ready.
- If a chat reaches you it's already allowed — you don't manage access.

## Examples

React only (acknowledge):

```json
{ "to": "5511983426258", "react": { "emoji": "👀", "messageId": "3A80...A448" } }
```

Quote-reply with a file:

```json
{ "to": "5511983426258", "text": "Done", "replyTo": { "id": "3A80...A448" }, "files": ["out/report.pdf"] }
```

Reply in a group, quoting the sender:

```json
{ "to": "120363...@g.us", "text": "On it", "replyTo": { "id": "3A80...A448", "participant": "5511983426258@s.whatsapp.net" } }
```

For the full reference see [INTEGRATION.md](https://github.com/rodgco/wabox/blob/main/INTEGRATION.md).
