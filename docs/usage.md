# Using the assistant

You don't have to learn commands: say or type things, messy and long is fine. Everything below also works over `POST /chat`.

## Capturing things
Say it however you'd say it to a person:

> the encoder is dropping frames, remind me to order SDI cables, and call Sam this week about the invoice

It splits that into separate items and picks a kind for each:

| Kind | Used for | Where it lives |
|---|---|---|
| **ticket** | something broken or multi-step to fix, tracked parts | the [Ticketing app](ticketing.md), with stages Reported → Diagnosing → Waiting on parts → Fix applied → Verified → Closed |
| **reminder** | "remind me…" — it nags until you acknowledge | the assistant |
| **task** | everything else | the assistant |
| school work (mentions a class) | "bio worksheet due Monday" | a task in [Canopy](canopy.md), attached to the class |

Dates are resolved in your time zone ("Friday", "tomorrow morning"); "this week" with no day means Friday.

## Updates happen by themselves
Later messages from you, your texts, email or chat can change open items:

| You or someone says | What happens |
|---|---|
| "the cables arrived" | the matching "order SDI cables" item is checked off |
| "it's the SDI card, waiting on a replacement" | the encoder ticket moves to *Waiting on parts* |
| "push the Sam call to Monday" | its due date changes |
| "I paid Sam's invoice" | **asks you first** (money) |

If it isn't sure which item a message refers to, it asks instead of guessing.

## When it asks
It adds new things without asking. It asks first when an action involves **money being settled or committed**, **another person's deadline or commitment**, **contacting someone for you**, **dropping an item**, or when it is **unsure / low confidence** about an update. Pending questions are announced in Chat; answer with:

```
approvals            list what's waiting
approve 3            do it
reject 3             don't
approve all
```

## Reminders and nagging
A reminder fires at its time (or immediately if it has none), then repeats on the `NAG_MINUTES` schedule (default after 15, 15, 30, then every 60 minutes) until you answer. Between `QUIET_HOURS` (default 22:00–07:00) nags wait for morning, except urgent ones.

```
ack 4f2a1c           handled — stops nagging (and completes a reminder)
snooze 4f2a1c 2h     also: 30m, 1d, tomorrow, later
done 4f2a1c          finish any item (ticket → Closed, Canopy task → completed)
```
Items are shown with a 6-character id in square brackets, e.g. `[4f2a1c]`.

## Seeing what's open
`open` (or "what's open", `list`, `todo`) lists tickets, reminders and tasks with stages and due times.

## Asking questions
Ask in plain language, or prefix with `ask`:

> what did Sam say about the invoice?  ·  ask which firmware did the encoder get

Answers come only from your own indexed messages, files and open items, with source citations; if nothing matches it says so rather than guessing. What's searchable:
- every message the assistant has seen (texts, email, chat, voice transcripts) since you turned each source on;
- text, Markdown, CSV, HTML, JSON, `.eml`, PDF (needs `pdftotext`, included in the Docker image) and DOCX files under `INDEX_PATHS` (mount your SMB share read-only into the container and point `INDEX_PATHS` at it; re-scanned every 30 minutes, only changed files);
- Google Docs, Sheets and text files in `DRIVE_FOLDER_IDS` (re-scanned hourly).

Search is keyword-based (SQLite FTS5 with stemming), so use the words you'd expect to appear.

## Connectors
`connector <paste API docs or an https URL>` starts the flow for adding a new service. See [Connectors](connectors.md).

## Full command list
| Command | Effect |
|---|---|
| `help` | short help |
| `open` · `what's open` · `list` · `todo` | open items |
| `approvals` · `pending` | waiting approvals |
| `approve N` · `yes N` / `reject N` · `no N` · `approve all` | decide |
| `ack ID` · `got it ID` · `handled ID` | acknowledge |
| `done ID` · `finished ID` · `complete ID` | complete |
| `snooze ID <30m\|2h\|1d\|tomorrow\|later>` | delay nags |
| `ask <question>` (or any question) | answer from your data |
| `connector <docs>` · `connectors` · `test connector ID` · `enable connector ID` | manage connectors |
| anything else | captured as new work |

## Alerts the assistant raises by itself
From [Canopy](canopy.md): due today/soon, overdue, missing work, exams, grade drops. From failures: a message it couldn't process after 5 tries (retries at 30 s, 1 m, 2 m, 4 m).
