import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { makeCtx } from './helpers.ts';
import { nagTick, nagGapMinutes, ack, parseSnooze, snooze } from '../src/nag.ts';
import { decodeAttributedBody, ingestMacRows } from '../src/mac.ts';
import { parseGmail, pollGmail } from '../src/google/gmail.ts';
import { parseChatEvent, isAllowed, ChatBot } from '../src/google/chat.ts';
import { ServiceAccount } from '../src/google/auth.ts';
import { setResolverForTests, validateManifest, assertPublicHttps, isPrivateIp, proposeConnector, testConnector, enableConnector, runConnectors, listConnectors } from '../src/connectors.ts';
import { decide, listApprovals } from '../src/approvals.ts';
import { canopySync } from '../src/sync/canopy.ts';
import { CanopyClient } from '../src/backends/canopy.ts';
import { applyTicketingEvent } from '../src/sync/ticketing.ts';
import { indexPaths } from '../src/index/indexer.ts';
import { ask } from '../src/qa.ts';
import { handleOwnerText } from '../src/commands.ts';
import { createHttp } from '../src/http.ts';
import { toUtcIso, inQuietHours } from '../src/time.ts';
import { storeMessage } from '../src/pipeline.ts';
import { ingestVoice } from '../src/voice.ts';

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });

test('time: local wall time → UTC honours Alaska standard/daylight offsets; quiet hours wrap midnight', () => {
  assert.equal(toUtcIso('2026-11-25T09:00', 'America/Anchorage'), '2026-11-25T18:00:00.000Z'); // AKST -9
  assert.equal(toUtcIso('2026-07-01T09:00', 'America/Anchorage'), '2026-07-01T17:00:00.000Z'); // AKDT -8
  assert.equal(toUtcIso('2026-11-25', 'America/Anchorage'), '2026-11-25T18:00:00.000Z');
  assert.equal(toUtcIso('2026-11-25T09:00:00-05:00', 'America/Anchorage'), '2026-11-25T14:00:00.000Z');
  assert.equal(toUtcIso('soon', 'America/Anchorage'), null);
  const q = { start: 22, end: 7 };
  assert.equal(inQuietHours(new Date('2026-11-25T08:00:00Z'), 'America/Anchorage', q), true);   // 23:00 local
  assert.equal(inQuietHours(new Date('2026-11-25T20:00:00Z'), 'America/Anchorage', q), false);  // 11:00 local
});

test('nagging: repeats on schedule until acknowledged, holds during quiet hours, urgent breaks through', async () => {
  let now = new Date('2026-11-25T20:00:00Z'); // 11:00 AKST
  const { ctx, notify } = makeCtx([], { now });
  ctx.now = () => now;
  const { item } = ctx.items.create({ kind: 'reminder', title: 'Order SDI cables', dueAt: now.toISOString() });
  assert.equal(await nagTick(ctx), 1);
  assert.equal(await nagTick(ctx), 0);                                  // not due again yet
  now = new Date(now.getTime() + 15 * 60000); assert.equal(await nagTick(ctx), 1);
  now = new Date(now.getTime() + 15 * 60000); assert.equal(await nagTick(ctx), 1);
  assert.equal(ctx.items.get(item.id)!.nagCount, 3);
  assert.match(notify.sent.at(-1)!.text, /reminder #3/);
  assert.deepEqual([1, 2, 3, 4, 5, 9].map((n) => nagGapMinutes(n, [15, 15, 30, 60])), [15, 15, 30, 60, 60, 60]);
  ack(ctx, ctx.items.get(item.id)!);
  now = new Date(now.getTime() + 3 * 3600000);
  assert.equal(await nagTick(ctx), 0);                                  // acknowledged → silence
  assert.equal(ctx.items.get(item.id)!.state, 'done');

  // quiet hours: 23:00 local
  now = new Date('2026-11-25T08:00:00Z');
  const a = ctx.items.create({ kind: 'reminder', title: 'quiet one', dueAt: now.toISOString() }).item;
  const u = ctx.items.create({ kind: 'reminder', title: 'urgent one', dueAt: now.toISOString(), priority: 'urgent' }).item;
  const before = notify.sent.length;
  assert.equal(await nagTick(ctx), 1);
  assert.match(notify.sent[before].text, /urgent one/);
  assert.equal(ctx.items.get(a.id)!.nextNagAt, '2026-11-25T16:00:00.000Z');   // held until 07:00 local
  assert.ok(u);
});

test('snooze parsing and effect', () => {
  const now = new Date('2026-11-25T20:00:00Z'); const q = { start: 22, end: 7 };
  assert.equal(parseSnooze('2h', now, 'America/Anchorage', q)!.toISOString(), '2026-11-25T22:00:00.000Z');
  assert.equal(parseSnooze('30 min', now, 'America/Anchorage', q)!.toISOString(), '2026-11-25T20:30:00.000Z');
  assert.equal(parseSnooze('whenever', now, 'America/Anchorage', q), null);
  const { ctx } = makeCtx([]);
  const { item } = ctx.items.create({ kind: 'reminder', title: 'x' });
  assert.equal(snooze(ctx, item, new Date('2026-12-01T00:00:00Z')).nextNagAt, '2026-12-01T00:00:00.000Z');
});

test('Mac: decodes attributedBody typedstream; skips OTP codes; idempotent by guid; own texts are from "me"', () => {
  const text = 'Call Sam about the invoice';
  const blob = Buffer.concat([Buffer.from([0x04, 0x0b]), Buffer.from('streamtyped'), Buffer.from('NSMutableString'), Buffer.from('NSString'), Buffer.from([0x01, 0x94, 0x84, 0x01, 0x2b, text.length]), Buffer.from(text), Buffer.from([0x86])]);
  assert.equal(decodeAttributedBody(blob.toString('hex')), text);
  const long = 'x'.repeat(200);
  const blob2 = Buffer.concat([Buffer.from('NSString'), Buffer.from([0x01, 0x94, 0x84, 0x01, 0x2b, 0x81, 200, 0]), Buffer.from(long)]);
  assert.equal(decodeAttributedBody(blob2.toString('hex')), long);
  assert.equal(decodeAttributedBody('deadbeef'), null);
  const { ctx } = makeCtx([]);
  const rows = [
    { rowid: 1, guid: 'g1', text: null, attr_hex: blob.toString('hex'), date: '2026-11-25T20:00:00Z', is_from_me: 1, handle: '+19075550100' },
    { rowid: 2, guid: 'g2', text: 'Your verification code is 482913', date: '2026-11-25T20:01:00Z', is_from_me: 0, handle: '22000' },
    { rowid: 3, guid: 'g3', text: 'dinner at 6?', date: '2026-11-25T20:02:00Z', is_from_me: 0, handle: '+19075550101' },
  ];
  assert.deepEqual(ingestMacRows(ctx, rows), { accepted: 2, maxRowid: 3 });
  assert.deepEqual(ingestMacRows(ctx, rows), { accepted: 0, maxRowid: 3 });
  const m = ctx.db.prepare("SELECT sender, body FROM messages WHERE source_id = 'g1'").get() as { sender: string; body: string };
  assert.deepEqual({ ...m }, { sender: 'me', body: text });
});

test('Gmail: parses multipart, skips promos/bulk/drafts, keeps sent mail; poll starts from "now" and follows history', async () => {
  const b64 = (s: string) => Buffer.from(s).toString('base64url');
  const msg = (id: string, labels: string[], headers: Record<string, string>, text = 'Please send the quote by Friday') => ({
    id, labelIds: labels, internalDate: '1764000000000',
    payload: { mimeType: 'multipart/alternative', headers: Object.entries(headers).map(([name, value]) => ({ name, value })), parts: [{ mimeType: 'text/plain', body: { data: b64(text) } }, { mimeType: 'text/html', body: { data: b64('<b>html</b>') } }] },
  });
  const ok = parseGmail(msg('1', ['INBOX'], { From: 'Bob <bob@x.com>', Subject: 'Quote' }), true)!;
  assert.equal(ok.body, 'Please send the quote by Friday'); assert.equal(ok.sender, 'Bob <bob@x.com>');
  assert.equal(parseGmail(msg('2', ['INBOX', 'CATEGORY_PROMOTIONS'], { From: 'a' }), true), null);
  assert.equal(parseGmail(msg('3', ['INBOX'], { From: 'a', 'List-Unsubscribe': '<x>' }), true), null);
  assert.equal(parseGmail(msg('4', ['DRAFT'], { From: 'a' }), true), null);
  assert.equal(parseGmail(msg('5', ['SENT'], { From: 'me', To: 'sam@x.com', Subject: 'Re: invoice' }), true)!.sender, 'me');
  const html = { id: '6', labelIds: ['INBOX'], payload: { mimeType: 'text/html', headers: [{ name: 'From', value: 'a' }], body: { data: b64('<p>Hello<br>there</p>') } } };
  assert.match(parseGmail(html, true)!.body, /Hello\s+there/);

  const { ctx } = makeCtx([]);
  const calls: string[] = [];
  const f = (async (url: string) => {
    calls.push(url); const u = new URL(url);
    if (u.pathname.endsWith('/profile')) return json({ historyId: '100' });
    if (u.pathname.endsWith('/history')) return json({ history: [{ messagesAdded: [{ message: { id: 'm1' } }, { message: { id: 'm2' } }] }], historyId: '105' });
    if (u.pathname.endsWith('/messages/m1')) return json(msg('m1', ['INBOX'], { From: 'Bob', Subject: 'Quote' }));
    if (u.pathname.endsWith('/messages/m2')) return json(msg('m2', ['INBOX', 'CATEGORY_SOCIAL'], { From: 'x' }));
    return json({}, 404);
  }) as unknown as typeof fetch;
  const auth = { token: async () => 't' };
  assert.equal(await pollGmail(ctx, auth, f), 0);          // first run: only records the starting point
  assert.equal(await pollGmail(ctx, auth, f), 1);          // second: m1 stored, m2 filtered
  assert.ok(calls.some((c) => c.includes('startHistoryId=100')));
  assert.equal(await pollGmail(ctx, auth, f), 1 - 1 + 0 || 0);   // m1 is a known message now → nothing new
});

test('Chat: parses both event shapes; only allow-listed humans are obeyed; DM space is remembered', async () => {
  const classic = { type: 'MESSAGE', message: { text: '@Assistant open', argumentText: ' open', name: 'spaces/S/messages/1', sender: { name: 'users/1', email: 'me@x.com', type: 'HUMAN' }, thread: { name: 'spaces/S/threads/T' } }, space: { name: 'spaces/S', type: 'DM' }, user: { name: 'users/1', email: 'me@x.com', type: 'HUMAN' } };
  const c1 = parseChatEvent(classic)!; assert.equal(c1.text, 'open'); assert.equal(c1.space, 'spaces/S');
  const modern = { chat: { user: { name: 'users/1', email: 'me@x.com', type: 'HUMAN' }, messagePayload: { space: { name: 'spaces/S', spaceType: 'DIRECT_MESSAGE' }, message: { text: 'open', name: 'm' } } } };
  const c2 = parseChatEvent(modern)!; assert.equal(c2.senderEmail, 'me@x.com'); assert.equal(c2.spaceType, 'DIRECT_MESSAGE');
  assert.equal(isAllowed(['me@x.com'], c1), true);
  assert.equal(isAllowed(['ME@x.com'], c1), true);
  assert.equal(isAllowed([], c1), false);                                // empty allow-list = nobody
  assert.equal(isAllowed(['me@x.com'], { ...c1, senderEmail: 'evil@x.com', senderName: 'users/2' }), false);
  assert.equal(isAllowed(['me@x.com'], { ...c1, senderType: 'BOT' }), false);

  const posted: { url: string; body: { text: string } }[] = [];
  const f = (async (url: string, init: RequestInit) => { posted.push({ url, body: JSON.parse(init.body as string) }); return json({}); }) as unknown as typeof fetch;
  const { ctx } = makeCtx([], { env: { CHAT_ALLOWED_USERS: 'me@x.com' } });
  const bot = new ChatBot(ctx, { token: async () => 't' }, f);
  await bot.handleEvent({ ...classic, message: { ...classic.message, sender: { name: 'users/2', email: 'evil@x.com', type: 'HUMAN' } }, user: { name: 'users/2', email: 'evil@x.com', type: 'HUMAN' } });
  assert.equal(posted.length, 0);
  await bot.handleEvent(classic);
  assert.equal(posted.length, 1); assert.match(posted[0].url, /spaces\/S\/messages/); assert.match(posted[0].body.text, /Nothing open/);
  await bot.send('hello');                                                // now knows the DM space
  assert.equal(posted.length, 2);
});

test('Google service account signs a valid RS256 JWT assertion', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  let assertion = '';
  const f = (async (_u: string, init: RequestInit) => { assertion = (init.body as URLSearchParams).get('assertion')!; return json({ access_token: 'tok', expires_in: 3600 }); }) as unknown as typeof fetch;
  const sa = new ServiceAccount({ client_email: 'bot@p.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string }, f);
  assert.equal(await sa.token(['scope-a']), 'tok');
  assert.equal(await sa.token(['scope-a']), 'tok');                       // cached
  const [h, p, s] = assertion.split('.');
  const { createVerify } = await import('node:crypto');
  assert.ok(createVerify('RSA-SHA256').update(`${h}.${p}`).verify(publicKey, Buffer.from(s, 'base64url')));
  assert.equal(JSON.parse(Buffer.from(p, 'base64url').toString()).iss, 'bot@p.iam.gserviceaccount.com');
});

const MANIFEST = { id: 'acme', name: 'Acme Orders', description: 'Open orders', baseUrl: 'https://api.acme.example/v1', auth: { type: 'bearer', secret: 'ACME_API_KEY' },
  poll: { path: '/orders', query: { status: 'open' }, intervalMinutes: 15, itemsPath: 'data.orders', idField: 'id', titleField: 'ref', bodyFields: ['status', 'note'], timeField: 'created' } };

test('connectors: manifests are validated and unsafe hosts are refused', async () => {
  assert.equal(validateManifest(MANIFEST).id, 'acme');
  assert.throws(() => validateManifest({ ...MANIFEST, baseUrl: 'http://api.acme.example' }), /https/);
  assert.throws(() => validateManifest({ ...MANIFEST, auth: { type: 'bearer', secret: 'lower' } }), /UPPER_SNAKE/);
  assert.throws(() => validateManifest({ ...MANIFEST, poll: { ...MANIFEST.poll, intervalMinutes: 1 } }), />= 5/);
  assert.throws(() => validateManifest({ ...MANIFEST, poll: { ...MANIFEST.poll, idField: 'a b;rm' } }), /bad field/);
  for (const ip of ['127.0.0.1', '10.0.0.5', '192.168.1.1', '169.254.169.254', '100.101.102.103', '172.16.0.1', '::1', 'fd00::1']) assert.equal(isPrivateIp(ip), true, ip);
  assert.equal(isPrivateIp('8.8.8.8'), false);
  await assert.rejects(assertPublicHttps('http://example.com'), /https/);
  await assert.rejects(assertPublicHttps('https://internal.example', async () => ['10.1.2.3']), /private/);
  await assert.rejects(assertPublicHttps('https://[::1]/x'), /private/);
  await assert.rejects(assertPublicHttps('https://user:pw@example.com'), /credentials/);
});

test('connectors: propose → approve → set secret → dry run → enable → poll (first run only seeds)', async () => {
  setResolverForTests(async () => ['93.184.216.34']);
  const dir = mkdtempSync(join(tmpdir(), 'asst-'));
  const { ctx } = makeCtx([MANIFEST], { env: { ASSISTANT_DATA: dir } });
  const out = await proposeConnector(ctx, 'Acme API docs: GET /orders returns {data:{orders:[{id,ref,status,note,created}]}} with bearer auth');
  assert.match(out, /Proposed connector "acme"/);
  const [a] = listApprovals(ctx); assert.equal(a.kind, 'connector');
  assert.match(await testConnector(ctx, 'acme'), /Approve the proposal first/);
  assert.match(await decide(ctx, a.id, true), /approved.*npm run secret/s);
  const orders = { data: { orders: [{ id: 1, ref: 'A-1', status: 'open', note: 'needs PO', created: '2026-11-24T00:00:00Z' }, { id: 2, ref: 'A-2', status: 'open', note: 'ok', created: '2026-11-25T00:00:00Z' }] } };
  let seenAuth = '';
  const f = (async (u: URL | string, init: RequestInit) => { seenAuth = (init.headers as Record<string, string>).authorization; assert.equal(init.method, 'GET'); assert.match(String(u), /status=open/); return json(orders); }) as unknown as typeof fetch;
  assert.match(await testConnector(ctx, 'acme', f), /secret ACME_API_KEY is not set/);
  mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'secrets.json'), JSON.stringify({ ACME_API_KEY: 'sekret' }));
  assert.match(enableConnector(ctx, 'acme'), /test connector/);
  const dry = await testConnector(ctx, 'acme', f);
  assert.match(dry, /Dry run OK — 2 record/); assert.equal(seenAuth, 'Bearer sekret');
  assert.equal(ctx.db.prepare('SELECT COUNT(*) n FROM messages').get()!.n, 0);          // a dry run saves nothing
  assert.match(enableConnector(ctx, 'acme'), /enabled/);
  assert.equal(await runConnectors(ctx, f), 2);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) n FROM messages WHERE processed_at IS NULL').get()!.n, 0);   // first run seeds history only
  orders.data.orders.push({ id: 3, ref: 'A-3', status: 'open', note: 'new!', created: '2026-11-26T00:00:00Z' });
  ctx.now = () => new Date(Date.now() + 20 * 60000);
  assert.equal(await runConnectors(ctx, f), 1);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) n FROM messages WHERE processed_at IS NULL').get()!.n, 1);   // the new one will be processed
  // an internal redirect target or DNS change must be refused at fetch time too
  setResolverForTests(async () => ['10.0.0.9']);
  assert.match(await testConnector(ctx, 'acme', f), /private or internal/);
  setResolverForTests(null);
});

test('connectors: a proposal pointing at an internal host is rejected before anything is stored', async () => {
  setResolverForTests(null);
  const { ctx } = makeCtx([{ ...MANIFEST, baseUrl: 'https://127.0.0.1/v1' }]);
  assert.match(await proposeConnector(ctx, 'docs'), /couldn't build a safe connector.*private/);
  assert.equal(listConnectors(ctx).length, 0);
});

test('Canopy sync: due-soon, overdue, missing and grade-drop alerts; completion in Canopy stops the nagging', async () => {
  const state = {
    assignments: [{ id: 'a1', classId: 'c1', className: 'AP Biology', title: 'Lab report', dueDate: '2026-11-25', completed: false, flags: ['missing'] }],
    overdue: [{ id: 'a0', classId: 'c1', className: 'Calculus', title: 'Problem set', dueDate: '2026-11-20', completed: false }],
    grade: 92.0,
  };
  const f = (async (url: string) => {
    const p = new URL(url).pathname.replace('/api/v1', '');
    if (p === '/upcoming') return json({ today: '2026-11-25', overdue: { assignments: state.overdue, tasks: [] }, assignments: state.assignments, tasks: [], exams: [] });
    if (p === '/classes') return json({ classes: [{ id: 'c1', name: 'AP Biology' }] });
    if (p === '/grade-history') return json({ history: [{ classId: 'c1', gradePercent: state.grade, letter: 'A', semester: 's', capturedAt: `2026-11-2${state.grade > 90 ? 4 : 5}T00:00:00Z` }] });
    if (p === '/tasks') return json({ tasks: [] });
    return json({}, 404);
  }) as unknown as typeof fetch;
  const { ctx } = makeCtx([]);
  ctx.canopy = new CanopyClient('http://c', 'r', 'w', f);
  let r = await canopySync(ctx);
  assert.equal(r.created, 3);                                   // due + overdue + missing (no grade alert on first look)
  assert.equal((await canopySync(ctx)).created, 0);            // deduped
  state.grade = 88.5;
  r = await canopySync(ctx);
  assert.equal(r.created, 1);
  assert.ok(ctx.items.list().some((i) => /Grade drop in AP Biology: 92\.0% → 88\.5%/.test(i.title)));
  state.assignments = []; state.overdue = [];                   // finished in Canopy
  r = await canopySync(ctx);
  assert.equal(r.closed, 3);                                    // due, overdue and the missing-work alert
  assert.equal(ctx.items.list({ state: 'open' }).filter((i) => i.externalKey?.startsWith('canopy:due') || i.externalKey?.startsWith('canopy:overdue')).length, 0);
});

test('Ticketing webhook mirrors stage changes and closes the local item', async () => {
  const { ctx } = makeCtx([]);
  const { item } = ctx.items.create({ kind: 'ticket', title: 'Encoder', backend: 'ticketing', backendRef: '7', stageId: 'reported', stageLabel: 'Reported' });
  assert.equal(applyTicketingEvent(ctx, { type: 'ticket.stage_changed', data: { ticket: { id: 7, stageId: 'diagnosing', stageLabel: 'Diagnosing', open: true } } }), true);
  assert.equal(ctx.items.get(item.id)!.stageLabel, 'Diagnosing');
  applyTicketingEvent(ctx, { type: 'ticket.closed', data: { id: 7, stageId: 'closed', stageLabel: 'Closed', open: false } });
  assert.equal(ctx.items.get(item.id)!.state, 'done');
  assert.equal(applyTicketingEvent(ctx, { type: 'ticket.stage_changed', data: { ticket: { id: 999, stageId: 'x' } } }), false);
});

test('search + Q&A: indexes files and messages, answers with citations, refuses when nothing matches', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'idx-'));
  writeFileSync(join(dir, 'encoder-notes.txt'), 'The Blackmagic encoder firmware was updated to 4.2 on March 3 after the frame drops.');
  writeFileSync(join(dir, 'binary.bin'), Buffer.from([0, 1, 2]));
  mkdirSync(join(dir, 'sub')); writeFileSync(join(dir, 'sub', 'vendor.md'), 'SDI cables come from Cable Co, account 55821.');
  const { ctx, llm } = makeCtx((req) => ({ answer: 'Firmware 4.2 on March 3.', cited: [1, 99] }));
  const r1 = await indexPaths(ctx.db, [dir]); assert.equal(r1.indexed, 2);
  const r2 = await indexPaths(ctx.db, [dir]); assert.equal(r2.indexed, 0);                // incremental
  storeMessage(ctx, { source: 'mac', sourceId: 'q', sender: 'Sam', body: 'Invoice 4471 is due in December' });
  const a = await ask(ctx, 'What firmware did the encoder get?');
  assert.match(a, /Firmware 4\.2/); assert.match(a, /Sources: \[1\] file .*encoder-notes\.txt/); assert.doesNotMatch(a, /\[99\]/);
  assert.match(llm.calls[0].prompt, /Blackmagic/);
  assert.match(await ask(ctx, 'zebra migration patterns'), /couldn't find/);
  assert.equal(llm.calls.length, 1);
});

test('chat commands: open, approvals, ack/snooze/done by short id, questions vs captures', async () => {
  const { ctx } = makeCtx((req) => (/Question:/.test(req.prompt) ? { answer: 'ok', cited: [] } : { actions: [{ op: 'create', kind: 'reminder', title: 'Order SDI cables', dueAt: '2026-11-26T09:00', confidence: 0.9, flags: [], why: '' }] }));
  const reply = await handleOwnerText(ctx, 'remind me to order SDI cables tomorrow morning');
  assert.match(reply, /✅ Reminder: Order SDI cables/);
  const list = await handleOwnerText(ctx, "what's open");
  const id = /\[([0-9a-f]{6})\]/.exec(list)![1];
  assert.match(list, /Reminders/);
  assert.match(await handleOwnerText(ctx, `snooze ${id} 2h`), /Snoozed/);
  assert.match(await handleOwnerText(ctx, `snooze ${id} blah`), /didn't understand/);
  assert.match(await handleOwnerText(ctx, `ack ${id}`), /Done: Order SDI cables/);
  assert.match(await handleOwnerText(ctx, 'open'), /Nothing open/);
  assert.match(await handleOwnerText(ctx, 'approve 99'), /No approval #99/);
  assert.match(await handleOwnerText(ctx, 'ack ffff'), /No item/);
  assert.match(await handleOwnerText(ctx, 'help'), /Commands:/);
});

test('HTTP: bearer auth, ingest, idempotent voice upload, webhook signature, approvals', async () => {
  const transcribeCalls: number[] = [];
  const stt = (async () => { transcribeCalls.push(1); return json({ text: 'order SDI cables' }); }) as unknown as typeof fetch;
  const { ctx } = makeCtx([], { env: { ASSISTANT_TOKEN: 'a'.repeat(32), INGEST_TOKEN: 'i'.repeat(32), TRANSCRIBE_URL: 'http://stt.test/v1/audio/transcriptions' } });
  const server = createHttp(ctx, { wake: () => {}, fetchImpl: stt });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const H = { authorization: 'Bearer ' + 'a'.repeat(32), 'content-type': 'application/json' };
  try {
    assert.equal((await fetch(base + '/healthz')).status, 200);
    assert.equal((await fetch(base + '/items')).status, 401);
    assert.equal((await fetch(base + '/items', { headers: { authorization: 'Bearer nope' } })).status, 401);
    assert.equal((await fetch(base + '/ingest/message', { method: 'POST', headers: H, body: JSON.stringify({ source: 'api', sourceId: 'x1', body: 'hi' }) })).status, 202);
    assert.equal((await fetch(base + '/ingest/message', { method: 'POST', headers: H, body: JSON.stringify({ body: 'no id' }) })).status, 400);
    assert.equal((ctx.db.prepare("SELECT COUNT(*) n FROM messages WHERE body = 'no id'").get() as { n: number }).n, 0);   // a rejected request stores nothing
    const voice = () => fetch(base + '/ingest/voice', { method: 'POST', headers: { authorization: H.authorization, 'x-capture-id': 'cap-12345678', 'x-filename': 'a.m4a' }, body: new Uint8Array([1, 2, 3]) });
    const v1 = await (await voice()).json() as { duplicate: boolean; text: string }; assert.equal(v1.duplicate, false); assert.equal(v1.text, 'order SDI cables');
    const v2 = await (await voice()).json() as { duplicate: boolean }; assert.equal(v2.duplicate, true);
    assert.equal(transcribeCalls.length, 1);                                       // the retry never re-transcribes
    assert.equal((await fetch(base + '/ingest/voice', { method: 'POST', headers: { authorization: H.authorization }, body: new Uint8Array([1]) })).status, 400);
    assert.equal((await fetch(base + '/approvals', { headers: H })).status, 200);
    // the ingest-only token can send input but cannot read items, approve, or chat
    const IH = { authorization: 'Bearer ' + 'i'.repeat(32), 'content-type': 'application/json' };
    assert.equal((await fetch(base + '/ingest/message', { method: 'POST', headers: IH, body: JSON.stringify({ sourceId: 'z9', body: 'from the mac' }) })).status, 202);
    for (const [m, p] of [['GET', '/items'], ['GET', '/approvals'], ['POST', '/approvals/1/approve'], ['POST', '/chat']] as const) {
      assert.equal((await fetch(base + p, { method: m, headers: IH, body: m === 'POST' ? '{}' : undefined })).status, 401, `${m} ${p}`);
    }
    assert.equal((await fetch(base + '/nope', { headers: H })).status, 404);
  } finally { server.close(); }
  // voice with no transcriber configured must fail loudly (so the phone keeps the recording queued)
  const { ctx: c2 } = makeCtx([]);
  await assert.rejects(ingestVoice(c2, { captureId: 'cap-87654321', audio: new Uint8Array([1]), filename: 'a.m4a' }), /TRANSCRIBE_URL/);
});
