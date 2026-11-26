import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, symlinkSync, existsSync, readFileSync, writeFileSync, copyFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeCtx } from './helpers.ts';
import * as C from '../src/code/manager.ts';

const FAKE = new URL('./fixtures/code/fake-claude.mjs', import.meta.url).pathname;
let haveTmux = true; try { execFileSync('tmux', ['-V']); } catch { haveTmux = false; }
const base = mkdtempSync(join(tmpdir(), 'cc-sess-')); const socket = 'test-' + Math.random().toString(36).slice(2, 8);
const root = join(base, 'root'); mkdirSync(root);
const { ctx } = makeCtx([], { env: { ASSISTANT_DATA: join(base, 'data'), CODE_ROOT: root, CODE_CLAUDE_BIN: FAKE, CODE_TMUX_SOCKET: socket, CLAUDE_CONFIG_DIR: join(base, 'cfg'), CODE_MAX_SESSIONS: '2' } });
after(() => { try { execFileSync('tmux', ['-L', socket, 'kill-server']); } catch { /* none running */ } });
const waitFor = async <T>(fn: () => Promise<T | false | undefined | null>, ms = 15000, what = 'condition'): Promise<T> => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out waiting for ' + what); await new Promise((r) => setTimeout(r, 150)); } };
const state = async (id: string) => (await C.live(ctx, id, 0)).screen?.state;

test('code: folders stay inside the projects folder; projects and sessions are validated', { skip: !haveTmux }, async () => {
  const p = await C.addProject(ctx, { name: 'Demo', folder: 'demo', create: true }); assert.equal(p.rel, 'demo'); assert.ok(existsSync(join(root, 'demo')));
  await assert.rejects(C.addProject(ctx, { folder: 'demo' }), /already a project/);
  await assert.rejects(C.addProject(ctx, { folder: '../escape', create: true }), /outside the projects folder/);
  await assert.rejects(C.addProject(ctx, { folder: '/etc', create: true }), /outside/);
  mkdirSync(join(base, 'secret')); symlinkSync(join(base, 'secret'), join(root, 'link')); await assert.rejects(C.addProject(ctx, { folder: 'link/inner', create: true }), /outside/);
  await assert.rejects(C.addProject(ctx, { folder: 'nope' }), /does not exist/); await assert.rejects(C.addProject(ctx, { folder: 'x', cloneUrl: 'http://example.com/a.git' }), /https/);
  await assert.rejects(C.addProject(ctx, { folder: '' }), /Choose a folder/);
  assert.deepEqual(C.listFolders(ctx, '').dirs.map((d) => d.name).sort(), ['demo']); assert.equal(C.listFolders(ctx, 'demo').parent, '');
  assert.throws(() => C.createSession(ctx, p.id, { permissionMode: 'bypassPermissions' }), /turned off/); assert.throws(() => C.createSession(ctx, p.id, { permissionMode: 'nope' }), /Unknown permission/); assert.throws(() => C.createSession(ctx, p.id, { model: 'bad model!' }), /not valid/);
  assert.throws(() => C.getSession(ctx, 'not-a-uuid'), /No such session/); assert.equal(C.renameProject(ctx, p.id, 'Renamed').name, 'Renamed');
});

test('code: a session starts in tmux, takes messages, shows tools and permission questions, stops and resumes (stand-in Claude, no model)', { skip: !haveTmux }, async () => {
  const p = C.listProjects(ctx)[0]; const s = C.createSession(ctx, p.id, { title: 'First', permissionMode: 'manual' });
  await assert.rejects(C.sendMessage(ctx, s.id, 'hi'), /stopped/);
  await C.startSession(ctx, s.id); assert.ok(C.sessionSummaries(ctx)); 
  await waitFor(async () => (await state(s.id)) === 'idle', 15000, 'idle prompt');
  assert.equal(JSON.parse(readFileSync(join(base, 'cfg', '.claude.json'), 'utf8')).projects[p.path].hasTrustDialogAccepted, true);   // first-run screens are skipped
  assert.equal((await C.sessionSummaries(ctx)).find((x) => x.id === s.id)!.running, true);
  // a message
  await C.sendMessage(ctx, s.id, 'hello there');
  let after = 0; const seen: any[] = [];   // eslint-disable-line @typescript-eslint/no-explicit-any
  const pump = async () => { const l = await C.live(ctx, s.id, after); after = l.next; seen.push(...l.msgs); return l; };
  await waitFor(async () => { await pump(); return seen.some((m) => m.t === 'assistant' && m.blocks[0]?.text === 'Echo: hello there'); }, 15000, 'reply');
  assert.ok(seen.some((m) => m.t === 'user' && m.text === 'hello there'));
  assert.ok((C.sessionUsage(ctx, s.id).output ?? 0) > 0);
  // multi-line text arrives intact (bracketed paste)
  await waitFor(async () => (await state(s.id)) === 'idle'); await C.sendMessage(ctx, s.id, 'line one\nline two');
  await waitFor(async () => { await pump(); return seen.some((m) => m.t === 'user' && m.text === 'line one\nline two'); }, 15000, 'multi-line');
  // a local slash command: its on-screen output is returned, and the command list includes custom commands
  await waitFor(async () => (await state(s.id)) === 'idle'); await C.sendMessage(ctx, s.id, '/context');
  assert.equal(await waitFor(async () => (await C.commandOutput(ctx, s.id, '/context')) || false, 8000, 'command output'), 'Context window: 1k of 200k used\n     Messages: 10 tokens');
  mkdirSync(join(p.path, '.claude', 'commands'), { recursive: true }); writeFileSync(join(p.path, '.claude', 'commands', 'ship.md'), '---\ndescription: Ship it\n---\nbody');
  const cl = C.listCommands(ctx, s.id); assert.ok(cl.some((c) => c.name === '/compact' && !c.custom)); assert.deepEqual(cl.find((c) => c.name === '/ship'), { name: '/ship', description: 'Ship it', custom: true });
  // permission mode is switched with Shift+Tab until the footer shows it; Esc interrupts
  await waitFor(async () => (await state(s.id)) === 'idle'); assert.match(await C.setMode(ctx, s.id, 'plan'), /plan mode/); assert.equal(C.getSession(ctx, s.id).permissionMode, 'plan');
  await assert.rejects(C.setMode(ctx, s.id, 'bypassPermissions'), /turned off/); await assert.rejects(C.setMode(ctx, s.id, 'bogus'), /Unknown/); await assert.rejects(C.setModel(ctx, s.id, 'a b;c'), /not valid/);
  await C.interrupt(ctx, s.id); await C.setMode(ctx, s.id, 'manual');
  // a permission question: shown with its options; typing is refused until answered; "No" is reported
  await waitFor(async () => (await state(s.id)) === 'idle'); await C.sendMessage(ctx, s.id, 'PERMISSION please');
  const q = await waitFor(async () => { const l = await pump(); return l.screen?.state === 'permission' ? l.screen : false; }, 15000, 'permission question');
  assert.equal(q.permission!.question, 'Do you want to create perm.txt?'); assert.equal(q.permission!.options.length, 3);
  await assert.rejects(C.sendMessage(ctx, s.id, 'typing now'), /waiting for an answer/);
  await assert.rejects(C.pressKeys(ctx, s.id, ['rm -rf']), /not allowed/); await assert.rejects(C.pressKeys(ctx, s.id, []), /not allowed/);
  await C.pressKeys(ctx, s.id, ['3']);
  await waitFor(async () => { await pump(); return seen.some((m) => m.t === 'result' && m.isError); }, 15000, 'rejection');
  await waitFor(async () => (await state(s.id)) === 'idle'); assert.ok(!existsSync(join(p.path, 'perm.txt')));
  await C.sendMessage(ctx, s.id, 'PERMISSION again'); await waitFor(async () => (await state(s.id)) === 'permission'); await C.pressKeys(ctx, s.id, ['1']);
  await waitFor(async () => existsSync(join(p.path, 'perm.txt')), 10000, 'file written'); await waitFor(async () => (await state(s.id)) === 'idle');
  await pump(); assert.ok(seen.some((m) => m.t === 'assistant' && m.blocks.some((b: any) => b.type === 'tool' && b.name === 'Write')));   // eslint-disable-line @typescript-eslint/no-explicit-any
  // interrupt a long answer
  await C.sendMessage(ctx, s.id, 'SLOW one'); await waitFor(async () => (await state(s.id)) === 'working', 8000, 'working'); const w = (await C.live(ctx, s.id, after)).screen!; assert.match(w.working ?? '', /Pondering/);
  await C.pressKeys(ctx, s.id, ['Escape']); await waitFor(async () => (await state(s.id)) === 'idle', 8000, 'interrupted');
  assert.match((await C.screenText(ctx, s.id)).text, /Interrupted/);
  // the tmux list shows it; stop; stopped sessions say so
  assert.deepEqual((await C.tmuxSessions(ctx)).map((t) => [t.known, t.title]), [[true, 'First']]);
  await C.stopSession(ctx, s.id); assert.equal((await C.live(ctx, s.id, 0)).running, false); assert.equal(C.getSession(ctx, s.id).desired, false);
  // start again: the conversation is resumed and the earlier messages are still there
  await C.startSession(ctx, s.id); await waitFor(async () => (await state(s.id)) === 'idle', 15000, 'resumed');
  const again = await C.live(ctx, s.id, 0); assert.ok(again.msgs.filter((m) => m.t === 'user').length >= 4); assert.equal(again.running, true);
  // limits: only 2 may run at once; a second project's session counts too
  const s2 = C.createSession(ctx, p.id, { title: 'Second' }); const s3 = C.createSession(ctx, p.id, { title: 'Third' }); await C.startSession(ctx, s2.id);
  await assert.rejects(C.startSession(ctx, s3.id), /limit is 2/);
  // killing from the tmux list works and only for our names
  await assert.rejects(C.killTmux(ctx, 'other-thing'), /made by this app/); await C.killTmux(ctx, 'cc-' + s2.id); assert.equal((await C.live(ctx, s2.id, 0)).running, false);
  // boot resume restarts what was running (s is "desired")
  await C.stopSession(ctx, s.id); await C.startSession(ctx, s.id); await C.killTmux(ctx, 'cc-' + s.id); ctx.db.prepare('UPDATE code_sessions SET desired = 1 WHERE id = ?').run(s.id);
  assert.equal(await C.bootResume(ctx), 1); await waitFor(async () => (await state(s.id)) === 'idle', 15000, 'boot resume');
  // plan usage is read from the /usage screen, without a model call
  const pu = await C.planUsage(ctx, true); assert.equal(pu.error, undefined); assert.deepEqual(pu.data!.sections.map((x) => x.label), ['Current session', 'Current week (all models)']);
  assert.equal((await C.tmuxSessions(ctx)).some((t) => t.name === 'cc-probe-usage'), false);   // the throw-away session is gone
  const ov = C.usageOverview(ctx, 7); assert.ok(ov.total.output > 0 && ov.byProject[0].key === 'Renamed' && ov.days.length === 7 && ov.sessions[0].tokens > 0);
  await C.deleteSession(ctx, s.id); assert.equal((await C.tmuxSessions(ctx)).some((t) => t.sessionId === s.id), false);
  await C.removeProject(ctx, p.id); assert.equal(C.listProjects(ctx).length, 0); assert.ok(existsSync(p.path), 'the folder is left alone');
});

test('code: Claude sessions started outside the app (in any tmux server on the host) are found and can be driven', { skip: !haveTmux }, async () => {
  const X = await import('../src/code/external.ts'); const dir = join(base, 'ext'); mkdirSync(dir); const sock = join(dir, 'mine.sock'); const cwd = join(base, 'elsewhere'); mkdirSync(cwd);
  copyFileSync(FAKE, join(dir, 'claude')); chmodSync(join(dir, 'claude'), 0o755);
  process.env.CODE_TMUX_DIRS = dir;
  try {
    execFileSync('tmux', ['-S', sock, 'new-session', '-d', '-s', 'my-own', '-c', cwd, '-e', `CLAUDE_CONFIG_DIR=${join(base, 'cfg')}`, '-x', '120', '-y', '40', '--', join(dir, 'claude'), '--session-id', '99999999-9999-4999-8999-999999999999']);
    execFileSync('tmux', ['-S', sock, 'new-session', '-d', '-s', 'not-claude', '-c', cwd, '--', 'sleep', '600']);
    const found = await waitFor(async () => { const l = (await X.discover(ctx)).filter((e) => e.cwd === cwd); return l.length ? l : false; }, 10000, 'discover');   // (the machine's own tmux sessions may be listed too)
    assert.equal(found.length, 2); const mine = found.find((e) => e.session === 'my-own')!; assert.ok(mine.claude); assert.equal(found.find((e) => e.session === 'not-claude')!.claude, false);
    const key = mine.key; await waitFor(async () => (await X.live(ctx, key, 0)).screen?.state === 'idle', 10000, 'idle');
    await X.send(ctx, key, 'hi from the app'); const l = await waitFor(async () => { const r = await X.live(ctx, key, 0); return r.msgs.some((m) => m.t === 'assistant') ? r : false; }, 10000, 'reply');
    assert.ok(l.msgs.some((m) => m.t === 'user' && m.text === 'hi from the app')); assert.equal((await X.info(ctx, key)).name, 'elsewhere');
    await assert.rejects(X.keys(ctx, key, ['rm -rf'], new Set(['Enter'])), /not allowed/); await assert.rejects(X.info(ctx, 'bm90LWE'), /No such session/);
    const up = await X.upload(ctx, key, Buffer.from('hello'), 'My Notes.PDF'); assert.ok(up.startsWith(join(cwd, '.claude-uploads') + '/') && up.endsWith('-My_Notes.pdf') && readFileSync(up, 'utf8') === 'hello');   // attach works for outside sessions too
    assert.ok((await X.usage(ctx, key)).output > 0); assert.ok((await X.commands(ctx, key)).some((c) => c.name === '/compact'));
    execFileSync('tmux', ['-S', sock, 'kill-server']); assert.deepEqual((await X.discover(ctx)).filter((e) => e.cwd === cwd), []); assert.equal((await X.live(ctx, key, 0)).running, false);
  } finally { delete process.env.CODE_TMUX_DIRS; try { execFileSync('tmux', ['-S', sock, 'kill-server'], { stdio: 'ignore' }); } catch { /* gone */ } }
});
