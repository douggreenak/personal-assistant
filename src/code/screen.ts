/** Reads the Claude Code terminal screen (text from tmux capture-pane). Everything the structured transcript can't tell us comes from here. */
export type ScreenState = 'idle' | 'working' | 'permission' | 'dialog' | 'unknown';
export interface PermissionOption { key: string; label: string; selected: boolean }
export interface ScreenInfo { state: ScreenState; working?: string; permission?: { question: string; detail: string; options: PermissionOption[] }; mode?: string; hint?: string }

const OPTION = /^\s*(❯|>)?\s*(\d)\.\s+(.+?)\s*$/;
const RULE = /^[\s─━╌▔▁-]{20,}$/;
const MODE = /(auto mode|manual mode|plan mode|accept edits|bypass permissions|don't ask|dontAsk)(?:\s+on)?/i;

export function parseScreen(text: string): ScreenInfo {
  const lines = text.replace(/\s+$/, '').split('\n'); const tail = lines.slice(-30);
  const joined = tail.join('\n');
  const info: ScreenInfo = { state: 'unknown' };
  const modeLine = tail.filter((l) => l.trim()).slice(-3).reverse().find((l) => MODE.test(l) && !OPTION.test(l)); if (modeLine) info.mode = MODE.exec(modeLine)![1].toLowerCase();
  // A permission question: numbered options plus "Esc to cancel", near the bottom.
  if (/Esc to cancel/.test(joined)) {
    const opts: PermissionOption[] = []; let first = -1;
    tail.forEach((l, i) => { const m = OPTION.exec(l); if (m && (opts.length === 0 || Number(m[2]) === opts.length + 1)) { if (first < 0) first = i; opts.push({ key: m[2], label: m[3], selected: !!m[1] }); } });
    if (opts.length >= 2) {
      let q = first - 1; while (q >= 0 && !tail[q].trim()) q--;
      const above: string[] = []; for (let i = Math.max(0, q - 12); i <= q; i++) above.push(tail[i]);
      return { ...info, state: 'permission', permission: { question: (tail[q] ?? '').trim(), detail: above.filter((l) => l.trim() && !RULE.test(l)).slice(0, -1).join('\n').trim(), options: opts } };
    }
    return { ...info, state: 'dialog', hint: tail.filter((l) => l.trim() && !RULE.test(l)).join('\n').trim() };   // trust prompt, theme picker, login… — answer in the terminal view
  }
  if (/Press Enter to continue|Let's get started|Choose the text style|trust this folder/i.test(joined)) return { ...info, state: 'dialog', hint: tail.filter((l) => l.trim()).join('\n') };
  const working = tail.find((l) => /^\s*[✻✶✳✢✽·*●]\s+\S.*…/.test(l) && /\(\d+s|\besc to interrupt\b|tokens\)/.test(l));
  if (/esc to interrupt/i.test(joined) || working) return { ...info, state: 'working', working: (working ?? '').replace(/^\s*\S\s+/, '').trim() || undefined };
  if (tail.some((l) => /^\s*❯/.test(l)) || modeLine) return { ...info, state: 'idle' };
  return info;
}

export interface UsageSection { label: string; percent: number | null; resets: string }
/** The /usage screen: plan limits ("Current session 54% used, Resets 2:40am"), plus the raw text for anything we don't parse. */
export function parseUsageScreen(text: string): { sections: UsageSection[]; session: string; raw: string } {
  const lines = text.split('\n').map((l) => l.replace(/\s+$/, '')); const sections: UsageSection[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /(\d{1,3})%\s*used/.exec(lines[i]); if (!m) continue;
    let label = ''; for (let k = i - 1; k >= Math.max(0, i - 3); k--) { const t = lines[k].trim(); if (t && !/[█▌░▒▓]{3,}/.test(t) && !/^Resets/.test(t)) { label = t; break; } }
    const resets = (lines.slice(i + 1, i + 3).find((l) => /^\s*Resets/.test(l)) ?? '').trim().replace(/^Resets\s*/, '');
    sections.push({ label: label || 'Usage', percent: Number(m[1]), resets });
  }
  const s = lines.findIndex((l) => /^\s*Session\s*$/.test(l)); const sessionLines: string[] = [];
  if (s >= 0) for (let i = s + 1; i < lines.length && lines[i].trim() && !/to switch|Esc to close/.test(lines[i]); i++) sessionLines.push(lines[i].trim());
  return { sections, session: sessionLines.join('\n'), raw: lines.filter((l) => l.trim()).join('\n') };
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const partsIn = (ms: number, zone: string) => Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' }).formatToParts(new Date(ms)).filter((x) => x.type !== 'literal').map((x) => [x.type, Number(x.value)])) as Record<'year' | 'month' | 'day' | 'hour' | 'minute', number>;
/** The instant at which a wall clock in `zone` shows the given date/time. */
function wallToMs(y: number, mo: number, d: number, h: number, mi: number, zone: string): number {
  let guess = Date.UTC(y, mo - 1, d, h, mi);
  for (let i = 0; i < 3; i++) { const p = partsIn(guess, zone); guess += Date.UTC(y, mo - 1, d, h, mi) - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute); }
  return guess;
}
/** Claude's "Resets 2:39am (UTC)" / "Resets Nov 27, 5:59pm (UTC)" shown in the owner's time zone ("Nov 26, 5:39 PM AKST"). Anything it cannot read is returned unchanged. */
export function resetInZone(text: string, tz: string, now = new Date()): string {
  const m = /^(?:([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+)?(\d{1,2})(?::(\d{2}))?\s*([ap]m)\s*(?:\(([^)]+)\))?/i.exec(text.trim()); if (!m) return text;
  try {
    const zone = m[6]?.trim() || tz; let h = Number(m[3]) % 12 + (m[5].toLowerCase() === 'pm' ? 12 : 0); const mi = Number(m[4] ?? 0);
    const nowP = partsIn(now.getTime(), zone); let ms: number;
    if (m[1]) { const mo = MONTHS.indexOf(m[1].toLowerCase()) + 1; if (!mo) return text; ms = wallToMs(nowP.year, mo, Number(m[2]), h, mi, zone); if (ms < now.getTime() - 86400000) ms = wallToMs(nowP.year + 1, mo, Number(m[2]), h, mi, zone); }
    else { ms = wallToMs(nowP.year, nowP.month, nowP.day, h, mi, zone); if (ms < now.getTime()) ms += 86400000; }
    const f = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-US', { timeZone: tz, ...o }).format(new Date(ms));
    const sameDay = f({ year: 'numeric', month: 'numeric', day: 'numeric' }) === new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric' }).format(now);
    return (sameDay ? 'today ' : f({ month: 'short', day: 'numeric' }) + ', ') + f({ hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
  } catch { return text; }
}
