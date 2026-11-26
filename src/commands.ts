import { randomUUID } from 'node:crypto';
import type { Ctx } from './ctx.ts';
import type { Item } from './items.ts';
import { decide, listApprovals } from './approvals.ts';
import { ack, parseSnooze, shortId, snooze } from './nag.ts';
import { processNextReport, storeMessage } from './pipeline.ts';
import { ask } from './qa.ts';
import type { Upload } from './images.ts';
import { toLlmImages } from './images.ts';
import { testConnector, enableConnector, listConnectors, proposeConnector, connectorActionMap } from './connectors.ts';

/** A request to DO something ("can you schedule…?", "add…", "use the X connector") — with a write-capable connector enabled it goes to the action pipeline, not the Q&A. */
const ACTION_REQUEST = /^(?:(?:can|could|would|will) you\b|please\b|i (?:need|want) you to\b|(?:schedule|add|create|log|start|stop|set|send|book|track|use|record|update|close|open|post|submit|mark|cancel|delete|remove)\b)/i;
const wantsAction = (ctx: Ctx, t: string): boolean => ACTION_REQUEST.test(t) && connectorActionMap(ctx).size > 0;
const QUESTION = /^(what|when|who|where|how|which|why|show|list|find|did|do|does|is|are|any)\b|\?\s*$/i;

function formatItems(items: Item[], tz: string): string {
  if (!items.length) return 'Nothing open.';
  const groups: Record<string, Item[]> = { ticket: [], reminder: [], task: [] };
  for (const i of items) groups[i.kind].push(i);
  const fmt = (i: Item) => {
    const due = i.dueAt ? ` — due ${new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(i.dueAt))}` : '';
    return `• [${shortId(i.id)}] ${i.title}${i.stageLabel ? ` (${i.stageLabel})` : ''}${due}`;
  };
  return (['ticket', 'reminder', 'task'] as const).filter((k) => groups[k].length)
    .map((k) => `*${{ ticket: 'Tickets', reminder: 'Reminders', task: 'Tasks' }[k]}*\n${groups[k].map(fmt).join('\n')}`).join('\n\n');
}

const HELP = `Just tell me things and I'll turn them into tickets, reminders and tasks.
Commands: open · approvals · approve N / reject N · ack ID · snooze ID 1h · done ID · ask <question>
Connectors: connector <docs text or URL> · test connector ID · enable connector ID`;

/** Handles one line from the owner (chat or HTTP) and returns the reply text. */
export async function handleOwnerText(ctx: Ctx, textIn: string, sourceId: string = randomUUID(), images: Upload[] = []): Promise<string> {
  const text = textIn.trim();
  if (!text && !images.length) return HELP;
  let m: RegExpExecArray | null;
  if (images.length) {   // pictures go to the model with the words: a question is answered, anything else is captured
    if (text && QUESTION.test(text) && !/\b(remind me|remember to)\b/i.test(text) && !wantsAction(ctx, text)) return ask(ctx, text, toLlmImages(images));
    return capture(ctx, text || '(picture only)', sourceId, images);
  }

  if (/^(help|\?)$/i.test(text)) return HELP;
  if (/^(open|what'?s open\??|list|tasks|todo|what do i have\??)$/i.test(text)) return formatItems(ctx.items.list({ state: 'open' }), ctx.cfg.tz);
  if (/^(approvals?|pending)$/i.test(text)) {
    const p = listApprovals(ctx);
    return p.length ? p.map((a) => `#${a.id} ${a.summary}\n   (${a.reason})`).join('\n') : 'No approvals waiting.';
  }
  if ((m = /^(approve|yes|ok|okay|reject|no|deny)\s+#?(\d+)$/i.exec(text))) {
    return decide(ctx, Number(m[2]), /^(approve|yes|ok|okay)$/i.test(m[1]));
  }
  if (/^(approve|yes|ok|okay) all$/i.test(text)) {
    const p = listApprovals(ctx); if (!p.length) return 'No approvals waiting.';
    const out: string[] = []; for (const a of p) out.push(await decide(ctx, a.id, true));
    return out.join('\n');
  }
  if ((m = /^(ack|acknowledge|got it|handled|done|finished|complete)\s+#?([0-9a-f-]{4,})$/i.exec(text))) {
    const it = ctx.items.find(m[2]); if (!it) return `No item matching "${m[2]}".`;
    if (it.state !== 'open') return `"${it.title}" is already ${it.state}.`;
    const { applyAction } = await import('./actions.ts');
    if (/^(ack|acknowledge|got it)$/i.test(m[1]) && it.kind !== 'reminder') { ack(ctx, it); return `Acknowledged: ${it.title}`; }
    const r = await applyAction(ctx, { op: 'complete', itemId: it.id, confidence: 1, flags: [], why: 'owner said so' }, null, 'owner');
    return r.summary;
  }
  if ((m = /^snooze\s+#?([0-9a-f-]{4,})\s+(.+)$/i.exec(text))) {
    const it = ctx.items.find(m[1]); if (!it) return `No item matching "${m[1]}".`;
    const until = parseSnooze(m[2], ctx.now(), ctx.cfg.tz, ctx.cfg.quietHours);
    if (!until) return `I didn't understand "${m[2]}". Try 30m, 2h, 1d, or tomorrow.`;
    snooze(ctx, it, until); return `Snoozed "${it.title}" until ${new Intl.DateTimeFormat('en-US', { timeZone: ctx.cfg.tz, weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(until)}.`;
  }
  if ((m = /^ask:?\s+(.+)$/is.exec(text))) return ask(ctx, m[1]);
  if (/^connectors?$/i.test(text)) { const c = listConnectors(ctx); return c.length ? c.map((x) => `${x.id} — ${x.status}${x.lastError ? ` (error: ${x.lastError})` : ''}`).join('\n') : 'No connectors yet. Send "connector <docs text or URL>".'; }
  if ((m = /^test connector\s+(\S+)$/i.exec(text))) return testConnector(ctx, m[1]);
  if ((m = /^enable connector\s+(\S+)$/i.exec(text))) return enableConnector(ctx, m[1]);
  if ((m = /^connector:?\s+([\s\S]+)$/i.exec(text))) return proposeConnector(ctx, m[1]);
  if (QUESTION.test(text) && !/\b(remind me|remember to)\b/i.test(text) && !wantsAction(ctx, text)) return ask(ctx, text);

  return capture(ctx, text, sourceId, []);
}

async function capture(ctx: Ctx, text: string, sourceId: string, images: Upload[]): Promise<string> {
  const id = storeMessage(ctx, { source: 'chat', sourceId, sender: 'me', body: text, images });
  if (id === null) return 'I already have that one.';
  for (let i = 0; i < 10; i++) {                       // drain anything queued ahead of it, then this message
    const r = await processNextReport(ctx);
    if (!r) break;
    if (r.msg.id === id) return summarize(r.report);
  }
  return 'Got it — queued.';
}

function summarize(r: { applied: string[]; queued: string[]; rejected: string[]; failed?: string[]; skipped?: string }): string {
  const lines: string[] = [];
  if (r.applied.length) lines.push(...r.applied.map((s) => `Done: ${s}`));
  if (r.queued.length) lines.push(...r.queued.map((s) => `Needs your OK: ${s}`));
  if (r.failed?.length) lines.push(...r.failed.map((s) => `That didn't work: ${s}`));
  if (r.skipped?.startsWith('error')) lines.push(`I couldn't process that yet (${r.skipped}). I'll retry.`);
  return lines.length ? lines.join('\n\n') : "I didn't find anything to do in that.";
}
