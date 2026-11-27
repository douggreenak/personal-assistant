import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeCtx } from './helpers.ts';
import * as C from '../src/code/manager.ts';
import { handleOwnerText } from '../src/commands.ts';
import { ask } from '../src/qa.ts';
import { formatDigests, mentioned, recentLines, ago, type Digest } from '../src/code/overview.ts';

const FAKE = new URL('./fixtures/code/fake-claude.mjs', import.meta.url).pathname;
let haveTmux = true; try { execFileSync('tmux', ['-V']); } catch { haveTmux = false; }
const base = mkdtempSync(join(tmpdir(), 'cc-ov-')); const socket = 'test-' + Math.random().toString(36).slice(2, 8);
const root = join(base, 'root'); mkdirSync(root);
const { ctx, llm } = makeCtx((req) => ({ answer: /Code tab agents/.test(req.prompt) && /Echo: build the invoice page/.test(req.prompt) ? 'The billing agent is idle; it last echoed the invoice page request.' : 'no code data', cited: [] }),
  { env: { ASSISTANT_DATA: join(base, 'data'), CODE_ROOT: root, CODE_CLAUDE_BIN: FAKE, CODE_TMUX_SOCKET: socket, CLAUDE_CONFIG_DIR: join(base, 'cfg'), CODE_TMUX_DIRS: join(base, 'none') } });
after(() => { try { execFileSync('tmux', ['-L', socket, 'kill-server']); } catch { /* none */ } });
const waitFor = async <T>(fn: () => Promise<T | false | undefined>, ms = 15000): Promise<T> => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 150)); } };

test('code overview: formatting and name matching (no tmux needed)', () => {
  const d = (o: Partial<Digest>): Digest => ({ name: 'Billing — invoices', where: 'app', running: true, state: 'idle, waiting for you', lastActivity: new Date(Date.now() - 5 * 60000).toISOString(), queued: 0, recent: ['You: hi', 'Claude: hello'], ...o });
  const a = d({ asked: 'build the invoice page', said: 'Done, the page is built.' }), b = d({ name: 'Website — redesign', state: 'needs your OK', question: 'Do you want to run npm install?' });
  const txt = formatDigests([b, a]);
  assert.match(txt, /2 coding agents/); assert.match(txt, /\*Website — redesign\*[^\n]*needs your OK: Do you want to run npm install\?/); assert.match(txt, /\*Billing — invoices\*[^\n]*idle, waiting for you; last activity 5 min ago/); assert.match(txt, /Claude last said: Done, the page is built\./);
  assert.match(formatDigests([a], { detail: true }), /\n {3}You: hi\n {3}Claude: hello/);
  assert.equal(formatDigests([]), 'No coding agents are running or active right now.');
  assert.deepEqual(mentioned([a, b], 'how is the billing project going?').map((x) => x.name), ['Billing — invoices']); assert.deepEqual(mentioned([a, b], 'what is the weather'), []);
  assert.equal(ago(null), 'no activity yet'); assert.equal(ago(new Date(Date.now() - 3 * 3600_000).toISOString()), '3 h ago');
  const r = recentLines([{ t: 'user', id: '1', ts: '', text: 'run the tests' }, { t: 'assistant', id: '2', msgId: 'm', ts: '', model: '', blocks: [{ type: 'tool', id: 't', name: 'Bash', input: { command: 'npm test' } }, { type: 'text', text: 'All green.' }] }], 5);
  assert.deepEqual(r.lines, ['You: run the tests', 'used Bash npm test', 'Claude: All green.']); assert.equal(r.said, 'All green.');
});

test('code overview: the main chat can see the agents in the Code tab (command + natural question)', { skip: !haveTmux }, async () => {
  const p = await C.addProject(ctx, { name: 'Billing', folder: 'billing', create: true }); const s = C.createSession(ctx, p.id, { title: 'invoices', permissionMode: 'manual' });
  assert.doesNotMatch(await handleOwnerText(ctx, 'code'), /Billing/);                          // the project exists but nothing is running yet (the machine's own terminal agents may be listed)
  await C.startSession(ctx, s.id); await waitFor(async () => (await C.live(ctx, s.id, 0)).screen?.state === 'idle');
  await C.sendMessage(ctx, s.id, 'build the invoice page'); await waitFor(async () => (await C.live(ctx, s.id, 0)).msgs.some((m) => m.t === 'assistant'));
  const all = await handleOwnerText(ctx, 'code');                                              // direct command: no model call
  assert.match(all, /\*Billing — invoices\* \(in the app\)/); assert.match(all, /You last asked: build the invoice page/); assert.match(all, /Claude last said: Echo: build the invoice page/);
  const one = await handleOwnerText(ctx, 'code billing'); assert.match(one, /You: build the invoice page/); assert.match(one, /Claude: Echo: build the invoice page/);
  assert.equal(llm.calls.length, 0);
  const answer = await ask(ctx, 'How is the billing project going?');                          // natural question: the live agent data reaches the model
  assert.match(answer, /billing agent is idle/); assert.match(llm.calls[0].prompt, /<live source="Code tab agents">[\s\S]*Billing — invoices/);
  assert.match(await handleOwnerText(ctx, 'agents'), /Billing — invoices/);
});

import { asksAboutCodeAgents } from '../src/commands.ts';
test('chat: phrasings that mean "check on my coding agents" are recognised; reminders about code are not', () => {
  for (const t of ['code', 'agents', 'Check on the coding agents', 'check on my coding agents', 'How are my coding projects going?', 'how are the agents doing', 'Any update on the agents?', 'status of the coding sessions', 'show me the code sessions', 'what are the claude agents doing']) assert.equal(asksAboutCodeAgents(t), true, t);
  for (const t of ['remind me to review the code sessions tomorrow', 'add a task to check the agents later', 'call Sam about the invoice', 'what is the weather', 'how is the billing going', 'schedule a code review for Friday']) assert.equal(asksAboutCodeAgents(t), false, t);
});
