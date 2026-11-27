import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pickTranscript } from '../src/code/external.ts';
import { encodeCwd } from '../src/code/transcript.ts';

const line = (role: 'user' | 'assistant', text: string, n: number) => JSON.stringify(role === 'user'
  ? { type: 'user', uuid: 'u' + n, timestamp: '2026-11-27T00:00:0' + n + 'Z', message: { role: 'user', content: text } }
  : { type: 'assistant', uuid: 'a' + n, timestamp: '2026-11-27T00:00:0' + n + 'Z', message: { id: 'm' + n, model: 'x', content: [{ type: 'text', text }] } });

test('code external: a pane is matched to the conversation on its screen, not just the newest file in the folder', () => {
  const cfg = mkdtempSync(join(tmpdir(), 'ext-')); const cwd = '/work/demo'; const dir = join(cfg, 'projects', encodeCwd(cwd)); mkdirSync(dir, { recursive: true });
  const mine = join(dir, 'mine.jsonl'), other = join(dir, 'other.jsonl');
  writeFileSync(mine, [line('user', 'please refactor the billing module', 1), line('assistant', 'Sure, I refactored the billing module for you.', 2)].join('\n') + '\n');
  writeFileSync(other, [line('user', 'what is the weather in Anchorage today', 1), line('assistant', 'It is cold and snowy in Anchorage today.', 2)].join('\n') + '\n');
  utimesSync(mine, new Date(Date.now() - 60000), new Date(Date.now() - 60000));   // the pane's conversation is OLDER by mtime
  const ctx = { cfg: { code: { configDir: cfg } } } as never;
  const screen = '> please refactor the billing module\n● Sure, I refactored the billing module for you.\n> ';
  assert.equal(pickTranscript(ctx, 'k1', cwd, screen), mine);          // matched by content
  assert.equal(pickTranscript(ctx, 'k1', cwd), mine);                  // history/usage calls (no screen) use the same file
  assert.equal(pickTranscript(ctx, 'k2', cwd, 'nothing recognisable'), other);   // no match anywhere: fall back to the newest
  assert.equal(pickTranscript(ctx, 'k1', cwd, 'nothing recognisable'), mine);    // an earlier match is kept, the chat does not flip
});
