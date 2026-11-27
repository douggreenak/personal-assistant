import type { Ctx } from '../ctx.ts';
import { getProject, listSessionRows, live as liveManaged, type Live } from './manager.ts';
import { discover, live as liveExternal } from './external.ts';
import type { Msg } from './transcript.ts';

/** A read-only picture of the coding agents in the Code tab (the app's own sessions and Claude Code panes started in a terminal), for the main chat. */
export interface Digest {
  name: string; where: 'app' | 'terminal'; running: boolean; state: string; working?: string; question?: string; lastActivity: string | null; queued: number;
  asked?: string; said?: string; recent: string[];
}

const flat = (s: string, n: number): string => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const toolLine = (name: string, i: Record<string, unknown>): string => { const arg = String(i.command ?? i.file_path ?? i.path ?? i.pattern ?? i.url ?? i.description ?? ''); return `used ${name}${arg ? ' ' + flat(arg, 80) : ''}`; };

/** The last few things that happened, oldest first, as short lines ("You: …", "Claude: …", "used Bash npm test"). */
export function recentLines(msgs: Msg[], max: number): { lines: string[]; asked?: string; said?: string } {
  const lines: string[] = []; let asked: string | undefined, said: string | undefined;
  for (const m of msgs) {
    if (m.t === 'user' && !m.command) { lines.push('You: ' + flat(m.text, 240)); asked = flat(m.text, 240); }
    else if (m.t === 'assistant') for (const b of m.blocks) {
      if (b.type === 'text' && b.text.trim()) { lines.push('Claude: ' + flat(b.text, 400)); said = flat(b.text, 400); }
      else if (b.type === 'tool') lines.push(toolLine(b.name, b.input));
    }
  }
  return { lines: lines.slice(-max), asked, said };
}

function digestOf(name: string, where: Digest['where'], l: Live, depth: number): Digest {
  const sc = l.screen; const r = recentLines(l.msgs, depth);
  const state = !l.running ? 'stopped' : sc?.state === 'working' ? 'working' : sc?.state === 'permission' ? 'needs your OK' : sc?.state === 'dialog' ? 'waiting at a prompt' : sc?.state === 'idle' ? 'idle, waiting for you' : 'running';
  return { name, where, running: l.running, state, working: sc?.working, question: sc?.permission?.question, lastActivity: l.lastActivity, queued: l.queue?.length ?? 0, asked: r.asked, said: r.said, recent: r.lines };
}

const withTimeout = <T>(p: Promise<T>, ms: number, fallback: T): Promise<T> => Promise.race([p, new Promise<T>((res) => setTimeout(() => res(fallback), ms))]);

/** Every agent worth mentioning: the app's sessions (running, or active in the last week) and Claude Code panes found in the host's terminals. */
export async function codeDigests(ctx: Ctx, depth = 6): Promise<Digest[]> {
  if (!ctx.cfg.code.enabled) return [];
  const out: Digest[] = []; const weekAgo = Date.now() - 7 * 86400_000;
  const managed = listSessionRows(ctx).map(async (s) => { try {
    const p = getProject(ctx, s.projectId); const l = await liveManaged(ctx, s.id, 0, Math.max(depth, 6));
    if (!l.running && !(l.lastActivity && Date.parse(l.lastActivity) > weekAgo)) return;
    out.push(digestOf(`${p.name} — ${s.title || s.aiTitle || 'session'}`, 'app', l, depth));
  } catch { /* gone or unreadable: leave it out */ } });
  const external = withTimeout(discover(ctx).then((list) => Promise.all(list.filter((e) => e.claude).map(async (e) => { try {
    const l = await liveExternal(ctx, e.key, 0, Math.max(depth, 6)); if (l.running) out.push(digestOf(`${e.name}${e.session ? ` (${e.session})` : ''}`, 'terminal', l, depth));
  } catch { /* ended */ } }))), 8000, []);
  await Promise.all([...managed, external]);
  const rank = (d: Digest) => (d.state === 'needs your OK' ? 0 : d.state === 'working' ? 1 : d.running ? 2 : 3);
  return out.sort((a, b) => rank(a) - rank(b) || String(b.lastActivity ?? '').localeCompare(String(a.lastActivity ?? '')));
}

export function ago(iso: string | null, now = Date.now()): string {
  if (!iso) return 'no activity yet'; const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return 'just now'; if (s < 3600) return `${Math.round(s / 60)} min ago`; if (s < 86400) return `${Math.round(s / 3600)} h ago`; return `${Math.round(s / 86400)} d ago`;
}

/** Digests whose project/session name the text mentions (words of 3+ letters), for "how is the billing one going?". */
export function mentioned(ds: Digest[], text: string): Digest[] {
  const t = text.toLowerCase();
  return ds.filter((d) => d.name.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !['the', 'and', 'session', 'for'].includes(w)).some((w) => new RegExp(`\\b${w}\\b`).test(t)));
}

/** Plain text for the chat. `detail` = the recent exchange for each agent, not just the last reply. */
export function formatDigests(ds: Digest[], opts: { detail?: boolean; now?: number } = {}): string {
  if (!ds.length) return 'No coding agents are running or active right now.';
  const head = `${ds.length} coding agent${ds.length === 1 ? '' : 's'}:`;
  const blocks = ds.map((d) => {
    const status = d.state === 'working' ? `working${d.working ? ': ' + flat(d.working, 80) : ''}` : d.state === 'needs your OK' ? `needs your OK: ${flat(d.question ?? 'a permission question', 160)}` : d.state;
    const lines = [`*${d.name}* (${d.where === 'app' ? 'in the app' : 'in a terminal'}) — ${status}; last activity ${ago(d.lastActivity, opts.now)}${d.queued ? `; ${d.queued} message${d.queued === 1 ? '' : 's'} waiting` : ''}`];
    if (opts.detail) for (const r of d.recent) lines.push('   ' + r);
    else { if (d.asked) lines.push(`   You last asked: ${flat(d.asked, 160)}`); if (d.said) lines.push(`   Claude last said: ${flat(d.said, 260)}`); }
    return lines.join('\n');
  });
  return [head, ...blocks].join('\n\n');
}

const CODE_WORDS = /\b(coding|code|agents?|claude|sessions?|tmux|terminal|programming|developer|dev)\b/i;
/** Live data for a question about the coding agents ("how is the billing project going?", "are my agents stuck?"), or null when it is about something else. */
export async function codeLive(ctx: Ctx, question: string): Promise<{ connector: string; label: string; ok: boolean; text: string } | null> {
  if (!ctx.cfg.code.enabled) return null;
  const asksCode = CODE_WORDS.test(question);
  const ds = await codeDigests(ctx, asksCode ? 10 : 6).catch(() => [] as Digest[]);
  const named = mentioned(ds, question);
  if (!asksCode && !named.length) return null;
  const pick = named.length ? named : ds;
  return { connector: 'code', label: 'Code tab agents', ok: true, text: formatDigests(pick, { detail: named.length > 0 || pick.length <= 3 }) };
}
