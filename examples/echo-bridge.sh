#!/usr/bin/env bash
# ============================================================================
# echo-bridge.sh
#
# The smallest useful wabox consumer: watches the inbox, echoes incoming text
# back to the sender as "echo: <text>". A learning artifact — read it to
# understand the envelope schema and the read-receipt-by-move pattern.
#
# For a real bot — slash commands, per-sender Claude sessions, single-instance
# locking, pluggable agent backends (Claude Code, aider, …) — use wabox-bot:
#
#   https://github.com/wabox-app/wabox-bot
#
# Quick start:
#   export WABOX_INBOX=$(wabox status --json | jq -r .inbox)
#   export WABOX_OUTBOX=$(wabox status --json | jq -r .outbox)
#   ./examples/echo-bridge.sh
#
# Requires: bash 4+, inotify-tools, jq.
# ============================================================================
set -euo pipefail
: "${WABOX_INBOX:?set WABOX_INBOX (try: \$(wabox status --json | jq -r .inbox))}"
: "${WABOX_OUTBOX:?set WABOX_OUTBOX (try: \$(wabox status --json | jq -r .outbox))}"

handle() {
  local f="$1" env to text id stem
  env="$(cat -- "$f" 2>/dev/null)" || return 0
  jq -e . <<<"$env" >/dev/null 2>&1 || { mv -- "$f" "$f.bad" 2>/dev/null; return; }
  to="$(jq -r '.from   // empty' <<<"$env")"
  text="$(jq -r '.text // empty' <<<"$env")"
  id="$(jq -r '.id    // empty' <<<"$env")"
  # Removing the inbox file fires the WhatsApp read receipt immediately —
  # users see blue ticks before we've thought about a reply.
  rm -f -- "$f"
  [[ -z "$to" || -z "$text" ]] && return  # ignore media-only / unaddressed
  stem="$(date +%s%N)"
  # Atomic write: dot-tmp + rename so wabox never reads a half-written file.
  jq -n --arg to "$to" --arg t "echo: $text" --arg r "$id" \
    '{to:$to, text:$t, replyTo:{id:$r}}' \
    >"$WABOX_OUTBOX/.$stem.tmp.json"
  mv "$WABOX_OUTBOX/.$stem.tmp.json" "$WABOX_OUTBOX/$stem.json"
}

# Catch up on anything already sitting in the inbox at startup …
for f in "$WABOX_INBOX"/*.json; do [[ -f $f ]] && handle "$f"; done
# … then follow new arrivals.
inotifywait -m -q -e close_write -e moved_to --format '%w%f' "$WABOX_INBOX" |
  while read -r path; do [[ $path == *.json ]] && handle "$path"; done
