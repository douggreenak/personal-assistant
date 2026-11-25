import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeCtx } from './helpers.ts';
import { setResolverForTests, listConnectors } from '../src/connectors.ts';
import { startAutoConnect, continueWithKey, getJob } from '../src/autoconnect.ts';

const wrong = { id: 'acme', name: 'Acme Orders', description: 'Open orders', baseUrl: 'https://api.acme.example/v1', auth: { type: 'bearer', secret: 'ACME_API_KEY' },
  poll: { path: '/orders', intervalMinutes: 15, itemsPath: 'orders', idField: 'id', titleField: 'ref', bodyFields: ['note'] } };
const fixed = { ...wrong, poll: { ...wrong.poll, itemsPath: 'data.orders' } };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
const done = async (id: string) => { for (let i = 0; i < 200; i++) { const j = getJob(id)!; if (j.state !== 'running') return j; await new Promise((r) => setTimeout(r, 10)); } throw new Error('job never finished'); };
const orders = { data: { orders: [{ id: 1, ref: 'A-1', note: 'needs PO' }, { id: 2, ref: 'A-2', note: 'ok' }] } };

test('autoconnect: paste docs + key → designs, tests, repairs a wrong itemsPath from the real response, enables — no manual steps', async () => {
  setResolverForTests(async () => ['93.184.216.34']);
  const { ctx, llm } = makeCtx([wrong, fixed], { env: { ASSISTANT_DATA: mkdtempSync(join(tmpdir(), 'asst-')) } });
  let auth = '';
  const f = (async (_u: unknown, init: RequestInit) => { auth = (init.headers as Record<string, string>).authorization; return json(orders); }) as unknown as typeof fetch;
  const j = await done(startAutoConnect(ctx, 'Acme docs: GET /orders …', 'sekret-key', f).id);
  assert.equal(j.state, 'done', j.steps.join('\n'));
  assert.equal(auth, 'Bearer sekret-key');
  assert.equal(listConnectors(ctx)[0].status, 'enabled'); assert.equal(listConnectors(ctx)[0].manifest.poll.itemsPath, 'data.orders');
  assert.equal(llm.calls.length, 2); assert.match(llm.calls[1].prompt, /itemsPath did not point to an array/); assert.match(llm.calls[1].prompt, /needs PO/);   // the model saw the real response…
  for (const c of llm.calls) assert.ok(!c.prompt.includes('sekret-key') && !c.system.includes('sekret-key'));                                                     // …but never the key
  assert.ok(j.steps.some((s) => /Adjusted/.test(s)));
});

test('autoconnect: without a key it pauses, then finishes once the key arrives', async () => {
  setResolverForTests(async () => ['93.184.216.34']);
  const { ctx } = makeCtx([fixed], { env: { ASSISTANT_DATA: mkdtempSync(join(tmpdir(), 'asst-')) } });
  const f = (async () => json(orders)) as unknown as typeof fetch;
  const j = await done(startAutoConnect(ctx, 'docs', undefined, f).id);
  assert.equal(j.state, 'needs_key'); assert.equal(j.secret, 'ACME_API_KEY'); assert.equal(listConnectors(ctx)[0].status, 'approved');
  continueWithKey(ctx, j.id, 'k-123', f);
  assert.equal((await done(j.id)).state, 'done'); assert.equal(listConnectors(ctx)[0].status, 'enabled');
  assert.throws(() => continueWithKey(ctx, j.id, 'again', f), /Nothing is waiting/);
});

test('autoconnect: gives up cleanly (removes the connector) when the key is rejected or repair cannot help', async () => {
  setResolverForTests(async () => ['93.184.216.34']);
  const { ctx } = makeCtx([wrong, wrong, wrong], { env: { ASSISTANT_DATA: mkdtempSync(join(tmpdir(), 'asst-')) } });
  const f = (async () => json({ error: 'bad key' }, 401)) as unknown as typeof fetch;
  const j = await done(startAutoConnect(ctx, 'docs', 'wrong-key', f).id);
  assert.equal(j.state, 'failed'); assert.match(j.result!, /HTTP 401/); assert.equal(listConnectors(ctx).length, 0);
});

test('autoconnect: refuses private hosts and bad input; never saves anything', async () => {
  setResolverForTests(async () => ['10.0.0.5']);
  const { ctx } = makeCtx([fixed], { env: { ASSISTANT_DATA: mkdtempSync(join(tmpdir(), 'asst-')) } });
  const j = await done(startAutoConnect(ctx, 'docs', 'k', (async () => json(orders)) as unknown as typeof fetch).id);
  assert.equal(j.state, 'failed'); assert.match(j.result!, /private or internal/); assert.equal(listConnectors(ctx).length, 0);
  const e = await done(startAutoConnect(ctx, '   ', undefined).id); assert.equal(e.state, 'failed'); assert.match(e.result!, /Paste the API docs/);
});

test('autoconnect: a records-missing-idField mismatch is repaired too', async () => {
  setResolverForTests(async () => ['93.184.216.34']);
  const bad = { ...fixed, poll: { ...fixed.poll, idField: 'orderId' } };
  const { ctx } = makeCtx([bad, fixed], { env: { ASSISTANT_DATA: mkdtempSync(join(tmpdir(), 'asst-')) } });
  const j = await done(startAutoConnect(ctx, 'docs', 'k', (async () => json(orders)) as unknown as typeof fetch).id);
  assert.equal(j.state, 'done', j.steps.join('\n')); assert.equal(listConnectors(ctx)[0].manifest.poll.idField, 'id');
});
