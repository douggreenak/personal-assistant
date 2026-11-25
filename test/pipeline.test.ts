import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCtx } from './helpers.ts';
import { storeMessage, processNext } from '../src/pipeline.ts';
import { decide as policy } from '../src/policy.ts';
import { parseActions } from '../src/actions.ts';
import { decide, listApprovals, announcePending } from '../src/approvals.ts';

const act = (o: Record<string, unknown>) => ({ confidence: 0.9, flags: [], why: 'test', ...o });
const NOW = new Date('2026-11-24T20:00:00Z'); // Tuesday 11:00 in Anchorage

test('one rambling message becomes separate tasks of the right kinds', async () => {
  const { ctx, notify, fakes } = makeCtx([{ actions: [
    act({ op: 'create', kind: 'ticket', title: 'Encoder dropping frames', priority: 'high' }),
    act({ op: 'create', kind: 'reminder', title: 'Order SDI cables', dueAt: '2026-11-25T09:00' }),
    act({ op: 'create', kind: 'task', title: 'Call Sam about the invoice', dueAt: '2026-11-27', flags: ['money'] }),
  ] }], { now: NOW });
  storeMessage(ctx, { source: 'voice', sourceId: 'v1', sender: 'me', body: 'the encoder is dropping frames, remind me to order SDI cables, and call Sam this week about the invoice' });
  assert.equal(await processNext(ctx), true);
  const items = ctx.items.list({ state: 'open' });
  assert.deepEqual(items.map((i) => i.title).sort(), ['Encoder dropping frames', 'Order SDI cables']);
  assert.equal(items.find((i) => i.kind === 'ticket')!.backend, 'ticketing');
  assert.equal(fakes.tickets.length, 1);
  assert.equal(items.find((i) => i.kind === 'reminder')!.nextNagAt, '2026-11-25T18:00:00.000Z'); // 09:00 AKST (UTC-9)
  // the money-flagged one waits for approval instead of being created
  const pend = listApprovals(ctx);
  assert.equal(pend.length, 1);
  assert.match(pend[0].summary, /Call Sam/);
  assert.equal(await processNext(ctx), false);
  await announcePending(ctx);
  assert.ok(notify.sent.some((n) => /needs your OK/.test(n.text)));
});

test('"the cables arrived" completes the matching open item instead of duplicating', async () => {
  const { ctx, llm } = makeCtx((req) => {
    const m = /id=(\S+) \| \w+ \| Order SDI cables/.exec(req.prompt);
    return { actions: m ? [act({ op: 'complete', itemId: m[1], why: 'cables arrived' })] : [] };
  }, { now: NOW });
  const { item } = ctx.items.create({ kind: 'reminder', title: 'Order SDI cables', dueAt: '2026-11-25T17:00:00Z' });
  storeMessage(ctx, { source: 'mac', sourceId: 'm1', sender: 'Sam', body: 'FYI the cables arrived this morning' });
  await processNext(ctx);
  assert.equal(ctx.items.get(item.id)!.state, 'done');
  assert.equal(ctx.items.get(item.id)!.nextNagAt, null);
  assert.match(llm.calls[0].prompt, /Order SDI cables/); // candidate surfaced via keyword match
});

test('ticket progress moves the real ticket through the pipeline; last stage closes the item', async () => {
  const { ctx, fakes } = makeCtx((req) => {
    const m = /id=(\S+) \| ticket/.exec(req.prompt)!;
    return { actions: [act({ op: 'stage', itemId: m[1], stageId: /fixed/.test(req.prompt) ? 'closed' : 'diagnosing' })] };
  });
  storeMessage(ctx, { source: 'voice', sourceId: 'a', sender: 'me', body: 'seed' });
  const { applyAction } = await import('../src/actions.ts');
  const r = await applyAction(ctx, { op: 'create', kind: 'ticket', title: 'Encoder dropping frames', confidence: 1, flags: [], why: '' }, null);
  assert.equal(r.item!.stageLabel, 'Reported');
  storeMessage(ctx, { source: 'voice', sourceId: 'b', sender: 'me', body: 'looking into the encoder now' });
  await processNext(ctx); await processNext(ctx);
  assert.equal(ctx.items.get(r.item!.id)!.stageLabel, 'Diagnosing');
  assert.equal(fakes.tickets[0].stageId, 'diagnosing');
  storeMessage(ctx, { source: 'voice', sourceId: 'c', sender: 'me', body: 'encoder fixed, all good' });
  await processNext(ctx);
  assert.equal(fakes.tickets[0].stageId, 'closed');
  assert.equal(ctx.items.get(r.item!.id)!.state, 'done');
});

test('school work lands in Canopy under the matching class', async () => {
  const { ctx, fakes } = makeCtx([{ actions: [act({ op: 'create', kind: 'task', title: 'Cell respiration worksheet', classHint: 'bio', dueAt: '2026-11-30' })] }]);
  storeMessage(ctx, { source: 'voice', sourceId: 'x', sender: 'me', body: 'bio worksheet due monday' });
  await processNext(ctx);
  assert.equal(fakes.canopyTasks.length, 1);
  assert.equal(fakes.canopyTasks[0].classId, 'c-bio');
  assert.equal(fakes.canopyTasks[0].dueDate, '2026-11-30');
  const it = ctx.items.list()[0];
  assert.equal(it.backend, 'canopy'); assert.equal(it.classId, 'c-bio');
});

test('policy: lean toward adding; ask for money/others/low-confidence changes/drops', () => {
  const cfg = { autoApplyMinConfidence: 0.6 };
  const base = { confidence: 0.9, flags: [] as never[], why: '' };
  assert.equal(policy({ op: 'create', ...base, confidence: 0.1 }, cfg).mode, 'apply');
  assert.equal(policy({ op: 'create', ...base, flags: ['money'] }, cfg).mode, 'ask');
  assert.equal(policy({ op: 'create', ...base, flags: ['others_deadline'] }, cfg).mode, 'ask');
  assert.equal(policy({ op: 'complete', ...base }, cfg).mode, 'apply');
  assert.equal(policy({ op: 'complete', ...base, confidence: 0.4 }, cfg).mode, 'ask');
  assert.equal(policy({ op: 'complete', ...base, flags: ['uncertain'] }, cfg).mode, 'ask');
  assert.equal(policy({ op: 'drop', ...base }, cfg).mode, 'ask');
});

test('approve applies the queued action exactly once; reject discards', async () => {
  const { ctx } = makeCtx([{ actions: [act({ op: 'create', kind: 'task', title: 'Pay vendor', flags: ['money'] }), act({ op: 'create', kind: 'task', title: 'Maybe thing', flags: ['outbound'] })] }]);
  storeMessage(ctx, { source: 'voice', sourceId: 'p', sender: 'me', body: 'pay the vendor, email Bob' });
  await processNext(ctx);
  const [a, b] = listApprovals(ctx);
  assert.match(await decide(ctx, a.id, true), /Task: Pay vendor/);
  assert.match(await decide(ctx, a.id, true), /already approved/);
  assert.match(await decide(ctx, b.id, false), /Rejected/);
  assert.deepEqual(ctx.items.list().map((i) => i.title), ['Pay vendor']);
});

test('prompt-injection style output is neutralised: unknown ids and bad ops are dropped', () => {
  const { actions, rejected } = parseActions({ actions: [
    { op: 'complete', itemId: 'not-a-real-id', confidence: 1, flags: [], why: '' },
    { op: 'delete_everything', confidence: 1, flags: [], why: '' },
    { op: 'create', title: 'ok', confidence: 5, flags: ['bogus'], why: '' },
  ] }, new Set(['real']));
  assert.equal(actions.length, 1);
  assert.equal(actions[0].confidence, 1);
  assert.deepEqual(actions[0].flags, []);
  assert.equal(rejected.length, 2);
});

test('duplicate messages are ignored; LLM failure retries then reports', async () => {
  let now = new Date('2026-11-25T12:00:00Z');
  const { ctx, notify } = makeCtx(() => { throw new Error('boom'); });
  ctx.now = () => now;
  assert.ok(storeMessage(ctx, { source: 'gmail', sourceId: 'g1', sender: 'a@b.c', body: 'hello' }));
  assert.equal(storeMessage(ctx, { source: 'gmail', sourceId: 'g1', sender: 'a@b.c', body: 'hello' }), null);
  assert.equal(await processNext(ctx), true);
  assert.equal(await processNext(ctx), false);                         // backing off, not hammering the model
  for (let i = 0; i < 4; i++) { now = new Date(now.getTime() + 11 * 60000); assert.equal(await processNext(ctx), true); }
  now = new Date(now.getTime() + 11 * 60000);
  assert.equal(await processNext(ctx), false);
  assert.ok(notify.sent.some((n) => /after 5 tries/.test(n.text)));
});

test('automated senders are skipped without calling the model', async () => {
  const { ctx, llm } = makeCtx([]);
  storeMessage(ctx, { source: 'gmail', sourceId: 'n1', sender: 'noreply@shop.com', body: 'Your order shipped' });
  await processNext(ctx);
  assert.equal(llm.calls.length, 0);
});

test('concurrent workers never process the same message twice', async () => {
  let calls = 0;
  const { ctx } = makeCtx(async () => { calls++; await new Promise((r) => setTimeout(r, 30)); return { actions: [act({ op: 'create', kind: 'task', title: 'only once' })] }; });
  storeMessage(ctx, { source: 'chat', sourceId: 'c1', sender: 'me', body: 'do one thing' });
  const { processNextReport } = await import('../src/pipeline.ts');
  const results = await Promise.all([processNextReport(ctx), processNextReport(ctx), processNextReport(ctx)]);
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(calls, 1);
  assert.equal(ctx.items.list().length, 1);
});
