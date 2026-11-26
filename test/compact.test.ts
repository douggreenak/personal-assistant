import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize } from '../src/code/transcript.ts';

test('compaction: the summary is not shown as something you said; the boundary becomes a marker', () => {
  assert.deepEqual(normalize({ type: 'user', uuid: 'a', isCompactSummary: true, message: { content: 'This session is being continued from a previous conversation...' } }), []);
  assert.deepEqual(normalize({ type: 'user', uuid: 'b', message: { content: 'This session is being continued from a previous conversation that ran out of context. Summary: ...' } }), []);
  const n = normalize({ type: 'system', subtype: 'compact_boundary', uuid: 'c', timestamp: 't' });
  assert.equal(n[0].t, 'note'); assert.equal((n[0] as { kind?: string }).kind, 'compact');
});

test('/clear shows as a marker, not as something you typed', () => {
  const n = normalize({ type: 'user', uuid: 'd', timestamp: 't', message: { content: '<command-name>/clear</command-name><command-args></command-args>' } });
  assert.equal(n.length, 1); assert.equal(n[0].t, 'note'); assert.equal((n[0] as { text: string }).text, 'Conversation cleared'); assert.equal((n[0] as { kind?: string }).kind, 'compact');
});

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { currentSessionId, transcriptPath, encodeCwd } from '../src/code/transcript.ts';
test('after /clear the chat follows the new conversation file (derived-from chain)', () => {
  const cfg = mkdtempSync(join(tmpdir(), 'cfg-')); const cwd = '/home/x/Checklist'; const dir = join(cfg, 'projects', encodeCwd(cwd)); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'aaa.jsonl'), '{"type":"mode","sessionId":"aaa"}\n');
  assert.equal(currentSessionId(cfg, cwd, 'aaa'), 'aaa');
  writeFileSync(join(dir, 'bbb.jsonl'), '{"type":"mode"}\n{"type":"derived-from","v":1,"sessionId":"bbb","sessions":[{"id":"aaa","via":"clear"}]}\n');
  writeFileSync(join(dir, 'ccc.jsonl'), '{"type":"derived-from","sessionId":"ccc","sessions":[{"id":"bbb","via":"clear"}]}\n');
  const cfg2 = cfg; void cfg2;
  // (the lookup is cached for ~1.5s per directory, so use a fresh directory for the chained case)
  const dir2 = join(cfg, 'projects', encodeCwd('/home/x/Other')); mkdirSync(dir2, { recursive: true });
  writeFileSync(join(dir2, 'a1.jsonl'), '{}\n'); writeFileSync(join(dir2, 'b1.jsonl'), '{"type":"derived-from","sessions":[{"id":"a1","via":"clear"}]}\n'); writeFileSync(join(dir2, 'c1.jsonl'), '{"type":"derived-from","sessions":[{"id":"b1","via":"clear"}]}\n');
  assert.equal(currentSessionId(cfg, '/home/x/Other', 'a1'), 'c1');
  assert.equal(transcriptPath(cfg, '/home/x/Other', 'a1'), join(dir2, 'c1.jsonl'));
});
