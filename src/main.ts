import { loadConfig } from './config.ts';
import { readOverrides } from './settings.ts';
import { captureLogs } from './logs.ts';
import { openDb } from './db.ts';
import { ItemStore } from './items.ts';
import { ClaudeCliLlm } from './llm.ts';
import { recordUsage, pruneUsage } from './llmusage.ts';
import { ConsoleNotifier, MultiNotifier, NtfyNotifier, type Notifier } from './notify.ts';
import { join } from 'node:path';
import { LocalTicketing } from './tickets/local.ts';
import { openDb as openTicketsDb } from './tickets/db.ts';
import { applyTicketingEvent } from './sync/ticketing.ts';
import { CanopyClient } from './backends/canopy.ts';
import { ServiceAccount, UserOAuth } from './google/auth.ts';
import { pollGmail } from './google/gmail.ts';
import { ChatBot, pollChatSpaces } from './google/chat.ts';
import { indexDrive } from './google/drive.ts';
import { indexPaths } from './index/indexer.ts';
import { announcePending } from './approvals.ts';
import { importCredentialFile } from './credentials.ts';
import { nagTick } from './nag.ts';
import { processNextReport } from './pipeline.ts';
import { canopySync } from './sync/canopy.ts';
import { runConnectors } from './connectors.ts';
import { nightlyBackupTick } from './backup.ts';
import { bootResume, restoreManagedQueues } from './code/manager.ts';
import { restoreExternalQueues } from './code/external.ts';
import { createHttp } from './http.ts';
import type { Ctx } from './ctx.ts';

captureLogs();
// Settings saved from the web UI override environment variables (they take effect after a restart).
const env = { ...process.env, ...readOverrides(process.env.ASSISTANT_DATA ?? './data') };
const cfg = loadConfig(env);
if (cfg.token.length < 16) { console.error('Set ASSISTANT_TOKEN to a random string of >= 16 chars (openssl rand -hex 32).'); process.exit(1); }

const db = openDb(cfg.dbPath);
const sa = cfg.google.serviceAccountFile ? ServiceAccount.fromFile(cfg.google.serviceAccountFile) : null;
const user = cfg.google.oauth?.refreshToken ? new UserOAuth(cfg.google.oauth.clientId, cfg.google.oauth.clientSecret, cfg.google.oauth.refreshToken) : null;

// ctx.notify is swapped in below once the chat bot (which needs ctx) exists.
const ctx: Ctx = {
  cfg, db, items: new ItemStore(db), llm: new ClaudeCliLlm({ ...cfg.claude, onUsage: (u) => recordUsage(db, u) }), now: () => new Date(), notify: new ConsoleNotifier(),
  ticketing: new LocalTicketing(openTicketsDb(join(cfg.dataDir, 'tickets.db'))),   // the ticket tracker is built in
  canopy: cfg.canopy ? new CanopyClient(cfg.canopy.url, cfg.canopy.readToken, cfg.canopy.writeToken) : undefined,
};
ctx.ticketing!.onChange = (type, data) => { try { applyTicketingEvent(ctx, { type, data: data as Record<string, unknown> }); } catch (e) { console.error('[tickets] mirror failed', (e as Error).message); } };   // edits made in the Tickets tab reach the item list
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
every('usage-prune', 6 * 3600_000, async () => pruneUsage(db), false);
every('approvals', 10_000, () => announcePending(ctx));
every('connectors', 60_000, () => runConnectors(ctx));
every('credentials-file', 15_000, async () => { const n = importCredentialFile(ctx); if (n) console.log(`[credentials] stored ${n} from the credentials file`); });
every('backup', 5 * 60_000, () => nightlyBackupTick(ctx), true);
void bootResume(ctx).then((n) => n && console.log(`[code] resumed ${n} session(s)`)).catch((e) => console.error('[code]', (e as Error).message))
  .then(() => { const n = restoreManagedQueues(ctx) + restoreExternalQueues(ctx); if (n) console.log(`[code] restored ${n} queued message(s)`); });   // after the sessions are back up
if (cfg.canopy) every('canopy', 15 * 60_000, () => canopySync(ctx));
if (cfg.gmail.enabled && user) every('gmail', 60_000, () => pollGmail(ctx, user));
if (cfg.chat.readUserSpaces && user) every('chat-read', 90_000, () => pollChatSpaces(ctx, user));
if (cfg.indexPaths.length) every('index', 30 * 60_000, () => indexPaths(db, cfg.indexPaths));
if (cfg.driveFolderIds.length && user) every('drive', 60 * 60_000, () => indexDrive(ctx, user));
if (bot && cfg.chat.pubsubSubscription) {
  (async () => { for (;;) { try { await bot.pullOnce(); } catch (e) { console.error('[chat]', (e as Error).message); await new Promise((r) => setTimeout(r, 10000)); } } })();
}

const server = createHttp(ctx, { wake });
server.listen(cfg.port, cfg.host, () => console.log(`assistant listening on :${cfg.port}`));
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => server.close(() => { db.close(); process.exit(0); }));
