#!/usr/bin/env bash
# ============================================================================
# wabox-claude-code.sh
#
# Bridge wabox (WhatsApp ↔ filesystem) to the Claude Code CLI.
#
#   inbox/<id>.json  →  per-sender Claude session  →  outbox/<id>.json
#
# What it does
# ------------
#   1. Watches `inbox/` with inotifywait for new *.json envelopes.
#   2. As soon as one appears, MOVES it out of `inbox/` (and any sibling media
#      file). That move is what fires wabox's "read receipt" on WhatsApp —
#      so the sender sees the blue ticks the instant we pick the message up,
#      not after Claude finishes thinking.
#   3. Parses the envelope, picks a "conversation key" from it (the WhatsApp
#      JID, or JID+participant for groups when GROUP_PER_PARTICIPANT=1), and
#      looks up a Claude session id stashed on disk for that conversation.
#   4. Runs `claude -p` with `--resume <session>` (or `--session-id <new>`
#      for the first message), pipes the WhatsApp text in on stdin, captures
#      the reply on stdout.
#   5. Writes the reply atomically into `outbox/` as a valid wabox job
#      (`to`, `text`, `replyTo`).
#
# Why -p instead of interactive mode
# ----------------------------------
# The brief asked for a "persistent Claude process per sender in interactive
# mode". Claude's interactive mode is a TUI that requires a TTY — it can't be
# safely driven from stdin/stdout in a bash loop, and there is no reliable
# delimiter that says "the model is done talking". The supported, robust way
# to get the *same outcome* (an isolated, persistent conversation thread per
# sender that remembers history) is `claude -p` with `--session-id` /
# `--resume`. Each conversation gets its own session id; Claude restores the
# full history every turn. From the user's perspective it behaves exactly
# like "one Claude per chat", with none of the TUI-piping fragility.
#
# Requirements
# ------------
#   bash 4+, inotify-tools (inotifywait), jq, flock, coreutils, claude
#
# Quick start
# -----------
#   chmod +x wabox-claude-code.sh
#   ./wabox-claude-code.sh              # uses `wabox status` defaults
#
# Configuration (env vars)
# ------------------------
#   WABOX_INBOX           inbox folder        (default: from `wabox status`)
#   WABOX_OUTBOX          outbox folder       (default: from `wabox status`)
#   STATE_DIR             session map + locks (default: $HOME/.local/state/wabox-claude)
#   LOG_FILE              log path            (default: $STATE_DIR/agent.log)
#   CLAUDE_BIN            claude binary       (default: claude)
#   CLAUDE_ARGS           extra args to claude (default: --permission-mode plan)
#   CLAUDE_TIMEOUT        seconds per turn    (default: 180)
#   SYSTEM_PROMPT_FILE    optional file appended via --append-system-prompt
#   GROUP_PER_PARTICIPANT 1 = each person in a group is its own thread
#                         0 = one thread per group (default)
#   IGNORE_FROM_ME        1 = drop fromMe=true envelopes (default 1)
#   KEEP_PROCESSED        1 = keep moved inbox files for audit (default 1)
#   DEBUG                 1 = verbose logs
# ============================================================================

set -euo pipefail
shopt -s nullglob

# ---- Defaults --------------------------------------------------------------

# Try to pick up the user's actual wabox paths from `wabox status --json`
# (falls back to platform defaults if wabox isn't on PATH).
default_paths_from_wabox() {
    if command -v wabox >/dev/null 2>&1; then
        local out
        if out="$(wabox status --json 2>/dev/null)"; then
            WABOX_INBOX_DEFAULT="$(jq -r '.inbox // empty' <<<"$out" 2>/dev/null || true)"
            WABOX_OUTBOX_DEFAULT="$(jq -r '.outbox // empty' <<<"$out" 2>/dev/null || true)"
        fi
    fi
    : "${WABOX_INBOX_DEFAULT:=${XDG_DATA_HOME:-$HOME/.local/share}/wabox/inbox}"
    : "${WABOX_OUTBOX_DEFAULT:=${XDG_DATA_HOME:-$HOME/.local/share}/wabox/outbox}"
}
default_paths_from_wabox

WABOX_INBOX="${WABOX_INBOX:-$WABOX_INBOX_DEFAULT}"
WABOX_OUTBOX="${WABOX_OUTBOX:-$WABOX_OUTBOX_DEFAULT}"
STATE_DIR="${STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/wabox-claude}"
SESSIONS_DIR="$STATE_DIR/sessions"
LOCKS_DIR="$STATE_DIR/locks"
PROCESSED_DIR="$STATE_DIR/processed"
LOG_FILE="${LOG_FILE:-$STATE_DIR/agent.log}"
PID_LOCK="$STATE_DIR/agent.lock"

CLAUDE_BIN="${CLAUDE_BIN:-claude}"
CLAUDE_ARGS="${CLAUDE_ARGS:---permission-mode plan}"
CLAUDE_TIMEOUT="${CLAUDE_TIMEOUT:-180}"
SYSTEM_PROMPT_FILE="${SYSTEM_PROMPT_FILE:-}"
GROUP_PER_PARTICIPANT="${GROUP_PER_PARTICIPANT:-0}"
IGNORE_FROM_ME="${IGNORE_FROM_ME:-1}"
KEEP_PROCESSED="${KEEP_PROCESSED:-1}"

mkdir -p "$STATE_DIR" "$SESSIONS_DIR" "$LOCKS_DIR" "$PROCESSED_DIR" \
         "$(dirname "$LOG_FILE")" "$WABOX_OUTBOX"

# ---- Logging ---------------------------------------------------------------

log() {
    local level="$1"; shift
    local line
    printf -v line '%s [%s] [pid=%d] %s' \
        "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$level" "$$" "$*"
    printf '%s\n' "$line" >>"$LOG_FILE"
    printf '%s\n' "$line" >&2
}
log_info()  { log INFO  "$@"; }
log_warn()  { log WARN  "$@"; }
log_error() { log ERROR "$@"; }
log_debug() { [[ "${DEBUG:-0}" == "1" ]] && log DEBUG "$@"; return 0; }

# ---- Dependency checks -----------------------------------------------------

need() {
    command -v "$1" >/dev/null 2>&1 || {
        log_error "missing required command: $1"
        exit 1
    }
}
need inotifywait
need jq
need flock
need timeout
need "$CLAUDE_BIN"

# ---- Single-instance guard -------------------------------------------------

exec 9>"$PID_LOCK"
if ! flock -n 9; then
    log_error "another wabox-claude-code agent is already running (lock: $PID_LOCK)"
    exit 1
fi

# ---- Shutdown handling -----------------------------------------------------

SHUTTING_DOWN=0
INOTIFY_PID=""
declare -A CHILDREN=()

reap_children() {
    local pid
    for pid in "${!CHILDREN[@]}"; do
        kill -0 "$pid" 2>/dev/null || unset 'CHILDREN[$pid]'
    done
}

shutdown() {
    [[ "$SHUTTING_DOWN" == "1" ]] && return
    SHUTTING_DOWN=1
    log_info "shutdown requested — draining in-flight handlers"

    if [[ -n "$INOTIFY_PID" ]] && kill -0 "$INOTIFY_PID" 2>/dev/null; then
        kill "$INOTIFY_PID" 2>/dev/null || true
    fi

    # Give handlers up to CLAUDE_TIMEOUT + 10s to finish gracefully, then SIGTERM
    local deadline=$(( $(date +%s) + CLAUDE_TIMEOUT + 10 ))
    while (( ${#CHILDREN[@]} > 0 )); do
        reap_children
        (( ${#CHILDREN[@]} == 0 )) && break
        if (( $(date +%s) >= deadline )); then
            log_warn "deadline reached; sending SIGTERM to ${#CHILDREN[@]} handler(s)"
            for pid in "${!CHILDREN[@]}"; do kill "$pid" 2>/dev/null || true; done
            sleep 1
            for pid in "${!CHILDREN[@]}"; do kill -9 "$pid" 2>/dev/null || true; done
            break
        fi
        sleep 0.2
    done

    log_info "bye"
    exit 0
}
trap shutdown INT TERM HUP

# ---- Conversation routing --------------------------------------------------

# Derive a stable conversation key from an inbox envelope.
# DM            → from JID (e.g. "5511...@s.whatsapp.net" or "...@lid")
# Group         → from JID (the @g.us)
# Group, per-participant → "from|participant"
conversation_key() {
    local envelope_json="$1"
    local from participant
    from="$(jq -r '.from // empty' <<<"$envelope_json")"
    participant="$(jq -r '.participant // empty' <<<"$envelope_json")"

    if [[ "$GROUP_PER_PARTICIPANT" == "1" && -n "$participant" ]]; then
        printf '%s|%s' "$from" "$participant"
    else
        printf '%s' "$from"
    fi
}

# Hash a conversation key into a safe filename slug.
key_slug() {
    printf '%s' "$1" | sha1sum | awk '{print $1}'
}

session_id_for() {
    local f="$SESSIONS_DIR/$1.session"
    [[ -s "$f" ]] && cat "$f"
}

save_session_id() {
    local slug="$1" sid="$2"
    printf '%s\n' "$sid" >"$SESSIONS_DIR/$slug.session"
}

# ---- Outbox writer ---------------------------------------------------------

# Atomically write a wabox outbox job. wabox treats any *.json in outbox/ as a
# job, so we write under a dot-prefixed temp name and rename into place.
write_outbox() {
    local to="$1" text="$2" reply_to_id="$3" stem="$4"

    local tmp="$WABOX_OUTBOX/.${stem}.tmp.json"
    local final="$WABOX_OUTBOX/${stem}.json"

    jq -n \
        --arg to "$to" \
        --arg text "$text" \
        --arg rid "$reply_to_id" \
        '{to: $to, text: $text} + (if $rid == "" then {} else {replyTo: {id: $rid}} end)' \
        >"$tmp"
    mv "$tmp" "$final"
    printf '%s' "$final"
}

# ---- One message handler ---------------------------------------------------

handle_envelope() {
    local in_path="$1"
    local in_name; in_name="$(basename "$in_path")"
    local stem="${in_name%.json}"

    log_info "[$stem] picked up"

    # ---- Step 1: capture content into memory before touching the FS --------
    local envelope
    if ! envelope="$(cat -- "$in_path" 2>/dev/null)"; then
        log_warn "[$stem] gone before we could read it (already handled?)"
        return 0
    fi
    if ! jq -e . >/dev/null 2>&1 <<<"$envelope"; then
        log_error "[$stem] invalid JSON; quarantining"
        mv -f -- "$in_path" "$PROCESSED_DIR/$in_name.invalid" 2>/dev/null || true
        return 1
    fi

    # ---- Step 2: read media filename (we won't process it here, just move it)
    local media_file
    media_file="$(jq -r '.media.file // empty' <<<"$envelope")"

    # ---- Step 3: MOVE the inbox files out NOW → triggers WhatsApp read tick.
    # Do this *before* calling Claude so the user sees blue checks immediately.
    local staged="$PROCESSED_DIR/$in_name"
    if ! mv -- "$in_path" "$staged" 2>/dev/null; then
        log_warn "[$stem] lost the race to move envelope; another worker has it"
        return 0
    fi
    if [[ -n "$media_file" ]]; then
        local media_src="$WABOX_INBOX/$media_file"
        if [[ -e "$media_src" ]]; then
            mv -- "$media_src" "$PROCESSED_DIR/$media_file" 2>/dev/null || \
                log_warn "[$stem] failed to move media $media_file"
        fi
    fi
    log_debug "[$stem] moved to $PROCESSED_DIR (read receipt fired)"

    # ---- Step 4: extract the bits we need ---------------------------------
    local id from number participant text from_me is_group conv_key slug
    id="$(jq -r '.id        // empty' <<<"$envelope")"
    from="$(jq -r '.from    // empty' <<<"$envelope")"
    number="$(jq -r '.number // empty' <<<"$envelope")"
    participant="$(jq -r '.participant // empty' <<<"$envelope")"
    text="$(jq -r '.text    // empty' <<<"$envelope")"
    from_me="$(jq -r '.fromMe // false' <<<"$envelope")"

    if [[ "$IGNORE_FROM_ME" == "1" && "$from_me" == "true" ]]; then
        log_debug "[$stem] skipping fromMe=true"
        return 0
    fi
    if [[ -z "$from" ]]; then
        log_error "[$stem] envelope has no 'from' field; cannot route"
        return 1
    fi

    is_group=0
    [[ "$from" == *@g.us ]] && is_group=1

    # WhatsApp "to" — bare number for DMs, group JID for groups
    local to
    if (( is_group )); then to="$from"; else to="$number"; fi
    if [[ -z "$to" ]]; then
        log_error "[$stem] could not determine reply target (no number/from)"
        return 1
    fi

    conv_key="$(conversation_key "$envelope")"
    slug="$(key_slug "$conv_key")"

    # Treat empty text as no-op (media-only messages). A real integration
    # would download the media and feed it to Claude here.
    if [[ -z "$text" ]]; then
        log_info "[$stem] empty text (likely media-only); not replying"
        return 0
    fi

    # ---- Step 5: serialize per-conversation, talk to Claude ----------------
    # The flock ensures messages from the *same* sender are processed in order
    # (so the session file doesn't race), while different senders run in
    # parallel via the per-conversation lockfile.
    (
        exec 8>"$LOCKS_DIR/$slug.lock"
        flock -x 8

        local sid_existing sid
        sid_existing="$(session_id_for "$slug" || true)"

        local -a cmd=("$CLAUDE_BIN")
        # shellcheck disable=SC2206 # intentional word-splitting of CLAUDE_ARGS
        cmd+=($CLAUDE_ARGS)
        cmd+=(-p --output-format json)
        if [[ -n "$SYSTEM_PROMPT_FILE" && -r "$SYSTEM_PROMPT_FILE" ]]; then
            cmd+=(--append-system-prompt "$(cat -- "$SYSTEM_PROMPT_FILE")")
        fi
        if [[ -n "$sid_existing" ]]; then
            cmd+=(--resume "$sid_existing")
            sid="$sid_existing"
            log_info "[$stem] from=$from conv=$conv_key resume session=$sid_existing"
        else
            sid="$(uuidgen 2>/dev/null || cat /proc/sys/kernel/random/uuid)"
            cmd+=(--session-id "$sid")
            log_info "[$stem] from=$from conv=$conv_key new session=$sid"
        fi

        local response_json reply rc=0
        # stdin = the user's message; stdout = JSON envelope with .result
        response_json="$(printf '%s' "$text" \
            | timeout --kill-after=5 "$CLAUDE_TIMEOUT" "${cmd[@]}" 2>>"$LOG_FILE")" \
            || rc=$?

        if (( rc != 0 )); then
            if (( rc == 124 )); then
                log_error "[$stem] claude timed out after ${CLAUDE_TIMEOUT}s"
                reply="(Sorry — I took too long to think. Please try again.)"
            else
                log_error "[$stem] claude exited rc=$rc"
                reply="(Sorry — I hit an error processing that message.)"
            fi
        else
            reply="$(jq -r '.result // empty' <<<"$response_json" 2>/dev/null || true)"
            # Persist whatever session id Claude reports back (it may rotate)
            local sid_returned
            sid_returned="$(jq -r '.session_id // empty' <<<"$response_json" 2>/dev/null || true)"
            [[ -n "$sid_returned" ]] && sid="$sid_returned"
            save_session_id "$slug" "$sid"
            if [[ -z "$reply" ]]; then
                log_warn "[$stem] claude returned empty .result"
                reply="(no response)"
            fi
        fi

        local out_path
        out_path="$(write_outbox "$to" "$reply" "$id" "$stem")"
        log_info "[$stem] wrote reply → $out_path (session=$sid)"
    )

    if [[ "$KEEP_PROCESSED" != "1" ]]; then
        rm -f -- "$staged"
        [[ -n "$media_file" ]] && rm -f -- "$PROCESSED_DIR/$media_file"
    fi
}

# Wrap so a crash in one handler can't take down the agent.
safe_handle_envelope() {
    if ! handle_envelope "$1"; then
        log_error "handler failed for $1 (continuing)"
    fi
}

# ---- Main loop -------------------------------------------------------------

log_info "starting"
log_info "  inbox     = $WABOX_INBOX"
log_info "  outbox    = $WABOX_OUTBOX"
log_info "  state     = $STATE_DIR"
log_info "  claude    = $CLAUDE_BIN $CLAUDE_ARGS"
log_info "  timeout   = ${CLAUDE_TIMEOUT}s"
log_info "  groupMode = $([[ $GROUP_PER_PARTICIPANT == 1 ]] && echo per-participant || echo per-chat)"

if [[ ! -d "$WABOX_INBOX" ]]; then
    log_error "inbox directory does not exist: $WABOX_INBOX"
    log_error "run \`wabox config\` to set up wabox first"
    exit 1
fi

# Catch-up: process anything already sitting in the inbox at startup
for existing in "$WABOX_INBOX"/*.json; do
    [[ -f "$existing" ]] || continue
    safe_handle_envelope "$existing" &
    CHILDREN[$!]=1
done

# Stream new events. We route inotifywait through a FIFO so:
#   - inotifywait has a known PID we can signal from the shutdown trap, and
#   - the while-loop runs in *this* shell (CHILDREN map and traps stay live).
FIFO="$STATE_DIR/.inotify.fifo"
rm -f -- "$FIFO"
mkfifo "$FIFO"

inotifywait -m -q \
    -e close_write -e moved_to \
    --format '%w%f' \
    "$WABOX_INBOX" >"$FIFO" &
INOTIFY_PID=$!

# Open FIFO for read on fd 3 (blocks until inotifywait opens the write end).
exec 3<"$FIFO"

# `read -t 1` polls so SIGTERM/SIGINT can break us out within ~1s even if no
# events are arriving. `if read` swallows the timeout exit code so set -e is OK.
while (( ! SHUTTING_DOWN )); do
    if IFS= read -r -t 1 path <&3; then
        [[ "$path" == *.json ]] || continue
        [[ -f "$path" ]] || continue
        safe_handle_envelope "$path" &
        CHILDREN[$!]=1
        reap_children
    else
        # Either the 1s timeout fired (rc=142) or inotifywait died (EOF, rc>128).
        # If the latter, abort so systemd/launchd can restart us.
        if ! kill -0 "$INOTIFY_PID" 2>/dev/null; then
            log_error "inotifywait died unexpectedly; exiting"
            break
        fi
        reap_children
    fi
done

exec 3<&-
rm -f -- "$FIFO"
shutdown
