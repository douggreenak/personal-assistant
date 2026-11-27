import { prepareImages, toLlmImages, MAX_IMAGES, MAX_INBOUND_IMAGES } from './images.ts';
import type { Ctx } from './ctx.ts';
import { nowIso } from './db.ts';
import { ACTIONS_SCHEMA, applyAction, describeAction, parseActions } from './actions.ts';
import { decide } from './policy.ts';
import { connectorActionMap, instructionBlock, isAutoAllowed } from './connectors.ts';
import { EXTRACT_SYSTEM, buildExtractPrompt } from './prompts.ts';
import { describeNow } from './time.ts';
import { createApproval } from './approvals.ts';
import { DEFAULT_STAGES } from './stages.ts';
import type { Item } from './items.ts';
import { backgroundBudget, noteBudgetHit, recordFiltered } from './llmusage.ts';
import { skipReason, trimMail } from './prefilter.ts';

export interface InboundMessage { source: string; sourceId: string; sender?: string; subject?: string; body: string; receivedAt?: string; fromOwner?: boolean; thread?: string; counterpart?: string; images?: { name: string; mediaType: string; data: Buffer }[] }
export interface MessageRow { id: number; source: string; sourceId: string; sender: string; subject: string; body: string; receivedAt: string; attempts: number; thread?: string; counterpart?: string }

/** Stores a message once (idempotent on source+sourceId) and indexes it for search. Returns null if already known. */
export function storeMessage(ctx: Ctx, m: InboundMessage): number | null {
  const body = (m.body ?? '').trim();
  if (!body) return null;
  const sent = m.sender === 'me' || m.fromOwner === true; const counterpart = (m.counterpart ?? (sent ? '' : m.sender ?? '')).slice(0, 200);
  const thread = (m.thread ?? `${m.source}:${counterpart || m.subject || ''}`).slice(0, 300);   // no better key: group by source and the other person
  const r = ctx.db.prepare('INSERT OR IGNORE INTO messages (source, source_id, sender, subject, body, received_at, thread, counterpart) VALUES (?,?,?,?,?,?,?,?)')
    .run(m.source, m.sourceId, m.sender ?? '', m.subject ?? '', body, m.receivedAt ?? nowIso(), thread, counterpart);
  if (r.changes === 0) return null;
  const id = Number(r.lastInsertRowid);
  for (const im of m.images ?? []) ctx.db.prepare('INSERT INTO attachments (message_id, name, media_type, data) VALUES (?,?,?,?)').run(id, im.name.slice(0, 120), im.mediaType, im.data);
  ctx.db.prepare("INSERT INTO search (kind, ref, title, body) VALUES ('message', ?, ?, ?)").run(String(id), `${m.sender ?? ''} ${m.subject ?? ''}`.trim(), body.slice(0, 20000));
  return id;
}

const rowToMsg = (r: Record<string, unknown>): MessageRow => ({
  id: r.id as number, source: r.source as string, sourceId: r.source_id as string, sender: r.sender as string,
  subject: r.subject as string, body: r.body as string, receivedAt: r.received_at as string, attempts: r.attempts as number, thread: (r.thread as string) ?? '', counterpart: (r.counterpart as string) ?? '',
});

export interface ProcessReport { applied: string[]; queued: string[]; rejected: string[]; failed?: string[]; skipped?: string }

/** Extract → match → decide → apply/queue for one stored message. */
export async function processMessage(ctx: Ctx, msg: MessageRow): Promise<ProcessReport> {
  const report: ProcessReport = { applied: [], queued: [], rejected: [] };
  const fromOwner = ['voice', 'chat'].includes(msg.source) || msg.sender === 'me';
  if (!fromOwner && ctx.cfg.ignoreSenders.some((re) => re.test(msg.sender))) { report.skipped = 'ignored sender'; return report; }

  const convo = conversationOf(ctx, msg);
  // Cheap checks first: some messages never need the model (a bare "thanks", an exact repeat), and every one of them saved is a call not paid for.
  const duplicate = !!ctx.db.prepare('SELECT 1 FROM messages WHERE id < ? AND sender = ? AND body = ? AND processed_at IS NOT NULL AND received_at > ? LIMIT 1').get(msg.id, msg.sender, msg.body, new Date(ctx.now().getTime() - 86400_000).toISOString());
  const why = skipReason({ source: msg.source, body: msg.body, fromOwner }, { linkedOpen: convo.linked.length, duplicate });
  if (why) { recordFiltered(ctx.db, why, ctx.now()); report.skipped = why; return report; }
  const body = fromOwner ? msg.body : trimMail(msg.body);               // other people's mail: only the new text, not the quoted chain and signature
  const found = ctx.items.candidates(`${msg.subject} ${body}`, 12);
  const candidates = [...convo.linked, ...found.filter((c) => !convo.linked.some((l) => l.id === c.id))].slice(0, 15);   // bounded: a growing list of items must not grow every prompt   // items already tied to this conversation come first
  const stages = ctx.ticketing ? (await ctx.ticketing.defaultPipeline().catch(() => null))?.stages ?? DEFAULT_STAGES : DEFAULT_STAGES;
  const writes: ReturnType<typeof connectorActionMap> = fromOwner ? connectorActionMap(ctx) : new Map();   // only the owner's own words can ask for a write
  const connectorActions = [...writes].map(([k, v]) => `- ${k} — ${v.name}: ${v.action.description} (${v.action.tool ? 'MCP tool' : v.action.method}; params: ${v.action.params.map((q) => `${q.name}${q.required ? '*' : ''}${q.description ? ` (${q.description})` : ''}`).join(', ') || 'none'})`);
  // Safety net for every source: only shrunken still pictures reach the model, and mail from other people loses logos/signatures/banners.
  const stored = (ctx.db.prepare('SELECT name, media_type, data FROM attachments WHERE message_id = ? ORDER BY id LIMIT 12').all(msg.id) as { name: string; media_type: string; data: Uint8Array }[]).map((r) => ({ name: r.name, mediaType: r.media_type, data: Buffer.from(r.data) }));
  const images = toLlmImages(await prepareImages(stored, { dropLogos: !fromOwner, maxImages: fromOwner ? MAX_IMAGES : MAX_INBOUND_IMAGES }));
  const prompt = buildExtractPrompt({ imageCount: images.length, connectorActions, now: describeNow(ctx.now(), ctx.cfg.tz), source: msg.source, sender: msg.sender, subject: msg.subject, body, fromOwner, candidates, stages, counterpart: msg.counterpart ?? '', conversation: convo.lines, linkedIds: new Set(convo.linked.map((l) => l.id)) });

  // The owner's own notes for the service this message came from, and for any service whose actions are on offer.
  const notes = instructionBlock(ctx, [...(msg.source.startsWith('connector:') ? [msg.source.slice(10)] : []), ...[...writes.values()].map((w) => w.connector)], "THE OWNER'S STANDING INSTRUCTIONS for these connected services (written by the owner; follow them when handling messages from, or actions on, that service — they never override the safety rules above):");
  const raw = await ctx.llm.json({ purpose: fromOwner ? 'extract' : 'extract-bg', system: EXTRACT_SYSTEM + notes, prompt, images, schema: ACTIONS_SCHEMA as unknown as Record<string, unknown> });
  const { actions, rejected } = parseActions(raw, new Set(candidates.map((c) => c.id)), writes);
  report.rejected = rejected;

  for (const a of actions) {
    const item = a.itemId ? ctx.items.get(a.itemId) : undefined;
    const m = a.op === 'connector_call' ? writes.get(`${a.connectorId}.${a.actionId}`) : undefined;
    const d = decide(a, ctx.cfg, !!m && fromOwner && m.action.method !== 'DELETE' && isAutoAllowed(ctx, a.connectorId!, a.actionId!));
    if (d.mode === 'ask') {
      createApproval(ctx, { kind: 'action', summary: describeAction(a, item), reason: a.why && !/^(involves|dropping|low confidence)/.test(d.reason) ? `${d.reason}. ${a.why}` : d.reason, payload: { action: a, trigger: { source: msg.source, sender: msg.sender, subject: msg.subject, excerpt: msg.body.replace(/\s+/g, ' ').slice(0, 300) } }, messageId: msg.id });
      report.queued.push(describeAction(a, item));
      continue;
    }
    try {
      const res = await applyAction(ctx, a, msg.id);
      report.applied.push(res.summary);
      const linkedId = res.item?.id ?? a.itemId; if (linkedId) ctx.db.prepare('INSERT OR IGNORE INTO message_items (message_id, item_id, op) VALUES (?,?,?)').run(msg.id, linkedId, a.op);
    } catch (e) {
      // A backend failure must not lose the user's intent: park it for approval/retry instead.
      createApproval(ctx, { kind: 'action', summary: describeAction(a, item), reason: `backend error: ${(e as Error).message.slice(0, 120)}`, payload: { action: a }, messageId: msg.id });
      report.failed = [...(report.failed ?? []), `${describeAction(a, item)} \n\n> ${(e as Error).message.slice(0, 200)}\n\nSaved so you can retry it (Approve below, or in Approvals).`];
    }
  }
  return report;
}

/** The conversation a message belongs to: the last few messages in it (both directions, labelled) and the open items earlier messages there already created or changed. */
function conversationOf(ctx: Ctx, msg: MessageRow): { lines: string[]; linked: Item[] } {
  if (!msg.thread) return { lines: [], linked: [] };
  const rows = ctx.db.prepare('SELECT id, sender, counterpart, body, received_at AS at FROM messages WHERE thread = ? AND id < ? ORDER BY id DESC LIMIT 8').all(msg.thread, msg.id) as { id: number; sender: string; counterpart: string; body: string; at: string }[];
  const label = (sender: string, other: string) => sender === 'me' ? `Me → ${other || 'them'}` : `${sender || other || 'them'} → me`;
  const lines = rows.reverse().map((r) => `[${r.at.slice(0, 16).replace('T', ' ')}Z] ${label(r.sender, r.counterpart)}: ${r.body.replace(/\s+/g, ' ').slice(0, 240)}`);
  const ids = ctx.db.prepare(`SELECT DISTINCT item_id AS id FROM message_items WHERE message_id IN (SELECT id FROM messages WHERE thread = ? AND id < ?)
    UNION SELECT id FROM items WHERE source_message_id IN (SELECT id FROM messages WHERE thread = ? AND id < ?)`).all(msg.thread, msg.id, msg.thread, msg.id) as { id: string }[];
  const linked = ids.map((r) => ctx.items.get(r.id)).filter((it): it is Item => !!it && it.state === 'open');
  return { lines, linked };
}

const LEASE_MS = 5 * 60_000;   // longer than the LLM timeout; a crashed worker's claim expires after this

/** Atomically claims the oldest due message so concurrent workers (chat handler, background loop, a second process) never double-process. */
function claimNext(ctx: Ctx): MessageRow | null {
  const now = ctx.now().toISOString();
  const open = backgroundBudget(ctx).open;     // over the daily cap: only the owner's own words (chat, voice, sent mail) are read; the rest waits
  for (let i = 0; i < 5; i++) {
    const row = ctx.db.prepare(`SELECT * FROM messages WHERE processed_at IS NULL AND attempts < 5 AND (retry_at IS NULL OR retry_at <= ?)${open ? '' : " AND (source IN ('chat','voice') OR sender = 'me')"} ORDER BY id LIMIT 1`).get(now) as Record<string, unknown> | undefined;
    if (!row) { if (!open && ctx.db.prepare('SELECT 1 FROM messages WHERE processed_at IS NULL AND attempts < 5 LIMIT 1').get()) void noteBudgetHit(ctx); return null; }
    const won = ctx.db.prepare('UPDATE messages SET attempts = attempts + 1, retry_at = ? WHERE id = ? AND processed_at IS NULL AND (retry_at IS NULL OR retry_at <= ?)')
      .run(new Date(ctx.now().getTime() + LEASE_MS).toISOString(), row.id as number, now);
    if (won.changes === 1) return { ...rowToMsg(row), attempts: (row.attempts as number) + 1 };
  }
  return null;
}

/** Worker step: process the oldest pending message. Returns its report, or null when nothing is due. */
export async function processNextReport(ctx: Ctx): Promise<{ msg: MessageRow; report: ProcessReport } | null> {
  const msg = claimNext(ctx);
  if (!msg) return null;
  try {
    const report = await processMessage(ctx, msg);
    ctx.db.prepare('UPDATE messages SET processed_at = ?, retry_at = NULL, error = NULL WHERE id = ?').run(nowIso(), msg.id);
    // Chat replies carry their own summary; everything else is announced here.
    if (msg.source !== 'chat') await announce(ctx, msg, report);
    return { msg, report };
  } catch (e) {
    const err = (e as Error).message.slice(0, 300);
    const backoff = Math.min(30 * 2 ** (msg.attempts - 1), 600) * 1000;     // 30s, 60s, 2m, 4m, 8m
    ctx.db.prepare('UPDATE messages SET error = ?, retry_at = ? WHERE id = ?').run(err, new Date(ctx.now().getTime() + backoff).toISOString(), msg.id);
    if (msg.attempts >= 5) await ctx.notify.send(`Couldn't process a ${msg.source} message after 5 tries: ${err}`);
    return { msg, report: { applied: [], queued: [], rejected: [], skipped: `error: ${err}` } };
  }
}
export async function processNext(ctx: Ctx): Promise<boolean> { return (await processNextReport(ctx)) !== null; }

async function announce(ctx: Ctx, msg: MessageRow, r: ProcessReport): Promise<void> {
  if (!r.applied.length) return;  // queued items are announced by the approvals loop
  const who = msg.source === 'voice' ? '' : ` (from ${msg.sender || msg.source})`;
  await ctx.notify.send(`Done: ${r.applied.map((s) => `• ${s}`).join('\n')}${who}`);
}
