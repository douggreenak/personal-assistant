#!/bin/bash
# Assistant Mac agent — the whole thing. Needs only what ships with macOS: bash, sqlite3, curl.
# Reads new rows from Messages' chat.db and POSTs them to the Assistant server (over Tailscale).
# All decoding and thinking happens on the server, so this stays tiny on an old Intel Mac.
set -u
CONF="${ASSISTANT_CONF:-$HOME/.assistant-agent.conf}"      # defines ASSISTANT_URL and ASSISTANT_TOKEN
# shellcheck disable=SC1090
[ -f "$CONF" ] && . "$CONF"
: "${ASSISTANT_URL:?set ASSISTANT_URL in $CONF}" "${ASSISTANT_TOKEN:?set ASSISTANT_TOKEN in $CONF}"
DB="${MESSAGES_DB:-$HOME/Library/Messages/chat.db}"
STATE="${AGENT_STATE:-$HOME/.assistant-agent.rowid}"
LIMIT=200

if ! last=$(cat "$STATE" 2>/dev/null) || [ -z "$last" ]; then
  # First run: start from "now" — never back-process your whole history.
  sqlite3 -readonly "$DB" "SELECT COALESCE(MAX(ROWID),0) FROM message" > "$STATE" || exit 1
  exit 0
fi
case "$last" in ''|*[!0-9]*) echo "bad state file $STATE" >&2; exit 1;; esac

# date is nanoseconds since 2001-01-01 on modern macOS, seconds on old ones.
rows=$(sqlite3 -readonly -json "$DB" "
  SELECT m.ROWID AS rowid, m.guid AS guid, m.text AS text,
         CASE WHEN m.text IS NULL OR m.text = '' THEN hex(m.attributedBody) END AS attr_hex,
         strftime('%Y-%m-%dT%H:%M:%SZ', (CASE WHEN m.date > 1000000000000 THEN m.date/1000000000 ELSE m.date END) + 978307200, 'unixepoch') AS date,
         m.is_from_me AS is_from_me, h.id AS handle
  FROM message m LEFT JOIN handle h ON h.ROWID = m.handle_id
  WHERE m.ROWID > $last ORDER BY m.ROWID LIMIT $LIMIT") || exit 1
[ -z "$rows" ] && exit 0

resp=$(curl -fsS -m 30 -H "authorization: Bearer $ASSISTANT_TOKEN" -H 'content-type: application/json' \
  --data-binary "{\"rows\":$rows}" "$ASSISTANT_URL/ingest/mac") || exit 1   # on failure the state is untouched, so it retries
max=$(printf '%s' "$resp" | sed -n 's/.*"maxRowid":\([0-9][0-9]*\).*/\1/p')
if [ -n "$max" ] && [ "$max" -gt "$last" ]; then echo "$max" > "$STATE"; fi
