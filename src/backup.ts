import { gzipSync, gunzipSync } from 'node:zlib';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { Ctx } from './ctx.ts';
import { openDb, kvGet, kvSet } from './db.ts';
import { localParts } from './time.ts';

/**
 * Backup = one gzip'd JSON file: the whole database (a consistent snapshot) plus the small files in the data folder
 * (settings, and — if you keep them in — keys, the web password and the Google service account).
 */
const FORMAT = 'personal-assistant-backup';
const PLAIN_FILES = ['settings.json'];
const SECRET_FILES = ['secrets.json', 'web-password.json', 'chat-service-account.json'];
const MAX_UNPACKED = 1024 * 1024 * 1024;

export interface BackupInfo { createdAt: string; includesSecrets: boolean; files: string[]; counts: Record<string, number> }

const countsOf = (db: DatabaseSync): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const t of ['messages', 'items', 'approvals', 'connectors', 'attachments']) out[t] = Number((db.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as { n: number }).n);
  return out;
};

export function createBackup(ctx: Ctx, includeSecrets: boolean): { data: Buffer; info: BackupInfo } {
  const tmp = join(ctx.cfg.dataDir, `.snapshot-${randomBytes(4).toString('hex')}.db`);
  let dbBytes: Buffer;
  try { ctx.db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`); dbBytes = readFileSync(tmp); } finally { rmSync(tmp, { force: true }); }
  const files: Record<string, string> = { 'assistant.db': dbBytes.toString('base64') };
  for (const f of [...PLAIN_FILES, ...(includeSecrets ? SECRET_FILES : [])]) {
    const p = join(ctx.cfg.dataDir, f); if (existsSync(p)) files[f] = readFileSync(p).toString('base64');
  }
  const info: BackupInfo = { createdAt: new Date().toISOString(), includesSecrets: includeSecrets, files: Object.keys(files), counts: countsOf(ctx.db) };
  const data = gzipSync(Buffer.from(JSON.stringify({ format: FORMAT, version: 1, ...info, files }), 'utf8'));
  return { data, info };
}

/** Reads and checks a backup without touching anything. Throws a plain-language Error if it is not usable. */
export function readBackup(buf: Buffer): { info: BackupInfo; files: Record<string, Buffer> } {
  let doc: { format?: string; version?: number; createdAt?: string; includesSecrets?: boolean; files?: Record<string, string> };
  try { doc = JSON.parse(gunzipSync(buf, { maxOutputLength: MAX_UNPACKED }).toString('utf8')); } catch { throw new Error('That is not a backup file from this app (it could not be opened).'); }
  if (doc?.format !== FORMAT || typeof doc.files !== 'object' || !doc.files || typeof doc.files['assistant.db'] !== 'string') throw new Error('That is not a backup file from this app.');
  if (doc.version !== 1) throw new Error('This backup was made by a newer version of the app. Update the app first.');
  const allowed = new Set(['assistant.db', ...PLAIN_FILES, ...SECRET_FILES]); const files: Record<string, Buffer> = {};
  for (const [k, v] of Object.entries(doc.files)) if (allowed.has(k) && typeof v === 'string') files[k] = Buffer.from(v, 'base64');
  if (files['assistant.db'].subarray(0, 15).toString('latin1') !== 'SQLite format 3') throw new Error('The database inside this backup is damaged.');
  return { info: { createdAt: String(doc.createdAt ?? ''), includesSecrets: !!doc.includesSecrets, files: Object.keys(files), counts: {} }, files };
}

const writeAtomic = (path: string, data: Buffer, secret: boolean) => { const t = `${path}.${randomBytes(3).toString('hex')}.tmp`; writeFileSync(t, data, { mode: secret ? 0o600 : 0o644 }); renameSync(t, path); };

/**
 * Replaces everything with the contents of a backup. A safety copy of the current data is saved first (data/backups/).
 * The database is copied table by table inside ONE transaction: if anything fails, nothing changes.
 */
export function restoreBackup(ctx: Ctx, buf: Buffer): { info: BackupInfo; safetyCopy: string; restartNeeded: boolean } {
  const { info, files } = readBackup(buf);
  const dir = ctx.cfg.dataDir; mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.import-${randomBytes(4).toString('hex')}.db`);
  writeFileSync(tmp, files['assistant.db']);
  try {
    const src = openDb(tmp);                                          // brings an older backup up to the current schema; refuses nothing silently
    const userVersion = (src.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    const mine = (ctx.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    if (userVersion > mine) { src.close(); throw new Error('This backup was made by a newer version of the app. Update the app first.'); }
    const counts = countsOf(src); src.close();

    mkdirSync(join(dir, 'backups'), { recursive: true });
    const safety = join(dir, 'backups', `before-restore-${new Date().toISOString().replace(/[:.]/g, '-')}.backup`);
    writeFileSync(safety, createBackup(ctx, true).data, { mode: 0o600 });
    pruneSafetyCopies(join(dir, 'backups'));

    const tables = (ctx.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('search', 'search_data', 'search_idx', 'search_content', 'search_docsize', 'search_config')").all() as { name: string }[]).map((r) => r.name);
    const q = (n: string) => `"${n.replace(/"/g, '""')}"`;
    ctx.db.exec('PRAGMA foreign_keys = OFF');
    try {
      ctx.db.exec(`ATTACH DATABASE '${tmp.replace(/'/g, "''")}' AS bk`); ctx.db.exec('BEGIN IMMEDIATE');
      try {
        for (const t of tables) { ctx.db.exec(`DELETE FROM main.${q(t)}`); ctx.db.exec(`INSERT INTO main.${q(t)} SELECT * FROM bk.${q(t)}`); }
        ctx.db.exec('DELETE FROM main.search'); ctx.db.exec('INSERT INTO main.search (rowid, kind, ref, title, body) SELECT rowid, kind, ref, title, body FROM bk.search');
        ctx.db.exec("DELETE FROM main.sqlite_sequence; INSERT INTO main.sqlite_sequence SELECT * FROM bk.sqlite_sequence");
        ctx.db.exec('COMMIT');
      } catch (e) { ctx.db.exec('ROLLBACK'); throw e; } finally { ctx.db.exec('DETACH DATABASE bk'); }
    } finally { ctx.db.exec('PRAGMA foreign_keys = ON'); }

    let restartNeeded = false;
    for (const f of [...PLAIN_FILES, ...SECRET_FILES]) if (files[f]) { writeAtomic(join(dir, f), files[f], SECRET_FILES.includes(f)); restartNeeded = true; }
    return { info: { ...info, counts }, safetyCopy: safety, restartNeeded };
  } finally { rmSync(tmp, { force: true }); for (const s of ['-wal', '-shm']) rmSync(tmp + s, { force: true }); }
}

/** Keeps the 5 newest automatic safety copies. */
function pruneSafetyCopies(dir: string): void {
  const all = readdirSync(dir).filter((f) => f.startsWith('before-restore-')).map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t);
  for (const x of all.slice(5)) rmSync(join(dir, x.f), { force: true });
}

// ---- nightly / manual backups kept on the server ----
const dirOf = (ctx: Ctx) => join(ctx.cfg.dataDir, 'backups');
const pad = (n: number) => String(n).padStart(2, '0');
export interface BackupFile { name: string; kind: 'nightly' | 'manual' | 'before-restore'; size: number; at: string }
export const BACKUP_NAME = /^(nightly|manual|before-restore)-[\w.-]+\.backup$/;

export function listBackups(ctx: Ctx): BackupFile[] {
  const d = dirOf(ctx); if (!existsSync(d)) return [];
  return readdirSync(d).filter((f) => BACKUP_NAME.test(f)).map((f) => { const st = statSync(join(d, f)); return { name: f, kind: f.startsWith('before-restore') ? 'before-restore' as const : f.startsWith('manual') ? 'manual' as const : 'nightly' as const, size: st.size, at: st.mtime.toISOString() }; }).sort((a, b) => b.at.localeCompare(a.at));
}
export const backupPath = (ctx: Ctx, name: string): string | null => (BACKUP_NAME.test(name) && existsSync(join(dirOf(ctx), name)) ? join(dirOf(ctx), name) : null);

/** Writes a backup file into data/backups/ (with keys — it sits next to them anyway — readable by the owner only). */
export function saveBackupFile(ctx: Ctx, kind: 'nightly' | 'manual', stamp: string): BackupFile {
  mkdirSync(dirOf(ctx), { recursive: true });
  const name = `${kind}-${stamp}.backup`; const path = join(dirOf(ctx), name);
  writeAtomic(path, createBackup(ctx, true).data, true);
  const st = statSync(path); return { name, kind, size: st.size, at: st.mtime.toISOString() };
}

/** Called every few minutes: makes today's nightly backup once the configured hour has passed, then trims old ones. */
export async function nightlyBackupTick(ctx: Ctx): Promise<string | null> {
  const { auto, hour, keep } = ctx.cfg.backup; if (!auto) return null;
  const lp = localParts(ctx.now(), ctx.cfg.tz); if (lp.hour < hour) return null;
  const day = `${lp.year}-${pad(lp.month)}-${pad(lp.day)}`;
  if (existsSync(join(dirOf(ctx), `nightly-${day}.backup`))) return null;
  try {
    const f = saveBackupFile(ctx, 'nightly', day);
    const old = listBackups(ctx).filter((b) => b.kind === 'nightly').sort((a, b) => b.name.localeCompare(a.name));
    for (const b of old.slice(keep)) rmSync(join(dirOf(ctx), b.name), { force: true });
    kvSet(ctx.db, 'backup.last', JSON.stringify({ at: new Date().toISOString(), ok: true, name: f.name, size: f.size }));
    return f.name;
  } catch (e) {
    const msg = (e as Error).message.slice(0, 200);
    kvSet(ctx.db, 'backup.last', JSON.stringify({ at: new Date().toISOString(), ok: false, error: msg }));
    if (kvGet(ctx.db, 'backup.failnote') !== day) { kvSet(ctx.db, 'backup.failnote', day); await ctx.notify.send(`Nightly backup failed: ${msg}`).catch(() => {}); }
    throw e;
  }
}
export const lastBackup = (ctx: Ctx): { at: string; ok: boolean; name?: string; size?: number; error?: string } | null => { const v = kvGet(ctx.db, 'backup.last'); return v ? JSON.parse(v) : null; };
