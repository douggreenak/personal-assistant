import { loadConfig } from './config.ts';
import { openDb } from './db.ts';
import { ItemStore } from './items.ts';
import { ClaudeCliLlm } from './llm.ts';
import { ConsoleNotifier, MultiNotifier, NtfyNotifier, type Notifier } from './notify.ts';
import { TicketingClient } from './backends/ticketing.ts';
import { CanopyClient } from './backends/canopy.ts';
import { ServiceAccount, UserOAuth } from './google/auth.ts';
import { pollGmail } from './google/gmail.ts';
import { ChatBot, pollChatSpaces } from './google/chat.ts';
import { indexDrive } from './google/drive.ts';
import { indexPaths } from './index/indexer.ts';
import { announcePending } from './approvals.ts';
import { nagTick } from './nag.ts';
import { processNextReport } from './pipeline.ts';
import { canopySync } from './sync/canopy.ts';
import { runConnectors } from './connectors.ts';
import { createHttp } from './http.ts';
import type { Ctx } from './ctx.ts';

const cfg = loadConfig();
if (cfg.token.length < 16) { console.error('Set ASSISTANT_TOKEN to a random string of >= 16 chars (openssl rand -hex 32).'); process.exit(1); }

const db = openDb(cfg.dbPath);
const sa = cfg.google.serviceAccountFile ? ServiceAccount.fromFile(cfg.google.serviceAccountFile) : null;
const user = cfg.google.oauth?.refreshToken ? new UserOAuth(cfg.google.oauth.clientId, cfg.google.oauth.clientSecret, cfg.google.oauth.refreshToken) : null;

// ctx.notify is swapped in below once the chat bot (which needs ctx) exists.
const ctx: Ctx = {
  cfg, db, items: new ItemStore(db), llm: new ClaudeCliLlm(cfg.claude), now: () => new Date(), notify: new ConsoleNotifier(),
  ticketing: cfg.ticketing ? new TicketingClient(cfg.ticketing.url, cfg.ticketing.token) : undefined,
  canopy: cfg.canopy ? new CanopyClient(cfg.canopy.url, cfg.canopy.readToken, cfg.canopy.writeToken) : undefined,
};
const bot = sa ? new ChatBot(ctx, sa) : null;
const targets: Notifier[] = [new ConsoleNotifier()];
if (bot) targets.push(bot);
if (cfg.ntfy) targets.push(new NtfyNotifier(cfg.ntfy.url, cfg.ntfy.topic));
ctx.notify = new MultiNotifier(targets);

/** Runs `fn` every `ms`, never overlapping itself, never crashing the process. */
function every(name: string, ms: number, fn: () => Promise<unknown>, runNow = true): () => void {
  let running = false;
  const tick = async () => {
    if (running) return; running = true;
    try { await fn(); } catch (e) { console.error(`[${name}]`, (e as Error).message); } finally { running = false; }
  };
  setInterval(tick, ms); if (runNow) void tick();
  return () => void tick();
}

// The worker drains the message queue one at a time (each message is one LLM call).
const wake = every('worker', 3000, async () => { while (await processNextReport(ctx)) { /* keep draining */ } });
every('nag', 30_000, () => nagTick(ctx));
every('approvals', 10_000, () => announcePending(ctx));
every('connectors', 60_000, () => runConnectors(ctx));
if (cfg.canopy) every('canopy', 15 * 60_000, () => canopySync(ctx));
if (cfg.gmail.enabled && user) every('gmail', 60_000, () => pollGmail(ctx, user));
if (cfg.chat.readUserSpaces && user) every('chat-read', 90_000, () => pollChatSpaces(ctx, user));
if (cfg.indexPaths.length) every('index', 30 * 60_000, () => indexPaths(db, cfg.indexPaths));
if (cfg.driveFolderIds.length && user) every('drive', 60 * 60_000, () => indexDrive(ctx, user));
if (bot && cfg.chat.pubsubSubscription) {
  (async () => { for (;;) { try { await bot.pullOnce(); } catch (e) { console.error('[chat]', (e as Error).message); await new Promise((r) => setTimeout(r, 10000)); } } })();
}

const server = createHttp(ctx, { wake, ticketingSecret: process.env.TICKETING_WEBHOOK_SECRET });
server.listen(cfg.port, cfg.host, () => console.log(`assistant listening on :${cfg.port}`));
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => server.close(() => { db.close(); process.exit(0); }));
