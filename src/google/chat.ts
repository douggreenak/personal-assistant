import type { Ctx } from '../ctx.ts';
import { kvGet, kvSet } from '../db.ts';
import type { Notifier } from '../notify.ts';
import { handleOwnerText } from '../commands.ts';
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

export const isAllowed = (allowed: string[], e: Pick<ChatEvent, 'senderName' | 'senderEmail' | 'senderType'>): boolean =>
  e.senderType !== 'BOT' && allowed.length > 0 && allowed.some((a) => a.toLowerCase() === e.senderName.toLowerCase() || (e.senderEmail && a.toLowerCase() === e.senderEmail.toLowerCase()));

export class ChatBot implements Notifier {
  ctx: Ctx; sa: TokenSource; fetchImpl: typeof fetch;
  constructor(ctx: Ctx, sa: TokenSource, fetchImpl: typeof fetch = fetch) { this.ctx = ctx; this.sa = sa; this.fetchImpl = fetchImpl; }

  async post(space: string, text: string, thread?: string): Promise<void> {
    for (let i = 0; i < text.length || i === 0; i += 3800) {
      await gjson(this.sa, BOT_SCOPE, `${CHAT}/${space}/messages${thread ? '?messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD' : ''}`,
        { method: 'POST', body: { text: text.slice(i, i + 3800), ...(thread ? { thread: { name: thread } } : {}) } }, this.fetchImpl);
    }
  }
  /** Notifier: proactive messages go to the DM space learned from your first message (or CHAT_NOTIFY_SPACE). */
  async send(text: string): Promise<void> {
    const space = kvGet(this.ctx.db, 'chat.space') ?? this.ctx.cfg.chat.notifySpace;
    if (!space) { console.warn('[chat] no DM space yet; message me once in Google Chat so I can reach you:', text.slice(0, 80)); return; }
    await this.post(space, text);
  }

  /** Pulls pending Chat events from Pub/Sub (outbound only — no public endpoint), handles them, acks them. */
  async pullOnce(): Promise<number> {
    const sub = this.ctx.cfg.chat.pubsubSubscription; if (!sub) return 0;
    const pull = await gjson<{ receivedMessages?: { ackId: string; message: { data: string } }[] }>(this.sa, PUBSUB_SCOPE, `https://pubsub.googleapis.com/v1/${sub}:pull`, { method: 'POST', body: { maxMessages: 10 } }, this.fetchImpl);
    const msgs = pull.receivedMessages ?? [];
    for (const m of msgs) {
      try { await this.handleEvent(JSON.parse(Buffer.from(m.message.data, 'base64').toString('utf8'))); }
      catch (e) { console.error('[chat] event failed:', (e as Error).message); }
    }
    if (msgs.length) await gjson(this.sa, PUBSUB_SCOPE, `https://pubsub.googleapis.com/v1/${sub}:acknowledge`, { method: 'POST', body: { ackIds: msgs.map((m) => m.ackId) } }, this.fetchImpl);
    return msgs.length;
  }

  async handleEvent(raw: unknown): Promise<void> {
    const e = parseChatEvent(raw);
    if (!e || !e.text || !e.space) return;
    if (!isAllowed(this.ctx.cfg.chat.allowedUsers, e)) { console.warn(`[chat] ignoring message from non-allowed user ${e.senderEmail || e.senderName}`); return; }
    if (/DIRECT_MESSAGE|DM/.test(e.spaceType)) kvSet(this.ctx.db, 'chat.space', e.space);
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
