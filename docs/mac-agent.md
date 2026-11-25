# Mac agent (texts)

The always-on Mac's only job is to forward new Messages rows to the server. The agent is a single ~40-line `bash` script that uses only what ships with macOS (`bash`, `sqlite3`, `curl`) — no Node, no Python, no daemon — so it costs an old Intel MacBook essentially nothing. All parsing and all the thinking happen on the server.

## What it does
Every 60 seconds (launchd `StartInterval`):
1. Reads the last row id it handled from `~/.assistant-agent.rowid`.
2. Selects newer rows from `~/Library/Messages/chat.db` (read-only): row id, guid, text, the raw `attributedBody` blob when `text` is empty (as hex), time, direction, and the other party's number/email.
3. POSTs them to `POST /ingest/mac` over Tailscale.
4. Advances the saved row id **only after the server confirms**, so a failed upload is simply retried next minute.

On first run it records the current latest row and sends nothing — it **never back-processes your history**.

The server side (`src/mac.ts`) decodes `attributedBody` (newer macOS leaves `text` empty and stores the message in a typedstream blob), drops one-time-code messages, stores each message once by its guid, and treats texts you sent as notes/commitments ("call Sam Friday") rather than requests.

## Install
On the Mac:
1. Install **Tailscale** and sign in to the same tailnet as the server.
2. Make sure **Messages** is signed in. For SMS (green bubbles) enable *Text Message Forwarding* on the iPhone: Settings → Messages → Text Message Forwarding → this Mac.
3. From a copy of this repo (or just the `mac/` folder):
   ```bash
   ./mac/install.sh http://<server-tailnet-name>:8090 <INGEST_TOKEN>
   ```
   Use the **`INGEST_TOKEN`** (send-input-only), not the full `ASSISTANT_TOKEN`. This copies `agent.sh` to `~/.assistant-agent/`, writes `~/.assistant-agent.conf` (mode 600) with the URL and token, and loads a launchd job `com.assistant.agent`.
4. **Grant Full Disk Access** to `/bin/bash`: System Settings → Privacy & Security → Full Disk Access → `+` → press ⌘⇧G, enter `/bin/bash`. macOS refuses to let scripts read `chat.db` otherwise.

## Check it
```bash
cat ~/.assistant-agent.rowid                 # a number that grows as texts arrive
tail ~/.assistant-agent/agent.log            # errors (permission, network)
~/.assistant-agent/agent.sh                  # run once by hand
launchctl list | grep assistant              # is the job loaded
```

## Uninstall
```bash
launchctl unload ~/Library/LaunchAgents/com.assistant.agent.plist
rm -rf ~/Library/LaunchAgents/com.assistant.agent.plist ~/.assistant-agent ~/.assistant-agent.conf ~/.assistant-agent.rowid
```

## Troubleshooting
| Symptom | Fix |
|---|---|
| log says `unable to open database file` / `authorization denied` | Full Disk Access isn't granted to `/bin/bash` (restart the job after granting: unload/load). |
| nothing arrives, no errors | row id isn't moving → no new texts reach this Mac (check Messages sign-in / SMS forwarding). Row id moving but nothing in the assistant → check the server logs and that the Mac can `curl http://<server>:8090/healthz`. |
| texts show as empty | an unrecognised message format (reaction, attachment-only) — those are skipped by design. |
| want to re-send from a point | edit `~/.assistant-agent.rowid` to a lower number; the server de-duplicates by guid. |

Environment overrides (used for testing): `MESSAGES_DB`, `AGENT_STATE`, `ASSISTANT_CONF`.

> Tested against a synthetic `chat.db` with both plain-text and `attributedBody` rows; not yet against a real macOS Tahoe database.
