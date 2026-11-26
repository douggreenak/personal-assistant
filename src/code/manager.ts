import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Ctx } from '../ctx.ts';
import { sniffImage } from '../images.ts';
import { ALLOWED_KEYS, makeTmux, type Tmux } from './tmux.ts';
import { parseScreen, parseUsageScreen, type ScreenInfo } from './screen.ts';
import { estimateCost, readDelta, scanUsage, transcriptPath, type Msg, type UsageRow } from './transcript.ts';

export const PERMISSION_MODES = ['manual', 'acceptEdits', 'auto', 'plan', 'dontAsk', 'bypassPermissions'] as const;
export class CodeError extends Error { status = 400; constructor(m: string, status = 400) { super(m); this.status = status; } }

export interface ProjectRow { id: string; name: string; path: string; rel: string; createdAt: string }
export interface SessionRow { id: string; projectId: string; title: string; aiTitle: string; model: string; permissionMode: string; createdAt: string; startedAt: string | null; desired: boolean }
const tmuxName = (id: string) => `cc-${id}`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tm = (ctx: Ctx): Tmux => makeTmux(ctx.cfg.code.tmuxBin, ctx.cfg.code.socket);

function enabled(ctx: Ctx): void { if (!ctx.cfg.code.enabled) throw new CodeError('The Code tab is turned off (Settings → Code).', 403); }
async function needTmux(ctx: Ctx): Promise<Tmux> { enabled(ctx); const t = tm(ctx); if (!(await t.available())) throw new CodeError('tmux is not installed on the server, so sessions cannot run.', 503); return t; }

// ---------- folders (everything stays inside the projects folder) ----------
export function rootDir(ctx: Ctx): string { const r = resolve(ctx.cfg.code.root); mkdirSync(r, { recursive: true }); return realpathSync(r); }
/** Resolves a folder given relative to the projects folder (or absolute inside it); refuses anything that escapes, symlinks included. */
export function resolveInRoot(ctx: Ctx, input: string): string {
  const root = rootDir(ctx); const raw = String(input ?? '').trim();
  const inside = (p: string) => p === root || p.startsWith(root + sep);
  const abs = isAbsolute(raw) ? resolve(raw) : resolve(root, raw);
  if (!inside(abs)) throw new CodeError('That folder is outside the projects folder.');
  let probe = abs; while (!existsSync(probe) && probe !== root) probe = dirname(probe);
  if (!inside(realpathSync(probe))) throw new CodeError('That folder is outside the projects folder.');
  return abs;
}
export function listFolders(ctx: Ctx, rel: string): { path: string; parent: string | null; dirs: { name: string; rel: string }[] } {
  const root = rootDir(ctx); const dir = resolveInRoot(ctx, rel || root); if (!existsSync(dir)) throw new CodeError('No such folder.', 404);
  const dirs = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules').map((d) => ({ name: d.name, rel: relative(root, join(dir, d.name)) })).sort((a, b) => a.name.localeCompare(b.name)).slice(0, 300);
  return { path: relative(root, dir), parent: dir === root ? null : relative(root, dirname(dir)), dirs };
}

// ---------- projects ----------
const toProject = (ctx: Ctx, r: Record<string, unknown>): ProjectRow => ({ id: r.id as string, name: r.name as string, path: r.path as string, rel: relative(rootDir(ctx), r.path as string) || '.', createdAt: r.created_at as string });
export const listProjects = (ctx: Ctx): ProjectRow[] => (ctx.db.prepare('SELECT * FROM code_projects ORDER BY created_at').all() as Record<string, unknown>[]).map((r) => toProject(ctx, r));
export function getProject(ctx: Ctx, id: string): ProjectRow { const r = ctx.db.prepare('SELECT * FROM code_projects WHERE id = ?').get(id) as Record<string, unknown> | undefined; if (!r) throw new CodeError('No such project.', 404); return toProject(ctx, r); }

function git(args: string[], cwd: string): Promise<string> {
  return new Promise((res, rej) => execFile('git', args, { cwd, timeout: 180000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, maxBuffer: 4 * 1024 * 1024 }, (e, out, err) => (e ? rej(new CodeError(`git: ${(err || e.message).trim().split('\n').slice(-2).join(' ').slice(0, 300)}`)) : res(out))));
}
export async function addProject(ctx: Ctx, o: { name?: string; folder: string; create?: boolean; cloneUrl?: string }): Promise<ProjectRow> {
  enabled(ctx);
  const folder = String(o.folder ?? '').trim(); if (!folder) throw new CodeError('Choose a folder.');
  const dir = resolveInRoot(ctx, folder);
  if (dir === rootDir(ctx)) throw new CodeError('Pick a folder inside the projects folder, not the folder itself.');
  if (ctx.db.prepare('SELECT 1 FROM code_projects WHERE path = ?').get(dir)) throw new CodeError('That folder is already a project.');
  if (o.cloneUrl) {
    if (!/^https:\/\/[^\s]+$/.test(o.cloneUrl)) throw new CodeError('Only https:// repository URLs can be cloned.');
    if (existsSync(dir) && readdirSync(dir).length) throw new CodeError('That folder already has files in it — pick a new folder to clone into.');
    mkdirSync(dirname(dir), { recursive: true }); await git(['clone', '--depth', '50', '--', o.cloneUrl, dir], rootDir(ctx));
  } else if (!existsSync(dir)) {
    if (!o.create) throw new CodeError('That folder does not exist. Tick “create it” to make it.');
    mkdirSync(dir, { recursive: true });
  } else if (!statSync(dir).isDirectory()) throw new CodeError('That is a file, not a folder.');
  const id = randomUUID().slice(0, 8); const name = String(o.name ?? '').trim().slice(0, 60) || basename(dir);
  ctx.db.prepare('INSERT INTO code_projects (id, name, path, created_at) VALUES (?,?,?,?)').run(id, name, dir, new Date().toISOString());
  return getProject(ctx, id);
}
export function renameProject(ctx: Ctx, id: string, name: string): ProjectRow { getProject(ctx, id); const n = String(name ?? '').trim().slice(0, 60); if (!n) throw new CodeError('Give it a name.'); ctx.db.prepare('UPDATE code_projects SET name = ? WHERE id = ?').run(n, id); return getProject(ctx, id); }
export async function removeProject(ctx: Ctx, id: string): Promise<void> {
  getProject(ctx, id); for (const s of listSessionRows(ctx, id)) await stopSession(ctx, s.id).catch(() => {});
  ctx.db.prepare('DELETE FROM code_projects WHERE id = ?').run(id);   // the folder and the conversation files stay on disk
}

// ---------- sessions ----------
const toSession = (r: Record<string, unknown>): SessionRow => ({ id: r.id as string, projectId: r.project_id as string, title: r.title as string, aiTitle: r.ai_title as string, model: r.model as string, permissionMode: r.permission_mode as string, createdAt: r.created_at as string, startedAt: (r.started_at as string) ?? null, desired: !!r.desired });
export const listSessionRows = (ctx: Ctx, projectId?: string): SessionRow[] => (projectId ? ctx.db.prepare('SELECT * FROM code_sessions WHERE project_id = ? ORDER BY created_at DESC').all(projectId) : ctx.db.prepare('SELECT * FROM code_sessions ORDER BY created_at DESC').all()).map((r) => toSession(r as Record<string, unknown>));
export function getSession(ctx: Ctx, id: string): SessionRow { const r = UUID.test(id) ? ctx.db.prepare('SELECT * FROM code_sessions WHERE id = ?').get(id) as Record<string, unknown> | undefined : undefined; if (!r) throw new CodeError('No such session.', 404); return toSession(r); }

export function createSession(ctx: Ctx, projectId: string, o: { title?: string; model?: string; permissionMode?: string }): SessionRow {
  enabled(ctx); getProject(ctx, projectId);
  const model = String(o.model ?? '').trim(); if (model && !/^[\w.\-[\]]{1,60}$/.test(model)) throw new CodeError('That model name is not valid.');
  const mode = String(o.permissionMode ?? '').trim(); if (mode && !(PERMISSION_MODES as readonly string[]).includes(mode)) throw new CodeError('Unknown permission mode.');
  if (mode === 'bypassPermissions' && !ctx.cfg.code.allowBypass) throw new CodeError('“Bypass permissions” is turned off (Settings → Code → Allow bypass).', 403);
  const n = (ctx.db.prepare('SELECT COUNT(*) n FROM code_sessions WHERE project_id = ?').get(projectId) as { n: number }).n + 1;
  const id = randomUUID(); const title = String(o.title ?? '').trim().slice(0, 80) || `Session ${n}`;
  ctx.db.prepare('INSERT INTO code_sessions (id, project_id, title, model, permission_mode, created_at) VALUES (?,?,?,?,?,?)').run(id, projectId, title, model, mode, new Date().toISOString());
  return getSession(ctx, id);
}
export function renameSession(ctx: Ctx, id: string, title: string): SessionRow { getSession(ctx, id); const t = String(title ?? '').trim().slice(0, 80); if (!t) throw new CodeError('Give it a name.'); ctx.db.prepare('UPDATE code_sessions SET title = ? WHERE id = ?').run(t, id); return getSession(ctx, id); }
export async function deleteSession(ctx: Ctx, id: string): Promise<void> { getSession(ctx, id); await stopSession(ctx, id).catch(() => {}); ctx.db.prepare('DELETE FROM code_sessions WHERE id = ?').run(id); }

/** Makes Claude Code skip its first-run screens: onboarding done, and the folder trusted (the owner added it as a project on purpose). */
export function ensureClaudeConfig(ctx: Ctx, projectPath: string): void {
  const file = ctx.cfg.code.globalConfig; let j: Record<string, any> = {};   // eslint-disable-line @typescript-eslint/no-explicit-any
  try { j = JSON.parse(readFileSync(file, 'utf8')); } catch { /* new file */ }
  const before = JSON.stringify([j.hasCompletedOnboarding, j.theme, j.projects?.[projectPath]?.hasTrustDialogAccepted]);
  j.hasCompletedOnboarding = true; j.theme ??= 'dark'; j.projects ??= {}; j.projects[projectPath] ??= { allowedTools: [], mcpContextUris: [], mcpServers: {}, enabledMcpjsonServers: [], disabledMcpjsonServers: [] }; j.projects[projectPath].hasTrustDialogAccepted = true;
  if (JSON.stringify([j.hasCompletedOnboarding, j.theme, j.projects[projectPath].hasTrustDialogAccepted]) === before && existsSync(file)) return;
  mkdirSync(dirname(file), { recursive: true }); const tmp = `${file}.${randomUUID().slice(0, 6)}.tmp`; writeFileSync(tmp, JSON.stringify(j, null, 2), { mode: 0o600 }); renameSync(tmp, file);
}

const runningNames = async (t: Tmux): Promise<Set<string>> => new Set((await t.list()).filter((n) => n.startsWith('cc-')));

export async function startSession(ctx: Ctx, id: string, firstPrompt?: string): Promise<void> {
  const t = await needTmux(ctx); const s = getSession(ctx, id); const p = getProject(ctx, s.projectId);
  if (!existsSync(p.path)) throw new CodeError('The project folder no longer exists.');
  const running = await runningNames(t); if (running.has(tmuxName(id))) { ctx.db.prepare('UPDATE code_sessions SET desired = 1 WHERE id = ?').run(id); return; }
  const live = [...running].filter((n) => !n.startsWith('cc-probe')).length; if (live >= ctx.cfg.code.maxSessions) throw new CodeError(`${live} sessions are already running (the limit is ${ctx.cfg.code.maxSessions}). Stop one first.`);
  if (s.permissionMode === 'bypassPermissions' && !ctx.cfg.code.allowBypass) throw new CodeError('“Bypass permissions” is turned off (Settings → Code).', 403);
  ensureClaudeConfig(ctx, p.path);
  const resumed = !!transcriptPath(ctx.cfg.code.configDir, p.path, id);
  const argv = [ctx.cfg.code.claudeBin, ...(resumed ? ['--resume', id] : ['--session-id', id]), ...(s.model ? ['--model', s.model] : []), ...(s.permissionMode ? ['--permission-mode', s.permissionMode] : [])];
  await t.start(tmuxName(id), p.path, argv, ctx.cfg.code.claudeEnv);
  ctx.db.prepare('UPDATE code_sessions SET started_at = ?, desired = 1 WHERE id = ?').run(new Date().toISOString(), id);
  if (firstPrompt?.trim()) void sendWhenReady(ctx, id, firstPrompt).catch(() => {});
}
export async function stopSession(ctx: Ctx, id: string): Promise<void> { getSession(ctx, id); const t = tm(ctx); await t.kill(tmuxName(id)); ctx.db.prepare('UPDATE code_sessions SET desired = 0 WHERE id = ?').run(id); }
export async function restartSession(ctx: Ctx, id: string): Promise<void> { await stopSession(ctx, id); await sleep(300); await startSession(ctx, id); }

/** Waits for the prompt box, then types the message (used for the "first prompt" given when a session is created). */
export async function sendWhenReady(ctx: Ctx, id: string, text: string, timeoutMs = 60000): Promise<void> {
  const t = tm(ctx); const end = Date.now() + timeoutMs;
  while (Date.now() < end) { if (!(await t.has(tmuxName(id)))) return; const sc = parseScreen(await t.capture(tmuxName(id))); if (sc.state === 'idle') return void (await sendMessage(ctx, id, text)); await sleep(700); }
}

export async function sendMessage(ctx: Ctx, id: string, textIn: string): Promise<void> {
  const t = await needTmux(ctx); getSession(ctx, id); const text = String(textIn ?? '').replace(/\r\n?/g, '\n').replace(/\u0000/g, '').trim();
  if (!text) throw new CodeError('Type a message first.'); if (text.length > 30000) throw new CodeError('That message is too long.');
  const name = tmuxName(id); if (!(await t.has(name))) throw new CodeError('This session is stopped. Start it first.');
  const sc = parseScreen(await t.capture(name)); if (sc.state === 'permission' || sc.state === 'dialog') throw new CodeError('Claude is waiting for an answer (see the buttons above the message box).');
  if (text.includes('\n')) await t.paste(name, text); else await t.literal(name, text);
  await sleep(text.startsWith('/') ? 300 : text.includes('\n') ? 90 : 30); await t.keys(name, ['Enter']);
}
/** Esc: stop what Claude is doing right now (the session stays up). */
export async function interrupt(ctx: Ctx, id: string): Promise<void> {
  const t = await needTmux(ctx); getSession(ctx, id); const name = tmuxName(id); if (!(await t.has(name))) throw new CodeError('This session is stopped.');
  await t.keys(name, ['Escape']);
}
const MODE_LABEL: Record<string, RegExp> = { manual: /manual mode/, acceptEdits: /accept edits/, auto: /auto mode/, plan: /plan mode/, dontAsk: /don.t ?ask/i, bypassPermissions: /bypass permissions/ };
/** Switch the permission mode of a running session the way a person does: Shift+Tab until the footer shows it. */
export async function setMode(ctx: Ctx, id: string, mode: string): Promise<string> {
  const t = await needTmux(ctx); getSession(ctx, id); const want = MODE_LABEL[mode]; if (!want) throw new CodeError('Unknown permission mode.');
  if (mode === 'bypassPermissions' && !ctx.cfg.code.allowBypass) throw new CodeError('“Bypass permissions” is turned off (Settings → Code → Allow bypass).', 403);
  const name = tmuxName(id); if (!(await t.has(name))) throw new CodeError('This session is stopped. Start it first.');
  for (let i = 0; i < 7; i++) {
    const sc = parseScreen(await t.capture(name)); if (sc.state === 'permission' || sc.state === 'dialog') throw new CodeError('Claude is waiting for an answer first.');
    if (sc.mode && want.test(sc.mode)) { ctx.db.prepare('UPDATE code_sessions SET permission_mode = ? WHERE id = ?').run(mode, id); return sc.mode; }
    await t.keys(name, ['BTab']); await sleep(350);
  }
  throw new CodeError('That mode is not available in this session right now (Claude Code only cycles through the modes it has enabled).');
}
/** Switch the model of a running session with Claude Code's own /model command. */
export async function setModel(ctx: Ctx, id: string, modelIn: string): Promise<void> {
  const model = String(modelIn ?? '').trim(); if (!/^[\w.\-[\]]{1,60}$/.test(model)) throw new CodeError('That model name is not valid.');
  await sendMessage(ctx, id, '/model ' + model); ctx.db.prepare('UPDATE code_sessions SET model = ? WHERE id = ?').run(model, id);
}
export async function pressKeys(ctx: Ctx, id: string, keys: unknown): Promise<void> {
  const t = await needTmux(ctx); getSession(ctx, id);
  const list = Array.isArray(keys) ? keys.map(String) : []; if (!list.length || list.length > 8 || list.some((k) => !ALLOWED_KEYS.has(k))) throw new CodeError('Those keys are not allowed.');
  const name = tmuxName(id); if (!(await t.has(name))) throw new CodeError('This session is stopped.');
  await t.keys(name, list);
}
export async function typeText(ctx: Ctx, id: string, text: string): Promise<void> {   // raw text into the terminal (no Enter): for answers typed into a dialog
  const t = await needTmux(ctx); getSession(ctx, id); const name = tmuxName(id); if (!(await t.has(name))) throw new CodeError('This session is stopped.');
  const s = String(text ?? '').slice(0, 500).replace(/[\r\n\u0000]/g, ''); if (s) await t.literal(name, s);
}
export async function screenText(ctx: Ctx, id: string, scrollback = 0): Promise<{ running: boolean; text: string }> {
  const t = await needTmux(ctx); getSession(ctx, id); const name = tmuxName(id); if (!(await t.has(name))) return { running: false, text: '' };
  return { running: true, text: await t.capture(name, Math.min(2000, Math.max(0, scrollback))) };
}

export interface Live { dialogText?: string; running: boolean; screen: ScreenInfo | null; msgs: Msg[]; next: number; title: string; transcript: boolean; lastActivity: string | null }
export async function live(ctx: Ctx, id: string, after: number): Promise<Live> {
  const t = await needTmux(ctx); const s = getSession(ctx, id); const p = getProject(ctx, s.projectId);
  const name = tmuxName(id); const running = await t.has(name);
  const raw = running ? await t.capture(name).catch(() => '') : '';
  const screen = running ? parseScreen(raw) : null;
  const file = transcriptPath(ctx.cfg.code.configDir, p.path, id);
  let msgs: Msg[] = [], next = 0, last: string | null = null;
  if (file) { const d = readDelta(file, after); msgs = d.msgs; next = d.next; last = new Date(statSync(file).mtimeMs).toISOString(); }
  const title = [...msgs].reverse().find((m) => m.t === 'title') as { title: string } | undefined;
  if (title && title.title !== s.aiTitle) ctx.db.prepare('UPDATE code_sessions SET ai_title = ? WHERE id = ?').run(title.title, id);
  return { dialogText: screen && (screen.state === 'dialog' || screen.state === 'unknown') ? raw.replace(/\n{3,}/g, '\n\n').trimEnd().slice(-3000) : undefined, running, screen, msgs, next, title: title?.title ?? s.aiTitle, transcript: !!file, lastActivity: last };
}

export async function sessionSummaries(ctx: Ctx): Promise<{ id: string; running: boolean; state: string }[]> {
  if (!ctx.cfg.code.enabled) return [];
  const t = tm(ctx); const running = (await t.available()) ? await runningNames(t).catch(() => new Set<string>()) : new Set<string>();
  const out: { id: string; running: boolean; state: string }[] = [];
  for (const s of listSessionRows(ctx)) { const name = tmuxName(s.id); if (!running.has(name)) { out.push({ id: s.id, running: false, state: 'stopped' }); continue; }
    out.push({ id: s.id, running: true, state: parseScreen(await t.capture(name).catch(() => '')).state }); }
  return out;
}

/** What a local slash command (/context, /status…) printed on the terminal: the lines after its echoed "❯ /cmd", up to the next rule or empty prompt. The transcript does not keep these. */
export async function commandOutput(ctx: Ctx, id: string, cmd: string): Promise<string> {
  const t = await needTmux(ctx); getSession(ctx, id); const name = tmuxName(id); if (!(await t.has(name))) return '';
  return commandOutputOf(t, name, cmd);
}
export async function commandOutputOf(t: Tmux, name: string, cmd: string): Promise<string> {
  const lines = (await t.capture(name, 400)).split('\n'); const want = '❯ ' + String(cmd).trim(); let at = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i].trimEnd() === want || lines[i].trimEnd().startsWith(want + ' ')) { at = i; break; }
  if (at < 0) return '';
  const out: string[] = []; for (let i = at + 1; i < lines.length; i++) { const l = lines[i]; if (/^[─╌━]{8,}/.test(l.trim()) || /^❯/.test(l)) break; out.push(l.replace(/^\s*⎿\s{0,2}/, '').trimEnd()); }
  return out.join('\n').replace(/^\n+|\s+$/g, '').slice(0, 6000);
}

// ---------- slash commands ----------
const BUILTIN_COMMANDS: [string, string][] = [['/help', 'Show help and commands'], ['/compact', 'Summarize the conversation to free up context'], ['/clear', 'Start a fresh conversation'], ['/context', 'Show what is using the context window'], ['/cost', 'Show token usage for this session'], ['/usage', 'Show plan usage limits'], ['/status', 'Show version, model and account'], ['/model', 'Choose the model'], ['/permissions', 'Manage tool permissions'], ['/config', 'Open settings'], ['/memory', 'Edit CLAUDE.md memory files'], ['/mcp', 'Manage MCP servers'], ['/agents', 'Manage sub-agents'], ['/init', 'Create a CLAUDE.md for this project'], ['/review', 'Review a pull request'], ['/resume', 'Resume another conversation'], ['/rewind', 'Rewind the conversation or code'], ['/todos', 'List the current to-dos'], ['/export', 'Export the conversation'], ['/doctor', 'Check the installation'], ['/vim', 'Toggle vim editing'], ['/exit', 'End the session']];
export function listCommands(ctx: Ctx, id: string) { return listCommandsAt(ctx, getProject(ctx, getSession(ctx, id).projectId).path); }
export function listCommandsAt(ctx: Ctx, projectPath: string): { name: string; description: string; custom: boolean }[] {
  const p = { path: projectPath }; const out = BUILTIN_COMMANDS.map(([name, description]) => ({ name, description, custom: false }));
  const seen = new Set(out.map((c) => c.name));
  const add = (name: string, description: string) => { if (!seen.has(name)) { seen.add(name); out.push({ name, description, custom: true }); } };
  const front = (file: string): string => { try { return /^description:\s*(.+)$/m.exec(readFileSync(file, 'utf8').split('---')[1] ?? '')?.[1]?.trim().slice(0, 120) ?? ''; } catch { return ''; } };
  for (const dir of [join(p.path, '.claude', 'commands'), join(ctx.cfg.code.configDir, 'commands')]) { try { for (const f of readdirSync(dir)) if (/^[\w-]+\.md$/.test(f)) add('/' + f.slice(0, -3), front(join(dir, f)) || 'Custom command'); } catch { /* none */ } }
  for (const dir of [join(p.path, '.claude', 'skills'), join(ctx.cfg.code.configDir, 'skills')]) { try { for (const f of readdirSync(dir)) if (/^[\w:-]+$/.test(f)) add('/' + f, front(join(dir, f, 'SKILL.md')) || 'Skill'); } catch { /* none */ } }
  return out;
}

// ---------- the tmux sessions themselves ----------
export async function tmuxSessions(ctx: Ctx): Promise<{ name: string; known: boolean; sessionId: string | null; title: string | null }[]> {
  const t = await needTmux(ctx); const known = new Map(listSessionRows(ctx).map((s) => [tmuxName(s.id), s]));
  return (await t.list()).map((name) => ({ name, known: known.has(name), sessionId: known.get(name)?.id ?? null, title: known.get(name)?.title ?? null }));
}
export async function killTmux(ctx: Ctx, name: string): Promise<void> { const t = await needTmux(ctx); if (!/^cc-[\w-]{1,60}$/.test(name)) throw new CodeError('Only sessions made by this app can be stopped here.'); await t.kill(name); const s = listSessionRows(ctx).find((x) => tmuxName(x.id) === name); if (s) ctx.db.prepare('UPDATE code_sessions SET desired = 0 WHERE id = ?').run(s.id); }
export async function bootResume(ctx: Ctx): Promise<number> {
  if (!ctx.cfg.code.enabled || !ctx.cfg.code.resumeOnBoot) return 0; const t = tm(ctx); if (!(await t.available())) return 0;
  let n = 0; const running = await runningNames(t);
  for (const s of listSessionRows(ctx)) if (s.desired && !running.has(tmuxName(s.id))) { try { await startSession(ctx, s.id); n++; } catch (e) { console.error('[code] could not resume', s.id, (e as Error).message); } }
  return n;
}

// ---------- pictures ----------
/** Files attached in the Code tab land in <project>/.claude-uploads/ (inside the project, so Claude can read them without a permission prompt). Any file type. */
export function saveUpload(ctx: Ctx, id: string, data: Buffer, nameIn: string): string {
  const s = getSession(ctx, id); const p = getProject(ctx, s.projectId);
  if (!data.length) throw new CodeError('That file is empty.'); if (data.length > 50 * 1024 * 1024) throw new CodeError('Files can be up to 50 MB.');
  const raw = String(nameIn || 'file').split(/[\\/]/).pop()!; const m = /\.([A-Za-z0-9]{1,8})$/.exec(raw); const ext = m ? m[1].toLowerCase() : 'bin';
  const dir = join(p.path, '.claude-uploads'); mkdirSync(dir, { recursive: true });
  const file = join(dir, `${Date.now()}-${raw.replace(/\.[^.]*$/, '').replace(/[^\w-]+/g, '_').slice(0, 50) || 'file'}.${ext}`); writeFileSync(file, data); return file;
}

// ---------- usage ----------
const scanCache = new Map<string, { sig: string; r: ReturnType<typeof scanUsage> }>();
function usageFor(ctx: Ctx, s: SessionRow, p: ProjectRow) {
  const file = transcriptPath(ctx.cfg.code.configDir, p.path, s.id); if (!file) return { rows: [] as UsageRow[], lastContext: 0, lastModel: '' };
  const st = statSync(file); const sig = `${st.size}:${st.mtimeMs}`; const c = scanCache.get(file);
  if (c?.sig === sig) return c.r; const r = scanUsage(file); scanCache.set(file, { sig, r }); return r;
}
const sum = (rows: UsageRow[]) => rows.reduce((a, r) => ({ input: a.input + r.input, output: a.output + r.output, cacheRead: a.cacheRead + r.cacheRead, cacheWrite: a.cacheWrite + r.cacheWrite, messages: a.messages + r.messages, cost: a.cost + estimateCost(r) }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: 0, cost: 0 });
export function sessionUsage(ctx: Ctx, id: string) { const s = getSession(ctx, id); const u = usageFor(ctx, s, getProject(ctx, s.projectId)); return { ...sum(u.rows), context: u.lastContext, model: u.lastModel }; }
export function usageOverview(ctx: Ctx, days = 14) {
  const projects = new Map(listProjects(ctx).map((p) => [p.id, p])); const all: (UsageRow & { session: string; project: string })[] = [];
  const perSession: { id: string; title: string; project: string; tokens: number; cost: number }[] = [];
  for (const s of listSessionRows(ctx)) { const p = projects.get(s.projectId); if (!p) continue; const u = usageFor(ctx, s, p); for (const r of u.rows) all.push({ ...r, session: s.id, project: p.id });
    const t = sum(u.rows); if (t.messages) perSession.push({ id: s.id, title: s.aiTitle || s.title, project: p.name, tokens: t.input + t.output + t.cacheRead + t.cacheWrite, cost: t.cost }); }
  const today = new Date(); const dayList = Array.from({ length: days }, (_, i) => new Date(today.getTime() - (days - 1 - i) * 86400000).toISOString().slice(0, 10));
  const byDay = dayList.map((day) => ({ day, ...sum(all.filter((r) => r.day === day)) }));
  const group = (key: (r: (typeof all)[number]) => string) => { const m = new Map<string, typeof all>(); for (const r of all) m.set(key(r), [...(m.get(key(r)) ?? []), r]); return [...m].map(([k, rows]) => ({ key: k, ...sum(rows) })).sort((a, b) => b.cost - a.cost); };
  const since = (n: number) => sum(all.filter((r) => r.day >= dayList[Math.max(0, dayList.length - n)]));
  return { days: byDay, today: since(1), week: since(7), total: sum(all), byProject: group((r) => projects.get(r.project)?.name ?? r.project), byModel: group((r) => r.model || 'unknown'), sessions: perSession.sort((a, b) => b.cost - a.cost).slice(0, 15), estimate: true };
}

let plan: { at: number; data: ReturnType<typeof parseUsageScreen> | null; error?: string } | null = null; let planBusy: Promise<void> | null = null;
/** Plan limits from Claude Code's own /usage screen (free: it makes no model call). Opens a throw-away tmux session, reads it, closes it. Cached for 5 minutes. */
export async function planUsage(ctx: Ctx, force = false) {
  if (plan && !force && Date.now() - plan.at < 300000) return { ...plan, cached: true };
  if (!planBusy) planBusy = (async () => {
    const t = await needTmux(ctx); const name = 'cc-probe-usage'; await t.kill(name);
    try {
      const dir = rootDir(ctx); ensureClaudeConfig(ctx, dir);
      await t.start(name, dir, [ctx.cfg.code.claudeBin], ctx.cfg.code.claudeEnv); let ready = false;
      for (let i = 0; i < 40 && !ready; i++) { await sleep(700); const sc = parseScreen(await t.capture(name).catch(() => '')); if (sc.state === 'idle') ready = true; else if (sc.state === 'dialog' && i > 6) throw new Error('Claude Code is asking a question I cannot answer (it may need to sign in: run `claude login` once).'); }
      if (!ready) throw new Error('Claude Code did not start in time.');
      await t.literal(name, '/usage'); await sleep(250); await t.keys(name, ['Enter']); await sleep(3500);
      const data = parseUsageScreen(await t.capture(name)); if (!data.sections.length) throw new Error('The usage screen had no limits to show (is this an API-key login?).');
      plan = { at: Date.now(), data };
    } catch (e) { plan = { at: Date.now(), data: null, error: (e as Error).message }; } finally { await t.kill(name).catch(() => {}); }
  })().finally(() => { planBusy = null; });
  await planBusy; return { ...plan!, cached: false };
}
