/** The owner never wants emoji: every text the server sends or shows goes through this. (Copyright/trademark signs are not emoji and stay.) */
const EMOJI = /(?![©®™])\p{Extended_Pictographic}|[\u{FE0F}\u{200D}\u{20E3}\u{1F3FB}-\u{1F3FF}]/gu;
export const noEmoji = (s: string): string => s.replace(EMOJI, '').replace(/[ \t]{2,}/g, ' ').replace(/^[ \t]+/gm, (m) => m).trimStart();
/** Strips emoji from every string inside a JSON-like value. */
export function noEmojiDeep<T>(v: T): T {
  if (typeof v === 'string') return noEmoji(v) as T;
  if (Array.isArray(v)) return v.map(noEmojiDeep) as T;
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, noEmojiDeep(x)])) as T;
  return v;
}
export const NO_EMOJI_RULE = '\n\nNever use emoji or emoticons in anything you write.';
