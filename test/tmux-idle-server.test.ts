import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { makeTmux } from '../src/code/tmux.ts';

let haveTmux = true; try { execFileSync('tmux', ['-V']); } catch { haveTmux = false; }
const socket = 'test-idle-' + Math.random().toString(36).slice(2, 8);
after(() => { try { execFileSync('tmux', ['-L', socket, 'kill-server']); } catch { /* gone */ } });

test('tmux: a server that is up but has no sessions (the app\'s host server when everything is stopped) is not an error to kill / list / check', { skip: !haveTmux }, async () => {
  execFileSync('tmux', ['-L', socket, 'start-server', ';', 'set', '-g', 'exit-empty', 'off']);
  const t = makeTmux('tmux', socket);
  await t.kill('cc-probe-usage');                           // used to throw "no current target"
  assert.deepEqual(await t.list(), []); assert.equal(await t.has('cc-probe-usage'), false);
});
