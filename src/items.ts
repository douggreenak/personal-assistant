import { randomUUID } from 'node:crypto';
import { type Db, nowIso, ftsQuery } from './db.ts';

export type Kind = 'ticket' | 'reminder' | 'task';
export interface Item {
  id: string; kind: Kind; title: string; detail: string; state: 'open' | 'done' | 'dropped';
  stageId: string | null; stageLabel: string | null; dueAt: string | null; priority: string;
  backend: 'local' | 'ticketing' | 'canopy'; backendRef: string | null; classId: string | null; externalKey: string | null;
  sourceMessageId: number | null; createdAt: string; updatedAt: string;
  ackedAt: string | null; snoozeUntil: string | null; nextNagAt: string | null; nagCount: number;
}
export interface NewItem {
  kind: Kind; title: string; detail?: string; dueAt?: string | null; priority?: string;
  backend?: Item['backend']; backendRef?: string | null; classId?: string | null; externalKey?: string | null;
  stageId?: string | null; stageLabel?: string | null; sourceMessageId?: number | null;
}
type Row = Record<string, unknown>;

const toItem = (r: Row): Item => ({
  id: r.id as string, kind: r.kind as Kind, title: r.title as string, detail: r.detail as string, state: r.state as Item['state'],
  stageId: (r.stage_id as string) ?? null, stageLabel: (r.stage_label as string) ?? null, dueAt: (r.due_at as string) ?? null,
  priority: r.priority as string, backend: r.backend as Item['backend'], backendRef: (r.backend_ref as string) ?? null,
  classId: (r.class_id as string) ?? null, externalKey: (r.external_key as string) ?? null,
  sourceMessageId: (r.source_message_id as number) ?? null, createdAt: r.created_at as string, updatedAt: r.updated_at as string,
  ackedAt: (r.acked_at as string) ?? null, snoozeUntil: (r.snooze_until as string) ?? null,
  nextNagAt: (r.next_nag_at as string) ?? null, nagCount: r.nag_count as number,
});

const COLS: Record<string, string> = {
  title: 'title', detail: 'detail', state: 'state', stageId: 'stage_id', stageLabel: 'stage_label', dueAt: 'due_at',
  priority: 'priority', backendRef: 'backend_ref', ackedAt: 'acked_at', snoozeUntil: 'snooze_until', nextNagAt: 'next_nag_at', nagCount: 'nag_count',
};

export class ItemStore {
  db: Db;
  constructor(db: Db) { this.db = db; }

  create(n: NewItem, actor = 'assistant'): { item: Item; created: boolean } {
    if (n.externalKey) {
      const dup = this.db.prepare('SELECT * FROM items WHERE external_key = ?').get(n.externalKey) as Row | undefined;
      if (dup) return { item: toItem(dup), created: false };
    }
    const id = randomUUID(); const t = nowIso();
    // Reminders start nagging at their due time (or immediately if they have none).
    const nextNag = n.kind === 'reminder' ? (n.dueAt ?? t) : null;
    this.db.prepare(`INSERT INTO items (id, kind, title, detail, state, stage_id, stage_label, due_at, priority, backend, backend_ref, class_id, external_key, source_message_id, created_at, updated_at, next_nag_at)
      VALUES (?,?,?,?, 'open', ?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, n.kind, n.title, n.detail ?? '', n.stageId ?? null, n.stageLabel ?? null, n.dueAt ?? null, n.priority ?? 'normal',
      n.backend ?? 'local', n.backendRef ?? null, n.classId ?? null, n.externalKey ?? null, n.sourceMessageId ?? null, t, t, nextNag);
    this.event(id, actor, 'created', { kind: n.kind, backend: n.backend ?? 'local' });
    const item = this.get(id)!;
    this.index(item);
    return { item, created: true };
  }
  get(id: string): Item | undefined {
    const r = this.db.prepare('SELECT * FROM items WHERE id = ?').get(id) as Row | undefined;
    return r ? toItem(r) : undefined;
  }
  /** Finds an item by full id or unique id prefix (what people type in chat). */
  find(idOrPrefix: string): Item | undefined {
    const exact = this.get(idOrPrefix); if (exact) return exact;
    if (!/^[0-9a-f-]{4,}$/i.test(idOrPrefix)) return undefined;
    const rows = this.db.prepare("SELECT * FROM items WHERE id LIKE ? || '%' LIMIT 2").all(idOrPrefix) as Row[];
    return rows.length === 1 ? toItem(rows[0]) : undefined;
  }
  findByBackend(backend: string, ref: string): Item | undefined {
    const r = this.db.prepare('SELECT * FROM items WHERE backend = ? AND backend_ref = ?').get(backend, ref) as Row | undefined;
    return r ? toItem(r) : undefined;
  }
  list(f: { state?: string; kind?: string; limit?: number; hidePowerSchool?: boolean } = {}): Item[] {
    const w: string[] = []; const a: string[] = [];
    if (f.hidePowerSchool) w.push("(external_key IS NULL OR (external_key NOT LIKE 'canopy:ps%' AND external_key NOT LIKE 'canopy:missing:%'))");
    if (f.state && f.state !== 'all') { w.push('state = ?'); a.push(f.state); }
    if (f.kind) { w.push('kind = ?'); a.push(f.kind); }
    const sql = `SELECT * FROM items ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY COALESCE(due_at, '9999') , created_at LIMIT ${Math.min(f.limit ?? 200, 1000)}`;
    return (this.db.prepare(sql).all(...a) as Row[]).map(toItem);
  }
  patch(id: string, fields: Partial<Pick<Item, 'title' | 'detail' | 'state' | 'stageId' | 'stageLabel' | 'dueAt' | 'priority' | 'backendRef' | 'ackedAt' | 'snoozeUntil' | 'nextNagAt' | 'nagCount'>>, actor = 'assistant', evt?: { type: string; data?: Record<string, unknown> }): Item {
    const sets: string[] = []; const args: (string | number | null)[] = [];
    for (const [k, v] of Object.entries(fields)) {
      if (!(k in COLS)) continue;
      sets.push(`${COLS[k]} = ?`); args.push(v as string | number | null);
    }
    if (sets.length) this.db.prepare(`UPDATE items SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...args, nowIso(), id);
    if (evt) this.event(id, actor, evt.type, evt.data ?? fields as Record<string, unknown>);
    const item = this.get(id)!;
    this.index(item);
    return item;
  }
  event(itemId: string, actor: string, type: string, data: Record<string, unknown> = {}): void {
    this.db.prepare('INSERT INTO item_events (item_id, at, actor, type, data) VALUES (?,?,?,?,?)').run(itemId, nowIso(), actor, type, JSON.stringify(data));
  }
  events(itemId: string): { at: string; actor: string; type: string; data: unknown }[] {
    return (this.db.prepare('SELECT * FROM item_events WHERE item_id = ? ORDER BY id').all(itemId) as Row[]).map((e) => ({ at: e.at as string, actor: e.actor as string, type: e.type as string, data: JSON.parse(e.data as string) }));
  }
  private index(item: Item): void {
    this.db.prepare("DELETE FROM search WHERE kind = 'item' AND ref = ?").run(item.id);
    if (item.state === 'open') this.db.prepare("INSERT INTO search (kind, ref, title, body) VALUES ('item', ?, ?, ?)").run(item.id, item.title, item.detail);
  }
  /** Open items most likely to be touched by `text`: keyword matches first, topped up with the most recent. */
  candidates(text: string, limit = 25): Item[] {
    const out = new Map<string, Item>();
    const q = ftsQuery(text);
    if (q) {
      const refs = this.db.prepare("SELECT ref FROM search WHERE kind = 'item' AND search MATCH ? ORDER BY bm25(search) LIMIT ?").all(q, limit) as { ref: string }[];
      for (const r of refs) { const it = this.get(r.ref); if (it && it.state === 'open') out.set(it.id, it); }
    }
    if (out.size < limit) {
      for (const it of this.list({ state: 'open', limit: 200 }).reverse()) { if (out.size >= limit) break; out.set(it.id, it); }
    }
    return [...out.values()];
  }
}
