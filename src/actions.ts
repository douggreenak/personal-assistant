import type { Ctx } from './ctx.ts';
import type { Item, Kind } from './items.ts';
import { toUtcIso } from './time.ts';

export type Flag = 'money' | 'others_deadline' | 'outbound' | 'uncertain';
export const FLAGS: Flag[] = ['money', 'others_deadline', 'outbound', 'uncertain'];

/** What the model is allowed to ask for. Everything else is impossible by construction. */
export interface Action {
  op: 'create' | 'update' | 'stage' | 'complete' | 'drop' | 'connector_call';
  kind?: Kind; title?: string; detail?: string; dueAt?: string; priority?: 'low' | 'normal' | 'high' | 'urgent';
  classHint?: string;            // a school class name → lands in Canopy
  itemId?: string; stageId?: string;
  connectorId?: string; actionId?: string; args?: Record<string, string>;   // op 'connector_call': a WRITE through a connector the owner set up
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
          op: { type: 'string', enum: ['create', 'update', 'stage', 'complete', 'drop', 'connector_call'] },
          connectorId: { type: 'string' }, actionId: { type: 'string' }, args: { type: 'object', additionalProperties: { type: 'string' } },
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
export function parseActions(raw: unknown, knownItemIds: Set<string>, connectorActions: Map<string, { action: { params: { name: string; required?: boolean }[] } }> = new Map()): { actions: Action[]; rejected: string[] } {
  const actions: Action[] = []; const rejected: string[] = [];
  const arr = (raw as { actions?: unknown })?.actions;
  if (!Array.isArray(arr)) return { actions, rejected: ['no actions array'] };
  for (const a of arr.slice(0, 20) as Record<string, unknown>[]) {
    const op = a?.op;
    if (!['create', 'update', 'stage', 'complete', 'drop', 'connector_call'].includes(op as string)) { rejected.push(`bad op ${String(op)}`); continue; }
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
    if (act.op === 'connector_call') {
      const known = connectorActions.get(`${String(a.connectorId)}.${String(a.actionId)}`);
      if (!known) { rejected.push(`unknown connector action ${String(a.connectorId)}.${String(a.actionId)}`); continue; }
      const given = (a.args && typeof a.args === 'object' ? a.args : {}) as Record<string, unknown>; const args: Record<string, string> = {};
      for (const p of known.action.params) if (given[p.name] !== undefined && given[p.name] !== null) args[p.name] = String(given[p.name]).slice(0, 4000);
      const missing = known.action.params.find((p) => p.required && !args[p.name]?.trim());
      if (missing) { rejected.push(`${String(a.connectorId)}.${String(a.actionId)} missing "${missing.name}"`); continue; }
      act.connectorId = String(a.connectorId); act.actionId = String(a.actionId); act.args = args;
    } else if (act.op === 'create') {
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

  if (a.op === 'connector_call') {
    const { callConnectorAction } = await import('./connectors.ts');   // dynamic: connectors.ts imports the pipeline, which imports this file
    const summary = await callConnectorAction(ctx, a.connectorId!, a.actionId!, a.args ?? {});
    (await import('./calls.ts')).noteCall(ctx, a);
    return { summary };
  }

  const item = items.get(a.itemId!);
  if (!item || item.state !== 'open') return { summary: 'Skipped: that item is no longer open' };

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

/** {"scheduled":"{\"date\":\"2026-11-26\",\"stops\":[\"Fred Meyer\"]}"} → date 2026-11-26, stops Fred Meyer (values that are themselves JSON are opened up). */
export function plainArgs(args: Record<string, unknown>): string {
  const flat = (v: unknown): string => {
    if (typeof v === 'string') { const t = v.trim(); if (/^[[{]/.test(t)) { try { return flat(JSON.parse(t)); } catch { /* plain text */ } } return t; }
    if (Array.isArray(v)) return v.map(flat).join(', ');
    if (v && typeof v === 'object') return Object.entries(v).filter(([, x]) => x !== '' && x != null).map(([k, x]) => `${k.replace(/_/g, ' ')} ${flat(x)}`).join(', ');
    return String(v ?? '');
  };
  const isJson = (v: unknown): boolean => typeof v === 'string' && /^\s*[[{]/.test(v) && (() => { try { JSON.parse(v); return true; } catch { return false; } })();
  return Object.entries(args).filter(([, v]) => v !== '' && v != null).map(([k, v]) => (isJson(v) ? flat(v) : `${k.replace(/_/g, ' ')} ${flat(v)}`)).join(', ');
}
export function describeAction(a: Action, item?: Item): string {
  const t = item?.title ?? a.title ?? '';
  switch (a.op) {
    case 'create': return `Create ${a.kind}: "${a.title}"${a.dueAt ? ` due ${a.dueAt}` : ''}${a.classHint ? ` in ${a.classHint}` : ''}`;
    case 'update': { const ch = [a.title ? `rename to "${a.title}"` : '', a.dueAt ? `due ${a.dueAt}` : '', a.priority ? `priority ${a.priority}` : '', a.detail ? `note: ${a.detail.replace(/\s+/g, ' ').slice(0, 200)}` : ''].filter(Boolean); return `Update "${t}"${ch.length ? ' — ' + ch.join('; ') : ''}`; }
    case 'stage': return `Move "${t}" to stage ${a.stageId}`;
    case 'complete': return `Mark done: "${t}"`;
    case 'drop': return `Drop: "${t}"`;
    case 'connector_call': return `${String(a.connectorId).replace(/[-_]+/g, ' ')} › ${String(a.actionId).replace(/[-_]+/g, ' ')}: ${plainArgs(a.args ?? {}) || 'no details'}`.slice(0, 400);
  }
}
