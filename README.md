# Personal Assistant

A self-hosted assistant that turns **what you say and what people send you** into tickets, nagging reminders and tasks — and keeps them up to date.

> *"The encoder is dropping frames, remind me to order SDI cables, and call Sam this week about the invoice."*
> → a **ticket** (tracked through Reported → Diagnosing → Waiting on parts → Fix applied → Verified → Closed), a **reminder** that nags until you acknowledge it, and a **task** due Friday.
> Later: *"the cables arrived"* → the matching item is checked off, no duplicate created.

It runs on your own Linux server (Docker), is reachable only over [Tailscale](https://tailscale.com), uses your existing **Claude Code** login as its brain (no API bill), transcribes voice locally, and needs almost nothing on your always-on Mac.

## What it does
- **Understands messy input** — long, rambling speech or text becomes separate items; updates match existing items instead of duplicating.
- **Reads your world** — texts (from a Mac), Gmail, Google Chat, plus anything you connect later by pasting its API docs.
- **Right place for each thing** — IT-style **tickets** with stages ([Ticketing](https://github.com/douggreenak/ticketing), a standalone app), **reminders** that keep nagging, plain **tasks**, and school work into [Canopy](https://github.com/douggreenak/Canopy-School-Planner).
- **Voice from anywhere** — iPhone and Apple Watch record offline and upload when connected.
- **Talk to it in Google Chat** — "what's open?", approvals, snoozes, and questions answered from your own messages and files (SMB share, Drive) with citations.
- **Asks before it matters** — it adds new things freely, but asks first about money, other people's deadlines, contacting anyone, dropping things, or when it's unsure.
- **Connects to new services** — send API docs; it proposes a read-only connector, you approve, add the credential yourself, dry-run, then enable.

```
 iPhone / Watch voice ─► local Whisper ─┐
 Mac texts (tiny script) ───────────────┤                         ┌─► Ticketing app (stages)
 Gmail ─────────────────────────────────┼─► messages ─► Claude ─► typed ─► policy ─┼─► Canopy (school)
 Google Chat (read + talk) ─────────────┤   (queue)    Code     actions   apply/ask └─► reminders & tasks (nag)
 Connectors / your own typing ──────────┘            (no tools)                │
                                                          approvals & alerts ◄──┘ Google Chat / ntfy
```

## Documentation
Start with **[Getting started](docs/getting-started.md)**. Everything is in [`docs/`](docs/README.md):

| | |
|---|---|
| [Getting started](docs/getting-started.md) | deploy on your server in ~15 minutes |
| [Configuration reference](docs/configuration.md) | every setting |
| [Using it](docs/usage.md) | what to say, commands, nagging, approvals, questions |
| [Architecture](docs/architecture.md) | how it works inside, data model, module map |
| [Google setup](docs/google-setup.md) · [Mac agent](docs/mac-agent.md) · [iPhone & Watch](docs/ios-watch.md) | connect each source |
| [Canopy](docs/canopy.md) · [Ticketing](docs/ticketing.md) · [Connectors](docs/connectors.md) | integrations |
| [HTTP API](docs/api.md) | script against it |
| [Security & privacy](docs/security.md) | threat model, what leaves your server |
| [Operations](docs/operations.md) · [Development](docs/development.md) | run it, change it |

## Quick start
```bash
git clone https://github.com/douggreenak/personal-assistant && git clone https://github.com/douggreenak/ticketing
cd personal-assistant && cp .env.example .env     # set ASSISTANT_TOKEN, INGEST_TOKEN, TICKETS_TOKEN, BIND_ADDR
docker compose run --rm assistant claude          # one-time Claude Code login, then /exit
docker compose up -d --build
```

## Repository layout
```
src/        the assistant (TypeScript, Node 24, zero runtime dependencies)
test/       25 automated tests
mac/        the tiny Mac agent (bash + sqlite3 + curl) and its launchd installer
ios/        SwiftUI sources: iPhone recorder/uploader and Apple Watch recorder
scripts/    one-time helpers (Google OAuth token, connector secrets)
docs/       full documentation
Dockerfile, docker-compose.yml, .env.example
```
Companion projects: **[Ticketing](https://github.com/douggreenak/ticketing)** (standalone ticket tracker) and **[Canopy](https://github.com/douggreenak/Canopy-School-Planner)** (school planner; its API now exposes task stages for this project).

## What is and isn't verified
**Tested (25 automated tests + live runs):** extraction → typed actions → policy → approvals; the real Claude Code model end-to-end against the real Ticketing app (the example sentence above splits correctly, updates match, injection text is ignored, money updates ask); atomic message leasing and retry backoff; nagging, quiet hours and snoozing; Alaska time handling; the Mac agent against a synthetic `chat.db` including `attributedBody` decoding; Gmail parsing and history; the Chat allow-list and event shapes; service-account JWT signing; connector validation and SSRF guards; Canopy sync logic; search and Q&A; HTTP auth (full vs ingest-only token) and idempotent voice upload; the Swift sources type-check against the iOS 27 / watchOS 27 SDKs.

**Not verified (needs real accounts/hardware):** live Gmail/Chat/Pub/Sub/Drive calls (stubs only — expect small payload fixes on first contact); the Docker images (never built on the dev machine; check the `speaches` Whisper image name on first pull); the Mac agent on a real macOS Tahoe `chat.db`; the phone/watch apps beyond type-checking; the Canopy sync against the live site.

**Known limits:** keyword search (FTS5), not embeddings; Chat approvals are text commands (no buttons yet); connectors are read-only polling; one model call at a time.

## Privacy
Message text, open-item titles and search snippets are sent to Anthropic through Claude Code to be understood — see [what leaves your server](docs/security.md#what-leaves-your-server). Voice audio is transcribed locally. This repository contains no secrets; `.env`, `data/` and `claude-home/` are git-ignored.

## Contributing / issues
Issues and pull requests are welcome; please keep private message content and secrets out of them.
