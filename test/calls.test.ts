import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCtx } from './helpers.ts';
import { callSig, noteCall, sameRequest } from '../src/calls.ts';
import { createApproval } from '../src/approvals.ts';
import type { Action } from '../src/actions.ts';

const call = (args: Record<string, string>): Action => ({ op: 'connector_call', connectorId: 'drive-tracker', actionId: 'create_scheduled', args, confidence: 0.9, flags: [], why: 'x' });

test('the same service call is recognised regardless of argument order', () => {
  assert.equal(callSig(call({ a: '1', b: '2' })), callSig(call({ b: '2', a: '1' })));
  assert.notEqual(callSig(call({ a: '1' })), callSig(call({ a: '2' })));
});

test('a repeat of a request already done today, or already waiting, is noticed', () => {
  const { ctx } = makeCtx([]);
  const a = call({ scheduled: '{"date":"2026-11-27"}' });
  assert.equal(sameRequest(ctx, a).pending, undefined); assert.equal(sameRequest(ctx, a).doneAt, undefined);
  const id = createApproval(ctx, { kind: 'action', summary: 's', reason: 'r', payload: { action: a } });
  assert.equal(sameRequest(ctx, a).pending, id);
  assert.equal(sameRequest(ctx, call({ scheduled: '{"date":"2026-11-28"}' })).pending, undefined, 'a different request is not a repeat');
  noteCall(ctx, a);
  assert.ok(sameRequest(ctx, a).doneAt);
});
