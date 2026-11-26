import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, copyFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseScreen, parseUsageScreen, resetInZone } from '../src/code/screen.ts';
import { readBack, readDelta, scanUsage, transcriptPath, encodeCwd, estimateCost } from '../src/code/transcript.ts';

const FX = new URL('./fixtures/code/', import.meta.url).pathname;
const screen = (n: string) => readFileSync(FX + n, 'utf8');
const S1 = '11111111-2222-4333-8444-555555555555', S2 = '22222222-2222-4333-8444-555555555555';

test('code: the terminal screen is understood — idle, working, permission question, plan usage (real captures)', () => {
  const idle = parseScreen(screen('screen-idle.txt')); assert.equal(idle.state, 'idle'); assert.equal(idle.mode, 'auto mode');
  const work = parseScreen(screen('screen-working.txt')); assert.equal(work.state, 'working'); assert.match(work.working!, /Razzle-dazzling/);
  const perm = parseScreen(screen('screen-permission.txt'));
  assert.equal(perm.state, 'permission'); assert.equal(perm.permission!.question, 'Do you want to create perm.txt?');
  assert.deepEqual(perm.permission!.options.map((o) => [o.key, o.selected]), [['1', true], ['2', false], ['3', false]]);
  assert.match(perm.permission!.options[1].label, /accept edits/); assert.match(perm.permission!.detail, /Create file/); assert.equal(perm.mode, undefined);
  assert.equal(parseScreen('Welcome to Claude Code\n Let\'s get started\n ❯ ✔ Auto (match terminal)\n').state, 'dialog');
  assert.equal(parseScreen('').state, 'unknown');
  const u = parseUsageScreen(screen('screen-usage.txt'));
  assert.deepEqual(u.sections.map((s) => s.label), ['Current session', 'Current week (all models)']); assert.ok(u.sections.every((s) => s.percent! >= 0 && s.percent! <= 100 && /^[A-Z0-9]/.test(s.resets)));
  assert.match(u.session, /Estimated cost:\s+\$/);
});

test('code: transcripts become chat messages (user, assistant with tool calls, tool results) and tokens are counted once per API message', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-')); mkdirSync(join(dir, 'projects', encodeCwd('/workspace/demo')), { recursive: true });
  const dst = join(dir, 'projects', encodeCwd('/workspace/demo'), S1 + '.jsonl'); copyFileSync(FX + S1 + '.jsonl', dst);
  assert.equal(encodeCwd('/workspace/demo'), '-workspace-demo'); assert.equal(transcriptPath(dir, '/workspace/demo', S1), dst); assert.equal(transcriptPath(dir, '/elsewhere/x', S1), dst, 'found by id even if the folder name differs'); assert.equal(transcriptPath(dir, '/x', 'nope'), null);
  const { msgs, next, size } = readDelta(dst, 0); assert.equal(next, size);
  const kinds = msgs.map((m) => m.t); assert.ok(kinds.includes('user') && kinds.includes('assistant') && kinds.includes('result'));
  const user = msgs.find((m) => m.t === 'user')!; assert.match((user as { text: string }).text, /Create hello\.txt/);
  const tools = msgs.flatMap((m) => (m.t === 'assistant' ? m.blocks.filter((b) => b.type === 'tool') : [])); assert.deepEqual(tools.map((b) => (b as { name: string }).name), ['Write', 'Bash']);
  const results = msgs.filter((m) => m.t === 'result') as { toolUseId: string; text: string }[]; assert.equal(results.length, 2); assert.equal(results[1].text, 'hi');
  assert.ok(msgs.some((m) => m.t === 'assistant' && m.blocks.some((b) => b.type === 'text' && /hello\.txt/.test(b.text)))); assert.ok(msgs.some((m) => m.t === 'title'));
  assert.deepEqual(readDelta(dst, next).msgs, []);                                           // nothing new → nothing returned
  const half = readDelta(dst, 0, 3000); assert.ok(half.next > 0 && half.next < size); assert.equal(readDelta(dst, half.next).next, size);   // reading in chunks loses nothing
  const { rows, lastContext } = scanUsage(dst);
  assert.equal(rows.length, 1); const r = rows[0]; assert.equal(r.messages, 2, 'the two tool-call blocks of one API message count once');
  assert.ok(r.cacheWrite > 40000 && r.output > 100); assert.ok(lastContext > 40000);
  assert.ok(estimateCost(r) > 0.05 && estimateCost(r) < 1);
});

test('code: a second real session (permission prompt, rejected) parses too', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-')); const f = join(dir, S2 + '.jsonl'); copyFileSync(FX + S2 + '.jsonl', f);
  const { msgs } = readDelta(f, 0); const res = msgs.filter((m) => m.t === 'result') as { isError: boolean; text: string }[];
  assert.ok(res.some((x) => x.isError || /reject|denied|doesn't want/i.test(x.text)), JSON.stringify(res));
});

test('code: a long conversation is read from the back in pages that add up to the whole thing, without gaps or repeats', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-back-')); const f = join(dir, 'long.jsonl'); const lines: string[] = [];
  for (let i = 0; i < 700; i++) {
    lines.push(JSON.stringify({ type: 'user', uuid: 'u' + i, timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: 'question ' + i + ' ' + 'x'.repeat(i % 7 * 300) } }));
    lines.push(JSON.stringify({ type: 'assistant', uuid: 'a' + i, timestamp: '2026-01-01T00:00:01Z', message: { id: 'm' + i, role: 'assistant', model: 'x', content: [{ type: 'text', text: 'answer ' + i }] } }));
  }
  writeFileSync(f, lines.join('\n') + '\n{"type":"user","uuid":"half');   // the last line is still being written
  const ids: string[] = []; let r = readBack(f, 40); assert.ok(r.msgs.length >= 40 && r.msgs.length <= 80); ids.unshift(...r.msgs.map((m) => m.id));
  assert.equal(r.msgs.at(-1)!.id, 'a699'); assert.equal(readDelta(f, r.next).msgs.length, 0);   // tail ends at the last complete line; nothing new after it
  let guard = 0; while (r.start > 0 && guard++ < 100) { r = readBack(f, 40, r.start); ids.unshift(...r.msgs.map((m) => m.id)); }
  assert.equal(ids.length, 1400); assert.equal(new Set(ids).size, 1400); assert.equal(ids[0], 'u0'); assert.deepEqual(ids, ids.slice().sort((a, b) => (Number(a.slice(1)) - Number(b.slice(1))) || (a[0] === 'u' ? -1 : 1)));
});

test('code: plan reset times are shown in the owner\'s time zone', () => {
  const now = new Date('2026-11-26T10:00:00Z');   // 01:00 in Anchorage
  assert.equal(resetInZone('2:39am (UTC)', 'America/Anchorage', now), 'today 5:39 PM AKST');   // the next 02:39 UTC is this evening in Alaska
  assert.equal(resetInZone('Nov 27, 5:59pm (UTC)', 'America/Anchorage', now), 'Nov 27, 8:59 AM AKST');
  assert.equal(resetInZone('something else', 'America/Anchorage', now), 'something else');
});
