import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type Db = DatabaseSync;

const MIGRATIONS: string[] = [`
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,              -- mac | gmail | chat | chat-read | voice | connector:<name>
  source_id TEXT NOT NULL,
  sender TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  received_at TEXT NOT NULL,
  processed_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  retry_at TEXT,                     -- lease while being processed, then backoff after a failure
  error TEXT,
  UNIQUE(source, source_id)
);
CREATE INDEX messages_pending ON messages(processed_at, id);
CREATE TABLE items (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,                -- ticket | reminder | task
  title TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'open',-- open | done | dropped
  stage_id TEXT,
  stage_label TEXT,
  due_at TEXT,
  priority TEXT NOT NULL DEFAULT 'normal',
  backend TEXT NOT NULL DEFAULT 'local',  -- local | ticketing | canopy
  backend_ref TEXT,
  class_id TEXT,
  external_key TEXT UNIQUE,          -- dedupe key for generated items (e.g. canopy alerts)
  source_message_id INTEGER REFERENCES messages(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  acked_at TEXT,
  snooze_until TEXT,
  next_nag_at TEXT,
  nag_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX items_open ON items(state, kind);
CREATE TABLE item_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  at TEXT NOT NULL, actor TEXT NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  kind TEXT NOT NULL,                -- action | connector
  summary TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  payload TEXT NOT NULL,
  message_id INTEGER,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected
  decided_at TEXT, decided_by TEXT,
  notified INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE connectors (
  id TEXT PRIMARY KEY, manifest TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'proposed', -- proposed | approved | enabled | disabled
  created_at TEXT NOT NULL, last_run_at TEXT, last_error TEXT
);
CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE VIRTUAL TABLE search USING fts5(kind UNINDEXED, ref UNINDEXED, title, body, tokenize = 'porter unicode61');
CREATE TABLE docs (path TEXT PRIMARY KEY, mtime TEXT NOT NULL, chunks INTEGER NOT NULL);
CREATE TABLE doc_rows (path TEXT NOT NULL, fts_rowid INTEGER NOT NULL);
CREATE INDEX doc_rows_path ON doc_rows(path);
`];

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  const { user_version } = db.prepare('PRAGMA user_version').get() as { user_version: number };
  for (let v = user_version; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try { db.exec(MIGRATIONS[v]); db.exec(`PRAGMA user_version = ${v + 1}`); db.exec('COMMIT'); }
    catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  return db;
}

export const kvGet = (db: Db, key: string): string | undefined =>
  (db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined)?.value;
export const kvSet = (db: Db, key: string, value: string): void => {
  db.prepare('INSERT INTO kv (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
};
export const nowIso = (): string => new Date().toISOString();

/** Builds a safe FTS5 MATCH expression (OR of quoted prefix terms) from free text. */
export function ftsQuery(text: string, max = 12): string | null {
  const words = [...new Set(text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])].slice(0, max);
  return words.length ? words.map((w) => `"${w}"*`).join(' OR ') : null;
}
