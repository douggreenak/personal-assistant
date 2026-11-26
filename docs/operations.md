# Operations

## Logs
```bash
docker compose logs -f assistant          # everything: worker, pollers, nags, notifications
docker compose logs -f assistant whisper
```
Notifications are also echoed to the log as `[notify] …`, so you can see what it tried to send even if Chat is misconfigured.

## Backups
The database is one SQLite file. Take a consistent copy while running:
```bash
docker compose exec assistant node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('/data/assistant.db');d.exec(\"VACUUM INTO '/data/backup-\"+Date.now()+\".db'\")"
```
(or stop the container and copy `data/assistant.db*`). (`data/tickets.db` is the ticket database.) Also keep `.env`, `data/secrets.json` and `data/chat-service-account.json` somewhere safe (they're not in git). `claude-home/` is only your login — you can recreate it with `claude` again.

## Upgrading
```bash
cd ~/apps/personal-assistant && git pull && docker compose up -d --build
```
Database migrations run automatically at start (versioned with `PRAGMA user_version`).

## How the background work runs
| Loop | Every | Does |
|---|---|---|
| worker | 3 s (and on new input) | processes one message at a time through the model |
| nag | 30 s | sends due reminders, schedules the next nag |
| approvals | 10 s | announces new pending approvals once |
| connectors | 60 s | polls enabled connectors that are due |
| gmail | 60 s | new mail via history API |
| chat-read | 90 s | your Chat spaces (if enabled) |
| canopy | 15 min | alerts + completion sync |
| index | 30 min | SMB/local files (changed files only) |
| drive | 60 min | Drive folders |
| chat pull | continuous | Pub/Sub events for the bot |
Loops never overlap themselves and an error in one is logged, not fatal.

## Inspecting state
```bash
docker compose exec assistant node -e "
const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('/data/assistant.db');
console.log(d.prepare(\"SELECT id,source,substr(body,1,60) b,attempts,error FROM messages WHERE processed_at IS NULL\").all());"
```
Useful tables: `messages` (queue; `processed_at IS NULL` = waiting), `items` + `item_events` (full history of every change and who made it), `approvals`, `connectors`, `kv` (poll cursors).

### Re-run a stuck message
```sql
UPDATE messages SET attempts = 0, retry_at = NULL, error = NULL WHERE id = 123;
```
A message that failed 5 times stops retrying and you're notified once.

### Reset a source cursor (`kv` table)
| key | meaning |
|---|---|
| `gmail.historyId` | delete to restart Gmail from "now" |
| `chatread.since` | time of the last Chat-spaces read |
| `chat.space` | the DM space it messages you in |
| `canopy.grade.<classId>` | last grade seen per class |

## Troubleshooting
| Symptom | Check |
|---|---|
| Nothing is ever extracted | `docker compose logs assistant` for `claude` errors. Not logged in? `docker compose run --rm assistant claude`. Hitting plan limits? Messages retry with backoff (30 s → 8 min, 5 tries). |
| `claude exited …` / `unparseable claude output` | Claude Code CLI version drift; update the image (`docker compose build --no-cache assistant`). |
| It asks about everything | lower the bar: `AUTO_APPLY_MIN_CONFIDENCE=0.4`. (New items already don't ask unless risk-flagged.) |
| It never asks | by design for plain new items; money/others/outbound/drop always ask. |
| Nags at odd hours | check `TZ_NAME` and `QUIET_HOURS`; urgent reminders bypass quiet hours. |
| Voice upload returns 503 | Whisper container not ready (first start downloads the model) or `TRANSCRIBE_URL` wrong. Phones retry automatically. |
| Tickets aren't created, items say "backend error" | the tracker is down or `TICKETING_TOKEN` is wrong; approve the parked action (`approvals`) once fixed. |
| Duplicates after restoring a backup | restore both databases from the same time; ticket creation is idempotent on `externalRef`. |
For source-specific problems see [Google setup](google-setup.md#verifying-and-troubleshooting), [Mac agent](mac-agent.md#troubleshooting), [iPhone & Watch](ios-watch.md#troubleshooting).
