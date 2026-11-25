# HTTP API

Base URL `http://<server>:8090`. Every endpoint except `/healthz` and `/hooks/ticketing` needs `Authorization: Bearer $ASSISTANT_TOKEN`. The three `/ingest/*` endpoints also accept `INGEST_TOKEN`, which is valid for nothing else. Bodies are JSON unless stated. Errors are `{ "error": "…" }` with the status below. JSON bodies are limited to 1 MB; audio to 60 MB.

## Web UI
`GET /` serves a small web UI (no auth for the page itself; it asks for `ASSISTANT_TOKEN` and calls the endpoints below).

## Capture
### `POST /chat`
Handle one line exactly as if typed in Google Chat (commands, questions, or something to capture).
```bash
curl -H "authorization: Bearer $T" -H 'content-type: application/json' -d '{"text":"remind me to call Sam tomorrow 9am"}' $BASE/chat
# {"reply":"✅ Reminder: call Sam (due 2026-11-26 18:00Z)"}
```
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
### `GET /app/mac/download` (full token) → the `Assistant-Mac.zip` file
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
### `POST /ask` body `{"question":"…"}` → `{"answer":"… Sources: [1] file …"}`

## Other
### `GET /connectors` → `{"connectors":[{id,status,name,lastError}]}`
### `GET /healthz` → `{"ok":true}` (no auth)
### `POST /hooks/ticketing`
Called by the ticket tracker's webhooks. No bearer token; authenticated by the `X-Tickets-Signature: sha256=<hmac>` header using `TICKETING_WEBHOOK_SECRET`. `401` on a bad signature.
