# Ticketing integration

The ticket tracker is a **separate, standalone app** ([github.com/douggreenak/ticketing](https://github.com/douggreenak/ticketing)) — you can use it on its own. The assistant is just one client of its HTTP API.

## What the assistant does with it
| Event | Ticketing call |
|---|---|
| You report a problem ("the encoder is dropping frames") | `POST /api/tickets` with `source: "assistant"` and an `externalRef` derived from the message id + title, so a retried message never creates a second ticket. The ticket starts at the pipeline's first stage (*Reported*). |
| "Looked at it, it's the SDI card, waiting on a part" | `POST /api/tickets/{id}/stage` → `waiting_on_parts` |
| "It's fixed and working" | stage → `fix_applied` / `verified` / `closed` as the message says |
| Item completed (`done ID`, or a message saying so) | stage → the pipeline's **last** stage (closed) |
| Priority / due-date changes | `PATCH /api/tickets/{id}` |

The model is told the pipeline's real stage ids (fetched from `GET /api/pipelines`, cached 5 minutes); it can only return one of those, and an unknown stage is discarded.

Each ticket is mirrored as an item in the assistant (`backend = ticketing`, `backend_ref = ticket id`) so updates can be matched and `open` shows its current stage.

## Changes made in the Ticketing UI
Move a ticket in the web UI and the assistant should know. Create a **webhook** in the tracker:
```bash
curl -s -H "authorization: Bearer $TICKETS_TOKEN" -H 'content-type: application/json' \
  -d '{"url":"http://assistant:8090/hooks/ticketing","events":["*"]}' http://<server>:8080/api/webhooks
# → {"id":1,"secret":"…"}   (shown once)
```
Put that secret in `.env` as `TICKETING_WEBHOOK_SECRET` and restart the assistant. The endpoint verifies the `X-Tickets-Signature` HMAC-SHA256 header, then mirrors stage changes, closes/reopens, title edits and deletions into the local item. (`ticket.stage_changed`, `.closed`, `.reopened`, `.updated`, `.deleted`.)

## If Ticketing is down or not configured
- Not configured (`TICKETING_URL` unset): tickets become ordinary local tasks.
- Configured but unreachable: the action is **not lost** — it is parked in the approval queue with the error ("backend error: …"). Approve it later (`approve N`) to retry once the tracker is back.

## Custom pipelines
The assistant always uses the tracker's **default** pipeline (the IT pipeline `it` unless you change it). To use different stages, edit that pipeline in the tracker (`PUT /api/pipelines/it` with new stages; a stage that still has tickets in it can't be removed) — the assistant picks the change up within 5 minutes. The last stage always means *closed*. See the tracker's own docs for the pipeline model.
