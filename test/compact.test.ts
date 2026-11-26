import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize } from '../src/code/transcript.ts';

test('compaction: the summary is not shown as something you said; the boundary becomes a marker', () => {
  assert.deepEqual(normalize({ type: 'user', uuid: 'a', isCompactSummary: true, message: { content: 'This session is being continued from a previous conversation...' } }), []);
  assert.deepEqual(normalize({ type: 'user', uuid: 'b', message: { content: 'This session is being continued from a previous conversation that ran out of context. Summary: ...' } }), []);
  const n = normalize({ type: 'system', subtype: 'compact_boundary', uuid: 'c', timestamp: 't' });
  assert.equal(n[0].t, 'note'); assert.equal((n[0] as { kind?: string }).kind, 'compact');
});
