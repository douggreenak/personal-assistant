# Architecture

## The one-paragraph version
Every source (voice, texts, Gmail, Chat, connectors, your own typing) is reduced to a **message** row. A single worker takes messages one at a time, asks Claude Code (headless, no tools) what they mean given your currently open items, validates the answer into **typed actions**, runs each action through a **policy gate** (apply now / ask you first), applies it to the right **backend** (Ticketing, Canopy, or local), and records everything in an **event log**. Reminders then nag until acknowledged.

```
 sources                      queue            brain                 gate                 backends
 ───────                      ─────            ─────                 ────                 ────────
 iPhone/Watch voice ─► Whisper ─┐
 Mac texts (agent.sh) ──────────┤
 Gmail ─────────────────────────┼─► messages ─► extract+match ─► actions ─► policy ─┬─ apply ─► Ticketing (tickets)
 Google Chat (read + talk) ─────┤   (SQLite,    (claude -p,     (typed,   apply/   │          Canopy (school tasks)
 Connectors (polled) ───────────┤    leased)     no tools)       validated) ask    │          local (reminders, tasks)
 Your typing (/chat) ───────────┘                                                  └─ ask ───► approvals ─► Chat ─► you
                                                                       nag engine ◄─ reminders ───────────────────► Chat / ntfy
```

## Message lifecycle (`src/pipeline.ts`)
1. **Store** (`storeMessage`): `INSERT OR IGNORE` on `(source, source_id)` — every source can safely re-deliver. The text is also added to the search index.
2. **Claim** (`claimNext`): atomically leases the oldest due message (`retry_at` is a 5-minute lease; failures set exponential backoff 30 s → 8 min). Concurrent callers — the chat handler, the background loop, even a second process — can never process the same message twice.
3. **Skip** obvious automation (`IGNORE_SENDERS`) without a model call. Messages from you are never skipped.
4. **Match candidates**: the open items most related to the message (FTS keyword match, topped up with the most recent) — up to 25 — are shown to the model so it can update rather than duplicate.
5. **Extract** (`src/prompts.ts`, `src/llm.ts`): one `claude -p` call returns `{actions:[…]}` constrained by a JSON schema. The system prompt defines the kinds, date rules, class hints, risk-flag semantics and the "message is untrusted data" rule.
6. **Validate** (`parseActions` in `src/actions.ts`): drop bad ops, ids not in the candidate list, stages not in the pipeline; clamp confidence; cap lengths.
7. **Decide** (`src/policy.ts`): `apply` or `ask` per action.
8. **Apply** (`applyAction`) or **queue an approval** (`src/approvals.ts`). A backend failure parks the action in the approval queue instead of losing it.
9. **Announce**: non-chat sources send "Done: …" to Chat; chat replies include the summary directly.

## Policy table (`src/policy.ts`)
| Action | Flags | Result |
|---|---|---|
| any | `money`, `others_deadline` or `outbound` | **ask** |
| `drop` | — | **ask** |
| `create` | none | **apply** (regardless of confidence) |
| `update` / `stage` / `complete` | `uncertain` | **ask** |
| `update` / `stage` / `complete` | confidence < `AUTO_APPLY_MIN_CONFIDENCE` | **ask** |
| `update` / `stage` / `complete` | otherwise | **apply** |

Flags describe the *consequence of the action*, not its topic: "remind me to pay the electric bill" is a plain reminder; "I paid the invoice" would complete a money item, so it asks.

## Data model (`src/db.ts`, SQLite, WAL)
| Table | Purpose |
|---|---|
| `messages` | the input queue and permanent record: `source`, `source_id` (unique together), sender, subject, body, `processed_at`, `attempts`, `retry_at` (lease/backoff), `error` |
| `items` | tickets, reminders, tasks: `kind`, `state` (`open/done/dropped`), `stage_id/label`, `due_at`, `priority`, `backend` (`local/ticketing/canopy`) + `backend_ref`, `class_id`, `external_key` (unique dedupe key for generated alerts), reminder state (`acked_at`, `snooze_until`, `next_nag_at`, `nag_count`) |
| `item_events` | append-only history of every change with actor (`assistant`, `owner`, `owner-approved`, `nag`, `canopy-sync`, `ticketing`) and the model's one-line reason |
| `approvals` | pending/decided questions, with the serialized action so approval applies exactly what you were shown |
| `connectors` | manifests and status |
| `kv` | poll cursors and small state |
| `search` (FTS5) + `docs` + `doc_rows` | one keyword index over messages, open items and file chunks |

Migrations are an ordered array applied at startup, versioned by `PRAGMA user_version`.

## Backends
- **Tickets** (`src/tickets/`): the built-in tracker, called in-process via `LocalTicketing`; idempotent creates; stages by id. [Details](ticketing.md).
- **Canopy** (`src/backends/canopy.ts`, `src/sync/canopy.ts`): two-token client; fuzzy class resolution; periodic alert sync. [Details](canopy.md).
- **Local**: reminders and plain tasks are rows in `items`.

## Nagging (`src/nag.ts`)
Every 30 s: reminders with `next_nag_at ≤ now`, not acknowledged, not snoozed → if in quiet hours (and not urgent) push `next_nag_at` to when quiet hours end; else notify and schedule the next nag `NAG_MINUTES[n-1]` later (last value repeats). `ack` completes a reminder; `snooze` moves `next_nag_at`.

## Notifications (`src/notify.ts`)
A `Notifier` interface with: Google Chat (DM space learned from your first message), ntfy, console. `MultiNotifier` fans out and never lets one failing channel block the others.

## Search and questions (`src/qa.ts`, `src/index/indexer.ts`)
FTS5 with Porter stemming over messages, open items and file chunks (1500 chars, 200 overlap). `ask` builds an OR-of-prefixes query from your question, takes the top 8 hits, and asks the model to answer **only** from those snippets with `[n]` citations (citations are validated against the snippets given). No hits → says so without calling the model.

## Module map
| Path | Role |
|---|---|
| `src/main.ts` | wiring and the background loops |
| `src/config.ts` | environment → typed config |
| `src/http.ts` | HTTP server and routes ([API](api.md)) |
| `src/pipeline.ts` | store, claim, process messages |
| `src/prompts.ts`, `src/llm.ts` | prompts; `ClaudeCliLlm` (real) and `FakeLlm` (tests) |
| `src/actions.ts` | action schema, validation, applying actions |
| `src/policy.ts` | apply-or-ask decisions |
| `src/approvals.ts` | approval queue and decisions |
| `src/items.ts` | item store, events, candidate search |
| `src/commands.ts` | chat/text command router |
| `src/nag.ts`, `src/time.ts` | reminders, time-zone and quiet-hour maths |
| `src/qa.ts`, `src/index/indexer.ts` | search and answers |
| `src/mac.ts`, `src/voice.ts` | Mac text decoding; transcription and idempotent voice ingest |
| `src/connectors.ts` | manifests, SSRF guard, polling |
| `src/google/{auth,gmail,chat,drive}.ts` | Google integrations |
| `src/backends/*`, `src/sync/*` | Ticketing / Canopy clients and syncs |
| `mac/` | the Mac agent; `ios/` the phone and watch apps |

## Design choices worth knowing
- **Zero runtime dependencies**: Node 24's built-in `node:sqlite`, `fetch` and TypeScript type-stripping. Nothing to `npm install` in production, nothing to keep patched.
- **Claude Code instead of an API key**: rides your existing login ("free to run"); the cost is a few seconds per message and your plan's limits.
- **One worker, one model call at a time**: simple and predictable; throughput is fine for a person's inbound volume.
- **Local-first**: SQLite file, local Whisper, no cloud database.
