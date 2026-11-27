# Security & privacy

The assistant reads your texts, email and chat and can change your task lists, so it is built around one rule: **untrusted text can only ever produce *proposals*, never actions.**

## Threat model in one paragraph
Anyone who can send you a text, an email or a chat message can put words in front of a language model. The design goal is that those words cannot make the assistant read your files, run commands, leak data, or message anyone — and that the worst they can do is bounded, visible and reversible.

## How untrusted text is contained
1. **The model has no tools.** Claude Code is run as `claude -p --tools "" --no-session-persistence --setting-sources ""` with a JSON-schema-constrained reply, from `/tmp`. It cannot read files, run shell commands, browse, or call anything — it can only return a list of proposed actions. No hooks, plugins or project settings are loaded.
2. **Typed actions only.** The reply is validated (`parseActions`): only `create / update / stage / complete / drop`; item ids must be ones that were shown to it; unknown ops, unknown ids, bad stages and over-long fields are discarded. There is no "run" or "send" action to ask for.
3. **A policy gate you control.** New items are added freely (they're harmless to create). Anything that changes existing work on a guess, or that touches money, other people's commitments or outbound contact, or drops something, waits for your `approve N`.
4. **The message is quoted as data.** The prompt tells the model the message is untrusted content and that instructions inside it are not instructions. (Defence in depth — points 1–3 do the real work.)
5. **Read-only by default for sources.** Gmail and Drive use read-only scopes; the Mac agent opens `chat.db` read-only; the assistant never sends mail, texts or chat messages on your behalf.
6. **Least-privilege tokens.** Canopy: a read-only token for alert syncing, a separate write token used only by the action layer. Ticketing: one token; the tracker is not reachable from the internet.
7. **Only you can command it.** The Chat bot obeys only `CHAT_ALLOWED_USERS` (empty = nobody) and ignores bot senders. Every HTTP route needs a bearer token (compared in constant time) — devices get the ingest-only `INGEST_TOKEN` — except the webhook, which requires a valid HMAC signature.
8. **Connectors can't reach inward.** HTTPS GET only, no redirects, hosts that resolve to private/loopback/Tailscale ranges refused at proposal *and* at fetch time; credentials supplied out-of-band; three human gates ([details](connectors.md#safety-rules-enforced-in-code)).
9. **Network exposure.** No port is published to the internet. Services bind to `BIND_ADDR` (your Tailscale IP). Google Chat events are *pulled* via Pub/Sub — no inbound webhook. Traffic between your devices and the server is plain HTTP *inside* Tailscale, i.e. WireGuard-encrypted end to end.

## Known residual risks (be aware)
- **A forged-looking message can still *propose* a real update.** If someone texts or emails "the cables arrived", the assistant may check off your "order SDI cables" item (it's a confident, plausible update, so it's auto-applied). Impact is limited to your own task state and is logged in each item's history. Mitigations you can apply: lower `AUTO_APPLY_MIN_CONFIDENCE` toward 1.0 to ask more often, and add noisy senders to `IGNORE_SENDERS`. Updates triggered by *money* or *others' deadlines* always ask regardless.
- **Junk creation.** A flood of messages can create junk items. They're easy to drop (`done ID`) and items from automated senders are skipped.
- **Denial of wallet/time.** Each message costs one model call; a flood is rate-limited only by the one-at-a-time worker and your Claude plan limits.
- **Device tokens.** The Mac (`~/.assistant-agent.conf`, mode 600) and phone (Keychain) hold a credential. Give them `INGEST_TOKEN`, which can only call `/ingest/*` — a stolen device can add input but cannot read items, approve actions or chat. (If you give a device `ASSISTANT_TOKEN` instead, it has full access.) Rotate by changing the token and reinstalling the agent/app settings.

## What leaves your server
| Data | Goes to | Why |
|---|---|---|
| Text of messages being processed, your open item titles, search snippets for questions, connector docs | **Anthropic**, via your Claude Code login | the model call. This includes Canopy-derived text (assignment titles, grade alerts) once it is in an item or message. Your Claude plan's data terms apply. |
| API calls | Google (Gmail/Drive/Chat/Pub/Sub), Canopy, your connectors' hosts | reading sources, posting replies |
| Notification text | your ntfy server — **or ntfy.sh if you use their public one** | optional push; if you use ntfy.sh, pick an unguessable topic or self-host, since the text of your reminders is sent |
| Pictures | **Anthropic**, same route — but only still pictures, downscaled to ≤1280px JPEG (`src/images.ts`). Videos, PDFs and other attachments are never sent. Pictures arriving with other people's messages also lose logos, signatures, banners and tracking pixels, and at most 3 are read per message. Gmail attachments are never downloaded. | keeps model usage low |
| Voice audio | nowhere — transcribed locally by the Whisper container | |
| Everything else (database, files you index) | stays on the server | |

## Secrets and the public repo
This repository is public; **no secrets are in it**. Git-ignored: `.env`, `data/` (database, `secrets.json`, service-account key), `claude-home/` (your Claude login), `*.db`. Keep `.env` at mode 600. Never paste tokens into issues. If a token is ever exposed, rotate it (new `ASSISTANT_TOKEN`/`TICKETS_TOKEN`, revoke Canopy tokens in Canopy, revoke Google access at <https://myaccount.google.com/permissions>).

## Credentials store
Agents save logins and API keys to one place (`/credentials`, see [API](api.md#credentials-central-store-for-agents)). Values are encrypted with AES-256-GCM (bound to their name) and the key sits in `data/credentials.key`, not in the database, so a database copy or a backup made *without* secrets reveals nothing. Anything holding `ASSISTANT_TOKEN` can read every value — give agents that token only if you trust them with all of it. Reads are logged by agent name. The message-reading model has no tools and no route to this store.

## Reporting a problem
Open an issue **without** secrets or private message content, or contact the maintainer privately for anything sensitive.
