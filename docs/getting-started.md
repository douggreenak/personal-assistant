# Getting started

This brings up the assistant, the ticket tracker and local speech-to-text on one Linux server, reachable only over Tailscale.
Do the first four steps and you can already talk to it with `curl`; the rest add sources one at a time.

## 0. What you need
- A Linux server with Docker + Docker Compose, and [Tailscale](https://tailscale.com) installed and signed in.
- A Claude account that can use Claude Code (the assistant's "brain" runs `claude -p` on your login; no API key, no per-token bill beyond your plan).
- The two repos side by side (compose builds the ticket tracker from the sibling folder):
  ```
  ~/apps/personal-assistant/
  ~/apps/ticketing/
  ```
  ```bash
  cd ~/apps
  git clone https://github.com/douggreenak/personal-assistant
  git clone https://github.com/douggreenak/ticketing
  ```

## 1. Configure
```bash
cd personal-assistant
cp .env.example .env
chmod 600 .env
openssl rand -hex 32        # → ASSISTANT_TOKEN
openssl rand -hex 32        # → TICKETS_TOKEN
tailscale ip -4             # → BIND_ADDR  (only your tailnet can then reach the ports)
```
Edit `.env`: set those three, plus `TZ_NAME` (default `America/Anchorage`), `QUIET_HOURS` and `NAG_MINUTES` if you want different nagging.
Every setting is in the [configuration reference](configuration.md).

## 2. Log Claude Code in (once)
The container runs Claude Code headless, so it needs your login. The login is stored in `./claude-home` (git-ignored).
```bash
docker compose run --rm assistant claude
# complete the login flow it prints, then /exit
```

## 3. Start it
```bash
docker compose up -d --build
curl http://$BIND_ADDR:8090/healthz          # {"ok":true}
```
The first start downloads the Whisper speech model on first use (a minute or two); nothing else is slow.

## 4. Try it
```bash
curl -s -H "authorization: Bearer $ASSISTANT_TOKEN" -H 'content-type: application/json' \
  -d '{"text":"the encoder is dropping frames, remind me to order SDI cables, and call Sam this week about the invoice"}' \
  http://$BIND_ADDR:8090/chat
```
You should get back three items: a ticket (visible at `http://$BIND_ADDR:8080`, enter `TICKETS_TOKEN` when asked), a reminder, and a task.
Then try `"the cables arrived"` and `open`. See [Using it](usage.md).

## 5. Add sources (any order)
| Source | Guide |
|---|---|
| Google Chat (talk to it, get nags and approvals) | [Google setup](google-setup.md#google-chat-bot) |
| Gmail | [Google setup](google-setup.md#gmail) |
| Texts from your Mac | [Mac agent](mac-agent.md) |
| Voice from iPhone / Watch | [iPhone & Apple Watch](ios-watch.md) |
| Canopy school planner | [Canopy integration](canopy.md) |
| Files on an SMB share / Google Drive (for questions) | [Usage → asking questions](usage.md#asking-questions) |
| Anything else | [Connectors](connectors.md) |

## 6. Phone pushes for nags (optional)
Google Chat notifications are the default. For louder pushes on iPhone/Watch, run a [ntfy](https://ntfy.sh) server (or use ntfy.sh with a private topic name), install the ntfy app, and set `NTFY_URL` / `NTFY_TOPIC`.

## Where things live
| Path | What |
|---|---|
| `./data/assistant.db` | the SQLite database — **back this up** |
| `./data/secrets.json` | connector credentials you stored (mode 600) |
| `./claude-home/` | your Claude Code login |
| `./ticketing-data/tickets.db` | the ticket tracker's database — back this up too |
