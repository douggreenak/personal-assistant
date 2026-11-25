import type { Ctx } from './ctx.ts';
import type { Item, Kind } from './items.ts';
import { toUtcIso } from './time.ts';

export type Flag = 'money' | 'others_deadline' | 'outbound' | 'uncertain';
export const FLAGS: Flag[] = ['money', 'others_deadline', 'outbound', 'uncertain'];

/** What the model is allowed to ask for. Everything else is impossible by construction. */
export interface Action {
  op: 'create' | 'update' | 'stage' | 'complete' | 'drop';
  kind?: Kind; title?: string; detail?: string; dueAt?: string; priority?: 'low' | 'normal' | 'high' | 'urgent';
  classHint?: string;            // a school class name → lands in Canopy
  itemId?: string; stageId?: string;
  confidence: number; flags: Flag[]; why: string;
}

export const ACTIONS_SCHEMA = {
  type: 'object',
  properties: {
    actions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          op: { type: 'string', enum: ['create', 'update', 'stage', 'complete', 'drop'] },
          kind: { type: 'string', enum: ['ticket', 'reminder', 'task'] },
          title: { type: 'string' }, detail: { type: 'string' }, dueAt: { type: 'string' },
          priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] },
          classHint: { type: 'string' }, itemId: { type: 'string' }, stageId: { type: 'string' },
          confidence: { type: 'number' },
          flags: { type: 'array', items: { type: 'string', enum: FLAGS } },
          why: { type: 'string' },
        },
        required: ['op', 'confidence', 'flags', 'why'],
      },
    },
  },
  required: ['actions'],
} as const;

/** Validates untrusted model output into Actions, dropping anything malformed. */
export function parseActions(raw: unknown, knownItemIds: Set<string>): { actions: Action[]; rejected: string[] } {
  const actions: Action[] = []; const rejected: string[] = [];
  const arr = (raw as { actions?: unknown })?.actions;
  if (!Array.isArray(arr)) return { actions, rejected: ['no actions array'] };
  for (const a of arr.slice(0, 20) as Record<string, unknown>[]) {
    const op = a?.op;
    if (!['create', 'update', 'stage', 'complete', 'drop'].includes(op as string)) { rejected.push(`bad op ${String(op)}`); continue; }
    const conf = typeof a.confidence === 'number' ? Math.min(1, Math.max(0, a.confidence)) : 0;
    const flags = (Array.isArray(a.flags) ? a.flags : []).filter((f): f is Flag => FLAGS.includes(f as Flag));
    const s = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
    const act: Action = {
      op: op as Action['op'], confidence: conf, flags, why: s(a.why, 300) ?? '',
      kind: (['ticket', 'reminder', 'task'] as const).find((k) => k === a.kind), title: s(a.title, 300), detail: s(a.detail, 4000),
      dueAt: s(a.dueAt, 40), classHint: s(a.classHint, 80), stageId: s(a.stageId, 60),
      priority: (['low', 'normal', 'high', 'urgent'] as const).find((p) => p === a.priority),
      itemId: s(a.itemId, 64),
    };
    if (act.op === 'create') {
      if (!act.title) { rejected.push('create without title'); continue; }
      act.kind ??= 'task';
    } else {
      if (!act.itemId || !knownItemIds.has(act.itemId)) { rejected.push(`${act.op} on unknown item ${act.itemId}`); continue; }
      if (act.op === 'stage' && !act.stageId) { rejected.push('stage without stageId'); continue; }
    }
    actions.push(act);
  }
  return { actions, rejected };
}

export interface ApplyResult { summary: string; item?: Item }

/** Applies an approved/allowed action: calls the backend first, then mirrors into the local store. */
export async function applyAction(ctx: Ctx, a: Action, sourceMessageId: number | null, actor = 'assistant'): Promise<ApplyResult> {
  const { items, ticketing, canopy, cfg } = ctx;
  const due = toUtcIso(a.dueAt, cfg.tz);

  if (a.op === 'create') {
    const base = { title: a.title!, detail: a.detail ?? '', dueAt: due, priority: a.priority ?? 'normal', sourceMessageId };
    // School work goes to Canopy as a task attached to the matching class.
    if (a.classHint && canopy) {
      const cls = await canopy.resolveClass(a.classHint);
      if (cls) {
        const t = await canopy.createTask({ title: a.title!, description: a.detail, dueDate: due ? localDate(a.dueAt!, due, cfg.tz) : undefined, priority: a.priority === 'urgent' ? 'high' : (a.priority === 'normal' ? 'medium' : a.priority), classId: cls.id });
        const { item } = items.create({ ...base, kind: 'task', backend: 'canopy', backendRef: t.id, classId: cls.id }, actor);
        return { summary: `Added to Canopy (${cls.name}): ${a.title}`, item };
      }
      base.detail = `${base.detail}\n(No Canopy class matched "${a.classHint}")`.trim();
    }
    if (a.kind === 'ticket' && ticketing) {
      const p = await ticketing.defaultPipeline();
      const ref = `msg-${sourceMessageId ?? 'x'}-${(a.title ?? '').toLowerCase().replace(/\W+/g, '-').slice(0, 40)}`;
      const t = await ticketing.create({ title: a.title!, description: a.detail, priority: a.priority, dueAt: due, externalRef: ref });
      const stage = p.stages.find((s) => s.id === t.stageId);
      const { item } = items.create({ ...base, kind: 'ticket', backend: 'ticketing', backendRef: String(t.id), stageId: t.stageId, stageLabel: stage?.label ?? t.stageLabel, externalKey: `ticketing:${t.id}` }, actor);
      return { summary: `Ticket #${t.id}: ${a.title}`, item };
    }
    const { item } = items.create({ ...base, kind: a.kind === 'ticket' ? 'task' : a.kind! }, actor);
    return { summary: `${item.kind === 'reminder' ? 'Reminder' : 'Task'}: ${a.title}${due ? ` (due ${due.slice(0, 16).replace('T', ' ')}Z)` : ''}`, item };
  }

  const item = items.get(a.itemId!);
  if (!item || item.state !== 'open') return { summary: `Skipped: item no longer open (${a.itemId?.slice(0, 8)})` };

  if (a.op === 'update') {
    const f: Record<string, unknown> = {};
    if (a.title) f.title = a.title;
    if (a.detail) f.detail = a.detail;
    if (a.priority) f.priority = a.priority;
    if (due) f.dueAt = due;
    if (item.backend === 'ticketing' && ticketing) await ticketing.patch(item.backendRef!, { ...(a.title && { title: a.title }), ...(a.detail && { description: a.detail }), ...(a.priority && { priority: a.priority }), ...(due && { dueAt: due }) });
    if (item.backend === 'canopy' && canopy) await canopy.patchTask(item.backendRef!, { ...(a.title && { title: a.title }), ...(a.detail && { description: a.detail }), ...(due && { dueDate: localDate(a.dueAt!, due, cfg.tz) }) });
    const up = items.patch(item.id, { ...f, ...(due && item.kind === 'reminder' ? { nextNagAt: due, nagCount: 0, ackedAt: null } : {}) } as never, actor, { type: 'updated', data: { ...f, why: a.why } });
    return { summary: `Updated: ${up.title}`, item: up };
  }

  if (a.op === 'stage') {
    if (item.backend !== 'ticketing' || !ticketing) return { summary: `Skipped: "${item.title}" is not a ticket` };
    const p = await ticketing.defaultPipeline();
    const stage = p.stages.find((s) => s.id === a.stageId);
    if (!stage) return { summary: `Skipped: unknown stage "${a.stageId}"` };
    await ticketing.setStage(item.backendRef!, stage.id);
    const last = p.stages[p.stages.length - 1].id === stage.id;
    const up = items.patch(item.id, { stageId: stage.id, stageLabel: stage.label, ...(last ? { state: 'done' as const, nextNagAt: null } : {}) }, actor, { type: 'stage', data: { to: stage.id, why: a.why } });
    return { summary: `Ticket "${up.title}" → ${stage.label}`, item: up };
  }

  if (a.op === 'complete' || a.op === 'drop') {
    const done = a.op === 'complete';
    if (item.backend === 'ticketing' && ticketing) {
      const p = await ticketing.defaultPipeline();
      await ticketing.setStage(item.backendRef!, p.stages[p.stages.length - 1].id);
    }
    if (item.backend === 'canopy' && canopy) {
      await canopy.patchTask(item.backendRef!, { completed: true }); // Canopy tasks have no "dropped"; closing is the closest equivalent
    }
    const up = items.patch(item.id, { state: done ? 'done' : 'dropped', nextNagAt: null }, actor, { type: done ? 'completed' : 'dropped', data: { why: a.why } });
    return { summary: `${done ? 'Done' : 'Dropped'}: ${up.title}`, item: up };
  }
  return { summary: 'Nothing to do' };
}

/** YYYY-MM-DD of an instant in the user's zone, honoring a date-only input as written. */
function localDate(raw: string, utcIso: string, tz: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(utcIso));
}

export function describeAction(a: Action, item?: Item): string {
  const t = item?.title ?? a.title ?? '';
  switch (a.op) {
    case 'create': return `Create ${a.kind}: "${a.title}"${a.dueAt ? ` due ${a.dueAt}` : ''}${a.classHint ? ` in ${a.classHint}` : ''}`;
    case 'update': return `Update "${t}"${a.title ? ` → "${a.title}"` : ''}${a.dueAt ? ` due ${a.dueAt}` : ''}`;
    case 'stage': return `Move "${t}" to stage ${a.stageId}`;
    case 'complete': return `Mark done: "${t}"`;
    case 'drop': return `Drop: "${t}"`;
  }
}
