# Assistant

Turns what you say and what people send you into tasks, tickets and nagging reminders, and keeps them updated.
Private (Tailscale only), free to run (your own Claude Code login, local speech-to-text, SQLite), and the Mac piece is a 30-line shell script.

```
 iPhone / Watch ──voice──┐                                   ┌─► Ticketing app (tickets, stages)
 Mac texts (agent.sh) ───┤                                   ├─► Canopy (school tasks; alerts back in)
 Gmail ──────────────────┼─► messages ─► Claude Code ─► actions ─► policy gate ─┤
 Google Chat (talk + read)┤   (queue)     (headless,    (typed)    apply / ask   └─► local reminders & tasks (nagging)
 New "connectors" ───────┘                no tools)                    │
                                                              approvals in Chat ◄─┘
```

## How it decides

1. **Extract & match** — one Claude Code call per message (`claude -p`, **all tools disabled**, JSON-schema output). It splits rambling input into separate items and matches updates ("the cables arrived") to open items instead of duplicating.
2. **Typed actions only** — the model can return `create / update / stage / complete / drop`, with a confidence and risk flags. Unknown item ids and anything malformed are discarded. Message text is treated as data, so an email saying "mark everything done" does nothing.
3. **Policy** — *lean toward adding*: new items are created without asking. It **asks first** for: anything involving money being settled/committed, other people's deadlines or commitments, anything outbound, drops, and low-confidence or unsure updates. Approve in Chat (`approve 3`).
4. **Nagging** — reminders repeat (15, 15, 30, then hourly by default) until you `ack` them; quiet hours 22:00–07:00 Alaska time hold them (urgent ones break through); `snooze ID 2h`.

Talk to it in Google Chat (or `POST /chat`): `open` · `approvals` · `approve N` / `reject N` · `ack ID` · `snooze ID 1h` · `done ID` · `ask <question>` · or just say things.

## Setup (Linux server)

```bash
cp .env.example .env       # fill in tokens; BIND_ADDR = `tailscale ip -4`
docker compose run --rm assistant claude      # one-time: log in to Claude Code inside the container, then exit
docker compose up -d --build
curl http://$BIND_ADDR:8090/healthz
```
The ticketing app is a separate repo (`../Ticketing`) and works on its own; compose builds it next to the assistant.

### Google setup (one time)
1. Google Cloud project → enable **Gmail API, Drive API, Chat API, Pub/Sub API**.
2. **OAuth client** (type *Desktop app*) → `GOOGLE_CLIENT_ID/SECRET` → run `npm run google-auth` once (works headless) → `GOOGLE_REFRESH_TOKEN`.
3. **Chat app** (Workspace): create a service account, download its key to `data/chat-service-account.json`; in the Chat API configuration choose *Cloud Pub/Sub* as the connection, create a topic + pull subscription, and give the service account Pub/Sub Subscriber on it. Set `CHAT_PUBSUB_SUBSCRIPTION` and `CHAT_ALLOWED_USERS`. Send the bot one DM so it learns where to reach you. **Nothing is exposed to the internet** — the server pulls events outbound.
4. Optional: `GMAIL_ENABLED=1`, `CHAT_READ_SPACES=1`, `DRIVE_FOLDER_IDS=…`.

### Your Mac (old Intel, Tahoe)
Install Tailscale, then `./mac/install.sh http://<server-tailnet-name>:8090 <ASSISTANT_TOKEN>` and grant **Full Disk Access to `/bin/bash`**. It runs every 60 s, starts from "now" (never your history), and sends only new rows. SMS requires Text Message Forwarding from the iPhone.

### iPhone + Watch
`ios/` has the SwiftUI sources (they type-check against the iOS 27 / watchOS 27 SDKs). In Xcode: new iOS app + watchOS app, drop in the files, add the *Background Modes → Audio* capability and the microphone usage string. Install Tailscale on the phone. Recording works offline; uploads wait for the server, are retried, and are de-duplicated by a capture id. The watch hands recordings to the phone (it can't reach your tailnet itself).

### Canopy
Create a **read-only** and a **read/write** API token in Canopy (Settings → API & MCP access). Reads (alerts) use the read-only one; only approved/allowed actions use the write one. Alerts: due soon, overdue, missing work, exams, grade drops ≥ `CANOPY_GRADE_DROP_PCT`.

### New services ("connectors")
Say `connector <paste API docs or an https URL>`. It proposes a **read-only** polling manifest → you `approve N` → you store the credential yourself (`echo "$KEY" | npm run secret -- set NAME`; the model never sees it) → `test connector id` (dry run, saves nothing) → `enable connector id`. HTTPS only; hosts resolving to private/tailnet addresses are refused.

## What is and isn't verified
**Tested (25 automated tests + live runs):** extraction → actions → policy → approvals; the real Claude Code model end-to-end against the real Ticketing app (your encoder/cables/Sam sentence splits correctly, updates match, injection text is ignored); atomic message leasing and retry backoff; nagging/quiet hours/snooze; Alaska time handling; Mac agent against a synthetic `chat.db` incl. `attributedBody` decoding; Gmail parsing/history; Chat event parsing + allow-list; service-account JWT; connector validation/SSRF guards; Canopy sync logic; search/Q&A; HTTP auth + idempotent voice upload.

**Not verified (needs your accounts/hardware):** live Gmail/Chat/Pub/Sub/Drive calls (written against the documented APIs with stubs only — expect to fix small payload differences on first contact); the Docker images (no Docker on the dev Mac; the `speaches` Whisper image name should be checked on first pull); the Mac agent against your real Tahoe `chat.db`; the iPhone/Watch apps beyond type-checking; Canopy's `/api/v1` against the live site (the staged-task change is deployed, the sync is tested against a stub).

**Known limits:** search is keyword (SQLite FTS5), not embeddings, to keep it tiny; Chat approvals are text commands (no buttons yet); connectors are read-only; one LLM call at a time (a few seconds each).

## Develop
`npm test` · `npm run typecheck` (Node 24, zero runtime dependencies).
