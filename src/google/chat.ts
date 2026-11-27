import type { Ctx } from '../ctx.ts';
import { kvGet, kvSet } from '../db.ts';
import type { Notifier, NotifyOpts } from '../notify.ts';
import { handleOwnerText } from '../commands.ts';
import { decide } from '../approvals.ts';
import { storeMessage } from '../pipeline.ts';
import { gjson, type TokenSource } from './auth.ts';

const CHAT = 'https://chat.googleapis.com/v1';
const BOT_SCOPE = ['https://www.googleapis.com/auth/chat.bot'];
const PUBSUB_SCOPE = ['https://www.googleapis.com/auth/pubsub'];

export interface ChatEvent { text: string; senderName: string; senderEmail: string; senderType: string; space: string; spaceType: string; thread?: string; messageName?: string }

/** Accepts both the classic Chat event shape and the newer `chat.messagePayload` shape. */
export function parseChatEvent(raw: unknown): ChatEvent | null {
  const e = raw as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const payload = e?.chat?.messagePayload;
  const message = payload?.message ?? e?.message;
  if (!message) return null;
  const user = e?.chat?.user ?? e?.user ?? message.sender ?? {};
  const space = payload?.space ?? e?.space ?? message.space ?? {};
  const text = String(message.argumentText ?? message.text ?? '').trim();
  return { text, senderName: String(user.name ?? ''), senderEmail: String(user.email ?? ''), senderType: String(user.type ?? message.sender?.type ?? ''),
    space: String(space.name ?? message.space?.name ?? ''), spaceType: String(space.spaceType ?? space.type ?? ''), thread: message.thread?.name, messageName: message.name };
}

export interface ChatClick { id: number; approve: boolean; senderName: string; senderEmail: string; senderType: string; space: string; messageName?: string }

/** A tap on an Approve / Reject button, in the classic (CARD_CLICKED) or the Workspace add-on event shape. */
export function parseChatClick(raw: unknown): ChatClick | null {
  const e = raw as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  let fn: string | undefined, params: Record<string, string> = {};
  if (e?.commonEventObject?.invokedFunction) { fn = e.commonEventObject.invokedFunction; params = e.commonEventObject.parameters ?? {}; }
  else if (e?.action?.actionMethodName || e?.action?.function) { fn = e.action.actionMethodName ?? e.action.function; for (const p of e.action.parameters ?? []) params[p.key] = p.value; }
  if (fn !== 'approval') return null;
  const id = Number(params.id); if (!Number.isInteger(id) || !/^(approve|reject)$/.test(params.decision ?? '')) return null;
  const payload = e?.chat?.buttonClickedPayload; const message = payload?.message ?? e?.message; const space = payload?.space ?? e?.space ?? message?.space ?? {};
  const user = e?.chat?.user ?? e?.user ?? {};
  return { id, approve: params.decision === 'approve', senderName: String(user.name ?? ''), senderEmail: String(user.email ?? ''), senderType: String(user.type ?? ''), space: String(space.name ?? message?.space?.name ?? ''), messageName: message?.name };
}

const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
const button = (label: string, id: number, decision: 'approve' | 'reject') => ({ text: label, onClick: { action: { function: 'approval', parameters: [{ key: 'id', value: String(id) }, { key: 'decision', value: decision }] } } });
/** A message card with Approve / Reject buttons (the typed "approve N" reply still works). */
export const approvalCard = (id: number, text: string) => ({ cardId: `approval-${id}`, card: { sections: [{ widgets: [{ textParagraph: { text: esc(text) } }, { buttonList: { buttons: [button('Approve', id, 'approve'), button('Reject', id, 'reject')] } }] }] } });
const resultCard = (id: number, text: string) => ({ cardId: `approval-${id}`, card: { sections: [{ widgets: [{ textParagraph: { text: esc(text) } }] }] } });

export const isAllowed = (allowed: string[], e: Pick<ChatEvent, 'senderName' | 'senderEmail' | 'senderType'>): boolean =>
  e.senderType !== 'BOT' && allowed.length > 0 && allowed.some((a) => a.toLowerCase() === e.senderName.toLowerCase() || (e.senderEmail && a.toLowerCase() === e.senderEmail.toLowerCase()));

export class ChatBot implements Notifier {
  ctx: Ctx; sa: TokenSource; fetchImpl: typeof fetch; seen = new Set<string>();   // Pub/Sub message ids already handled (it can deliver one twice)
  constructor(ctx: Ctx, sa: TokenSource, fetchImpl: typeof fetch = fetch) { this.ctx = ctx; this.sa = sa; this.fetchImpl = fetchImpl; }

  async post(space: string, text: string, thread?: string): Promise<void> {
    for (let i = 0; i < text.length || i === 0; i += 3800) {
      await gjson(this.sa, BOT_SCOPE, `${CHAT}/${space}/messages${thread ? '?messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD' : ''}`,
        { method: 'POST', body: { text: text.slice(i, i + 3800), ...(thread ? { thread: { name: thread } } : {}) } }, this.fetchImpl);
    }
  }
  /** Notifier: proactive messages go to the DM space learned from your first message (or CHAT_NOTIFY_SPACE). */
  async send(text: string, opts?: NotifyOpts): Promise<void> {
    const space = kvGet(this.ctx.db, 'chat.space') ?? this.ctx.cfg.chat.notifySpace;
    if (!space) { console.warn('[chat] no DM space yet; message me once in Google Chat so I can reach you:', text.slice(0, 80)); return; }
    if (opts?.approvalId) {
      try { await gjson(this.sa, BOT_SCOPE, `${CHAT}/${space}/messages`, { method: 'POST', body: { cardsV2: [approvalCard(opts.approvalId, text.slice(0, 3000))] } }, this.fetchImpl); return; }
      catch (e) { console.warn('[chat] button card failed, sending plain text:', (e as Error).message.slice(0, 120)); }
    }
    await this.post(space, text);
  }

  /** Approve / Reject tapped on a card: do it, then turn the card into the outcome so it can't be tapped twice. */
  async handleClick(c: ChatClick): Promise<void> {
    if (!isAllowed(this.ctx.cfg.chat.allowedUsers, c)) { console.warn(`[chat] ignoring button from non-allowed user ${c.senderEmail || c.senderName}`); return; }
    const result = await decide(this.ctx, c.id, c.approve);
    const text = `Approval #${c.id}: ${result}`;
    if (c.messageName) { try { await gjson(this.sa, BOT_SCOPE, `${CHAT}/${c.messageName}?updateMask=cardsV2`, { method: 'PATCH', body: { cardsV2: [resultCard(c.id, text)] } }, this.fetchImpl); return; } catch { /* fall through to a new message */ } }
    if (c.space) await this.post(c.space, text);
  }

  /** Pulls pending Chat events from Pub/Sub (outbound only — no public endpoint), handles them, acks them. */
  async pullOnce(): Promise<number> {
    const sub = this.ctx.cfg.chat.pubsubSubscription; if (!sub) return 0;
    const pull = await gjson<{ receivedMessages?: { ackId: string; message: { data: string; messageId?: string } }[] }>(this.sa, PUBSUB_SCOPE, `https://pubsub.googleapis.com/v1/${sub}:pull`, { method: 'POST', body: { maxMessages: 10 } }, this.fetchImpl);
    const msgs = pull.receivedMessages ?? [];
    // Acknowledge FIRST. Pub/Sub re-sends anything not acknowledged within the ack deadline (10 s), and a reply that needs the model takes longer than that:
    // handling before acking made every slow message come back and get answered again, forever.
    if (msgs.length) await gjson(this.sa, PUBSUB_SCOPE, `https://pubsub.googleapis.com/v1/${sub}:acknowledge`, { method: 'POST', body: { ackIds: msgs.map((m) => m.ackId) } }, this.fetchImpl);
    for (const m of msgs) {
      const id = (m as { message: { messageId?: string } }).message.messageId;
      if (id) { if (this.seen.has(id)) continue; this.seen.add(id); if (this.seen.size > 500) this.seen.delete(this.seen.values().next().value as string); }
      try { await this.handleEvent(JSON.parse(Buffer.from(m.message.data, 'base64').toString('utf8'))); }
      catch (e) { console.error('[chat] event failed:', (e as Error).message); }
    }
    return msgs.length;
  }

  async handleEvent(raw: unknown): Promise<void> {
    const click = parseChatClick(raw); if (click) return this.handleClick(click);
    const e = parseChatEvent(raw);
    if (!e || !e.text || !e.space) return;
    if (!isAllowed(this.ctx.cfg.chat.allowedUsers, e)) { console.warn(`[chat] ignoring message from non-allowed user ${e.senderEmail || e.senderName}`); return; }
    if (/DIRECT_MESSAGE|DM/.test(e.spaceType)) kvSet(this.ctx.db, 'chat.space', e.space);
    if (e.messageName) {   // the same Chat message is never answered twice, even across restarts or re-deliveries
      const done = (kvGet(this.ctx.db, 'chat.handled') ?? '').split('\n').filter(Boolean);
      if (done.includes(e.messageName)) return;
      kvSet(this.ctx.db, 'chat.handled', [...done, e.messageName].slice(-100).join('\n'));
    }
    const reply = await handleOwnerText(this.ctx, e.text, e.messageName ?? undefined);
    await this.post(e.space, reply, e.thread);
  }
}

/** Reads the owner's own conversations in Chat spaces (user OAuth) as input messages. Opt-in via CHAT_READ_SPACES=1. */
export async function pollChatSpaces(ctx: Ctx, user: TokenSource, fetchImpl: typeof fetch = fetch): Promise<number> {
  const scopes = ['https://www.googleapis.com/auth/chat.messages.readonly', 'https://www.googleapis.com/auth/chat.spaces.readonly'];
  const since = kvGet(ctx.db, 'chatread.since') ?? new Date().toISOString();
  const newest = new Date().toISOString();
  const spaces = (await gjson<{ spaces?: { name: string; displayName?: string }[] }>(user, scopes, `${CHAT}/spaces?pageSize=100`, {}, fetchImpl)).spaces ?? [];
  const self = ctx.cfg.chat.allowedUsers[0] ?? '';
  let n = 0;
  for (const sp of spaces) {
    const r = await gjson<{ messages?: { name: string; text?: string; createTime: string; sender?: { name?: string; displayName?: string; type?: string } }[] }>(
      user, scopes, `${CHAT}/${sp.name}/messages?pageSize=100&filter=${encodeURIComponent(`createTime > "${since}"`)}`, {}, fetchImpl).catch(() => ({ messages: [] }));
    for (const m of r.messages ?? []) {
      if (!m.text || m.sender?.type === 'BOT') continue;
      const mine = !!self && (m.sender?.name === self);
      if (storeMessage(ctx, { source: 'chat-read', sourceId: m.name, sender: mine ? 'me' : (m.sender?.displayName ?? m.sender?.name ?? ''), subject: sp.displayName ?? '', thread: `chat:${sp.name}`, counterpart: sp.displayName ?? '', body: m.text, receivedAt: m.createTime }) !== null) n++;
    }
  }
  kvSet(ctx.db, 'chatread.since', newest);
  return n;
}
