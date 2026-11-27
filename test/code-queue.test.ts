import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendOrQueue, restoreQueue, queuedTexts } from '../src/code/manager.ts';
import type { ScreenInfo } from '../src/code/screen.ts';

test('code queue: messages sent while Claude is working wait, then go in order once it is idle', async () => {
  let state: ScreenInfo['state'] = 'working'; const sent: string[] = [];
  const screen = async (): Promise<ScreenInfo> => ({ state });
  const deliver = async (t: string) => { sent.push(t); state = 'working'; };
  assert.equal(await sendOrQueue('t1', 'first', screen, deliver), 1);
  assert.equal(await sendOrQueue('t1', 'second', screen, deliver), 2);
  assert.deepEqual(sent, []);
  state = 'idle';
  for (let i = 0; i < 80 && sent.length < 1; i++) await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(sent, ['first']);
  state = 'idle';
  for (let i = 0; i < 80 && sent.length < 2; i++) await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(sent, ['first', 'second']);
  state = 'idle';
  assert.equal(await sendOrQueue('t1', 'now', screen, deliver), 0);   // idle and nothing waiting: straight in
  assert.deepEqual(sent, ['first', 'second', 'now']);
});

const until = async (f: () => boolean, ms = 12000) => { for (let i = 0; i < ms / 100 && !f(); i++) await new Promise((r) => setTimeout(r, 100)); };

test('code queue: a delivery that fails (e.g. Claude is asking a question) is kept and retried, never dropped', async () => {
  let state: ScreenInfo['state'] = 'working'; const sent: string[] = []; let failures = 2;
  const screen = async (): Promise<ScreenInfo> => ({ state });
  const deliver = async (t: string) => { if (failures-- > 0) throw new Error('Claude is waiting for an answer'); sent.push(t); };
  assert.equal(await sendOrQueue('f1', 'keep me', screen, deliver), 1);
  state = 'idle'; await until(() => sent.length === 1, 20000);
  assert.deepEqual(sent, ['keep me']); assert.deepEqual(queuedTexts('f1'), []);
});

test('code queue: a screen that cannot be read once or twice does not wipe the queue', async () => {
  let state: ScreenInfo['state'] = 'working'; const sent: string[] = []; let calls = 0;
  const screen = async (): Promise<ScreenInfo> => { calls++; if (calls > 1 && calls < 5) throw new Error('tmux hiccup'); return { state }; };
  assert.equal(await sendOrQueue('f2', 'still here', screen, async (t) => { sent.push(t); }), 1);
  assert.deepEqual(queuedTexts('f2'), ['still here']);
  await new Promise((r) => setTimeout(r, 6000)); assert.deepEqual(queuedTexts('f2'), ['still here']);
  state = 'idle'; await until(() => sent.length === 1); assert.deepEqual(sent, ['still here']);
});

test('code queue: messages saved before a restart are put back in line and delivered, and the saved copy follows the queue', async () => {
  let state: ScreenInfo['state'] = 'working'; const sent: string[] = []; const saved: string[][] = [];
  const screen = async (): Promise<ScreenInfo> => ({ state }); const store = { save: (t: string[]) => { saved.push([...t]); } };
  restoreQueue('f3', ['one', 'two'], screen, async (t) => { sent.push(t); state = 'working'; }, store);
  assert.deepEqual(queuedTexts('f3'), ['one', 'two']);
  state = 'idle'; await until(() => sent.length === 1); state = 'idle'; await until(() => sent.length === 2);
  assert.deepEqual(sent, ['one', 'two']); assert.deepEqual(saved.at(-1), []);
});

test('code queue: the database copy tracks the queue (saved, replaced, emptied)', async () => {
  const { openDb } = await import('../src/db.ts'); const { queueStore } = await import('../src/code/manager.ts');
  const db = openDb(':memory:'); const ctx = { db } as never; const st = queueStore(ctx, 's:abc');
  st.save(['a', 'b']); queueStore(ctx, 's:other').save(['z']); st.save(['b']);
  const rows = (k: string) => (db.prepare('SELECT text FROM code_queue WHERE key = ? ORDER BY id').all(k) as { text: string }[]).map((r) => r.text);
  assert.deepEqual(rows('s:abc'), ['b']); assert.deepEqual(rows('s:other'), ['z']); st.save([]); assert.deepEqual(rows('s:abc'), []);
});
