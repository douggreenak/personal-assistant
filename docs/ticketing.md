# Tickets (built in)

The ticket tracker is part of the assistant: its own **Tickets** tab in the web UI, and code in `src/tickets/` (`tickets.ts` the service, `db.ts` the SQLite schema, `local.ts` the in-process adapter the assistant calls). It used to be a separate app; there is no second container, URL, token or webhook any more. Tickets live in `data/tickets.db` (back it up with the rest of `data/`).

## What the assistant does with it
| Event | Tracker call |
|---|---|
| You report a problem ("the encoder is dropping frames") | create a ticket with `source: "assistant"` and an `externalRef` derived from the message id + title, so a retried message never creates a second ticket. It starts at the pipeline's first stage (*Reported*). |
| "Looked at it, it's the SDI card, waiting on a part" | move to stage `waiting_on_parts` |
| "It's fixed and working" | `fix_applied` / `verified` / `closed` as the message says |
| Item completed (`done ID`, or a message saying so) | the pipeline's **last** stage (closed) |
| Priority / due-date changes | ticket update |

The model is told the pipeline's real stage ids and can only return one of those; an unknown stage is discarded. Each assistant-created ticket is mirrored as an item (`backend = ticketing`, `backend_ref = ticket id`) so later messages can update it.

## The Tickets tab
List (Open / Closed / All, filter box), **New**, and a detail view per ticket with a package-tracker style stage bar: click a stage to move there (click the current one to step back), add comments, see the timeline, delete. Moving or closing a ticket there updates the matching item immediately (in-process, no webhook).

REST (same bearer token as everything else): `GET/POST /tickets`, `GET/PATCH/DELETE /tickets/{id}`, `POST /tickets/{id}/stage`, `POST /tickets/{id}/comments`, `GET /tickets/pipelines`. See [API](api.md).

## Pipelines
The assistant uses the **default** pipeline (`it`: Reported → Diagnosing → Waiting on parts → Fix applied → Verified → Closed). The last stage always means *closed*. Pipelines are created in the database by the service (`createPipeline` / `updatePipeline`); a stage that still has tickets in it can't be removed. There is no pipeline editor in the UI.

## History
The standalone app's webhooks, API tokens and separate UI were dropped in the merge. Its final repository snapshot was archived to `data/backups/ticketing-repo-final-*.tgz`.
