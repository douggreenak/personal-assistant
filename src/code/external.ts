import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Ctx } from '../ctx.ts';
import { makeTmux } from './tmux.ts';
import { parseScreen, type ScreenInfo } from './screen.ts';
import { encodeCwd, readBack, readDelta, scanUsage, estimateCost, type Msg } from './transcript.ts';
import { queuedTexts, sendOrQueue, submitText, CodeError, listCommandsAt, commandOutputOf, writeUpload } from './manager.ts';

/** Claude Code sessions that were started outside this app: any tmux server on the host whose socket the container can see
 *  (the app's own is skipped; its sessions are managed). Found by looking for a pane running `claude`. */
export interface External { state?: string; key: string; socket: string; pane: string; session: string; window: string; cwd: string; name: string; claude: boolean; command: string }
const isClaude = (cmd: string) => /^claude(\.exe)?$/i.test(cmd) || /^\d+\.\d+\.\d+/.test(cmd);
/** Claude Code's own screen: its banner, or the footer under the prompt box. */
const looksLikeClaude = (screen: string) => /Claude Code v?\d|\? for shortcuts|\(shift\+tab to cycle\)|esc to interrupt|accept edits on/.test(screen);
const sockDirs = (): string[] => [`/tmp/tmux-${process.getuid?.() ?? 1000}`, ...(process.env.CODE_TMUX_DIRS ?? '').split(':').filter(Boolean)];
const enc = (socket: string, pane: string) => Buffer.from(JSON.stringify([socket, pane])).toString('base64url');
function dec(ctx: Ctx, key: string): { socket: string; pane: string } {
  let v: unknown; try { v = JSON.parse(Buffer.from(String(key), 'base64url').toString()); } catch { /* bad */ }
  if (!Array.isArray(v) || typeof v[0] !== 'string' || typeof v[1] !== 'string' || !/^%\d{1,7}$/.test(v[1]) || !sockets(ctx).includes(v[0])) throw new CodeError('No such session.', 404);
  return { socket: v[0], pane: v[1] };
}
function sockets(ctx: Ctx): string[] {
  const out: string[] = [];
  for (const d of sockDirs()) { try { for (const f of readdirSync(d)) { const p = join(d, f); try { if (statSync(p).isSocket()) out.push(p); } catch { /* gone */ } } } catch { /* no such dir */ } }
  if (ctx.cfg.code.socket.startsWith('/') && !out.includes(ctx.cfg.code.socket)) out.push(ctx.cfg.code.socket);
  return out;
}
const tmx = (ctx: Ctx, socket: string) => makeTmux(ctx.cfg.code.tmuxBin, socket);

export async function discover(ctx: Ctx): Promise<External[]> {
  if (!ctx.cfg.code.enabled) return [];
  const out: External[] = [];
  await Promise.all(sockets(ctx).map(async (socket) => {
    try { for (const p of await tmx(ctx, socket).panes()) {
      const claude = isClaude(p.command) || (/^(node|bun|deno|bash|zsh|sh)$/.test(p.command) && looksLikeClaude(await tmx(ctx, socket).capture(p.pane).catch(() => '')));
      if ((socket === ctx.cfg.code.socket || basename(socket) === ctx.cfg.code.socket) && p.session.startsWith('cc-')) continue;   // managed by the app
      const state = claude ? parseScreen(await tmx(ctx, socket).capture(p.pane).catch(() => '')).state : undefined;   // so the list can show who is working
      out.push({ state, key: enc(socket, p.pane), socket, pane: p.pane, session: p.session, window: p.window, cwd: p.cwd, name: `${basename(p.cwd) || p.cwd}`, claude, command: p.command });
    } } catch { /* stale socket or another tmux version */ }
  }));
  return out.sort((a, b) => Number(b.claude) - Number(a.claude) || a.cwd.localeCompare(b.cwd) || a.session.localeCompare(b.session));
}

async function target(ctx: Ctx, key: string) {
  const { socket, pane } = dec(ctx, key); const t = tmx(ctx, socket);
  const p = (await t.panes()).find((x) => x.pane === pane); if (!p) throw new CodeError('That session has ended.', 404);
  return { t, pane, cwd: p.cwd, session: p.session };
}
/** The conversation file of the newest session in that folder (a pane does not say which conversation it holds). */
function newestTranscript(ctx: Ctx, cwd: string): string | null {
  const dir = join(ctx.cfg.code.configDir, 'projects', encodeCwd(cwd)); if (!existsSync(dir)) return null;
  let best: [number, string] | null = null;
  for (const f of readdirSync(dir)) if (f.endsWith('.jsonl')) { const m = statSync(join(dir, f)).mtimeMs; if (!best || m > best[0]) best = [m, join(dir, f)]; }
  return best?.[1] ?? null;
}

export async function info(ctx: Ctx, key: string) { const x = await target(ctx, key); return { title: x.session, name: basename(x.cwd) || x.cwd, path: x.cwd }; }
export async function live(ctx: Ctx, key: string, after: number, tail = 0): Promise<{ start?: number; running: boolean; screen: ScreenInfo | null; dialogText?: string; msgs: Msg[]; next: number; title: string; transcript: boolean; queue?: string[]; lastActivity: string | null }> {
  let x; try { x = await target(ctx, key); } catch { return { running: false, screen: null, msgs: [], next: 0, title: '', transcript: false, lastActivity: null }; }
  const raw = await x.t.capture(x.pane).catch(() => ''); const screen = parseScreen(raw); const file = newestTranscript(ctx, x.cwd);
  let msgs: Msg[] = [], next = 0, last: string | null = null; let start = 0; if (file) { const d = tail ? readBack(file, tail) : readDelta(file, after); msgs = d.msgs; next = d.next; if ('start' in d) start = d.start; last = new Date(statSync(file).mtimeMs).toISOString(); }
  const title = [...msgs].reverse().find((m) => m.t === 'title') as { title: string } | undefined;
  return { running: true, screen, dialogText: screen.state === 'dialog' || screen.state === 'unknown' ? raw.replace(/\n{3,}/g, '\n\n').trimEnd().slice(-3000) : undefined, msgs, next, start, title: title?.title ?? x.session, transcript: !!file, lastActivity: last, queue: queuedTexts('x:' + key) };
}
export async function send(ctx: Ctx, key: string, textIn: string): Promise<void> {
  const x = await target(ctx, key); const text = String(textIn ?? '').replace(/\r\n?/g, '\n').replace(/\u0000/g, '').trim();
  if (!text) throw new CodeError('Type a message first.'); if (text.length > 30000) throw new CodeError('That message is too long.');
  const sc = parseScreen(await x.t.capture(x.pane)); if (sc.state === 'permission' || sc.state === 'dialog') throw new CodeError('Claude is waiting for an answer (see the buttons above the message box).');
  await submitText(x.t, x.pane, text, () => x.t.capture(x.pane));
}
/** Like send, but waits for Claude to finish when it is busy. Returns how many messages are waiting (0 = sent now). */
export async function sendOrQueueExternal(ctx: Ctx, key: string, text: string): Promise<number> {
  const x = await target(ctx, key);
  return sendOrQueue('x:' + key, text, async () => ((await x.t.panes()).some((p) => p.pane === x.pane) ? parseScreen(await x.t.capture(x.pane)) : null), () => send(ctx, key, text));
}
export async function keys(ctx: Ctx, key: string, list: string[], allowed: Set<string>, text?: string): Promise<void> {
  const x = await target(ctx, key);
  if (list.length > 8 || list.some((k) => !allowed.has(k))) throw new CodeError('Those keys are not allowed.');
  if (text) await x.t.literal(x.pane, String(text).slice(0, 500).replace(/[\r\n\u0000]/g, ''));
  if (list.length) await x.t.keys(x.pane, list);
}
export async function screen(ctx: Ctx, key: string, scrollback = 0) { try { const x = await target(ctx, key); return { running: true, text: await x.t.capture(x.pane, Math.min(2000, Math.max(0, scrollback))) }; } catch { return { running: false, text: '' }; } }
export async function output(ctx: Ctx, key: string, cmd: string) { const x = await target(ctx, key); return commandOutputOf(x.t, x.pane, cmd); }
export async function commands(ctx: Ctx, key: string) { const x = await target(ctx, key); return listCommandsAt(ctx, x.cwd); }
export async function usage(ctx: Ctx, key: string) {
  const x = await target(ctx, key); const f = newestTranscript(ctx, x.cwd); if (!f) return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: 0, cost: 0, context: 0, model: '' };
  const u = scanUsage(f, ctx.cfg.tz); const t = u.rows.reduce((a, r) => ({ input: a.input + r.input, output: a.output + r.output, cacheRead: a.cacheRead + r.cacheRead, cacheWrite: a.cacheWrite + r.cacheWrite, messages: a.messages + r.messages, cost: a.cost + estimateCost(r) }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: 0, cost: 0 });
  return { ...t, context: u.lastContext, model: u.lastModel };
}
export async function history(ctx: Ctx, key: string, before: number, limit = 30) {
  const x = await target(ctx, key); const f = newestTranscript(ctx, x.cwd); if (!f || before <= 0) return { msgs: [], start: 0 };
  const r = readBack(f, Math.min(100, Math.max(1, limit)), before); return { msgs: r.msgs, start: r.start };
}
export async function upload(ctx: Ctx, key: string, data: Buffer, name: string): Promise<string> { const x = await target(ctx, key); return writeUpload(join(x.cwd, '.claude-uploads'), data, name); }
