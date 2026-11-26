import type { Db } from './db.ts';
import { HttpError } from './errors.ts';

export interface Stage { id: string; label: string }
export interface Pipeline { id: string; name: string; stages: Stage[]; isDefault: boolean }
export const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type Priority = (typeof PRIORITIES)[number];

export interface Ticket {
  id: number; title: string; description: string; pipelineId: string; stageId: string;
  stageLabel: string; stageIndex: number; stageCount: number; open: boolean;
  priority: Priority; assignee: string; requester: string; category: string; tags: string[];
  dueAt: string | null; source: string; externalRef: string | null;
  createdAt: string; updatedAt: string; closedAt: string | null;
}
export interface TicketEvent { id: number; ticketId: number; at: string; actor: string; type: string; data: Record<string, unknown> }
export type Emit = (type: string, payload: unknown) => void;

type Row = Record<string, unknown>;
const now = () => new Date().toISOString();
const str = (v: unknown, field: string, max: number, required = false): string | undefined => {
  if (v === undefined || v === null) {
    if (required) throw new HttpError(400, `${field} is required.`);
    return undefined;
  }
  if (typeof v !== 'string' || v.length > max || (required && !v.trim())) throw new HttpError(400, `${field} must be a string (max ${max} chars).`);
  return v.trim();
};

export function parseStages(v: unknown): Stage[] {
  if (!Array.isArray(v) || v.length < 2 || v.length > 20) throw new HttpError(400, 'stages must be an array of 2–20 {id,label}.');
  const seen = new Set<string>();
  return v.map((s) => {
    const id = (s as Stage)?.id, label = (s as Stage)?.label;
    if (typeof id !== 'string' || !/^[a-z0-9_]{1,40}$/.test(id)) throw new HttpError(400, 'stage id must match [a-z0-9_]{1,40}.');
    if (typeof label !== 'string' || !label.trim() || label.length > 60) throw new HttpError(400, 'stage label required (max 60 chars).');
    if (seen.has(id)) throw new HttpError(400, 'stage ids must be unique.');
    seen.add(id);
    return { id, label: label.trim() };
  });
}

export class TicketService {
  db: Db;
  emit: Emit;
  constructor(db: Db, emit: Emit = () => {}) { this.db = db; this.emit = emit; }

  // ---- pipelines ----
  private pipelineFromRow(r: Row): Pipeline {
    return { id: r.id as string, name: r.name as string, stages: JSON.parse(r.stages as string), isDefault: !!r.is_default };
  }
  listPipelines(): Pipeline[] {
    return (this.db.prepare('SELECT * FROM pipelines ORDER BY is_default DESC, name').all() as Row[]).map((r) => this.pipelineFromRow(r));
  }
  getPipeline(id: string): Pipeline {
    const r = this.db.prepare('SELECT * FROM pipelines WHERE id = ?').get(id) as Row | undefined;
    if (!r) throw new HttpError(404, 'Pipeline not found.');
    return this.pipelineFromRow(r);
  }
  createPipeline(input: Row): Pipeline {
    const id = str(input.id, 'id', 40, true)!;
    if (!/^[a-z0-9_-]+$/.test(id)) throw new HttpError(400, 'id must match [a-z0-9_-]+.');
    const name = str(input.name, 'name', 80, true)!;
    const stages = parseStages(input.stages);
    try {
      this.db.prepare('INSERT INTO pipelines (id, name, stages) VALUES (?,?,?)').run(id, name, JSON.stringify(stages));
    } catch { throw new HttpError(409, 'A pipeline with that id or name already exists.'); }
    return this.getPipeline(id);
  }
  /** Rename and/or change stages. A stage that tickets currently sit in cannot be removed. */
  updatePipeline(id: string, input: Row): Pipeline {
    const cur = this.getPipeline(id);
    const name = str(input.name, 'name', 80) ?? cur.name;
    const stages = input.stages === undefined ? cur.stages : parseStages(input.stages);
    const keep = new Set(stages.map((s) => s.id));
    const used = this.db.prepare('SELECT DISTINCT stage_id FROM tickets WHERE pipeline_id = ?').all(id) as { stage_id: string }[];
    const missing = used.filter((u) => !keep.has(u.stage_id)).map((u) => u.stage_id);
    if (missing.length) throw new HttpError(409, `Tickets are still in stage(s): ${missing.join(', ')}. Move them first.`);
    this.db.prepare('UPDATE pipelines SET name = ?, stages = ? WHERE id = ?').run(name, JSON.stringify(stages), id);
    // Closing semantics follow the last stage; recompute closed_at when the last stage changed.
    const last = stages[stages.length - 1].id;
    this.db.prepare('UPDATE tickets SET closed_at = NULL WHERE pipeline_id = ? AND stage_id != ?').run(id, last);
    this.db.prepare('UPDATE tickets SET closed_at = COALESCE(closed_at, ?) WHERE pipeline_id = ? AND stage_id = ?').run(now(), id, last);
    return this.getPipeline(id);
  }

  // ---- tickets ----
  private ticketFromRow(r: Row, p: Pipeline): Ticket {
    const idx = p.stages.findIndex((s) => s.id === r.stage_id);
    return {
      id: r.id as number, title: r.title as string, description: r.description as string,
      pipelineId: r.pipeline_id as string, stageId: r.stage_id as string,
      stageLabel: p.stages[idx]?.label ?? (r.stage_id as string), stageIndex: idx, stageCount: p.stages.length,
      open: r.closed_at === null, priority: r.priority as Priority, assignee: r.assignee as string,
      requester: r.requester as string, category: r.category as string, tags: JSON.parse(r.tags as string),
      dueAt: (r.due_at as string) ?? null, source: r.source as string, externalRef: (r.external_ref as string) ?? null,
      createdAt: r.created_at as string, updatedAt: r.updated_at as string, closedAt: (r.closed_at as string) ?? null,
    };
  }
  private hydrate(rows: Row[]): Ticket[] {
    const cache = new Map<string, Pipeline>();
    return rows.map((r) => {
      let p = cache.get(r.pipeline_id as string);
      if (!p) { p = this.getPipeline(r.pipeline_id as string); cache.set(p.id, p); }
      return this.ticketFromRow(r, p);
    });
  }
  getTicket(id: number): Ticket {
    const r = this.db.prepare('SELECT * FROM tickets WHERE id = ?').get(id) as Row | undefined;
    if (!r) throw new HttpError(404, 'Ticket not found.');
    return this.hydrate([r])[0];
  }
  listTickets(f: { status?: string; q?: string; stage?: string; priority?: string; pipeline?: string; assignee?: string; limit?: number }): Ticket[] {
    const where: string[] = []; const args: (string | number)[] = [];
    const status = f.status ?? 'open';
    if (status === 'open') where.push('closed_at IS NULL');
    else if (status === 'closed') where.push('closed_at IS NOT NULL');
    else if (status !== 'all') throw new HttpError(400, 'status must be open, closed or all.');
    if (f.q) {
      const like = `%${f.q.replace(/[\\%_]/g, '\\$&')}%`;
      where.push(`(title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\' OR requester LIKE ? ESCAPE '\\')`);
      args.push(like, like, like, like);
    }
    if (f.stage) { where.push('stage_id = ?'); args.push(f.stage); }
    if (f.priority) { where.push('priority = ?'); args.push(f.priority); }
    if (f.pipeline) { where.push('pipeline_id = ?'); args.push(f.pipeline); }
    if (f.assignee) { where.push('assignee = ?'); args.push(f.assignee); }
    const limit = Math.min(Math.max(f.limit ?? 200, 1), 1000);
    const sql = `SELECT * FROM tickets ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, updated_at DESC LIMIT ${limit}`;
    return this.hydrate(this.db.prepare(sql).all(...args) as Row[]);
  }
  listEvents(ticketId: number): TicketEvent[] {
    return (this.db.prepare('SELECT * FROM events WHERE ticket_id = ? ORDER BY id').all(ticketId) as Row[]).map((e) => ({
      id: e.id as number, ticketId: e.ticket_id as number, at: e.at as string, actor: e.actor as string,
      type: e.type as string, data: JSON.parse(e.data as string),
    }));
  }
  private addEvent(ticketId: number, actor: string, type: string, data: Record<string, unknown>): void {
    this.db.prepare('INSERT INTO events (ticket_id, at, actor, type, data) VALUES (?,?,?,?,?)').run(ticketId, now(), actor, type, JSON.stringify(data));
  }
  private checkFields(input: Row, partial: boolean) {
    const out: Record<string, unknown> = {};
    const title = str(input.title, 'title', 300, !partial); if (title !== undefined) out.title = title;
    const description = str(input.description, 'description', 20000); if (description !== undefined) out.description = description;
    for (const [k, max] of [['assignee', 100], ['requester', 100], ['category', 100]] as const) {
      const v = str(input[k], k, max); if (v !== undefined) out[k] = v;
    }
    if (input.priority !== undefined) {
      if (!PRIORITIES.includes(input.priority as Priority)) throw new HttpError(400, `priority must be one of ${PRIORITIES.join(', ')}.`);
      out.priority = input.priority;
    }
    if (input.tags !== undefined) {
      if (!Array.isArray(input.tags) || input.tags.length > 30 || input.tags.some((t) => typeof t !== 'string' || !t.trim() || t.length > 50)) throw new HttpError(400, 'tags must be up to 30 short strings.');
      out.tags = [...new Set((input.tags as string[]).map((t) => t.trim()))];
    }
    if (input.dueAt !== undefined) {
      if (input.dueAt !== null && (typeof input.dueAt !== 'string' || Number.isNaN(Date.parse(input.dueAt)))) throw new HttpError(400, 'dueAt must be an ISO date/time or null.');
      out.dueAt = input.dueAt;
    }
    return out;
  }

  /** Creates a ticket. If `source` + `externalRef` match an existing ticket, returns it (created=false) — safe to retry. */
  createTicket(input: Row, actor = 'api'): { ticket: Ticket; created: boolean } {
    const f = this.checkFields(input, false);
    const source = str(input.source, 'source', 50) ?? '';
    const externalRef = str(input.externalRef, 'externalRef', 200) || null;
    if (externalRef) {
      const dup = this.db.prepare('SELECT id FROM tickets WHERE source = ? AND external_ref = ?').get(source, externalRef) as { id: number } | undefined;
      if (dup) return { ticket: this.getTicket(dup.id), created: false };
    }
    const pipeline = input.pipelineId === undefined
      ? (this.db.prepare('SELECT id FROM pipelines WHERE is_default = 1').get() as { id: string }).id
      : (str(input.pipelineId, 'pipelineId', 40, true) as string);
    const p = this.getPipeline(pipeline);
    let stageId = p.stages[0].id;
    if (input.stageId !== undefined) {
      if (!p.stages.some((s) => s.id === input.stageId)) throw new HttpError(400, 'stageId is not in that pipeline.');
      stageId = input.stageId as string;
    }
    const t = now();
    const closed = stageId === p.stages[p.stages.length - 1].id ? t : null;
    const res = this.db.prepare(`INSERT INTO tickets (title, description, pipeline_id, stage_id, priority, assignee, requester, category, tags, due_at, source, external_ref, created_at, updated_at, closed_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      f.title as string, (f.description as string) ?? '', p.id, stageId, (f.priority as string) ?? 'normal',
      (f.assignee as string) ?? '', (f.requester as string) ?? '', (f.category as string) ?? '',
      JSON.stringify(f.tags ?? []), (f.dueAt as string) ?? null, source, externalRef, t, t, closed,
    );
    const id = Number(res.lastInsertRowid);
    this.addEvent(id, actor, 'created', { stageId });
    const ticket = this.getTicket(id);
    this.emit('ticket.created', ticket);
    return { ticket, created: true };
  }

  updateTicket(id: number, input: Row, actor = 'api'): Ticket {
    const before = this.getTicket(id);
    const f = this.checkFields(input, true);
    if (input.stageId !== undefined) return this.setStage(id, input.stageId as string, actor, f);
    return this.applyFields(before, f, actor);
  }

  private applyFields(before: Ticket, f: Record<string, unknown>, actor: string): Ticket {
    const map: Record<string, string> = { title: 'title', description: 'description', priority: 'priority', assignee: 'assignee', requester: 'requester', category: 'category', tags: 'tags', dueAt: 'due_at' };
    const sets: string[] = []; const args: (string | number | null)[] = []; const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const [k, col] of Object.entries(map)) {
      if (!(k in f)) continue;
      const cur = (before as unknown as Record<string, unknown>)[k];
      if (JSON.stringify(cur) === JSON.stringify(f[k])) continue;
      changes[k] = { from: cur, to: f[k] };
      sets.push(`${col} = ?`); args.push(k === 'tags' ? JSON.stringify(f[k]) : (f[k] as string | null));
    }
    if (!sets.length) return before;
    this.db.prepare(`UPDATE tickets SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...args, now(), before.id);
    this.addEvent(before.id, actor, 'updated', { changes });
    const after = this.getTicket(before.id);
    this.emit('ticket.updated', { ticket: after, changes });
    return after;
  }

  /** Move to any stage in the ticket's pipeline (forward or back). Landing on the last stage closes it; leaving reopens it. */
  setStage(id: number, stageId: string, actor = 'api', extra: Record<string, unknown> = {}): Ticket {
    const t = this.getTicket(id);
    const p = this.getPipeline(t.pipelineId);
    if (!p.stages.some((s) => s.id === stageId)) throw new HttpError(400, `stage must be one of: ${p.stages.map((s) => s.id).join(', ')}.`);
    let cur = t;
    if (Object.keys(extra).length) cur = this.applyFields(t, extra, actor);
    if (stageId === t.stageId) return cur;
    const isLast = stageId === p.stages[p.stages.length - 1].id;
    const ts = now();
    this.db.prepare('UPDATE tickets SET stage_id = ?, closed_at = ?, updated_at = ? WHERE id = ?').run(stageId, isLast ? ts : null, ts, id);
    this.addEvent(id, actor, 'stage_changed', { from: t.stageId, to: stageId });
    const after = this.getTicket(id);
    this.emit('ticket.stage_changed', { ticket: after, from: t.stageId, to: stageId });
    if (isLast) this.emit('ticket.closed', after);
    else if (!t.open) this.emit('ticket.reopened', after);
    return after;
  }

  addComment(id: number, body: unknown, actor = 'api'): TicketEvent {
    this.getTicket(id);
    const text = str(body, 'body', 20000, true)!;
    this.addEvent(id, actor, 'comment', { body: text });
    this.db.prepare('UPDATE tickets SET updated_at = ? WHERE id = ?').run(now(), id);
    const ev = this.listEvents(id).at(-1)!;
    this.emit('ticket.commented', { ticketId: id, event: ev });
    return ev;
  }

  deleteTicket(id: number): void {
    const t = this.getTicket(id);
    this.db.prepare('DELETE FROM tickets WHERE id = ?').run(id);
    this.emit('ticket.deleted', t);
  }
}
