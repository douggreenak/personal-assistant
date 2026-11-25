# Configuration reference

All settings are environment variables (put them in `.env`; Docker Compose passes them through). Unset optional features are simply off.

## Core
| Variable | Default | Meaning |
|---|---|---|
| `ASSISTANT_TOKEN` | — **required** | Full-access bearer token (≥ 16 chars): read items, approve, chat, ask, ingest. Keep it to yourself and your scripts. |
| `INGEST_TOKEN` | (off) | Optional second token (≥ 16 chars) that can **only** call `/ingest/*`. Put this one on the Mac agent and the phone app so a stolen device can add input but can't read your data or approve anything. |
| `PORT` / `HOST` | `8090` / `0.0.0.0` | Listen address inside the container. |
| `BIND_ADDR` | `127.0.0.1` | (compose) host interface to publish on. Set to your Tailscale IP. |
| `ASSISTANT_DATA` | `./data` (`/data` in Docker) | Folder for the database and `secrets.json`. |
| `ASSISTANT_DB` | `$ASSISTANT_DATA/assistant.db` | Database file. |
| `TZ_NAME` | `America/Anchorage` | Your time zone. Used to resolve "Friday", "9am", quiet hours. |

## Nagging
| Variable | Default | Meaning |
|---|---|---|
| `QUIET_HOURS` | `22-7` | `start-end` local hours. Nags are held inside this window (urgent reminders ignore it). `0-0` disables. |
| `NAG_MINUTES` | `15,15,30,60` | Gap before nag #2, #3, #4, …; the last value repeats until you acknowledge. |

## The brain (Claude Code)
| Variable | Default | Meaning |
|---|---|---|
| `CLAUDE_BIN` | `claude` | Path to the Claude Code CLI. |
| `CLAUDE_MODEL` | (CLI default) | Model for extraction/answers, e.g. a faster one. |
| `CLAUDE_TIMEOUT_MS` | `180000` | Per-call timeout. |
| `AUTO_APPLY_MIN_CONFIDENCE` | `0.6` | Updates/completions below this confidence go to the approval queue. New items are always added (unless risk-flagged). |
| `IGNORE_SENDERS` | `no-?reply,mailer-daemon,notifications?@` | Comma-separated regexes; messages from matching senders are skipped without calling the model. Messages from you are never skipped. |

## Ticketing
| Variable | Meaning |
|---|---|
| `TICKETING_URL` | e.g. `http://ticketing:8080` (set by compose). Unset → tickets become plain local tasks. |
| `TICKETING_TOKEN` | The ticket tracker's `TICKETS_TOKEN`. |
| `TICKETING_WEBHOOK_SECRET` | Optional. Secret of a webhook you create in the tracker pointing at `http://assistant:8090/hooks/ticketing`, so stage changes made in its UI show up here. |
| `TICKETS_TOKEN` | (compose) shared token given to both containers. |

## Canopy
| Variable | Meaning |
|---|---|
| `CANOPY_URL` | Your Canopy base URL. Unset → Canopy integration off. |
| `CANOPY_READ_TOKEN` | A **read-only** `spk_…` token, used for syncing alerts. |
| `CANOPY_WRITE_TOKEN` | A read/write token, used only to create/update tasks. |
| `CANOPY_GRADE_DROP_PCT` | `2` — alert when a class grade falls by at least this many points between syncs. |

## Google
| Variable | Meaning |
|---|---|
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` | Your account's OAuth credentials (Gmail, Drive, reading Chat). Get the token with `npm run google-auth`. |
| `GOOGLE_SERVICE_ACCOUNT_FILE` | Path to the Chat bot's service-account key (e.g. `/data/chat-service-account.json`). |
| `CHAT_PUBSUB_SUBSCRIPTION` | `projects/<project>/subscriptions/<name>` the bot pulls Chat events from. |
| `CHAT_ALLOWED_USERS` | Comma-separated emails (or `users/…` ids) allowed to command the bot. **Empty means nobody.** |
| `CHAT_NOTIFY_SPACE` | Optional `spaces/…` to send notifications to before the bot has learned your DM space. |
| `CHAT_READ_SPACES` | `1` to also read your own conversations in Chat spaces as input. The first `CHAT_ALLOWED_USERS` entry must then be your `users/…` id so your own messages are recognised. |
| `GMAIL_ENABLED` | `1` to poll Gmail. |
| `GMAIL_SKIP_BULK` | default on; `0` to also process bulk/list mail. |
| `DRIVE_FOLDER_IDS` | Comma-separated Drive folder ids to index for questions. |

## Files and voice
| Variable | Meaning |
|---|---|
| `INDEX_PATHS` | Comma-separated folders (inside the container) to index, e.g. a mounted SMB share. |
| `TRANSCRIBE_URL` | OpenAI-compatible transcription endpoint (set by compose to the local Whisper). Unset → voice uploads return 503 so phones keep them queued. |
| `TRANSCRIBE_MODEL` | default `Systran/faster-whisper-small`. |

## Mac app downloads
| Variable | Default | Meaning |
|---|---|---|
| `GITHUB_REPO` | `douggreenak/personal-assistant` | `owner/name` whose `mac-v*` releases the System page offers |
| `GITHUB_TOKEN` | (none) | only for a private repo; needs read access to releases. Sent to GitHub only. |

## Push
| Variable | Meaning |
|---|---|
| `NTFY_URL`, `NTFY_TOPIC` | Also push every notification to this ntfy topic (iPhone/Watch). |

## Connector secrets
`SECRET_<NAME>` environment variables, or `$ASSISTANT_DATA/secrets.json` (written by `npm run secret`), supply credentials for [connectors](connectors.md). The model never sees them.
