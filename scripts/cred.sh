#!/usr/bin/env bash
# Central credentials store client for agents (Claude Code sessions, scripts). Needs curl + jq.
#   cred.sh save NAME [--service S] [--user U] [--url URL] [--notes TEXT]   (secret on stdin: read -s v; echo "$v" | cred.sh save NAME)
#   cred.sh get NAME            prints the secret only (so: TOKEN=$(cred.sh get GITHUB_PAT))
#   cred.sh show NAME           prints the whole record as JSON
#   cred.sh list [QUERY]        names and details, never values
#   cred.sh delete NAME
# Config: ASSISTANT_URL (default http://127.0.0.1:8090), ASSISTANT_TOKEN, AGENT_NAME (who is asking; shows in the audit log).
# Missing values are read from ~/.assistant-credentials.conf (mode 600, KEY=value lines).
set -euo pipefail
conf="$HOME/.assistant-credentials.conf"; [ -f "$conf" ] && { set -a; . "$conf"; set +a; }
base="${ASSISTANT_URL:-http://127.0.0.1:8090}"; token="${ASSISTANT_TOKEN:?set ASSISTANT_TOKEN (or put it in $conf)}"; agent="${AGENT_NAME:-${USER:-agent}@$(hostname -s)}"
call() { curl -fsS -H "authorization: Bearer $token" -H "x-agent: $agent" -H 'content-type: application/json' "$@"; }
cmd="${1:-}"; shift || true
case "$cmd" in
  save)
    name="${1:?usage: cred.sh save NAME [--service S] [--user U] [--url URL] [--notes T]}"; shift
    secret="$(cat)"; [ -n "$secret" ] || { echo "no secret on stdin" >&2; exit 1; }
    body="$(jq -n --arg s "$secret" '{secret:$s}')"
    while [ $# -gt 0 ]; do case "$1" in
      --service) body="$(jq --arg v "$2" '.service=$v' <<<"$body")";; --user) body="$(jq --arg v "$2" '.username=$v' <<<"$body")";;
      --url) body="$(jq --arg v "$2" '.url=$v' <<<"$body")";; --notes) body="$(jq --arg v "$2" '.notes=$v' <<<"$body")";;
      *) echo "unknown option $1" >&2; exit 1;; esac; shift 2; done
    call -X PUT -d "$body" "$base/credentials/$name" | jq -r '"saved \(.credential.name)"';;
  get)    call "$base/credentials/${1:?NAME}" | jq -r '.credential.secret';;
  show)   call "$base/credentials/${1:?NAME}" | jq '.credential';;
  list)   call -G --data-urlencode "q=${1:-}" "$base/credentials" | jq -r '.credentials[] | [.name, .service, .username, .url, .updatedBy, .updatedAt] | @tsv';;
  delete) call -X DELETE "$base/credentials/${1:?NAME}" | jq -r 'if .ok then "deleted" else "not found" end';;
  *) sed -n 2,8p "$0"; exit 1;;
esac
