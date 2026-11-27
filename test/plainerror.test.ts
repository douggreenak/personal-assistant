import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plainError } from '../src/plainerror.ts';

test('a service refusal becomes one readable sentence', () => {
  const raw = 'Drive Tracker: POST /api/scheduled → HTTP 422 {"error":"Could not resolve \\"Work\\", \\"Costco\\" to a real street address","field":"start","unresolved":["Work","Costco"],"hint":"Ask the user for the full street address (number, street, city, state)","suggestions":[{"label":"Home","address":"1 A St"';
  const t = plainError(raw);
  assert.equal(t, 'Drive Tracker said: Could not resolve "Work", "Costco" to a real street address. Ask the user for the full street address (number, street, city, state)');
  assert.ok(!/[{}\[\]]/.test(t.replace(/\(.*?\)/g, '')));
});
test('an error with no body still reads well', () => {
  assert.match(plainError('Drive Tracker: POST /api/scheduled → HTTP 500'), /Drive Tracker returned an error \(HTTP 500\)\. It may be a problem on their side/);
  assert.equal(plainError('network down'), 'network down');
});
