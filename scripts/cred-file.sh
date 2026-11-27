#!/usr/bin/env bash
# The simplest way for an agent to use credentials. One file, ~/.credentials.env (mode 600, NAME=value lines).
# The assistant copies it into its encrypted central store within ~15 seconds. Values never need to appear in the chat:
#   cred put NAME            save: the value comes from stdin  (read -rs v; printf %s "$v" | cred put NAME)
#   cred run NAME... -- CMD  run CMD with those names in its environment ($NAME inside CMD; nothing is printed)
#   cred names               list the names saved here (never values)
#   cred has NAME            exit 0 if saved
set -euo pipefail
f="${CREDENTIALS_FILE:-$HOME/.credentials.env}"
cmd="${1:-}"; shift || true
valid() { [[ "$1" =~ ^[A-Z][A-Z0-9_]{2,60}$ ]] || { echo "names look like GITHUB_PAT" >&2; exit 1; }; }
case "$cmd" in
  put)
    valid "${1:-}"; v="$(cat)"; [ -n "$v" ] || { echo "no value on stdin" >&2; exit 1; }
    case "$v" in *$'\n'*) echo "value must be one line" >&2; exit 1;; esac
    umask 077; touch "$f"; chmod 600 "$f"
    tmp="$(mktemp "$f.XXXX")"; grep -v -E "^(export )?$1=" "$f" > "$tmp" || true
    printf "%s='%s'\n" "$1" "${v//\'/\'\\\'\'}" >> "$tmp"; mv "$tmp" "$f"; chmod 600 "$f"; echo "saved $1";;
  run)
    names=(); while [ $# -gt 0 ] && [ "$1" != "--" ]; do valid "$1"; names+=("$1"); shift; done
    [ "${1:-}" = "--" ] || { echo "usage: cred run NAME... -- CMD" >&2; exit 1; }; shift
    for n in "${names[@]}"; do
      line="$(grep -E "^(export )?$n=" "$f" | tail -1)" || { echo "no credential $n" >&2; exit 1; }
      eval "export ${line#export }"
    done
    exec "$@";;
  names) [ -f "$f" ] && sed -nE 's/^(export )?([A-Z][A-Z0-9_]+)=.*/\2/p' "$f" || true;;
  has)   grep -qE "^(export )?${1:?NAME}=" "$f" 2>/dev/null;;
  *) sed -n 2,9p "$0"; exit 1;;
esac
