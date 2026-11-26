import type { Ctx } from './ctx.ts';
import { nowIso } from './db.ts';
import type { Item } from './items.ts';
import { inQuietHours, quietEndsAt } from './time.ts';

export const shortId = (id: string): string => id.slice(0, 6);

/** Minutes until the next nag after `count` nags have been sent; the last configured gap repeats forever. */
export function nagGapMinutes(count: number, gaps: number[]): number {
  const g = gaps.length ? gaps : [30];
  return g[Math.min(Math.max(count - 1, 0), g.length - 1)];
}

/**
 * Sends every reminder that is due and not acknowledged, then schedules the next nag.
 * Quiet hours hold nags until they end — except urgent reminders, which always go through.
 */
export async function nagTick(ctx: Ctx): Promise<number> {
  const now = ctx.now(); const iso = now.toISOString(); let sent = 0;
  const due = ctx.db.prepare(`SELECT id FROM items WHERE kind = 'reminder' AND state = 'open' AND acked_at IS NULL
    AND next_nag_at IS NOT NULL AND next_nag_at <= ? AND (snooze_until IS NULL OR snooze_until <= ?) ORDER BY next_nag_at`).all(iso, iso) as { id: string }[];
  for (const { id } of due) {
    const it = ctx.items.get(id)!;
    if (it.priority !== 'urgent' && inQuietHours(now, ctx.cfg.tz, ctx.cfg.quietHours)) {
      ctx.items.patch(id, { nextNagAt: quietEndsAt(now, ctx.cfg.tz, ctx.cfg.quietHours).toISOString() });
      continue;
    }
    const n = it.nagCount + 1;
    await ctx.notify.send(nagText(it, n), { urgent: it.priority === 'urgent' || it.priority === 'high', itemId: id });
    ctx.items.patch(id, { nagCount: n, nextNagAt: new Date(now.getTime() + nagGapMinutes(n, ctx.cfg.nagMinutes) * 60000).toISOString(), snoozeUntil: null }, 'nag', { type: 'nagged', data: { n } });
    sent++;
  }
  return sent;
}

const nagText = (it: Item, n: number): string =>
  `${n === 1 ? 'Reminder:' : n < 4 ? 'Reminder, again:' : 'URGENT:'} ${it.title}${n > 1 ? ` (reminder #${n})` : ''}\n   reply "ack ${shortId(it.id)}" when handled, or "snooze ${shortId(it.id)} 1h"`;

export function ack(ctx: Ctx, it: Item, by = 'owner'): Item {
  return ctx.items.patch(it.id, { ackedAt: nowIso(), nextNagAt: null, ...(it.kind === 'reminder' ? { state: 'done' as const } : {}) }, by, { type: 'acknowledged' });
}

/** "10m", "2h", "1d", "tomorrow" → absolute time; null if not understood. */
export function parseSnooze(text: string, now: Date, tz: string, quiet: { start: number; end: number }): Date | null {
  const t = text.trim().toLowerCase();
  const m = /^(\d+)\s*(m|min|mins|minutes?|h|hrs?|hours?|d|days?)$/.exec(t);
  if (m) {
    const n = Number(m[1]); const u = m[2][0];
    return new Date(now.getTime() + n * (u === 'm' ? 60000 : u === 'h' ? 3600000 : 86400000));
  }
  if (t === 'tomorrow' || t === 'later') {
    const d = new Date(now.getTime() + (t === 'later' ? 3 : 24) * 3600000);
    return inQuietHours(d, tz, quiet) ? quietEndsAt(d, tz, quiet) : d;
  }
  return null;
}

export function snooze(ctx: Ctx, it: Item, until: Date, by = 'owner'): Item {
  return ctx.items.patch(it.id, { snoozeUntil: until.toISOString(), nextNagAt: until.toISOString() }, by, { type: 'snoozed', data: { until: until.toISOString() } });
}
