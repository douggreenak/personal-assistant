# HTTP API

Base URL `http://<server>:8090`. Every endpoint except `/healthz` and `/hooks/ticketing` needs `Authorization: Bearer $ASSISTANT_TOKEN`. The three `/ingest/*` endpoints, `/app/mac/heartbeat` and `/app/mac/download` also accept `INGEST_TOKEN`, which is valid for nothing else. Bodies are JSON unless stated. Errors are `{ "error": "…" }` with the status below. JSON bodies are limited to 1 MB; audio to 60 MB.

## Web UI
`GET /` serves a small web UI (no auth for the page itself; it asks for `ASSISTANT_TOKEN` and calls the endpoints below).

## Capture
### `POST /chat`
Handle one line exactly as if typed in Google Chat (commands, questions, or something to capture).
```bash
curl -H "authorization: Bearer $T" -H 'content-type: application/json' -d '{"text":"remind me to call Sam tomorrow 9am"}' $BASE/chat
# {"reply":"✅ Reminder: call Sam (due 2026-11-26 18:00Z)"}
```
**Pictures.** `/chat` (`{text, images}`) and `/ask` (`{question, images}`) accept up to 5 pictures: `images: [{name, data}]` with `data` = base64 (or a `data:` URL) of a PNG, JPEG, GIF or WebP, each ≤ 5 MB; the type is taken from the file's bytes. The model sees them with the text: a question is answered using them, anything else is captured with the pictures saved alongside the message (table `attachments`). These two routes take bodies up to 30 MB; every other JSON route stays at 1 MB.

### `POST /ingest/message` → `202 {"queued": true|false}`
Add a message for background processing. Idempotent on `(source, sourceId)`; `queued:false` means already known.
| field | |
|---|---|
| `sourceId` | **required** unique id from the sender |
| `body` | **required** text |
| `source` | default `api` |
| `sender`, `subject`, `receivedAt` (ISO) | optional |

### `POST /ingest/voice` (raw audio body) → `200 {"ok":true,"duplicate":false,"text":"…"}`
Headers: `X-Capture-Id` (**required**, 8–64 chars `[A-Za-z0-9-]`, unique per recording), `X-Filename` (default `capture.m4a`), `X-Recorded-At` (ISO). Transcribes with the local Whisper, then queues the transcript. A repeated capture id returns `duplicate:true` without re-transcribing. `503` if transcription is unavailable (clients should retry); `400` for a bad id/empty body.

### `POST /ingest/mac` → `{"accepted":N,"maxRowid":N}`
Used by the [Mac agent](mac-agent.md). Body `{"rows":[{rowid,guid,text,attr_hex,date,is_from_me,handle}]}` (max 500 rows).

## Mac app
### `GET /app/mac/latest` (full token) → `{"release":{available,version,tag,name,publishedAt,notes,size,assetName,releaseUrl,error?}}`
The newest Mac app release on GitHub (`GITHUB_REPO`), cached 10 minutes; `?refresh=1` bypasses the cache. `available:false` + `error` when nothing is released or GitHub can't be reached.
### `POST /app/mac/heartbeat` (either token) `{id, name?, version?, os?, updateError?}` → `{updateRequested, latest:{available, version?}}`
The Mac app's check-in (id = 8–64 chars `[A-Za-z0-9-]`). `updateRequested` is true when someone pressed Update for this Mac and it is behind the newest release; `updateError` reports a failed self-update and stops the requests. Macs not seen for 90 days are forgotten.
### `GET /app/mac/clients` (full token) → `{"clients":[{id,name,version,os,firstSeen,lastSeen,online,updateAvailable,updatePending,updateError?}]}`
### `POST /app/mac/clients/{id|all}/update` (full token) → `{"asked":N}`
Asks that Mac (or every Mac that is behind) to update on its next check-in. `409` if nothing is released or the id is unknown.
### `DELETE /app/mac/clients/{id}` (full token) → forgets a Mac.
### `GET /app/mac/download` (full token, or the ingest token) → the `Assistant-Mac.zip` file
Streams the newest release asset through the server (so a private repo works with `GITHUB_TOKEN`). `404` if nothing is released, `502` if GitHub refuses.

## Items
### `GET /items?state=open|done|dropped|all&kind=ticket|reminder|task`
`{"items":[{id,kind,title,detail,state,stageId,stageLabel,dueAt,priority,backend,backendRef,classId,externalKey,createdAt,updatedAt,ackedAt,snoozeUntil,nextNagAt,nagCount}]}` — default `state=open`.
### `GET /items/{id}`
`id` may be a unique prefix (≥ 4 hex chars). Returns `{item, events:[{at,actor,type,data}]}`. `404` if none/ambiguous.
### `POST /items/{id}/ack`
Acknowledge (stops nagging; completes a reminder).
### `POST /items/{id}/snooze` body `{"for":"2h"}`
`30m`, `2h`, `1d`, `tomorrow`, `later`. `400` if not understood.

## Approvals
### `GET /approvals` → `{"approvals":[{id,kind,summary,reason,payload,status,…}]}` (pending)
### `POST /approvals/{id}/approve` · `POST /approvals/{id}/reject` → `{"result":"…"}`
Approving applies the stored action exactly once (a second call says it was already decided).

## Questions
### `POST /ask` body `{"question":"…", "images"?: […]}` → `{"answer":"… Sources: [1] file …"}`

## Other
### `GET /connectors` → `{"connectors":[{id,status,name,lastError}]}`
### `GET /healthz` → `{"ok":true}` (no auth)
### `POST /hooks/ticketing`
Called by the ticket tracker's webhooks. No bearer token; authenticated by the `X-Tickets-Signature: sha256=<hmac>` header using `TICKETING_WEBHOOK_SECRET`. `401` on a bad signature.

### Connect a service in one step
`POST /connectors/auto` (full token) `{input, apiKey?}` → `202 {job}`. `input` is pasted API docs or an `https://` docs URL; `apiKey` is optional: keys inside `input` (labelled values, `Bearer …`, `?key=…`, well-known prefixes) are detected, stored in `secrets.json` and replaced by `<API_KEY_n>` before the model sees the text. Auth styles: bearer, header, basic, or `query` (key in a URL parameter).
The server designs a read-only connector, saves it, dry-runs it against the real service and — if that fails — shows the model what the service actually returned so it can fix the manifest (up to 4 tries), then enables it. On failure nothing is left behind.
`input` may also be an MCP server (URL, `mcpServers` JSON or a `claude mcp add` line): the connector is then built from the server's own `tools/list` (manifest has `mcp:{url}`; each action has `tool`), without calling the model.

`GET /connectors/auto/{id}` → `{job:{id,state,steps[],connectorId,secret,result}}` with `state` = `running | needs_key | done | failed`. `POST /connectors/auto/{id}/key` `{apiKey}` resumes a job that is `needs_key`.

### Write connectors
A manifest may have `actions` (writes) as well as `poll` (read); either may be missing, not both. `actions[]`: `{id, name, description, method: POST|PUT|PATCH|DELETE, path: "/x/{id}", params: [{name, description, in: path|query|body, required?}]}`.
The model can request one with an action `{op:"connector_call", connectorId, actionId, args}`, but only from the owner's own messages (chat/voice) — messages from other people never see write actions. Every call goes to Approvals unless the owner switched that action to *no need to ask*; DELETE always asks, and money/outbound-flagged calls always ask.
`POST /connectors/{id}/actions/{action}/auto` `{allow: boolean}` sets that switch. `GET /connectors/full` lists the allowed ones in `autoActions`. A write-only connector is never called to "test" it.

## Backup

`GET /backup/export[?secrets=0]` (full token) → the backup file (`application/octet-stream`, gzip'd JSON; `Content-Disposition` names it `assistant-backup-YYYY-MM-DD.backup`). It holds a consistent snapshot of the database plus `settings.json` and — unless `secrets=0` — `secrets.json`, `web-password.json` and the Google service account. Treat a file with secrets like a password.

`POST /backup/import` (full token, raw file as the body, up to 400 MB) → `{ok, createdAt, counts, includesSecrets, restartNeeded, safetyCopy}`. Replaces all data with the backup in one transaction (nothing changes if it fails) after saving a safety copy of the current data to `data/backups/before-restore-*.backup` (the newest 5 are kept). A backup made without secrets leaves this machine's keys alone. `400` with a plain message for a file that is not a backup or comes from a newer version.

**Nightly backups.** Once a day after `BACKUP_HOUR` (default 02, in the configured time zone; if the assistant was off then it runs as soon as it starts) a backup with keys is written to `data/backups/nightly-YYYY-MM-DD.backup` (mode 600) and only the newest `BACKUP_KEEP` (default 14) nightly files are kept; `BACKUP_AUTO=0` turns it off. A failure is announced through the normal notifications once a day. `GET /backup/list` → `{auto, hour, keep, last, backups:[{name, kind: nightly|manual|before-restore, size, at}]}`; `POST /backup/run` saves a `manual-*` copy on the server; `GET /backup/file/{name}` downloads one. The `data/` folder is a Docker volume, so these survive rebuilds, but they are on the same disk — copy them elsewhere for real safety.

`PUT /connectors/{id}/instructions` (full token) `{text}` → `{instructions}`: the owner's standing instructions for that connector (≤ 4000 chars, empty clears). They are added to the model's system prompt when it handles that connector's messages, plans live lookups, or answers from its data.
