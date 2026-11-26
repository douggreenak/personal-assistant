import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendOrQueue } from '../src/code/manager.ts';
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
