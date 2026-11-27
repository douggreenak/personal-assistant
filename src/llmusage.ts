import type { Ctx } from './ctx.ts';
import type { LlmUsage } from './llm.ts';
import type { Db } from './db.ts';
import { kvGet, kvSet } from './db.ts';

/** Every Claude call is logged here (tokens and estimated cost as reported by Claude Code), so usage can be seen and capped. */
export function recordUsage(db: Db, u: LlmUsage, at = new Date()): void {
  db.prepare('INSERT INTO llm_usage (at, purpose, model, input, output, cache_read, cache_write, cost, ms, chars, ok) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run(at.toISOString(), u.purpose, u.model, u.input, u.output, u.cacheRead, u.cacheWrite, u.cost, u.ms, u.chars, u.ok ? 1 : 0);
}
/** A message the pre-filter kept away from the model (a saved call). */
export const recordFiltered = (db: Db, why: string, at = new Date()): void => recordUsage(db, { purpose: 'filtered:' + why, model: '', input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, ms: 0, chars: 0, ok: true }, at);

const DAY = 86400_000;
/** Background reading (mail and other outside sources) is capped per rolling 24 hours; the owner's own chats and questions never are. */
export function backgroundBudget(ctx: Ctx): { used: number; limit: number; left: number; open: boolean } {
  const limit = ctx.cfg.llm.backgroundCallsPerDay;
  const used = (ctx.db.prepare("SELECT COUNT(*) AS n FROM llm_usage WHERE purpose = 'extract-bg' AND at > ?").get(new Date(ctx.now().getTime() - DAY).toISOString()) as { n: number }).n;
  return { used, limit, left: limit ? Math.max(0, limit - used) : Infinity, open: !limit || used < limit };
}
/** Once per day, when the cap stops background reading, the owner is told (and how to raise it). Returns true when a notice was due. */
export async function noteBudgetHit(ctx: Ctx): Promise<boolean> {
  const day = ctx.now().toISOString().slice(0, 10); if (kvGet(ctx.db, 'llm.budget.notified') === day) return false;
  kvSet(ctx.db, 'llm.budget.notified', day); const b = backgroundBudget(ctx);
  await ctx.notify.send(`I have read ${b.used} incoming messages in the last 24 hours, which is my daily limit, so newer mail will wait until the count drops. Your own chats still work. You can raise the limit in Settings (Daily limit for background reading).`).catch(() => {});
  return true;
}

export interface UsageSummary { since: string; calls: number; failed: number; input: number; output: number; cacheRead: number; cost: number; filtered: number; byPurpose: { purpose: string; calls: number; tokens: number; cost: number }[]; budget: ReturnType<typeof backgroundBudget>; days: { day: string; calls: number; tokens: number; cost: number }[] }
export function usageSummary(ctx: Ctx, hours = 24): UsageSummary {
  const since = new Date(ctx.now().getTime() - hours * 3600_000).toISOString();
  const rows = ctx.db.prepare("SELECT purpose, COUNT(*) AS calls, SUM(ok = 0) AS failed, SUM(input) AS i, SUM(output) AS o, SUM(cache_read) AS cr, SUM(cost) AS c FROM llm_usage WHERE at > ? GROUP BY purpose").all(since) as { purpose: string; calls: number; failed: number; i: number; o: number; cr: number; c: number }[];
  const real = rows.filter((r) => !r.purpose.startsWith('filtered:'));
  const days = ctx.db.prepare("SELECT substr(at, 1, 10) AS day, COUNT(*) AS calls, SUM(input + output + cache_read) AS tokens, SUM(cost) AS cost FROM llm_usage WHERE at > ? AND purpose NOT LIKE 'filtered:%' GROUP BY day ORDER BY day").all(new Date(ctx.now().getTime() - 7 * DAY).toISOString()) as UsageSummary['days'];
  return { since, calls: real.reduce((s, r) => s + r.calls, 0), failed: real.reduce((s, r) => s + (r.failed ?? 0), 0), input: real.reduce((s, r) => s + r.i, 0), output: real.reduce((s, r) => s + r.o, 0), cacheRead: real.reduce((s, r) => s + r.cr, 0), cost: real.reduce((s, r) => s + r.c, 0),
    filtered: rows.filter((r) => r.purpose.startsWith('filtered:')).reduce((s, r) => s + r.calls, 0),
    byPurpose: real.map((r) => ({ purpose: r.purpose, calls: r.calls, tokens: r.i + r.o + r.cr, cost: r.c })).sort((a, b) => b.tokens - a.tokens), budget: backgroundBudget(ctx), days };
}
/** Old usage rows are not needed forever. */
export const pruneUsage = (db: Db, keepDays = 60, now = new Date()): void => { db.prepare('DELETE FROM llm_usage WHERE at < ?').run(new Date(now.getTime() - keepDays * DAY).toISOString()); };
