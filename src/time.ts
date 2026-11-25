/** Timezone helpers without a date library. */
const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'long' });
    fmtCache.set(tz, f);
  }
  return f;
}
export interface LocalParts { year: number; month: number; day: number; hour: number; minute: number; second: number; weekday: string }
export function localParts(d: Date, tz: string): LocalParts {
  const m: Record<string, string> = {};
  for (const p of fmt(tz).formatToParts(d)) m[p.type] = p.value;
  return { year: +m.year, month: +m.month, day: +m.day, hour: +m.hour, minute: +m.minute, second: +m.second, weekday: m.weekday };
}
const tzOffsetMs = (d: Date, tz: string): number => {
  const p = localParts(d, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(d.getTime() / 1000) * 1000;
};
/** "2026-11-27", "2026-11-27T14:30" (interpreted in tz), or full ISO with offset → UTC ISO string. null if unparseable. */
export function toUtcIso(s: string | undefined | null, tz: string, defaultHour = 9): string | null {
  if (!s) return null;
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s) && /T/.test(s)) { const t = Date.parse(s); return Number.isNaN(t) ? null : new Date(t).toISOString(); }
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(s);
  if (!m) return null;
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], m[4] ? +m[4] : defaultHour, m[5] ? +m[5] : 0);
  let utc = wall - tzOffsetMs(new Date(wall), tz);
  utc = wall - tzOffsetMs(new Date(utc), tz);
  return new Date(utc).toISOString();
}
/** "Tuesday 2026-11-24 15:30 (America/Anchorage)" — given to the model so relative dates resolve correctly. */
export function describeNow(d: Date, tz: string): string {
  const p = localParts(d, tz); const z = (n: number) => String(n).padStart(2, '0');
  return `${p.weekday} ${p.year}-${z(p.month)}-${z(p.day)} ${z(p.hour)}:${z(p.minute)} (${tz})`;
}
export const inQuietHours = (d: Date, tz: string, q: { start: number; end: number }): boolean => {
  const h = localParts(d, tz).hour;
  return q.start === q.end ? false : q.start > q.end ? h >= q.start || h < q.end : h >= q.start && h < q.end;
};
/** The next instant at which quiet hours end (local `end`:00). */
export function quietEndsAt(d: Date, tz: string, q: { start: number; end: number }): Date {
  let t = new Date(d.getTime());
  for (let i = 0; i < 48 && inQuietHours(t, tz, q); i++) t = new Date(t.getTime() + 15 * 60000);
  const p = localParts(t, tz);
  return new Date(Math.max(d.getTime(), new Date(toUtcIso(`${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}T${String(q.end).padStart(2, '0')}:00`, tz)!).getTime()));
}
