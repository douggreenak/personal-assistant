import type { Ctx } from './ctx.ts';
import { storeMessage } from './pipeline.ts';

/**
 * Newer macOS stores message text in `attributedBody` (a typedstream blob) and leaves `text` NULL.
 * The Mac agent sends that blob as hex so the Mac stays tiny; decoding happens here.
 */
export function decodeAttributedBody(hex: string): string | null {
  if (!hex) return null;
  const buf = Buffer.from(hex, 'hex');
  const marker = buf.indexOf('NSString');
  if (marker < 0) return null;
  let i = buf.indexOf(0x2b, marker + 8);   // '+' precedes the length-prefixed UTF-8 string
  if (i < 0) return null;
  i += 1;
  let len = buf[i++];
  if (len === 0x81) { len = buf.readUInt16LE(i); i += 2; }
  else if (len === 0x82) { len = buf.readUInt32LE(i); i += 4; }
  if (!Number.isFinite(len) || len <= 0 || i + len > buf.length) return null;
  return buf.subarray(i, i + len).toString('utf8').replace(/￼/g, '').trim() || null;
}

export interface MacRow { rowid: number; guid: string; text?: string | null; attr_hex?: string | null; date: string; is_from_me: number | boolean; handle?: string | null; chat?: string | null }

const OTP = /\b(verification|security|login|one[- ]time)\b.*\b\d{4,8}\b|\b\d{4,8}\b.*\b(is your|code)\b/i;

/** Stores a batch of rows from the Mac agent; returns how many were new. */
export function ingestMacRows(ctx: Ctx, rows: MacRow[]): { accepted: number; maxRowid: number } {
  let accepted = 0, maxRowid = 0;
  for (const r of rows.slice(0, 500)) {
    maxRowid = Math.max(maxRowid, Number(r.rowid) || 0);
    const text = (r.text && r.text.trim()) || decodeAttributedBody(r.attr_hex ?? '') || '';
    if (!text || OTP.test(text)) continue;
    const mine = !!Number(r.is_from_me);
    const id = storeMessage(ctx, {
      source: 'mac', sourceId: r.guid || `rowid-${r.rowid}`, sender: mine ? 'me' : (r.handle ?? 'unknown'),
      subject: mine && r.handle ? `to ${r.handle}` : '', thread: `mac:${r.chat || r.handle || 'unknown'}`, counterpart: r.handle ?? '', body: text, receivedAt: new Date(r.date).toString() === 'Invalid Date' ? undefined : new Date(r.date).toISOString(),
    });
    if (id !== null) accepted++;
  }
  return { accepted, maxRowid };
}
