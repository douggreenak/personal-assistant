import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type Db = DatabaseSync;

export const DEFAULT_PIPELINE_STAGES = [
  { id: 'reported', label: 'Reported' },
  { id: 'diagnosing', label: 'Diagnosing' },
  { id: 'waiting_on_parts', label: 'Waiting on parts' },
  { id: 'fix_applied', label: 'Fix applied' },
  { id: 'verified', label: 'Verified' },
  { id: 'closed', label: 'Closed' },
];

const MIGRATIONS: string[] = [
  `
  CREATE TABLE pipelines (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    stages TEXT NOT NULL,            -- JSON [{id,label}], ordered; the last stage means "closed"
    is_default INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE tickets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    pipeline_id TEXT NOT NULL REFERENCES pipelines(id),
    stage_id TEXT NOT NULL,
    priority TEXT NOT NULL DEFAULT 'normal',
    assignee TEXT NOT NULL DEFAULT '',
    requester TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '[]',
    due_at TEXT,
    source TEXT NOT NULL DEFAULT '',        -- who/what created it (e.g. "ui", "assistant")
    external_ref TEXT,                      -- caller's idempotency key, unique per source
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    closed_at TEXT
  );
  CREATE UNIQUE INDEX tickets_source_ref ON tickets(source, external_ref) WHERE external_ref IS NOT NULL;
  CREATE INDEX tickets_open ON tickets(closed_at, updated_at);
  CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    at TEXT NOT NULL,
    actor TEXT NOT NULL,
    type TEXT NOT NULL,                     -- created | stage_changed | comment | updated
    data TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX events_ticket ON events(ticket_id, id);
  CREATE TABLE webhooks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT NOT NULL,
    secret TEXT NOT NULL,
    events TEXT NOT NULL DEFAULT '["*"]',
    created_at TEXT NOT NULL
  );
  `,
];

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  for (let v = row.user_version; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
  const has = db.prepare('SELECT COUNT(*) AS n FROM pipelines').get() as { n: number };
  if (has.n === 0) {
    db.prepare('INSERT INTO pipelines (id, name, stages, is_default) VALUES (?,?,?,1)').run(
      'it', 'IT ticket', JSON.stringify(DEFAULT_PIPELINE_STAGES),
    );
  }
  return db;
}
