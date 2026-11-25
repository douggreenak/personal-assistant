// Tests for the web UI's server side: static files, password login, settings, management endpoints.
// None of these call the language model (no /chat, /ask or connector proposals).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { makeCtx } from './helpers.ts';
import { createHttp } from '../src/http.ts';
import { loadConfig } from '../src/config.ts';
import { readOverrides, saveSettings, viewSettings, SETTINGS } from '../src/settings.ts';
import { captureLogs, getLogs } from '../src/logs.ts';
import { storeMessage } from '../src/pipeline.ts';
import { createApproval } from '../src/approvals.ts';
import { setResolverForTests } from '../src/connectors.ts';

const TOKEN = 'a'.repeat(32), INGEST = 'i'.repeat(32);
const H = { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' };

async function boot(env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'assistant-web-'));
  const made = makeCtx([], { env: { ASSISTANT_TOKEN: TOKEN, INGEST_TOKEN: INGEST, ASSISTANT_DATA: dir, TICKETING_URL: 'http://tickets.test', ...env } });
  let restarts = 0, wakes = 0;
  const server = createHttp(made.ctx, { wake: () => { wakes++; }, restart: () => { restarts++; } });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown, headers = H) => {
    const r = await fetch(base + path, { method, headers, body: method === 'GET' || body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
    const text = await r.text(); let json: any = null; try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: r.status, json, text, headers: r.headers };
  };
  return { ...made, dir, base, call, close: () => server.close(), counts: () => ({ restarts, wakes }) };
}

test('static UI: index and built assets are served with a strict CSP; nothing outside assets/ leaks', async () => {
  const s = await boot();
  try {
    const idx = await s.call('GET', '/', undefined, {} as never);
    assert.equal(idx.status, 200); assert.match(idx.headers.get('content-type')!, /text\/html/);
    assert.match(idx.text, /<script type="module" src="\/assets\/app\.js">/);
    assert.match(idx.headers.get('content-security-policy')!, /script-src 'self'/);
    assert.equal(idx.headers.get('x-content-type-options'), 'nosniff');
    for (const [p, type] of [['/assets/app.js', /javascript/], ['/assets/styles.css', /css/], ['/assets/fonts/roboto-flex.woff2', /woff2/], ['/assets/icon.svg', /svg/]] as const) {
      const r = await s.call('GET', p, undefined, {} as never); assert.equal(r.status, 200, p); assert.match(r.headers.get('content-type')!, type);
    }
    for (const p of ['/assets/../package.json', '/assets/%2e%2e/package.json', '/assets/..%2fpackage.json', '/assets/nope.js', '/assets/', '/assets/%00']) {
      const r = await s.call('GET', p, undefined, {} as never); assert.ok([401, 404].includes(r.status), `${p} -> ${r.status}`);
      assert.ok(!r.text.includes('"name": "assistant"'), p);
    }
    assert.equal((await s.call('GET', '/items', undefined, {} as never)).status, 401);   // the shell is public, the data is not
  } finally { s.close(); }
});

test('every management endpoint requires the full token (and rejects the ingest-only token)', async () => {
  const s = await boot();
  try {
    const IH = { authorization: 'Bearer ' + INGEST, 'content-type': 'application/json' };
    const eps: [string, string][] = [['GET', '/status'], ['GET', '/status/integrations'], ['GET', '/activity'], ['GET', '/logs'], ['GET', '/search?q=abc'], ['GET', '/stages'],
      ['GET', '/messages'], ['POST', '/messages/1/retry'], ['POST', '/messages/1/skip'], ['POST', '/items'], ['PATCH', '/items/abcd'], ['POST', '/items/abcd/complete'], ['POST', '/items/abcd/drop'],
      ['POST', '/items/abcd/stage'], ['GET', '/connectors/full'], ['POST', '/connectors/propose'], ['POST', '/connectors/x/test'], ['POST', '/connectors/x/enable'], ['POST', '/connectors/x/disable'],
      ['DELETE', '/connectors/x'], ['PUT', '/secrets/ACME_KEY'], ['GET', '/settings'], ['PUT', '/settings'], ['POST', '/admin/service-account'], ['POST', '/admin/reindex'], ['POST', '/admin/restart'], ['POST', '/auth/password']];
    for (const [m, p] of eps) {
      assert.equal((await s.call(m, p, '{}', {} as never)).status, 401, `no token ${m} ${p}`);
      assert.equal((await s.call(m, p, '{}', IH)).status, 401, `ingest token ${m} ${p}`);
    }
    assert.equal(s.counts().restarts, 0);
  } finally { s.close(); }
});

test('password login: disabled without WEB_PASSWORD; wrong/right; lockout; change password stores only a hash', async () => {
  const off = await boot();
  try { assert.equal((await off.call('POST', '/auth/login', { password: 'whatever1' }, {} as never)).status, 404); } finally { off.close(); }

  const s = await boot({ WEB_PASSWORD: 'sunny-harbor-313' });
  try {
    const login = (password: string) => s.call('POST', '/auth/login', { password }, {} as never);
    const ok = await login('sunny-harbor-313'); assert.equal(ok.status, 200); assert.equal(ok.json.token, TOKEN);
    assert.equal((await login('')).status, 401);
    // change: wrong current, too short, then success
    assert.equal((await s.call('POST', '/auth/password', { current: 'nope', new: 'longenough1' })).status, 401);
    assert.equal((await s.call('POST', '/auth/password', { current: 'sunny-harbor-313', new: 'short' })).status, 400);
    assert.equal((await s.call('POST', '/auth/password', { current: 'sunny-harbor-313', new: 'brand-new-pass' })).status, 200);
    assert.equal((await login('sunny-harbor-313')).status, 401);
    assert.equal((await login('brand-new-pass')).status, 200);
    const f = join(s.dir, 'web-password.json'); const raw = readFileSync(f, 'utf8');
    assert.ok(!raw.includes('brand-new-pass')); assert.match(raw, /"salt"/); assert.equal(statSync(f).mode & 0o777, 0o600);
    // the page password can be changed only with the API token
    assert.equal((await s.call('POST', '/auth/password', { current: 'brand-new-pass', new: 'another-pass-1' }, {} as never)).status, 401);
    // brute force: 5 wrong answers lock further attempts
    for (let i = 0; i < 5; i++) assert.equal((await login('wrong-' + i)).status, 401);
    assert.equal((await login('brand-new-pass')).status, 429);
  } finally { s.close(); }
});

test('settings: secrets never leave the server; validation; overrides win over env and "" falls back', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'assistant-set-'));
  const env = { TZ_NAME: 'America/Denver', TICKETING_TOKEN: 'super-secret-token', GMAIL_ENABLED: '1' } as NodeJS.ProcessEnv;
  let v = viewSettings(dir, env);
  const tok = v.find((d) => d.key === 'TICKETING_TOKEN')!;
  assert.equal(tok.value, ''); assert.equal(tok.isSet, true); assert.ok(!JSON.stringify(v).includes('super-secret-token'));
  assert.equal(v.find((d) => d.key === 'TZ_NAME')!.value, 'America/Denver');
  assert.equal(v.find((d) => d.key === 'GMAIL_SKIP_BULK')!.value, '1');            // documented default shows as on

  assert.throws(() => saveSettings(dir, { TZ_NAME: 'Mars/Olympus' }), /time zone/i);
  assert.throws(() => saveSettings(dir, { QUIET_HOURS: 'night' }), /Quiet hours/);
  assert.throws(() => saveSettings(dir, { NTFY_URL: 'ftp://x' }), /http/);
  assert.throws(() => saveSettings(dir, { CLAUDE_TIMEOUT_MS: 'soon' }), /number/);
  assert.deepEqual(readOverrides(dir), {});                                        // nothing partial was written

  assert.deepEqual(saveSettings(dir, { TZ_NAME: 'America/Anchorage', QUIET_HOURS: '23-6', NAG_MINUTES: '5,10', NOT_A_SETTING: 'x', INGEST_TOKEN: 'abc', CLAUDE_MODEL: null }).sort(), ['INGEST_TOKEN', 'NAG_MINUTES', 'QUIET_HOURS', 'TZ_NAME']);
  assert.equal(statSync(join(dir, 'settings.json')).mode & 0o777, 0o600);
  const cfg = loadConfig({ ...env, ...readOverrides(dir) });
  assert.equal(cfg.tz, 'America/Anchorage'); assert.deepEqual(cfg.quietHours, { start: 23, end: 6 }); assert.deepEqual(cfg.nagMinutes, [5, 10]); assert.equal(cfg.ingestToken, 'abc');
  assert.ok(!('NOT_A_SETTING' in readOverrides(dir)));

  saveSettings(dir, { TICKETING_TOKEN: '' });                                     // blank secret = keep
  assert.equal(viewSettings(dir, env).find((d) => d.key === 'TICKETING_TOKEN')!.isSet, true);
  saveSettings(dir, { TZ_NAME: '' });                                              // '' removes the override -> env value again
  assert.equal(loadConfig({ ...env, ...readOverrides(dir) }).tz, 'America/Denver');
  saveSettings(dir, { INGEST_TOKEN: '__clear__' }); assert.ok(!('INGEST_TOKEN' in readOverrides(dir)));
  assert.equal(new Set(SETTINGS.map((d) => d.key)).size, SETTINGS.length);          // no duplicate keys
});

test('settings over HTTP: GET never contains secret values; PUT validates and reports changed keys', async () => {
  process.env.CANOPY_READ_TOKEN = 'canopy-secret-xyz';          // viewSettings reads the real environment, like the running server
  const s = await boot();
  try {
    const g = await s.call('GET', '/settings'); assert.equal(g.status, 200);
    assert.ok(!g.text.includes('canopy-secret-xyz')); assert.ok(!g.text.includes(TOKEN));
    assert.equal(g.json.settings.find((d: any) => d.key === 'CANOPY_READ_TOKEN').isSet, true);
    assert.equal((await s.call('PUT', '/settings', { values: { TZ_NAME: 'Nope/Nope' } })).status, 400);
    const p = await s.call('PUT', '/settings', { values: { NTFY_URL: 'http://ntfy:80', NTFY_TOPIC: 'mine' } });
    assert.equal(p.status, 200); assert.deepEqual(p.json.changed.sort(), ['NTFY_TOPIC', 'NTFY_URL']);
    assert.equal(readOverrides(s.dir).NTFY_TOPIC, 'mine');
    assert.equal((await s.call('PUT', '/settings', { values: {} })).status, 200);
    assert.equal((await s.call('PUT', '/settings', 'not json')).status, 400);
  } finally { s.close(); delete process.env.CANOPY_READ_TOKEN; }
});

test('items: create / edit / stage / complete / drop through the management API, with history', async () => {
  const s = await boot();
  try {
    assert.equal((await s.call('POST', '/items', { kind: 'bogus', title: 'x' })).status, 400);
    assert.equal((await s.call('POST', '/items', { kind: 'task', title: '   ' })).status, 400);
    const t = await s.call('POST', '/items', { kind: 'task', title: 'File taxes', detail: 'by the deadline', dueAt: '2026-12-01T09:00', priority: 'high' });
    assert.equal(t.status, 200); assert.equal(t.json.item.title, 'File taxes'); assert.equal(t.json.item.priority, 'high');
    assert.equal(t.json.item.dueAt, '2026-12-01T18:00:00.000Z');                      // 09:00 Anchorage (AKST, UTC-9)
    const r = await s.call('POST', '/items', { kind: 'reminder', title: 'Stretch' }); assert.equal(r.json.item.kind, 'reminder'); assert.ok(r.json.item.nextNagAt);
    const k = await s.call('POST', '/items', { kind: 'ticket', title: 'Encoder dropping frames' });
    assert.equal(k.json.item.kind, 'ticket'); assert.equal(k.json.item.backend, 'ticketing'); assert.equal(k.json.item.stageId, 'reported');
    assert.equal(s.fakes.tickets.length, 1);

    const id = t.json.item.id;
    const e = await s.call('PATCH', '/items/' + id.slice(0, 8), { title: 'File taxes (extension)', priority: 'urgent', dueAt: '2026-12-05' });
    assert.equal(e.status, 200); assert.equal(e.json.item.title, 'File taxes (extension)'); assert.equal(e.json.item.priority, 'urgent');
    assert.equal((await s.call('PATCH', '/items/ffffffff', { title: 'x' })).status, 404);

    const st = await s.call('POST', `/items/${k.json.item.id}/stage`, { stageId: 'diagnosing' });
    assert.equal(st.json.item.stageLabel, 'Diagnosing'); assert.equal(s.fakes.tickets[0].stageId, 'diagnosing');
    const bad = await s.call('POST', `/items/${k.json.item.id}/stage`, { stageId: 'nonsense' }); assert.match(bad.json.summary, /unknown stage/);
    const notTicket = await s.call('POST', `/items/${id}/stage`, { stageId: 'closed' }); assert.match(notTicket.json.summary, /not a ticket/);

    const done = await s.call('POST', `/items/${id}/complete`); assert.equal(done.json.item.state, 'done');
    const again = await s.call('POST', `/items/${id}/complete`); assert.match(again.json.summary, /no longer open/);
    const drop = await s.call('POST', `/items/${r.json.item.id}/drop`); assert.equal(drop.json.item.state, 'dropped');
    assert.equal((await s.call('POST', '/items/ffffffff/complete')).status, 404);

    const hist = await s.call('GET', '/items/' + id); assert.deepEqual(hist.json.events.map((x: any) => x.type), ['created', 'updated', 'completed']);
    assert.ok(hist.json.events.every((x: any) => x.actor === 'owner'));
    assert.equal((await s.call('GET', '/items?state=done')).json.items.length, 1);
    assert.equal((await s.call('GET', '/items?state=all&limit=2')).json.items.length, 2);
    const stages = await s.call('GET', '/stages'); assert.equal(stages.json.stages.length, 6);
    // ack/snooze endpoints used by the UI
    const rem = await s.call('POST', '/items', { kind: 'reminder', title: 'Call Sam' });
    assert.equal((await s.call('POST', `/items/${rem.json.item.id}/snooze`, { for: '2h' })).status, 200);
    assert.equal((await s.call('POST', `/items/${rem.json.item.id}/snooze`, { for: 'whenever' })).status, 400);
    assert.equal((await s.call('POST', `/items/${rem.json.item.id}/ack`)).json.item.state, 'done');
  } finally { s.close(); }
});

test('status, activity and search reflect real state', async () => {
  const s = await boot({ INDEX_PATHS: '' });
  try {
    await s.call('POST', '/items', { kind: 'task', title: 'Overdue thing', dueAt: '2020-01-01T09:00' });
    await s.call('POST', '/items', { kind: 'reminder', title: 'Quarterly invoice reminder' });
    createApproval(s.ctx, { kind: 'action', summary: 'Pay the invoice', reason: 'money', payload: { action: {} } });
    storeMessage(s.ctx, { source: 'mac', sourceId: 'm1', sender: 'Sam', body: 'invoice 4471 is due' });
    const st = (await s.call('GET', '/status')).json;
    assert.equal(st.items.open, 2); assert.equal(st.items.tasks, 1); assert.equal(st.items.reminders, 1); assert.equal(st.items.overdue, 1);
    assert.equal(st.approvals, 1); assert.equal(st.queue.pending, 1); assert.equal(st.queue.total, 1); assert.equal(st.tz, 'America/Anchorage');
    assert.deepEqual(st.bySource, [{ source: 'mac', n: 1 }]); assert.ok(st.uptimeSec >= 0); assert.match(st.version, /^\d/);
    const act = (await s.call('GET', '/activity?limit=5')).json.events; assert.equal(act.length, 2); assert.equal(act[0].actor, 'owner');
    const hits = (await s.call('GET', '/search?q=invoice')).json.hits; assert.ok(hits.length >= 2); assert.ok(hits.some((h: any) => h.kind === 'message'));
    assert.deepEqual((await s.call('GET', '/search?q=')).json.hits, []);
    assert.deepEqual((await s.call('GET', '/search?q=%22%20OR%20*%20(')).json.hits, []);   // FTS syntax can't break it
    assert.equal((await s.call('GET', '/approvals')).json.approvals.length, 1);
    assert.equal((await s.call('GET', '/approvals?status=approved')).json.approvals.length, 0);
    assert.equal((await s.call('GET', '/approvals?status=DROP TABLE')).json.approvals.length, 1);   // unknown status falls back to pending
  } finally { s.close(); }
});

test('integrations report what is configured and whether it answers', async () => {
  const s = await boot();
  try {
    const list = (await s.call('GET', '/status/integrations')).json.integrations as { id: string; configured: boolean; ok: boolean | null }[];
    const by = Object.fromEntries(list.map((i) => [i.id, i]));
    assert.equal(by.ticketing.configured, true); assert.equal(by.ticketing.ok, true);   // the fake ticketing app answers
    for (const id of ['canopy', 'whisper', 'gmail', 'chat', 'drive', 'ntfy', 'files']) assert.equal(by[id].configured, false, id);
    assert.equal(by.ingest.configured, true);
  } finally { s.close(); }
});

test('inbox: filters, search, retry and skip', async () => {
  const s = await boot();
  try {
    const a = storeMessage(s.ctx, { source: 'gmail', sourceId: 'a', sender: 'boss@x.test', subject: 'Budget', body: 'please review the budget' })!;
    const b = storeMessage(s.ctx, { source: 'mac', sourceId: 'b', sender: 'Sam', body: 'lunch?' })!;
    const c = storeMessage(s.ctx, { source: 'voice', sourceId: 'c', body: 'buy milk' })!;
    s.ctx.db.prepare("UPDATE messages SET processed_at = '2026-01-01T00:00:00Z' WHERE id = ?").run(a);
    s.ctx.db.prepare("UPDATE messages SET error = 'boom', attempts = 3 WHERE id = ?").run(b);
    const ids = async (q: string) => (await s.call('GET', '/messages' + q)).json.messages.map((m: any) => m.id).sort();
    assert.deepEqual(await ids(''), [a, b, c]); assert.deepEqual(await ids('?filter=done'), [a]); assert.deepEqual(await ids('?filter=failed'), [b]); assert.deepEqual(await ids('?filter=pending'), [c]);
    assert.deepEqual(await ids('?q=budget'), [a]); assert.deepEqual(await ids('?q=Sam'), [b]); assert.deepEqual(await ids('?q=%25'), [a, b, c]);   // % is not a wildcard
    assert.equal((await s.call('GET', '/status')).json.queue.failing, 1);
    const w = s.counts().wakes;
    assert.equal((await s.call('POST', `/messages/${b}/retry`)).status, 200); assert.equal(s.counts().wakes, w + 1);
    assert.deepEqual(await ids('?filter=failed'), []);
    assert.equal((s.ctx.db.prepare('SELECT attempts FROM messages WHERE id = ?').get(b) as any).attempts, 0);
    assert.equal((await s.call('POST', `/messages/${c}/skip`)).status, 200); assert.deepEqual(await ids('?filter=pending'), [b]);
    assert.equal((await s.call('POST', `/messages/${c}/skip`)).status, 404);          // already processed
    assert.equal((await s.call('POST', '/messages/999/retry')).status, 404);
    assert.equal((await s.call('POST', '/messages/abc/retry')).status, 404);
  } finally { s.close(); }
});

test('connectors: list with secret state, disable, delete; secrets stay server-side', async () => {
  setResolverForTests(async () => ['93.184.216.34']);
  const s = await boot();
  try {
    const manifest = { id: 'acme', name: 'Acme', description: 'd', baseUrl: 'https://api.acme.test', auth: { type: 'bearer', secret: 'ACME_KEY' }, poll: { path: '/x', intervalMinutes: 5, idField: 'id', bodyFields: ['t'] } };
    s.ctx.db.prepare("INSERT INTO connectors (id, manifest, status, created_at) VALUES ('acme', ?, 'approved', '2026-01-01T00:00:00Z')").run(JSON.stringify(manifest));
    let c = (await s.call('GET', '/connectors/full')).json.connectors[0];
    assert.equal(c.secretName, 'ACME_KEY'); assert.equal(c.secretSet, false); assert.equal(c.tested, false); assert.equal(c.status, 'approved');
    assert.equal((await s.call('PUT', '/secrets/lowercase', { value: 'x' })).status, 404);      // route only matches UPPER_SNAKE
    assert.equal((await s.call('PUT', '/secrets/AB', { value: 'x' })).status, 400);        // too short a name
    assert.equal((await s.call('PUT', '/secrets/ACME_KEY', { value: 'sk-live-123' })).status, 200);
    c = (await s.call('GET', '/connectors/full')).json.connectors[0]; assert.equal(c.secretSet, true);
    const file = join(s.dir, 'secrets.json'); assert.equal(statSync(file).mode & 0o777, 0o600); assert.equal(JSON.parse(readFileSync(file, 'utf8')).ACME_KEY, 'sk-live-123');
    for (const p of ['/connectors/full', '/settings', '/status', '/logs']) assert.ok(!(await s.call('GET', p)).text.includes('sk-live-123'), p);
    // enabling needs a successful dry run first
    assert.match((await s.call('POST', '/connectors/acme/enable')).json.result, /test connector/);
    s.ctx.db.prepare("INSERT INTO kv (key, value) VALUES ('connector.tested.acme', '1')").run();
    assert.match((await s.call('POST', '/connectors/acme/enable')).json.result, /enabled/);
    assert.equal((await s.call('POST', '/connectors/acme/disable')).json.ok, true);
    assert.equal((await s.call('GET', '/connectors/full')).json.connectors[0].status, 'disabled');
    assert.equal((await s.call('POST', '/connectors/nope/disable')).json.ok, false);
    assert.equal((await s.call('PUT', '/secrets/ACME_KEY', { value: '' })).status, 200);          // empty removes it
    assert.equal((await s.call('GET', '/connectors/full')).json.connectors[0].secretSet, false);
    assert.equal((await s.call('DELETE', '/connectors/acme')).json.ok, true);
    assert.equal((await s.call('GET', '/connectors/full')).json.connectors.length, 0);
    assert.equal((s.ctx.db.prepare("SELECT COUNT(*) n FROM kv WHERE key LIKE 'connector.tested.%'").get() as any).n, 0);
  } finally { s.close(); setResolverForTests(null); }
});

test('service-account upload: validates, stores 0600 and points the setting at it', async () => {
  const s = await boot();
  try {
    assert.equal((await s.call('POST', '/admin/service-account', 'not json')).status, 400);
    assert.equal((await s.call('POST', '/admin/service-account', JSON.stringify({ type: 'user' }))).status, 400);
    const good = JSON.stringify({ type: 'service_account', client_email: 'bot@p.iam.gserviceaccount.com', private_key: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n' });
    const r = await s.call('POST', '/admin/service-account', good); assert.equal(r.status, 200);
    assert.equal(statSync(r.json.path).mode & 0o777, 0o600); assert.equal(readOverrides(s.dir).GOOGLE_SERVICE_ACCOUNT_FILE, r.json.path);
    assert.ok(!(await s.call('GET', '/settings')).text.includes('BEGIN PRIVATE KEY'));
  } finally { s.close(); }
});

test('admin actions: restart calls the hook once; reindex needs paths; indexes when configured', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'assistant-idx-')); writeFileSync(join(dir, 'notes.txt'), 'The encoder firmware version is 4.2.1 and the rack is in room 12.');
  const none = await boot();
  try {
    assert.equal((await none.call('POST', '/admin/reindex')).status, 400);
    const r = await none.call('POST', '/admin/restart'); assert.equal(r.status, 200);
    await new Promise((res) => setTimeout(res, 600)); assert.equal(none.counts().restarts, 1);
  } finally { none.close(); }
  const s = await boot({ INDEX_PATHS: dir });
  try {
    const r = await s.call('POST', '/admin/reindex'); assert.equal(r.status, 200); assert.equal(r.json.indexed, 1);
    assert.equal((await s.call('GET', '/status')).json.indexedFiles, 1);
    assert.ok((await s.call('GET', '/search?q=firmware')).json.hits.some((h: any) => h.kind === 'doc'));
  } finally { s.close(); }
});

test('log buffer captures console output with levels and a cap', () => {
  captureLogs();
  console.log('hello from test'); console.error('bad thing');
  const l = getLogs(5); assert.ok(l.some((x) => x.text === 'hello from test' && x.level === 'info')); assert.ok(l.some((x) => x.text === 'bad thing' && x.level === 'error'));
  for (let i = 0; i < 600; i++) console.log('x' + i); assert.ok(getLogs(1000).length <= 500);
});

test('web build is in sync: every page/route the UI calls exists on the server', () => {
  const js = readFileSync(new URL('../src/web/assets/app.js', import.meta.url), 'utf8');
  assert.ok(existsSync(new URL('../src/web/assets/fonts/roboto-flex.woff2', import.meta.url)));
  for (const needle of ['/status', '/items', '/messages', '/approvals', '/connectors/full', '/admin/restart', '/settings', '/auth/login', '/auth/password', '/search?q=', '/app/mac/download', '/app/mac/latest']) assert.ok(js.includes(needle), needle);
  assert.ok(!/#c2478f|#6750a4/i.test(readFileSync(new URL('../src/web/assets/styles.css', import.meta.url), 'utf8')));
});

test('voice: a missing Whisper model is downloaded once automatically, then transcription is retried', async () => {
  const { transcribe } = await import('../src/voice.ts');
  const calls: string[] = []; let installed = false;
  const f = (async (url: string, init: RequestInit = {}) => {
    calls.push(`${init.method} ${new URL(url).pathname}`);
    if (new URL(url).pathname.startsWith('/v1/models/')) { installed = true; return new Response('ok'); }
    return installed ? new Response(JSON.stringify({ text: ' hello there ' })) : new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;
  assert.equal(await transcribe('http://stt.test:8000/v1/audio/transcriptions', new Uint8Array([1]), 'a.wav', f), 'hello there');
  assert.deepEqual(calls, ['POST /v1/audio/transcriptions', 'POST /v1/models/Systran/faster-whisper-small', 'POST /v1/audio/transcriptions']);
  const bad = (async (url: string) => new URL(url).pathname.startsWith('/v1/models/') ? new Response('x', { status: 500 }) : new Response('{}', { status: 404 })) as unknown as typeof fetch;
  await assert.rejects(transcribe('http://stt.test/v1/audio/transcriptions', new Uint8Array([1]), 'a.wav', bad), /could not be downloaded/);
});
