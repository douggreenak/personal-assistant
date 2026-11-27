import type { Ctx } from './ctx.ts';
import { kvGet, kvSet } from './db.ts';
import { listApprovals } from './approvals.ts';
import type { Action } from './actions.ts';

const stable = (v: unknown): string => (v && typeof v === 'object' && !Array.isArray(v) ? `{${Object.keys(v).sort().map((k) => `${k}:${stable((v as Record<string, unknown>)[k])}`).join(',')}}` : JSON.stringify(v));
/** Two service calls with the same service, action and arguments are "the same request". */
export const callSig = (a: Pick<Action, 'connectorId' | 'actionId' | 'args'>): string => `${a.connectorId}.${a.actionId}|${stable(a.args ?? {})}`;

const WINDOW_MS = 24 * 3600_000;
type Done = { sig: string; at: string };
const recent = (ctx: Ctx): Done[] => { try { return JSON.parse(kvGet(ctx.db, 'conn.recent') ?? '[]') as Done[]; } catch { return []; } };
export function noteCall(ctx: Ctx, a: Action): void {
  const cutoff = new Date(ctx.now().getTime() - WINDOW_MS).toISOString();
  kvSet(ctx.db, 'conn.recent', JSON.stringify([...recent(ctx).filter((d) => d.at > cutoff), { sig: callSig(a), at: ctx.now().toISOString() }].slice(-60)));
}
/** Was this exact request already done today, or is it already waiting for an OK? Vague follow-ups ("try again") must not repeat a write on their own. */
export function sameRequest(ctx: Ctx, a: Action): { pending?: number; doneAt?: string } {
  const sig = callSig(a), cutoff = new Date(ctx.now().getTime() - WINDOW_MS).toISOString();
  const pending = listApprovals(ctx).find((p) => { const x = p.payload.action as Action | undefined; return x?.op === 'connector_call' && callSig(x) === sig; });
  return { pending: pending?.id, doneAt: recent(ctx).reverse().find((d) => d.sig === sig && d.at > cutoff)?.at };
}
