# Canopy integration

[Canopy](https://github.com/douggreenak/Canopy-School-Planner) is the school planner (web app + iOS/Watch clients). The assistant talks to it through Canopy's token API (`/api/v1`).

## Setup
In Canopy → **Settings → API & MCP access** create two tokens:
1. **Read-only** → `CANOPY_READ_TOKEN`
2. **Read & write** → `CANOPY_WRITE_TOKEN`
and set `CANOPY_URL`. Giving the assistant two tokens is deliberate: everything that touches untrusted text (alert syncing) uses the read-only one; the write token is used only by the action layer when it creates/updates/completes a Canopy task.

## School work → Canopy
When something you say or receive is school work, the model attaches a `classHint` (e.g. "bio"). The assistant resolves it to a real class by fuzzy match against `GET /classes` (exact word match scores highest, prefixes lower), then creates a **Canopy task** attached to that class (`POST /api/v1/tasks` with `classId`, due date, priority). A local mirror item remembers the link so later messages can update or complete it:

| Later message | Canopy call |
|---|---|
| "bio worksheet is due Tuesday instead" | `PATCH /tasks/{id}` `{dueDate}` |
| "finished the bio worksheet" | `PATCH /tasks/{id}` `{completed:true}` |

If no class matches, the item is kept locally with a note, so nothing is lost. (Canopy's PowerSchool-synced assignments are read-only apart from "completed", so mentioned assignments become tasks, same as Canopy's own *Quick Add Homework*.)

## Canopy → alerts (every 15 minutes)
Each sync reads `/upcoming?days=2`, `/classes`, `/grade-history`, `/tasks?completed=true` and creates **reminders** (which then nag like any other), deduplicated by a stable key so you're never alerted twice for the same thing:

| Alert | Trigger | Priority |
|---|---|---|
| `Due today/<date>: <class> — <title>` | assignment/task due within 2 days, not completed | normal |
| `OVERDUE: …` | past due and not completed | high |
| `Missing in PowerSchool: …` | assignment flagged *missing* | high |
| `Exam <date>: …` | exam in the next 2 days | normal |
| `Grade drop in <class>: 92.0% → 88.5%` | newest grade snapshot fell by ≥ `CANOPY_GRADE_DROP_PCT` since the last sync (first sync only records a baseline) | high |

**Tasks page:** PowerSchool-assignment alerts (due, overdue, missing) are hidden from the web Tasks/Items list (keys `canopy:ps…`, `canopy:missing:`) but still nag and auto-close.

**Auto-stop:** when an assignment or task is completed in Canopy it drops out of the due/overdue lists, and the matching due, overdue and missing-work reminders are closed on the next sync, so you stop being nagged. Tasks the assistant created that you complete in Canopy are marked done locally too.

## Task stages
Canopy tasks support per-task completion stages (`stages`, `stageId`); the API/MCP now returns and accepts them (added in the Canopy repo alongside this project; `completed` stays derived from "is the last stage"). The assistant does not use stages on Canopy tasks yet.

## Privacy note
Grades and assignment titles that appear in reminders or in prompts to the model are sent to Anthropic via Claude Code like any other message content. See [Security & privacy](security.md#what-leaves-your-server).
