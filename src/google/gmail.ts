import type { Ctx } from '../ctx.ts';
import { kvGet, kvSet } from '../db.ts';
import { storeMessage } from '../pipeline.ts';
import { gjson, type TokenSource } from './auth.ts';

const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';

interface Part { mimeType?: string; filename?: string; body?: { data?: string }; parts?: Part[]; headers?: { name: string; value: string }[] }
export interface GmailMessage { id: string; threadId?: string; labelIds?: string[]; internalDate?: string; payload?: Part; snippet?: string }

const b64 = (s?: string): string => (s ? Buffer.from(s, 'base64url').toString('utf8') : '');
const htmlToText = (h: string): string => h.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>|<\/p>|<\/div>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();

function bodyOf(p: Part | undefined): string {
  if (!p) return '';
  const plain: string[] = []; const html: string[] = [];
  const walk = (x: Part) => {
    if (x.filename) return;                                    // attachments
    if (x.mimeType === 'text/plain' && x.body?.data) plain.push(b64(x.body.data));
    else if (x.mimeType === 'text/html' && x.body?.data) html.push(b64(x.body.data));
    x.parts?.forEach(walk);
  };
  walk(p);
  return (plain.join('\n') || htmlToText(html.join('\n'))).trim();
}
const header = (p: Part | undefined, n: string): string => p?.headers?.find((h) => h.name.toLowerCase() === n)?.value ?? '';

/** Turns a Gmail API message into pipeline input; null for mail we never want to process. */
export function parseGmail(m: GmailMessage, skipBulk: boolean): { sourceId: string; sender: string; subject: string; body: string; receivedAt?: string } | null {
  const labels = m.labelIds ?? [];
  if (labels.some((l) => ['DRAFT', 'SPAM', 'TRASH'].includes(l))) return null;
  const sent = labels.includes('SENT');
  if (!sent && labels.some((l) => ['CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL'].includes(l))) return null;
  if (!sent && skipBulk && (header(m.payload, 'list-unsubscribe') || /bulk|list|junk/i.test(header(m.payload, 'precedence')) || header(m.payload, 'auto-submitted').startsWith('auto-'))) return null;
  const body = bodyOf(m.payload) || m.snippet || '';
  if (!body) return null;
  return {
    sourceId: m.id, sender: sent ? 'me' : header(m.payload, 'from'),
    subject: sent ? `to ${header(m.payload, 'to')}: ${header(m.payload, 'subject')}` : header(m.payload, 'subject'),
    body: body.slice(0, 20000), receivedAt: m.internalDate ? new Date(Number(m.internalDate)).toISOString() : undefined,
  };
}

/** Polls new mail via the History API. The first run only records "now"; it never back-processes your inbox. */
export async function pollGmail(ctx: Ctx, auth: TokenSource, fetchImpl: typeof fetch = fetch): Promise<number> {
  const g = <T>(path: string) => gjson<T>(auth, SCOPES, `${API}${path}`, {}, fetchImpl);
  const start = kvGet(ctx.db, 'gmail.historyId');
  if (!start) { kvSet(ctx.db, 'gmail.historyId', (await g<{ historyId: string }>('/profile')).historyId); return 0; }
  const ids = new Set<string>(); let pageToken = ''; let latest = start;
  try {
    do {
      const h = await g<{ history?: { messagesAdded?: { message: { id: string } }[] }[]; historyId?: string; nextPageToken?: string }>(`/history?startHistoryId=${start}&historyTypes=messageAdded${pageToken ? `&pageToken=${pageToken}` : ''}`);
      for (const rec of h.history ?? []) for (const a of rec.messagesAdded ?? []) ids.add(a.message.id);
      if (h.historyId) latest = h.historyId;
      pageToken = h.nextPageToken ?? '';
    } while (pageToken);
  } catch (e) {
    if ((e as { status?: number }).status === 404) { kvSet(ctx.db, 'gmail.historyId', (await g<{ historyId: string }>('/profile')).historyId); return 0; } // history expired
    throw e;
  }
  let n = 0;
  for (const id of [...ids].slice(0, 100)) {
    const m = await g<GmailMessage>(`/messages/${id}?format=full`).catch(() => null);
    const p = m && parseGmail(m, ctx.cfg.gmail.skipBulk);
    if (p && storeMessage(ctx, { source: 'gmail', ...p }) !== null) n++;
  }
  kvSet(ctx.db, 'gmail.historyId', latest);
  return n;
}
