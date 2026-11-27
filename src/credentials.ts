import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { Ctx } from './ctx.ts';
import { nowIso } from './db.ts';

/**
 * The central credentials store: one place every agent (Claude Code sessions, scripts, the Mac app) saves logins and API keys to,
 * and reads them back from, over the HTTP API (full token only). Values are encrypted at rest with AES-256-GCM; the key is
 * data/credentials.key (mode 600, or the CREDENTIALS_KEY env var as 64 hex chars), so a copy of the database alone reveals nothing.
 * Listing never returns values. Every save / read / delete is logged with the agent's name — never the value. The language model
 * that reads messages has no route to this store.
 */
export interface Credential { name: string; service: string; username: string; url: string; notes: string; createdBy: string; updatedBy: string; createdAt: string; updatedAt: string }
export interface CredentialWithSecret extends Credential { secret: string }
export interface CredentialInput { secret: string; service?: unknown; username?: unknown; url?: unknown; notes?: unknown }

const NAME = /^[A-Z][A-Z0-9_]{2,60}$/;
const MAX = { secret: 20_000, service: 100, username: 200, url: 500, notes: 2_000, agent: 80 };

function key(ctx: Ctx): Buffer {
  const env = process.env.CREDENTIALS_KEY;
  if (env) { if (!/^[0-9a-f]{64}$/i.test(env)) throw new Error('CREDENTIALS_KEY must be 64 hex characters.'); return Buffer.from(env, 'hex'); }
  const file = `${ctx.cfg.dataDir}/credentials.key`;
  if (existsSync(file)) { const k = Buffer.from(readFileSync(file, 'utf8').trim(), 'hex'); if (k.length === 32) return k; throw new Error('data/credentials.key is damaged.'); }
  mkdirSync(ctx.cfg.dataDir, { recursive: true });
  const k = randomBytes(32); writeFileSync(file, k.toString('hex'), { mode: 0o600, flag: 'wx' }); chmodSync(file, 0o600);
  return k;
}
const b64 = (b: Buffer) => b.toString('base64url');
function seal(ctx: Ctx, name: string, plain: string): string {
  const iv = randomBytes(12); const c = createCipheriv('aes-256-gcm', key(ctx), iv); c.setAAD(Buffer.from(name));   // bound to its name: a value can't be moved to another row
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', b64(iv), b64(c.getAuthTag()), b64(ct)].join('.');
}
function open(ctx: Ctx, name: string, sealed: string): string {
  const [v, iv, tag, ct] = sealed.split('.'); if (v !== 'v1' || !ct) throw new Error('Unreadable credential.');
  const d = createDecipheriv('aes-256-gcm', key(ctx), Buffer.from(iv, 'base64url')); d.setAAD(Buffer.from(name)); d.setAuthTag(Buffer.from(tag, 'base64url'));
  try { return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8'); }
  catch { throw new Error('Could not decrypt this credential (wrong or missing data/credentials.key).'); }
}

type Row = { name: string; service: string; username: string; url: string; notes: string; secret: string; created_by: string; updated_by: string; created_at: string; updated_at: string };
const meta = (r: Row): Credential => ({ name: r.name, service: r.service, username: r.username, url: r.url, notes: r.notes, createdBy: r.created_by, updatedBy: r.updated_by, createdAt: r.created_at, updatedAt: r.updated_at });
const log = (ctx: Ctx, agent: string, action: string, name: string): void => { ctx.db.prepare('INSERT INTO credential_log (at, agent, action, name) VALUES (?,?,?,?)').run(nowIso(), agent.slice(0, MAX.agent) || 'api', action, name); };
const text = (v: unknown, max: number, what: string): string => {
  const s = v == null ? '' : String(v).trim(); if (s.length > max) throw new Error(`${what} is too long (max ${max} characters).`); return s;
};

/** Names and details only — never the values. `q` filters by name, service, username or notes. */
export function listCredentials(ctx: Ctx, q = ''): Credential[] {
  const like = `%${q.replace(/[%_]/g, '')}%`;
  return (ctx.db.prepare(`SELECT * FROM credentials WHERE ? = '' OR name LIKE ? OR service LIKE ? OR username LIKE ? OR notes LIKE ? ORDER BY name`).all(q.trim(), like, like, like, like) as Row[]).map(meta);
}

export function getCredential(ctx: Ctx, name: string, agent: string): CredentialWithSecret | null {
  const r = ctx.db.prepare('SELECT * FROM credentials WHERE name = ?').get(name) as Row | undefined; if (!r) return null;
  const secret = open(ctx, name, r.secret); log(ctx, agent, 'read', name);
  return { ...meta(r), secret };
}

/** Creates or replaces a credential. Fields left out keep their old value when updating. */
export function saveCredential(ctx: Ctx, name: string, input: CredentialInput, agent: string): Credential {
  if (!NAME.test(name)) throw new Error('Credential names look like GITHUB_PAT (UPPER_SNAKE_CASE, 3–61 characters).');
  const secret = typeof input.secret === 'string' ? input.secret.trim() : ''; if (!secret) throw new Error('A credential needs a secret value.');
  if (secret.length > MAX.secret) throw new Error('The secret is too long.');
  const by = agent.trim().slice(0, MAX.agent) || 'api'; const now = nowIso();
  const old = ctx.db.prepare('SELECT * FROM credentials WHERE name = ?').get(name) as Row | undefined;
  const pick = (k: 'service' | 'username' | 'url' | 'notes'): string => input[k] === undefined ? (old?.[k] ?? '') : text(input[k], MAX[k], k);
  ctx.db.prepare(`INSERT INTO credentials (name, service, username, url, notes, secret, created_by, updated_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(name) DO UPDATE SET service = excluded.service, username = excluded.username, url = excluded.url, notes = excluded.notes, secret = excluded.secret, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
    .run(name, pick('service'), pick('username'), pick('url'), pick('notes'), seal(ctx, name, secret), by, by, now, now);
  log(ctx, by, old ? 'update' : 'create', name);
  return meta(ctx.db.prepare('SELECT * FROM credentials WHERE name = ?').get(name) as Row);
}

export function deleteCredential(ctx: Ctx, name: string, agent: string): boolean {
  const ok = ctx.db.prepare('DELETE FROM credentials WHERE name = ?').run(name).changes > 0; if (ok) log(ctx, agent, 'delete', name); return ok;
}

export const credentialLog = (ctx: Ctx, name?: string, limit = 200): { at: string; agent: string; action: string; name: string }[] =>
  ctx.db.prepare(`SELECT at, agent, action, name FROM credential_log ${name ? 'WHERE name = ?' : "WHERE ? = ''"} ORDER BY id DESC LIMIT ?`).all(name ?? '', limit) as never;
