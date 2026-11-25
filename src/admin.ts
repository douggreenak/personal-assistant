import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import type { Ctx } from './ctx.ts';
import { nowIso } from './db.ts';
import { listConnectors } from './connectors.ts';

type Row = Record<string, unknown>;
const startedAt = Date.now();
const pkg = (() => { try { return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }; } catch { return { version: '?' }; } })();

const count = (ctx: Ctx, sql: string, ...a: string[]): number => (ctx.db.prepare(sql).get(...a) as { n: number }).n;

export function status(ctx: Ctx) {
  const now = nowIso();
  return {
    version: pkg.version, node: process.version, uptimeSec: Math.round((Date.now() - startedAt) / 1000), now, tz: ctx.cfg.tz, model: ctx.cfg.claude.model ?? '(default)',
    queue: {
      pending: count(ctx, "SELECT COUNT(*) n FROM messages WHERE processed_at IS NULL AND (error IS NULL OR error = '')"),
      failing: count(ctx, "SELECT COUNT(*) n FROM messages WHERE processed_at IS NULL AND error IS NOT NULL AND error <> ''"),
      total: count(ctx, 'SELECT COUNT(*) n FROM messages'),
    },
    items: {
      open: count(ctx, "SELECT COUNT(*) n FROM items WHERE state = 'open'"),
      tickets: count(ctx, "SELECT COUNT(*) n FROM items WHERE state = 'open' AND kind = 'ticket'"),
      reminders: count(ctx, "SELECT COUNT(*) n FROM items WHERE state = 'open' AND kind = 'reminder'"),
      tasks: count(ctx, "SELECT COUNT(*) n FROM items WHERE state = 'open' AND kind = 'task'"),
      overdue: count(ctx, "SELECT COUNT(*) n FROM items WHERE state = 'open' AND due_at IS NOT NULL AND due_at < ?", now),
      nagging: count(ctx, "SELECT COUNT(*) n FROM items WHERE state = 'open' AND kind = 'reminder' AND nag_count > 0 AND acked_at IS NULL"),
    },
    approvals: count(ctx, "SELECT COUNT(*) n FROM approvals WHERE status = 'pending'"),
    indexedFiles: count(ctx, 'SELECT COUNT(*) n FROM docs'),
    bySource: ctx.db.prepare('SELECT source, COUNT(*) n FROM messages GROUP BY source ORDER BY n DESC LIMIT 12').all() as Row[],
  };
}

async function probe(url: string, headers: Record<string, string> = {}): Promise<{ ok: boolean; detail: string }> {
  try { const r = await fetch(url, { headers, signal: AbortSignal.timeout(3000) }); return { ok: r.status < 500, detail: `HTTP ${r.status}` }; }
  catch (e) { return { ok: false, detail: (e as Error).message.slice(0, 80) }; }
}
/** Which integrations are configured, and (for network ones) whether they answer right now. */
export async function integrations(ctx: Ctx) {
  const c = ctx.cfg; const out: { id: string; name: string; configured: boolean; ok: boolean | null; detail: string }[] = [];
  const add = (id: string, name: string, configured: boolean, ok: boolean | null, detail: string) => out.push({ id, name, configured, ok, detail });
  if (c.ticketing) {
    let ok = false, d = '';
    try { const p = await Promise.race([ctx.ticketing!.defaultPipeline(), new Promise<never>((_, r) => setTimeout(() => r(new Error('timeout')), 3000))]); ok = true; d = `${p.name} · ${p.stages.length} stages`; } catch (e) { d = (e as Error).message.slice(0, 80); }
    add('ticketing', 'Ticketing', true, ok, d);
  } else add('ticketing', 'Ticketing', false, null, 'Not configured');
  if (c.canopy) { const p = await probe(c.canopy.url); add('canopy', 'Canopy', true, p.ok, p.detail); } else add('canopy', 'Canopy', false, null, 'Not configured');
  if (c.transcribeUrl) { const p = await probe(new URL(c.transcribeUrl).origin + '/health'); add('whisper', 'Speech-to-text', true, p.ok, p.detail); } else add('whisper', 'Speech-to-text', false, null, 'Not configured');
  const g = !!c.google.oauth?.refreshToken;
  add('gmail', 'Gmail', c.gmail.enabled, c.gmail.enabled ? g : null, !c.gmail.enabled ? 'Off' : g ? 'Polling every minute' : 'Enabled but Google OAuth is incomplete');
  add('chat', 'Google Chat bot', !!c.chat.pubsubSubscription, c.chat.pubsubSubscription ? !!c.google.serviceAccountFile : null, c.chat.pubsubSubscription ? (c.google.serviceAccountFile ? 'Listening' : 'Needs a service account file') : 'Not configured');
  add('drive', 'Google Drive index', c.driveFolderIds.length > 0, c.driveFolderIds.length ? g : null, c.driveFolderIds.length ? `${c.driveFolderIds.length} folder(s)` : 'Not configured');
  add('ntfy', 'Phone push (ntfy)', !!c.ntfy, null, c.ntfy ? `${c.ntfy.url} / ${c.ntfy.topic}` : 'Not configured');
  add('files', 'File index', c.indexPaths.length > 0, null, c.indexPaths.length ? c.indexPaths.join(', ') : 'Not configured');
  add('ingest', 'Device ingest token', c.ingestToken.length >= 16, null, c.ingestToken.length >= 16 ? 'Set' : 'Not set');
  return out;
}

export function activity(ctx: Ctx, limit = 60) {
  return (ctx.db.prepare(`SELECT e.id, e.at, e.actor, e.type, e.data, e.item_id AS itemId, i.title, i.kind FROM item_events e JOIN items i ON i.id = e.item_id ORDER BY e.id DESC LIMIT ?`).all(Math.min(limit, 300)) as Row[])
    .map((r) => ({ ...r, data: JSON.parse(r.data as string) }));
}

export function listMessages(ctx: Ctx, f: { filter?: string; q?: string; limit?: number }) {
  const w: string[] = []; const a: (string | number)[] = [];
  if (f.filter === 'pending') w.push("processed_at IS NULL AND (error IS NULL OR error = '')");
  else if (f.filter === 'failed') w.push("processed_at IS NULL AND error IS NOT NULL AND error <> ''");
  else if (f.filter === 'done') w.push('processed_at IS NOT NULL');
  if (f.q) { w.push('(body LIKE ? OR sender LIKE ? OR subject LIKE ?)'); const l = `%${f.q.replace(/[%_]/g, '')}%`; a.push(l, l, l); }
  a.push(Math.min(f.limit ?? 100, 500));
  return (ctx.db.prepare(`SELECT id, source, sender, subject, substr(body, 1, 600) AS body, received_at AS receivedAt, processed_at AS processedAt, attempts, retry_at AS retryAt, error
    FROM messages ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`).all(...a) as Row[]);
}
export const retryMessage = (ctx: Ctx, id: number): boolean =>
  ctx.db.prepare('UPDATE messages SET processed_at = NULL, retry_at = NULL, error = NULL, attempts = 0 WHERE id = ?').run(id).changes > 0;
export const skipMessage = (ctx: Ctx, id: number): boolean =>
  ctx.db.prepare("UPDATE messages SET processed_at = ?, retry_at = NULL, error = 'skipped from web UI' WHERE id = ? AND processed_at IS NULL").run(nowIso(), id).changes > 0;

// ---- connectors ----
export function connectorsFull(ctx: Ctx) {
  return listConnectors(ctx).map((c) => {
    const secret = c.manifest.auth.type !== 'none' ? c.manifest.auth.secret : undefined;
    return { ...c, secretName: secret ?? null, secretSet: secret ? hasSecret(ctx, secret) : null,
      tested: !!ctx.db.prepare('SELECT 1 FROM kv WHERE key = ?').get(`connector.tested.${c.id}`) };
  });
}
export function setConnectorStatus(ctx: Ctx, id: string, status: 'disabled'): boolean {
  return ctx.db.prepare('UPDATE connectors SET status = ? WHERE id = ?').run(status, id).changes > 0;
}
export function deleteConnector(ctx: Ctx, id: string): boolean {
  ctx.db.prepare('DELETE FROM kv WHERE key = ?').run(`connector.tested.${id}`);
  return ctx.db.prepare('DELETE FROM connectors WHERE id = ?').run(id).changes > 0;
}
const secretsFile = (ctx: Ctx) => `${ctx.cfg.dataDir}/secrets.json`;
const readSecrets = (ctx: Ctx): Record<string, string> => { try { return existsSync(secretsFile(ctx)) ? JSON.parse(readFileSync(secretsFile(ctx), 'utf8')) : {}; } catch { return {}; } };
export const hasSecret = (ctx: Ctx, name: string): boolean => !!process.env[`SECRET_${name}`] || !!readSecrets(ctx)[name];
export function setSecret(ctx: Ctx, name: string, value: string | null): void {
  if (!/^[A-Z][A-Z0-9_]{2,60}$/.test(name)) throw new Error('Secret names look like ACME_API_KEY.');
  const s = readSecrets(ctx); if (value) s[name] = value.trim(); else delete s[name];
  mkdirSync(ctx.cfg.dataDir, { recursive: true });
  writeFileSync(secretsFile(ctx), JSON.stringify(s, null, 2), { mode: 0o600 }); chmodSync(secretsFile(ctx), 0o600);
}

export function saveServiceAccount(ctx: Ctx, json: string): string {
  let j: Record<string, unknown>;
  try { j = JSON.parse(json); } catch { throw new Error('That is not valid JSON.'); }
  if (j.type !== 'service_account' || typeof j.private_key !== 'string' || typeof j.client_email !== 'string') throw new Error('That does not look like a Google service-account key file.');
  const path = `${ctx.cfg.dataDir}/chat-service-account.json`;
  mkdirSync(ctx.cfg.dataDir, { recursive: true }); writeFileSync(path, json, { mode: 0o600 }); chmodSync(path, 0o600);
  return path;
}
