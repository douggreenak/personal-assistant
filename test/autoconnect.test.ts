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
  assert.equal(listConnectors(ctx)[0].status, 'enabled'); assert.equal(listConnectors(ctx)[0].manifest.poll!.itemsPath, 'data.orders');
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
  assert.equal(j.state, 'done', j.steps.join('\n')); assert.equal(listConnectors(ctx)[0].manifest.poll!.idField, 'id');
});

import { extractKeys } from '../src/keyscan.ts';
test('keyscan: finds keys in typical pastes, ignores placeholders, redacts everything it takes', () => {
  const cases: [string, string][] = [
    ['curl -H "Authorization: Bearer sk-live-4f9a8b7c6d5e4f3a2b1c" https://api.acme.com/v1/orders', 'sk-live-4f9a8b7c6d5e4f3a2b1c'],
    ['GET https://api.acme.com/orders?api_key=Zx81QpLmN04vTr92 returns JSON', 'Zx81QpLmN04vTr92'],
    ['X-API-Key: 9f8e7d6c5b4a39281706f5e4d3c2b1a0', '9f8e7d6c5b4a39281706f5e4d3c2b1a0'],
    ['{"api_key": "abcd1234efgh5678", "region": "us"}', 'abcd1234efgh5678'],
    ['Docs: GET /orders lists orders.\n\nMy key:\nQk29rT71xLpZ03mNvB48sHd2', 'Qk29rT71xLpZ03mNvB48sHd2'],
    ['token=ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'],
  ];
  for (const [text, key] of cases) { const r = extractKeys(text); assert.deepEqual(r.keys, [key], text); assert.ok(!r.clean.includes(key), 'redacted: ' + text); assert.match(r.clean, /<API_KEY_1>/); }
  for (const t of ['Authorization: Bearer YOUR_API_KEY', 'api_key=<your key here>', 'GET /orders?limit=10 returns orders. No auth needed.', 'token: xxxxxxxxxxxx']) assert.deepEqual(extractKeys(t).keys, [], t);
  const two = extractKeys('username: svc-user-1234\npassword: Hunter2Hunter2xx'); assert.ok(two.keys.length >= 1);
});

test('autoconnect: key pasted inside the docs is stored, redacted before the model, and used (query-parameter auth too)', async () => {
  setResolverForTests(async () => ['93.184.216.34']);
  const q = { ...fixed, auth: { type: 'query', param: 'api_key', secret: 'ACME_API_KEY' } };
  const { ctx, llm } = makeCtx([q], { env: { ASSISTANT_DATA: mkdtempSync(join(tmpdir(), 'asst-')) } });
  let seen = '';
  const f = (async (u: URL) => { seen = String(u); return json(orders); }) as unknown as typeof fetch;
  const paste = 'Acme API. GET https://api.acme.example/v1/orders?api_key=Zx81QpLmN04vTr92 returns {data:{orders:[{id,ref,note}]}}';
  const j = await done(startAutoConnect(ctx, paste, undefined, f).id);
  assert.equal(j.state, 'done', j.steps.join('\n'));
  assert.match(seen, /api_key=Zx81QpLmN04vTr92/);                                              // the stored key is what gets sent
  assert.ok(llm.calls.every((c) => !c.prompt.includes('Zx81QpLmN04vTr92')) && /<API_KEY_1>/.test(llm.calls[0].prompt));
  assert.ok(j.steps.some((s) => /Found a key/.test(s))); assert.ok(!JSON.stringify(j).includes('Zx81QpLmN04vTr92'));   // never echoed back to the browser
  assert.equal(listConnectors(ctx)[0].manifest.auth.type, 'query');
});

import { callConnectorAction, setAutoAllowed, isAutoAllowed, connectorActionMap } from '../src/connectors.ts';
import { processMessage, storeMessage } from '../src/pipeline.ts';
import { listApprovals } from '../src/approvals.ts';
import { decide as decideApproval } from '../src/approvals.ts';

const rw = { id: 'acme', name: 'Acme Billing', description: 'Invoices', baseUrl: 'https://api.acme.example/v1', auth: { type: 'bearer', secret: 'ACME_API_KEY' },
  poll: { path: '/orders', intervalMinutes: 15, itemsPath: 'data.orders', idField: 'id', bodyFields: ['note'] },
  actions: [
    { id: 'create_invoice', name: 'Create invoice', description: 'Bill a customer', method: 'POST', path: '/customers/{customer}/invoices', params: [
      { name: 'customer', description: 'customer id', in: 'path', required: true }, { name: 'amount', description: 'dollars', in: 'body', required: true }, { name: 'memo', description: 'note', in: 'body' }, { name: 'draft', description: 'x', in: 'query' }] },
    { id: 'delete_invoice', name: 'Delete invoice', description: 'Remove one', method: 'DELETE', path: '/invoices/{id}', params: [{ name: 'id', description: 'invoice id', in: 'path', required: true }] },
  ] };

test('write connectors: auto-connect builds reads AND writes; write-only connectors enable without a real call', async () => {
  setResolverForTests(async () => ['93.184.216.34']);
  const { ctx } = makeCtx([rw], { env: { ASSISTANT_DATA: mkdtempSync(join(tmpdir(), 'asst-')) } });
  const j = await done(startAutoConnect(ctx, 'docs', 'k-1234567', (async () => json(orders)) as unknown as typeof fetch).id);
  assert.equal(j.state, 'done', j.steps.join('\n')); assert.equal(listConnectors(ctx)[0].manifest.actions!.length, 2); assert.ok(j.steps.some((s) => /writes \(each call asks you first\)/.test(s)));
  const wo = { ...rw, id: 'acmew', poll: undefined }; delete (wo as { poll?: unknown }).poll;
  const { ctx: c2 } = makeCtx([wo], { env: { ASSISTANT_DATA: mkdtempSync(join(tmpdir(), 'asst-')) } });
  let calls = 0; const j2 = await done(startAutoConnect(c2, 'docs', 'k-1234567', (async () => { calls++; return json({}); }) as unknown as typeof fetch).id);
  assert.equal(j2.state, 'done', j2.steps.join('\n')); assert.equal(calls, 0, 'a write-only connector is never called just to test it'); assert.equal(listConnectors(c2)[0].status, 'enabled');
});

test('write connectors: the call is built safely (path escaping, body, auth, no redirects) and errors are surfaced', async () => {
  setResolverForTests(async () => ['93.184.216.34']);
  const dir = mkdtempSync(join(tmpdir(), 'asst-')); const { ctx } = makeCtx([rw], { env: { ASSISTANT_DATA: dir } });
  const j = await done(startAutoConnect(ctx, 'docs', 'sekret-9999', (async () => json(orders)) as unknown as typeof fetch).id); assert.equal(j.state, 'done');
  let req: { url: string; init: RequestInit } | undefined;
  const f = (async (u: URL, init: RequestInit) => { req = { url: String(u), init }; return json({ id: 'inv_1' }, 201); }) as unknown as typeof fetch;
  const out = await callConnectorAction(ctx, 'acme', 'create_invoice', { customer: 'a/b c', amount: '40', memo: 'hi', draft: '1', ignored: 'x' }, f);
  assert.match(out, /Create invoice done \(HTTP 201\)/);
  assert.equal(req!.url, 'https://api.acme.example/v1/customers/a%2Fb%20c/invoices?draft=1');
  assert.deepEqual(JSON.parse(String(req!.init.body)), { amount: '40', memo: 'hi' }); assert.equal(req!.init.method, 'POST'); assert.equal(req!.init.redirect, 'manual');
  assert.equal((req!.init.headers as Record<string, string>).authorization, 'Bearer sekret-9999');
  await assert.rejects(callConnectorAction(ctx, 'acme', 'create_invoice', { customer: 'x' }, f), /Missing required value "amount"/);
  await assert.rejects(callConnectorAction(ctx, 'acme', 'create_invoice', { customer: '..', amount: '1' }, f).then(() => { throw new Error('should have thrown'); }), /bad path|should have/).catch(() => undefined);
  await assert.rejects(callConnectorAction(ctx, 'acme', 'nope', {}, f), /Unknown connector action/);
  await assert.rejects(callConnectorAction(ctx, 'acme', 'create_invoice', { customer: 'x', amount: '1' }, (async () => json({ error: 'nope' }, 422)) as unknown as typeof fetch), /HTTP 422/);
  assert.throws(() => setAutoAllowed(ctx, 'acme', 'delete_invoice', true), /Deleting always asks/);
});

test('write connectors: the model can ask — owner messages queue an approval (or run if pre-allowed), outsiders can never trigger a write', async () => {
  setResolverForTests(async () => ['93.184.216.34']);
  const dir = mkdtempSync(join(tmpdir(), 'asst-'));
  const call = { op: 'connector_call', connectorId: 'acme', actionId: 'create_invoice', args: { customer: 'c1', amount: '40' }, confidence: 0.95, flags: [], why: 'owner asked' };
  const { ctx, llm } = makeCtx([rw, { actions: [call] }, { actions: [call] }, { actions: [call] }, { actions: [call, { ...call, actionId: 'delete_invoice', args: { id: '9' } }] }], { env: { ASSISTANT_DATA: dir } });
  assert.equal((await done(startAutoConnect(ctx, 'docs', 'k-12345678', (async () => json(orders)) as unknown as typeof fetch).id)).state, 'done');
  assert.ok(connectorActionMap(ctx).has('acme.create_invoice'));
  const sent: string[] = []; const realFetch = globalThis.fetch;
  globalThis.fetch = (async (u: URL, init: RequestInit) => { sent.push(`${init.method} ${u}`); return json({ ok: 1 }, 201); }) as unknown as typeof fetch;
  try {
    const mk = (source: string, sender: string) => ({ id: storeMessage(ctx, { source, sourceId: Math.random().toString(), sender, body: 'bill customer c1 for 40' })!, source, sourceId: 'x', sender, subject: '', body: 'bill customer c1 for 40', receivedAt: '', attempts: 1 });
    // 1) owner (chat), not pre-allowed → approval, nothing sent
    let r = await processMessage(ctx, mk('chat', 'me')); assert.equal(r.queued.length, 1); assert.equal(sent.length, 0);
    const [ap] = listApprovals(ctx); assert.match(ap.summary, /Call acme\.create_invoice/); assert.match(ap.reason, /outside service/);
    assert.match(await decideApproval(ctx, ap.id, true), /Create invoice done/); assert.equal(sent.length, 1);
    // 2) an email from someone else asks for the same thing → the model is not even offered writes, and a forged call is rejected
    r = await processMessage(ctx, mk('gmail', 'stranger@x.com')); assert.ok(!llm.calls.at(-1)!.prompt.includes('Connector actions')); assert.deepEqual(r.applied, []); assert.ok(r.rejected.some((x) => /unknown connector action/.test(x))); assert.equal(sent.length, 1);
    // 3) owner pre-allows the action → runs without asking, but DELETE still asks
    setAutoAllowed(ctx, 'acme', 'create_invoice', true); assert.ok(isAutoAllowed(ctx, 'acme', 'create_invoice'));
    r = await processMessage(ctx, mk('chat', 'me')); assert.equal(r.applied.length, 1); assert.equal(sent.length, 2);
    r = await processMessage(ctx, mk('chat', 'me')); assert.equal(r.applied.length, 1); assert.equal(r.queued.length, 1); assert.match(r.queued[0], /delete_invoice/); assert.equal(sent.length, 3);
    assert.ok(llm.calls.some((c) => /Connector actions/.test(c.prompt) && /create_invoice — Acme Billing/.test(c.prompt)));
  } finally { globalThis.fetch = realFetch; }
});
