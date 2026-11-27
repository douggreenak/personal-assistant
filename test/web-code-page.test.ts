import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The Code page function ends at `return cleanup;` and everything after it is a hoisted function. A `let`/`const` down there is never
// set, and the first click that reads it throws "Cannot access ... before initialization" (that is how "New session" once stopped working).
test('code page: no variables are declared after the page function has returned', () => {
  const src = readFileSync(new URL('../web-src/src/pages/code.js', import.meta.url), 'utf8').split('\n');
  const ret = src.findIndex((l) => /^  return cleanup;\s*$/.test(l)); assert.ok(ret > 0, 'found the return');
  const end = src.findIndex((l, i) => i > ret && /^}/.test(l));
  const stranded = src.slice(ret + 1, end).map((l, i) => ({ l, n: ret + 2 + i })).filter(({ l }) => /^  (let|const|var) /.test(l));
  assert.deepEqual(stranded.map((s) => `${s.n}: ${s.l.trim().slice(0, 60)}`), []);
});
