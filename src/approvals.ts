import type { Ctx } from './ctx.ts';
import { nowIso } from './db.ts';
import { applyAction, type Action } from './actions.ts';

export interface Approval {
  id: number; createdAt: string; kind: 'action' | 'connector'; summary: string; reason: string;
  payload: Record<string, unknown>; messageId: number | null; status: 'pending' | 'approved' | 'rejected'; notified: boolean;
}
type Row = Record<string, unknown>;
const toApproval = (r: Row): Approval => ({
  id: r.id as number, createdAt: r.created_at as string, kind: r.kind as Approval['kind'], summary: r.summary as string,
  reason: r.reason as string, payload: JSON.parse(r.payload as string), messageId: (r.message_id as number) ?? null,
  status: r.status as Approval['status'], notified: !!r.notified,
});

export function createApproval(ctx: Ctx, a: { kind: Approval['kind']; summary: string; reason: string; payload: Record<string, unknown>; messageId?: number | null }): number {
  const r = ctx.db.prepare('INSERT INTO approvals (created_at, kind, summary, reason, payload, message_id) VALUES (?,?,?,?,?,?)')
    .run(nowIso(), a.kind, a.summary, a.reason, JSON.stringify(a.payload), a.messageId ?? null);
  return Number(r.lastInsertRowid);
}
export const listApprovals = (ctx: Ctx, status = 'pending'): Approval[] =>
  (ctx.db.prepare('SELECT * FROM approvals WHERE status = ? ORDER BY id').all(status) as Row[]).map(toApproval);
export const getApproval = (ctx: Ctx, id: number): Approval | undefined => {
  const r = ctx.db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as Row | undefined;
  return r ? toApproval(r) : undefined;
};

/** Pending approvals not yet shown to the owner; marks them notified. */
export async function announcePending(ctx: Ctx): Promise<number> {
  const fresh = (ctx.db.prepare('SELECT * FROM approvals WHERE status = ? AND notified = 0 ORDER BY id').all('pending') as Row[]).map(toApproval);
  for (const a of fresh) {
    await ctx.notify.send(`❓ #${a.id} needs your OK: ${a.summary}\n   (${a.reason}) — reply "approve ${a.id}" or "reject ${a.id}"`, { approvalId: a.id });
    ctx.db.prepare('UPDATE approvals SET notified = 1 WHERE id = ?').run(a.id);
  }
  return fresh.length;
}

export type Hook = (ctx: Ctx, a: Approval) => Promise<string>;
const kindHooks = new Map<string, Hook>();
/** Other modules (connectors) register what "approve" means for their approval kind. */
export const registerApprovalKind = (kind: string, h: Hook): void => { kindHooks.set(kind, h); };

export async function decide(ctx: Ctx, id: number, approve: boolean, by = 'owner'): Promise<string> {
  const a = getApproval(ctx, id);
  if (!a) return `No approval #${id}.`;
  if (a.status !== 'pending') return `#${id} was already ${a.status}.`;
  // Claim first so a double-tap can't apply twice.
  const claimed = ctx.db.prepare("UPDATE approvals SET status = ?, decided_at = ?, decided_by = ? WHERE id = ? AND status = 'pending'")
    .run(approve ? 'approved' : 'rejected', nowIso(), by, id);
  if (claimed.changes === 0) return `#${id} was already decided.`;
  if (!approve) return `Rejected #${id}: ${a.summary}`;
  try {
    if (a.kind === 'action') {
      const res = await applyAction(ctx, a.payload.action as Action, a.messageId, 'owner-approved');
      return `Approved — ${res.summary}`;
    }
    const hook = kindHooks.get(a.kind);
    return hook ? await hook(ctx, a) : `Approved #${id}.`;
  } catch (e) {
    ctx.db.prepare("UPDATE approvals SET status = 'pending', notified = 0 WHERE id = ?").run(id);
    return `Approved #${id} but it failed (${(e as Error).message.slice(0, 120)}); it's back in the queue.`;
  }
}
