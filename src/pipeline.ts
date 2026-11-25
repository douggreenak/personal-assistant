import type { Ctx } from './ctx.ts';
import { nowIso } from './db.ts';
import { ACTIONS_SCHEMA, applyAction, describeAction, parseActions } from './actions.ts';
import { decide } from './policy.ts';
import { EXTRACT_SYSTEM, buildExtractPrompt } from './prompts.ts';
import { describeNow } from './time.ts';
import { createApproval } from './approvals.ts';
import { DEFAULT_STAGES } from './stages.ts';

export interface InboundMessage { source: string; sourceId: string; sender?: string; subject?: string; body: string; receivedAt?: string; fromOwner?: boolean }
export interface MessageRow { id: number; source: string; sourceId: string; sender: string; subject: string; body: string; receivedAt: string; attempts: number }

/** Stores a message once (idempotent on source+sourceId) and indexes it for search. Returns null if already known. */
export function storeMessage(ctx: Ctx, m: InboundMessage): number | null {
  const body = (m.body ?? '').trim();
  if (!body) return null;
  const r = ctx.db.prepare('INSERT OR IGNORE INTO messages (source, source_id, sender, subject, body, received_at) VALUES (?,?,?,?,?,?)')
    .run(m.source, m.sourceId, m.sender ?? '', m.subject ?? '', body, m.receivedAt ?? nowIso());
  if (r.changes === 0) return null;
  const id = Number(r.lastInsertRowid);
  ctx.db.prepare("INSERT INTO search (kind, ref, title, body) VALUES ('message', ?, ?, ?)").run(String(id), `${m.sender ?? ''} ${m.subject ?? ''}`.trim(), body.slice(0, 20000));
  return id;
}

const rowToMsg = (r: Record<string, unknown>): MessageRow => ({
  id: r.id as number, source: r.source as string, sourceId: r.source_id as string, sender: r.sender as string,
  subject: r.subject as string, body: r.body as string, receivedAt: r.received_at as string, attempts: r.attempts as number,
});

export interface ProcessReport { applied: string[]; queued: string[]; rejected: string[]; skipped?: string }

/** Extract → match → decide → apply/queue for one stored message. */
export async function processMessage(ctx: Ctx, msg: MessageRow): Promise<ProcessReport> {
  const report: ProcessReport = { applied: [], queued: [], rejected: [] };
  const fromOwner = ['voice', 'chat'].includes(msg.source) || msg.sender === 'me';
  if (!fromOwner && ctx.cfg.ignoreSenders.some((re) => re.test(msg.sender))) { report.skipped = 'ignored sender'; return report; }

  const candidates = ctx.items.candidates(`${msg.subject} ${msg.body}`, 25);
  const stages = ctx.ticketing ? (await ctx.ticketing.defaultPipeline().catch(() => null))?.stages ?? DEFAULT_STAGES : DEFAULT_STAGES;
  const prompt = buildExtractPrompt({ now: describeNow(ctx.now(), ctx.cfg.tz), source: msg.source, sender: msg.sender, subject: msg.subject, body: msg.body, fromOwner, candidates, stages });

  const raw = await ctx.llm.json({ system: EXTRACT_SYSTEM, prompt, schema: ACTIONS_SCHEMA as unknown as Record<string, unknown> });
  const { actions, rejected } = parseActions(raw, new Set(candidates.map((c) => c.id)));
  report.rejected = rejected;

  for (const a of actions) {
    const item = a.itemId ? ctx.items.get(a.itemId) : undefined;
    const d = decide(a, ctx.cfg);
    if (d.mode === 'ask') {
      createApproval(ctx, { kind: 'action', summary: describeAction(a, item), reason: d.reason, payload: { action: a }, messageId: msg.id });
      report.queued.push(describeAction(a, item));
      continue;
    }
    try {
      const res = await applyAction(ctx, a, msg.id);
      report.applied.push(res.summary);
    } catch (e) {
      // A backend failure must not lose the user's intent: park it for approval/retry instead.
      createApproval(ctx, { kind: 'action', summary: describeAction(a, item), reason: `backend error: ${(e as Error).message.slice(0, 120)}`, payload: { action: a }, messageId: msg.id });
      report.queued.push(`${describeAction(a, item)} (backend error)`);
    }
  }
  return report;
}

/** Worker step: process the oldest pending message. Returns false when the queue is empty. */
export async function processNext(ctx: Ctx): Promise<boolean> {
  const row = ctx.db.prepare('SELECT * FROM messages WHERE processed_at IS NULL AND attempts < 5 ORDER BY id LIMIT 1').get() as Record<string, unknown> | undefined;
  if (!row) return false;
  const msg = rowToMsg(row);
  ctx.db.prepare('UPDATE messages SET attempts = attempts + 1 WHERE id = ?').run(msg.id);
  try {
    const report = await processMessage(ctx, msg);
    ctx.db.prepare('UPDATE messages SET processed_at = ?, error = NULL WHERE id = ?').run(nowIso(), msg.id);
    await announce(ctx, msg, report);
  } catch (e) {
    const err = (e as Error).message.slice(0, 300);
    ctx.db.prepare('UPDATE messages SET error = ? WHERE id = ?').run(err, msg.id);
    if (msg.attempts + 1 >= 5) await ctx.notify.send(`⚠️ Couldn't process a ${msg.source} message after 5 tries: ${err}`);
  }
  return true;
}

async function announce(ctx: Ctx, msg: MessageRow, r: ProcessReport): Promise<void> {
  if (!r.applied.length) return;  // queued items are announced by the approvals loop
  const who = msg.source === 'voice' || msg.source === 'chat' ? '' : ` (from ${msg.sender || msg.source})`;
  await ctx.notify.send(`✅ ${r.applied.map((s) => `• ${s}`).join('\n')}${who}`);
}
