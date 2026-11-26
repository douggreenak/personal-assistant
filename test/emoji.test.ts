import { test } from 'node:test';
import assert from 'node:assert/strict';
import { noEmoji, noEmojiDeep } from '../src/text.ts';

test('emoji are stripped from everything the server says; ordinary symbols stay', () => {
  assert.equal(noEmoji('Nothing open. \u{1F389}'), 'Nothing open. ');
  assert.equal(noEmoji('\u{1F514}\u{1F514} Call Sam ✅'), 'Call Sam ');
  assert.equal(noEmoji('Copyright © 2026 → next — ok'), 'Copyright © 2026 → next — ok');
  assert.deepEqual(noEmojiDeep({ a: ['x ⚠️ y', { b: '❓?' }] }), { a: ['x y', { b: '?' }] });
});
