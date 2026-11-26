import type { Ctx } from '../ctx.ts';

/** Mirrors changes made in the Ticketing UI (stage moves, closes) into the Assistant's item list. */
export function applyTicketingEvent(ctx: Ctx, ev: { type: string; data: Record<string, any> }): boolean { // eslint-disable-line @typescript-eslint/no-explicit-any
  const t = (ev.data?.ticket ?? ev.data) as { id?: number; stageId?: string; stageLabel?: string; open?: boolean; title?: string } | undefined;
  if (!t?.id) return false;
  const item = ctx.items.findByBackend('ticketing', String(t.id));
  if (!item) return false;
  if (ev.type === 'ticket.deleted') { ctx.items.patch(item.id, { state: 'dropped' }, 'ticketing', { type: 'dropped' }); return true; }
  if (!['ticket.stage_changed', 'ticket.closed', 'ticket.reopened', 'ticket.updated'].includes(ev.type)) return false;
  ctx.items.patch(item.id, {
    stageId: t.stageId ?? item.stageId, stageLabel: t.stageLabel ?? item.stageLabel, ...(t.title ? { title: t.title } : {}),
    state: t.open === false ? 'done' : 'open',
  }, 'ticketing', { type: 'stage', data: { to: t.stageId, via: 'ticketing webhook' } });
  return true;
}
