/**
 * Things the model never needs to see. These are cheap, deterministic checks that keep a message away from Claude (or shrink what is sent),
 * so reading more mail does not mean paying for more of the same text.
 */

const ACK = /^(?:ok(?:ay)?|k|kk|thanks?(?: you| so much)?|thx|ty|got it|sounds good|great|cool|nice|lol|haha+|yes|yep|yeah|no|nope|will do|np|no problem|you(?:'|’)?re welcome|perfect|awesome|good|alright|sure|👍|👌|🙏|😂|❤️?)[\s.!?,👍👌🙏😂❤️]*$/iu;

/** A bare acknowledgement ("ok", "thanks", a thumbs-up) carries nothing to track. */
export const isAcknowledgement = (body: string): boolean => { const t = body.trim(); return t.length > 0 && t.length <= 30 && ACK.test(t); };

/** Why this message can skip the model, or null when it must be read. `linkedOpen`: open items already tied to this conversation (a short reply may be what closes one). */
export function skipReason(m: { source: string; body: string; fromOwner: boolean }, ctx: { linkedOpen: number; duplicate: boolean }): string | null {
  if (m.source === 'chat' || m.source === 'voice') return null;          // the owner talking to the assistant is always read
  if (!m.body.trim()) return 'empty';
  if (ctx.duplicate) return 'repeat';
  if (isAcknowledgement(m.body) && ctx.linkedOpen === 0) return 'acknowledgement';
  return null;
}

const REPLY_MARKERS = [
  /^\s*On .{5,200}wrote:\s*$/i, /^\s*On .{5,120}$/i, /^\s*-{2,}\s*(?:Original Message|Forwarded message)\s*-{2,}/i, /^\s*_{5,}\s*$/, /^\s*From:\s.+\n?\s*(?:Sent|Date):/i,
  /^\s*Sent from my (?:iPhone|iPad|Android|Galaxy|mobile)/i, /^\s*Get Outlook for /i, /^\s*Begin forwarded message/i,
];
/** Strips what an email repeats: the quoted chain below the new text, quote markers, signatures and unsubscribe footers, and collapses long links and blank runs. */
export function trimMail(body: string, max = 6000): string {
  const lines = body.replace(/\r/g, '').split('\n'); const keep: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*On .{5,200}$/.test(l) && (/wrote:\s*$/i.test(l) || /^.{0,80}wrote:\s*$/i.test(lines[i + 1] ?? ''))) break;                       // "On Tue, Nov 4, X wrote:" (may wrap onto the next line)
    if (REPLY_MARKERS.slice(2).some((re) => re.test(l)) && keep.length) break;
    if (/^\s*--\s*$/.test(l) && keep.length) break;                                                                // the "-- " signature separator
    if (/^\s*>/.test(l)) continue;                                                                                 // quoted text
    if (/unsubscribe|view (?:this email )?in (?:your )?browser|manage (?:your )?(?:email )?preferences/i.test(l) && keep.length) break;
    keep.push(l.replace(/https?:\/\/\S{60,}/g, (u) => { try { return new URL(u).origin + '/…'; } catch { return u.slice(0, 40) + '…'; } }));
  }
  const out = keep.join('\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return (out || body.trim()).length > max ? (out || body.trim()).slice(0, max) + ' …[truncated]' : (out || body.trim());   // never trim a message down to nothing
}
