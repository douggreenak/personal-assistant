# Google setup (Gmail, Chat, Drive)

You'll create **one Google Cloud project** and use it two ways:

- **Your own account** (OAuth) — reads Gmail, Drive and, optionally, your Chat spaces.
- **A Chat bot** (service account) — the thing you talk to, and that sends you nags and approval requests.

> Assumes a Google Workspace account (needed for Chat apps). Nothing here opens a port on your server: Gmail/Drive are polled, and Chat events are *pulled* from Pub/Sub.

## 1. Project and APIs
1. <https://console.cloud.google.com> → create a project (e.g. `personal-assistant`).
2. **APIs & Services → Library**: enable **Gmail API**, **Google Drive API**, **Google Chat API**, **Cloud Pub/Sub API**.

## 2. OAuth for your account (Gmail, Drive, reading Chat)
1. **APIs & Services → OAuth consent screen**. Choose user type **Internal** (Workspace). *Internal* matters: an "External / Testing" app's refresh tokens expire after 7 days and the assistant would silently lose Gmail.
2. **Credentials → Create credentials → OAuth client ID → Desktop app.** Copy the client id and secret into `.env`:
   ```
   GOOGLE_CLIENT_ID=…
   GOOGLE_CLIENT_SECRET=…
   ```
3. Get a refresh token (works on a headless server):
   ```bash
   npm install            # once, in the repo
   npm run google-auth
   ```
   Open the URL it prints in any browser, approve, and when the browser lands on a page that fails to load (`localhost:1`), copy that **whole address-bar URL** back into the terminal. It prints `GOOGLE_REFRESH_TOKEN=…` — add it to `.env`.
   Scopes requested: Gmail read-only, Drive read-only, Chat messages read-only, Chat spaces read-only. Nothing can send, edit or delete.

## Gmail
Set `GMAIL_ENABLED=1`.
- The first poll only records "now"; **it never processes your existing inbox**. New mail is picked up about once a minute via Gmail's history API.
- Your **sent** mail is processed too (as things you committed to).
- Skipped without calling the model: drafts, spam, trash, Promotions/Social categories, and bulk mail (`List-Unsubscribe`, `Precedence: bulk`, auto-submitted) unless `GMAIL_SKIP_BULK=0`; plus senders matching `IGNORE_SENDERS`.

## Google Chat bot
1. **Service account:** IAM & Admin → Service Accounts → create one (e.g. `assistant-chat`), then **Keys → Add key → JSON**. Save it on the server as `./data/chat-service-account.json` (`chmod 600`) and set
   ```
   GOOGLE_SERVICE_ACCOUNT_FILE=/data/chat-service-account.json
   ```
2. **Pub/Sub:** create a **topic** (e.g. `assistant-chat-events`) and a **pull subscription** (e.g. `assistant-chat`) on it.
   - Grant `chat-api-push@system.gserviceaccount.com` the **Pub/Sub Publisher** role on the topic (this lets Chat publish events).
   - Grant your service account **Pub/Sub Subscriber** on the subscription.
   - Set `CHAT_PUBSUB_SUBSCRIPTION=projects/<project-id>/subscriptions/assistant-chat`.
3. **Chat API → Configuration:** give the app a name and avatar, enable **Receive 1:1 messages**, set **Connection settings → Cloud Pub/Sub** with your topic's full name (`projects/<project-id>/topics/assistant-chat-events`), and restrict visibility to yourself.
4. Set who may command it — **required; empty means nobody**:
   ```
   CHAT_ALLOWED_USERS=you@your-domain.example
   ```
5. `docker compose up -d`, open Google Chat, find the app, and send it a message (`help`). The first message teaches it your DM space; from then on it can message you first (nags, approvals, "added …" confirmations).

Messages from anyone not in `CHAT_ALLOWED_USERS` are ignored (and logged).

### Reading your own Chat spaces (optional)
`CHAT_READ_SPACES=1` makes the assistant also read messages in your spaces (using your OAuth account) as input, the same as texts and email. Set the **first** `CHAT_ALLOWED_USERS` entry to your Chat user id (`users/1234567890`) so your own messages are recognised as yours. New messages only, polled every 90 s.

## Drive
Set `DRIVE_FOLDER_IDS` to one or more folder ids (the long id in a folder's URL). Subfolders are included to 6 levels. Google Docs are exported as text, Sheets as CSV, and text-like files are downloaded; everything else is skipped. Used for [questions](usage.md#asking-questions), not for creating tasks.

## Verifying and troubleshooting
| Symptom | Likely cause |
|---|---|
| `google oauth: invalid_grant` in logs | refresh token expired/revoked — consent screen not *Internal*, or you revoked access. Re-run `npm run google-auth`. |
| Bot never answers | not in `CHAT_ALLOWED_USERS` (check logs for "ignoring message from non-allowed user"); subscription name wrong; the service account lacks Subscriber; Chat isn't publishing to your topic (missing publisher role for `chat-api-push@…`). |
| Bot answers but never messages first | it hasn't learned your DM space — send it one message, or set `CHAT_NOTIFY_SPACE=spaces/…`. |
| Gmail does nothing | `GMAIL_ENABLED` not `1`, or no *new* mail yet (the first poll is the baseline). |
| Chat payload parse problems | the code accepts both Google's classic event shape and the newer `chat.messagePayload` shape; if Google changed it again, `parseChatEvent` in `src/google/chat.ts` is the only place to adjust. |

> These integrations were written against Google's documented APIs and tested with stubs. See [what's verified](../README.md#what-is-and-isnt-verified).
