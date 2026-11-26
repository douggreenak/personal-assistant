// End-to-end browser test of the web UI against a THROWAWAY assistant (temp data dir, random port).
// It never calls the AI model: the worker's Claude binary is /bin/false, so messages just fail and show up as "failing".
//   usage: CHROMIUM=/usr/bin/chromium node web-src/e2e/run.mjs
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const root = new URL('../../', import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), 'assistant-e2e-'));
const port = 20000 + Math.floor(Math.random() * 20000), base = `http://127.0.0.1:${port}`;
const PW = 'e2e-password-1';
const srv = spawn('node', ['src/main.ts'], { cwd: root, env: { PATH: process.env.PATH, PORT: String(port), HOST: '127.0.0.1', ASSISTANT_DATA: dir, ASSISTANT_TOKEN: 't'.repeat(32), INGEST_TOKEN: 'i'.repeat(32), WEB_PASSWORD: PW, CLAUDE_BIN: '/bin/false', TZ_NAME: 'America/Anchorage' }, stdio: ['ignore', 'pipe', 'pipe'] });
let log = ''; srv.stdout.on('data', (d) => (log += d)); srv.stderr.on('data', (d) => (log += d));
for (let i = 0; i < 50; i++) { try { if ((await fetch(base + '/healthz')).ok) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 200)); }

const results = []; let current = '';
// E2E_GROUP=a|b runs half of the steps (each half has its own server + browser), so the two halves can run side by side. Default: all.
const GROUP = process.env.E2E_GROUP || 'all';
const groupOf = (n) => /^(keyboard:|items: sort|command palette|unsaved settings|connection lost)/.test(n) ? 'b'
  : /^(settings: (edit|theme)|system:|connectors:|mobile:|chat page|connect wizard|dialogs ignore|write connectors)/.test(n) ? 'c' : 'a';
const step = async (name, fn) => { if (GROUP !== 'all' && !/^no JavaScript errors/.test(name) && groupOf(name) !== GROUP) return; current = name; try { await fn(); results.push([true, name]); console.log('  ✔', name); } catch (e) { results.push([false, name, e]); console.log('  ✖', name, '\n     ', String(e.message).split('\n').slice(0, 4).join('\n      ')); if (errors.length) console.log('      page errors:', errors.slice(-3).join(' | ').slice(0, 400)); await page.screenshot({ path: join(dir, 'fail-' + results.length + '.png') }); } };

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/usr/bin/chromium', args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1300, height: 900 } });
const page = await ctx.newPage();
{ const wait = page.waitForTimeout.bind(page); page.waitForTimeout = (ms) => wait(Math.max(60, Math.round(ms * 0.4))); }   // the fixed pauses were generous; real waits are on selectors
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/status of (4\d\d)|ERR_INTERNET_DISCONNECTED/.test(m.text())) errors.push('console: ' + m.text()); });
page.on('dialog', (d) => d.dismiss());

const setField = (label, value) => page.locator(`md-outlined-text-field[label="${label}"], md-outlined-select[label="${label}"]`).first().evaluate((el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }, value);
const btn = (text, scope = page) => scope.locator('md-filled-button, md-filled-tonal-button, md-outlined-button, md-text-button', { hasText: text }).first();
const goto = async (p) => { await page.goto(`${base}/#/${p}`); await page.waitForTimeout(700); };
const heading = (t) => page.locator('h1.display', { hasText: t }).waitFor({ timeout: 5000 });
const toastText = (re) => page.locator('.toast', { hasText: re }).first().waitFor({ timeout: 5000 });
const row = (text) => page.locator('.row', { hasText: text });
const group = (name) => page.locator('summary', { hasText: new RegExp('^\\s*' + name + '\\s*$') });
const mi = (t) => page.locator('md-menu-item:visible', { hasText: t }).first();
const dlg = () => page.locator('md-dialog[open]');
const db = () => new DatabaseSync(join(dir, 'assistant.db'));

console.log('E2E against', base);
try {
  if (GROUP !== 'all' && GROUP !== 'a') { await page.goto(base + '/'); await setField('Password', PW); await btn('Sign in').click(); await heading(/Good (morning|afternoon|evening)|Still up/); }
  await step('login: wrong password is refused, right one signs in', async () => {
    await page.goto(base + '/'); await page.locator('md-outlined-text-field[label="Password"]').waitFor();
    await setField('Password', 'nope'); await btn('Sign in').click(); await page.locator('.err', { hasText: 'Wrong password' }).waitFor();
    await setField('Password', PW); await btn('Sign in').click(); await heading(/Good (morning|afternoon|evening)|Still up/);
  });

  await step('navigation: all eight pages open from the rail', async () => {
    for (const [label, title] of [['Items', 'Items'], ['Chat', 'Chat'], ['Inbox', 'Inbox'], ['Approvals', 'Approvals'], ['Connect', 'Connectors'], ['System', 'System'], ['Settings', 'Settings'], ['Home', /Good|Still/]]) {
      await page.locator('.rail .dest', { hasText: label }).click(); await heading(title);
    }
  });

  await step('items: create task + reminder, filter, search', async () => {
    await goto('items'); await page.locator('md-fab').click(); await dlg().waitFor();
    await setField('Title', 'Renew passport'); await setField('Details', 'forms are in the drawer'); await setField('Due', '2030-03-04T10:00'); await setField('Priority', 'high');
    await btn('Create', dlg()).click(); await row('Renew passport').waitFor();
    assert.match(await row('Renew passport').innerText(), /high/); assert.match(await row('Renew passport').innerText(), /Mar 4, 2030/);
    await page.locator('md-fab').click(); await dlg().waitFor(); await setField('Type', 'reminder'); await setField('Title', 'Drink water'); await btn('Create', dlg()).click(); await row('Drink water').waitFor();
    await page.locator('.seg button', { hasText: 'Reminders' }).click(); await page.waitForTimeout(500);
    assert.equal(await row('Renew passport').count(), 0); assert.equal(await row('Drink water').count(), 1);
    await page.locator('.seg button', { hasText: 'Everything' }).click(); await page.waitForTimeout(500);
    await page.locator('md-outlined-text-field[label="Filter"]').evaluate((el) => { el.value = 'passport'; el.dispatchEvent(new Event('input')); }); await page.waitForTimeout(500);
    assert.equal(await row('Drink water').count(), 0); assert.equal(await row('Renew passport').count(), 1);
    await page.locator('md-outlined-text-field[label="Filter"]').evaluate((el) => { el.value = ''; el.dispatchEvent(new Event('input')); }); await page.waitForTimeout(400);
    assert.equal(await page.locator('.dot, .toast.error').count(), 0);
  });

  await step('items: validation — empty title does not create anything', async () => {
    const before = await page.locator('.row').count();
    await page.locator('md-fab').click(); await dlg().waitFor(); await btn('Create', dlg()).click(); await page.waitForTimeout(500);
    assert.equal(await dlg().count(), 1); await btn('Cancel', dlg()).click(); await page.waitForTimeout(500); assert.equal(await page.locator('.row').count(), before);
  });

  await step('items: edit, history, complete, drop (with confirm)', async () => {
    await row('Renew passport').click(); await dlg().waitFor(); await setField('Title', 'Renew passport (rush)'); await btn('Save', dlg()).click(); await row('Renew passport (rush)').waitFor();
    await row('Renew passport (rush)').getByRole('button', { name: 'More actions' }).click(); await mi('History').click();
    await dlg().waitFor(); assert.match(await dlg().innerText(), /created/); assert.match(await dlg().innerText(), /updated/); await btn('Close', dlg()).click(); await page.waitForTimeout(500);
    await row('Renew passport (rush)').locator('md-filled-tonal-icon-button').click(); await toastText(/Done/); await page.waitForTimeout(600);
    assert.equal(await row('Renew passport (rush)').count(), 0);
    await page.locator('.seg button', { hasText: 'Done' }).first().click(); await row('Renew passport (rush)').waitFor();
    await page.locator('.seg button', { hasText: 'Open' }).first().click(); await page.waitForTimeout(500);
    await row('Drink water').getByRole('button', { name: 'More actions' }).click(); await mi('Drop').click();
    await dlg().waitFor(); await btn('Drop', dlg()).click(); await toastText(/Dropped/); await page.waitForTimeout(600); assert.equal(await row('Drink water').count(), 0);
  });

  await step('reminders: acknowledge and snooze from the menu', async () => {
    await page.locator('md-fab').click(); await dlg().waitFor(); await setField('Type', 'reminder'); await setField('Title', 'Call dentist'); await btn('Create', dlg()).click(); await row('Call dentist').waitFor();
    await row('Call dentist').getByRole('button', { name: 'More actions' }).click(); await mi('Snooze 2h').click(); await toastText(/Snoozed/);
    await page.waitForTimeout(600); assert.match(await row('Call dentist').innerText(), /until/);
    await row('Call dentist').getByRole('button', { name: 'More actions' }).click(); await mi('Acknowledge').click(); await toastText(/Acknowledged/);
  });

  await step('inbox: failing messages appear, can be retried and skipped (model is stubbed out)', async () => {
    await goto('inbox'); await page.locator('md-fab').click(); await dlg().waitFor(); await setField('Subject (optional)', 'Test subject'); await setField('Message', 'pick up the parcel'); await btn('Add', dlg()).click(); await toastText(/Queued/);
    await page.waitForTimeout(5000);                              // worker tries, /bin/false fails
    await page.locator('.seg button', { hasText: 'Failing' }).click(); await row('Test subject').waitFor({ timeout: 8000 });
    await row('Test subject').locator('md-icon-button[title="Process again"]').click(); await toastText(/Queued again/);
    await row('Test subject').locator('md-icon-button[title="Skip"]').click(); await toastText(/Skipped/); await page.waitForTimeout(800);
    await page.locator('.seg button', { hasText: 'Processed' }).click(); await row('Test subject').waitFor(); assert.match(await row('Test subject').innerText(), /skipped/);
    await row('Test subject').click(); await dlg().waitFor(); assert.match(await dlg().innerText(), /pick up the parcel/); await btn('Close', dlg()).click();
  });

  await step('approvals: approve creates the item, reject discards, approve-all', async () => {
    const d = db(); const ins = d.prepare("INSERT INTO approvals (created_at, kind, summary, reason, payload) VALUES (?, 'action', ?, 'money', ?)");
    const act = (t) => JSON.stringify({ action: { op: 'create', kind: 'task', title: t, confidence: 1, flags: ['money'], why: 'x' } });
    ins.run(new Date().toISOString(), 'Create task: Pay electric bill', act('Pay electric bill')); ins.run(new Date().toISOString(), 'Create task: Buy a boat', act('Buy a boat')); ins.run(new Date().toISOString(), 'Create task: Pay rent', act('Pay rent')); d.close();
    await goto('approvals'); await page.locator('.card', { hasText: 'Pay electric bill' }).waitFor();
    assert.match(await page.locator('.rail .dest[data-id=approvals] .badge').innerText(), /3/);
    await btn('Approve', page.locator('.card', { hasText: 'Pay electric bill' })).click(); await toastText(/Approved/); await page.waitForTimeout(800);
    await btn('Reject', page.locator('.card', { hasText: 'Buy a boat' })).click(); await toastText(/Rejected/); await page.waitForTimeout(800);
    await page.locator('.seg button', { hasText: 'Approved' }).click(); await page.locator('.card', { hasText: 'Pay electric bill' }).waitFor();
    await page.locator('.seg button', { hasText: 'Rejected' }).click(); await page.locator('.card', { hasText: 'Buy a boat' }).waitFor();
    await page.locator('.seg button', { hasText: 'Waiting' }).click(); await btn('Approve all').click(); await toastText(/Approved 1/); await page.waitForTimeout(800);
    await goto('items'); await row('Pay electric bill').waitFor(); await row('Pay rent').waitFor(); assert.equal(await row('Buy a boat').count(), 0);
  });

  await step('home: stat tiles and sections reflect the data; quick links work', async () => {
    await goto('home'); await page.locator('.stat.s3 .num').waitFor(); assert.ok(+(await page.locator('.stat.s3 .num').innerText()) >= 2);
    await page.locator('.stat.s3').click(); await heading('Items');
  });

  const call2 = (m, p, b) => fetch(base + p, { method: m, headers: { authorization: 'Bearer ' + 't'.repeat(32), 'content-type': 'application/json' }, body: b && JSON.stringify(b) }).then((r) => r.json());
  await step('connectors: card, set key, dry-run fails safely, disable, delete, edit instructions', async () => {
    const m = { id: 'acme', name: 'Acme Alerts', description: 'Alerts from Acme', baseUrl: 'https://api.acme.invalid', auth: { type: 'bearer', secret: 'ACME_KEY' }, poll: { path: '/alerts', intervalMinutes: 15, idField: 'id', bodyFields: ['text'] } };
    const d = db(); d.prepare("INSERT INTO connectors (id, manifest, status, created_at) VALUES ('acme', ?, 'approved', ?)").run(JSON.stringify(m), new Date().toISOString()); d.close();
    await goto('connectors'); const card = page.locator('.card', { hasText: 'Acme Alerts' }); await card.waitFor();
    assert.match(await card.innerText(), /Proposed[\s\S]*Approved/); assert.ok(!/✓ Credential/.test(await card.innerText()));
    await btn('Set key', card).click(); await dlg().waitFor(); await setField('ACME_KEY', 'sk-test-123'); await btn('Save', dlg()).click(); await toastText(/Saved/); await page.waitForTimeout(800);
    assert.match(await card.innerText(), /✓ Credential/); assert.match(await card.innerText(), /Change key/);
    await btn('Instructions', card).click(); await dlg().waitFor(); await setField('Instructions for Acme Alerts', 'Treat HW as homework.'); await btn('Save', dlg()).click(); await toastText(/Instructions saved/); await page.waitForTimeout(800);
    assert.match(await card.innerText(), /instructions/); assert.equal(JSON.parse((await call2('GET', '/connectors/full')).connectors.find((c) => c.id === 'acme').manifest ? JSON.stringify((await call2('GET', '/connectors/full')).connectors.find((c) => c.id === 'acme').manifest) : '{}').instructions, 'Treat HW as homework.');
    await btn('Edit instructions', card).click(); await dlg().waitFor(); assert.equal(await page.locator('md-dialog[open] md-outlined-text-field').first().evaluate((e) => e.value), 'Treat HW as homework.'); await btn('Clear', dlg()).click(); await toastText(/Instructions cleared/); await page.waitForTimeout(800);
    assert.ok(!/Edit instructions/.test(await card.innerText()));
    await btn('Test', card).click(); await dlg().waitFor(); assert.match(await dlg().innerText(), /Dry run failed/); await btn('OK', dlg()).click(); await page.waitForTimeout(500);
    await btn('Enable', card).click(); await toastText(/Run "test connector|test connector/); 
    await card.getByRole('button', { name: 'Delete' }).click(); await dlg().waitFor(); await btn('Delete', dlg()).click(); await toastText(/Deleted/); await page.waitForTimeout(800);
    assert.equal(await page.locator('.card', { hasText: 'Acme Alerts' }).count(), 0);
  });

  await step('system: status, integrations and logs render; restart asks first', async () => {
    await goto('system'); await page.locator('.card', { hasText: 'Integrations' }).waitFor(); const txt = (await page.locator('main').innerText()).toLowerCase();
    for (const w of ['Version', 'Uptime', 'Ticketing', 'Gmail', 'Server log', 'Maintenance']) assert.ok(txt.includes(w.toLowerCase()), w);
    assert.match(await page.locator('.logs').innerText(), /assistant listening/);
    await btn('Restart assistant').click(); await dlg().waitFor(); assert.match(await dlg().innerText(), /Restart the assistant/); await btn('Cancel', dlg()).click();
    await page.locator('.seg button', { hasText: 'Errors' }).click();
  });

  await step('settings: edit → unsaved bar → save persists; discard works; secrets are masked', async () => {
    await goto('settings'); await group('Notifications').click();
    await setField('ntfy topic', 'e2e-topic'); await page.locator('.savebar').waitFor(); assert.match(await page.locator('.savebar').innerText(), /1 unsaved/);
    await btn('Discard', page.locator('.savebar')).click(); await page.waitForTimeout(800); assert.equal(await page.locator('.savebar').count(), 0);
    await group('Notifications').click(); await setField('ntfy topic', 'e2e-topic'); await setField('ntfy server URL', 'http://ntfy:80');
    await btn('Save', page.locator('.savebar')).first().click(); await toastText(/Saved/); await page.waitForTimeout(500);
    const saved = JSON.parse((await (await fetch(base + '/settings', { headers: { authorization: 'Bearer ' + 't'.repeat(32) } })).text())).settings.find((s) => s.key === 'NTFY_TOPIC'); assert.equal(saved.value, 'e2e-topic');
    await page.reload(); await page.waitForTimeout(1000); await group('Notifications').click(); assert.equal(await page.locator('md-outlined-text-field[label="ntfy topic"]').evaluate((e) => e.value), 'e2e-topic');
    await group('Access').click(); assert.match(await page.locator('md-outlined-text-field[label="Ingest token"]').evaluate((e) => e.placeholder), /set/);
    await setField('Ingest token', 'new-ingest-token-value-1234'); await btn('Save', page.locator('.savebar')).first().click(); await toastText(/Saved/);
    assert.ok(!(await page.locator('body').innerText()).includes('new-ingest-token-value-1234'));
    await group('General').click(); await setField('Time zone', 'Not/AZone'); await btn('Save', page.locator('.savebar')).first().click(); await toastText(/time zone/i);
    await btn('Discard', page.locator('.savebar')).click(); await page.waitForTimeout(800);
  });

  await step('settings: theme mode and color apply instantly and persist', async () => {
    await goto('settings'); await page.locator('.seg button', { hasText: 'Dark' }).click(); assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor); assert.ok(bg !== 'rgb(255, 255, 255)');
    await page.locator('.swatch[title=Green]').click(); const prim = await page.evaluate(() => document.documentElement.style.getPropertyValue('--md-sys-color-primary')); assert.ok(prim);
    await page.reload(); await page.waitForTimeout(800); assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark'); assert.equal(await page.evaluate(() => localStorage.getItem('ui_seed')), '#2E7D32');
    await goto('settings'); await page.locator('.seg button', { hasText: 'Light' }).click(); assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light');
    const hue = await page.evaluate(() => ['primary', 'primary-container', 'tertiary', 'secondary-container', 'surface-container'].map((r) => getComputedStyle(document.documentElement).getPropertyValue('--md-sys-color-' + r).trim()));
    for (const c of hue) { const [r, g, b] = [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16)); assert.ok(!(r > g + 25 && b > g + 25), `pink/purple colour ${c}`); }   // magenta-ish = red and blue both well above green
  });

  await step('settings: change password through the dialog, then sign in with it', async () => {
    await goto('settings'); await btn('Change password').click(); await dlg().waitFor();
    await setField('Current password', PW); await setField('New password (8+ characters)', 'second-pass-9'); await setField('Repeat new password', 'mismatch-9'); await btn('Change', dlg()).click(); await toastText(/do not match/);
    await setField('Repeat new password', 'second-pass-9'); await btn('Change', dlg()).click(); await toastText(/Password changed/);
    await page.waitForTimeout(500); await btn('Sign out').click(); await page.waitForTimeout(1500); await page.locator('md-outlined-text-field[label="Password"]').waitFor();
    await setField('Password', PW); await btn('Sign in').click(); await page.locator('.err', { hasText: 'Wrong password' }).waitFor();
    await setField('Password', 'second-pass-9'); await btn('Sign in').click(); await heading('Settings');      // the page you were on is kept
  });

  await step('search dialog finds items and messages', async () => {
    await page.getByRole('button', { name: 'Search' }).click(); await dlg().waitFor(); await setField('Search messages, items and files', 'parcel'); await dlg().locator('.row').first().waitFor({ timeout: 5000 });
    assert.match(await dlg().innerText(), /parcel/); await btn('Close', dlg()).click();
  });

  await step('sign-out and session loss return to the login screen', async () => {
    await page.locator('.topbar').getByRole('button', { name: 'Sign out' }).click(); await page.locator('md-outlined-text-field[label="Password"]').waitFor();
    await page.evaluate(() => localStorage.setItem('assistant_token', 'bogus')); await page.reload(); await page.locator('md-outlined-text-field[label="Password"]').waitFor({ timeout: 6000 });
    await setField('Password', 'second-pass-9'); await btn('Sign in').click(); await page.locator('h1.display').waitFor();
  });

  await step('mobile: bottom nav and the More menu work, nothing overflows sideways', async () => {
    await page.setViewportSize({ width: 390, height: 800 }); await goto('home');
    assert.ok(await page.locator('.bottom-nav').isVisible()); assert.ok(!(await page.locator('.rail').isVisible()));
    for (const p of ['home', 'items', 'chat', 'inbox', 'approvals', 'connectors', 'system', 'settings']) { await goto(p); assert.ok(!(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)), 'overflow on ' + p); }
    await page.locator('.bottom-nav .dest', { hasText: 'Chat' }).click(); await heading('Chat');
    await page.locator('#moreBtn').click(); await page.locator('md-menu-item', { hasText: 'System' }).click(); await heading('System');
  });

  await step('chat page: renders, suggestions present (no message is sent)', async () => {
    await page.setViewportSize({ width: 1300, height: 900 }); await goto('chat'); assert.ok((await page.locator('md-assist-chip').count()) >= 2); await page.locator('.seg button', { hasText: 'Ask a question' }).click();
    assert.equal(await page.locator('.seg button[aria-pressed=true]').innerText(), 'Ask a question');
  });

  await step('chat page: markdown renders safely; pictures attach, preview, send and show (the reply is canned — no AI)', async () => {
    const evil = '# Title\n\n**bold** and *it* and `code`\n\n- one\n- two\n\n1. a\n2. b\n\n```\nlet x = 1 < 2;\n```\n\n| h1 | h2 |\n|---|---|\n| c1 | c2 |\n\n[ok](https://example.com) [bad](javascript:alert(1)) ![img](https://evil.example/x.png)\n\n<script>window.pwned=1</script><img src=x onerror="window.pwned=1">';
    await page.evaluate((t) => localStorage.setItem('chat_history', JSON.stringify([{ role: 'bot', text: t }])), evil);
    await goto('chat'); await page.reload(); await page.waitForTimeout(700);
    const b = page.locator('.bubble.bot .md').first(); await b.waitFor();
    assert.equal(await b.locator('h3').innerText(), 'Title'); assert.equal(await b.locator('strong').first().innerText(), 'bold'); assert.equal(await b.locator('em').first().innerText(), 'it');
    assert.equal(await b.locator('ul li').count(), 2); assert.equal(await b.locator('ol li').count(), 2); assert.match(await b.locator('pre code').innerText(), /let x = 1 < 2;/); assert.equal(await b.locator('table td').count(), 2);
    assert.equal(await b.locator('a[href^="https://example.com"]').count(), 1); assert.equal(await b.locator('a[href^="javascript"]').count(), 0); assert.equal(await b.locator('img, script').count(), 0);   // no external image, no script, no javascript: link
    assert.match(await b.innerText(), /<script>window\.pwned=1<\/script>/);          // shown as text
    assert.ok(!(await page.evaluate(() => window.pwned)), 'injected HTML ran');
    // attach a picture: preview chip, remove, attach again, send
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGN4oKCAFTEMLQkAUmxIATH3sAAAAAAASUVORK5CYII=', 'base64');
    const input = page.locator('input[type=file]'); await input.setInputFiles({ name: 'shot.png', mimeType: 'image/png', buffer: png });
    await page.locator('.pics .pic img').waitFor(); await page.locator('.pic button').click(); assert.equal(await page.locator('.pics .pic').count(), 0);
    await input.setInputFiles({ name: 'shot.png', mimeType: 'image/png', buffer: png }); await page.locator('.pics .pic img').waitFor();
    await input.setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hi') }); await toastText(/not a PNG/);
    let sent; await page.route('**/chat', async (r) => { sent = JSON.parse(r.request().postData()); await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ reply: 'Saw **one** picture\n\n- noted' }) }); });
    await page.locator('textarea[aria-label=Message]').fill('look at *this*'); await page.locator('.composer md-filled-icon-button').click();
    await page.locator('.bubble.bot strong', { hasText: 'one' }).waitFor();
    assert.equal(sent.text, 'look at *this*'); assert.equal(sent.images.length, 1); assert.ok(['PNG', '\xff\xd8\xff'].some((m) => Buffer.from(sent.images[0].data, 'base64').toString('latin1').includes(m)), 'real image bytes');
    assert.equal(await page.locator('.bubble.me .bubble-pics img').count(), 1); assert.equal(await page.locator('.bubble.me em', { hasText: 'this' }).count(), 1); assert.equal(await page.locator('.pics .pic').count(), 0);   // composer is cleared
    await page.unroute('**/chat');
    // pasting a picture also attaches it
    await page.evaluate(async () => { const ta = document.querySelector('textarea[aria-label=Message]'); const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGN4oKCAFTEMLQkAUmxIATH3sAAAAAAASUVORK5CYII='), (c) => c.charCodeAt(0)); const blob = new Blob([bytes], { type: 'image/png' }); const dt = new DataTransfer(); dt.items.add(new File([blob], 'p.png', { type: 'image/png' })); ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); });
    await page.locator('.pics .pic img').waitFor();
  });

  await step('settings: backup downloads, and restoring it brings back the saved state (and undoes later changes)', async () => {
    const T = 't'.repeat(32); const call = (m, p, b) => fetch(base + p, { method: m, headers: { authorization: 'Bearer ' + T, 'content-type': 'application/json' }, body: b && JSON.stringify(b) }).then((r) => r.json());
    const titles = async () => (await call('GET', '/items?state=open')).items.map((i) => i.title);
    await call('POST', '/items', { kind: 'task', title: 'Backup keeper' }); assert.ok((await titles()).includes('Backup keeper'));
    await goto('settings'); await page.locator('h2', { hasText: 'Backup' }).waitFor();
    await page.evaluate(() => { const o = URL.createObjectURL.bind(URL); URL.createObjectURL = (b) => { window.savedBlob = b; return o(b); }; });
    const [dl] = await Promise.all([page.waitForEvent('download'), btn('Download backup').click()]);
    assert.match(dl.suggestedFilename(), /^assistant-backup-\d{4}-\d{2}-\d{2}\.backup$/);
    const path = join(dir, 'saved.backup'); writeFileSync(path, Buffer.from(await page.evaluate(async () => { const b = new Uint8Array(await window.savedBlob.arrayBuffer()); let t = ''; for (let i = 0; i < b.length; i += 8192) t += String.fromCharCode(...b.subarray(i, i + 8192)); return btoa(t); }), 'base64'));   // (the browser's own download folder may be unreachable)
    assert.match(await page.locator('.card', { hasText: 'Saved on the server' }).innerText(), /Nightly backup is on/);
    await btn('Back up now').click(); await page.locator('.row .t', { hasText: /^manual-.*\.backup$/ }).first().waitFor();
    assert.ok((await call('GET', '/backup/list')).backups.some((b) => b.kind === 'manual'));
    await call('POST', '/items', { kind: 'task', title: 'Added after the backup' }); assert.ok((await titles()).includes('Added after the backup'));
    // a wrong file is refused with a plain message and changes nothing
    await page.locator('input[aria-label="Choose a backup file"]').setInputFiles({ name: 'x.backup', mimeType: 'application/octet-stream', buffer: Buffer.from('not a backup') });
    await btn('Restore', page.locator('md-dialog[open]')).click(); await toastText(/not a backup file/); assert.ok((await titles()).includes('Added after the backup'));
    await page.locator('input[aria-label="Choose a backup file"]').setInputFiles({ name: 'saved.backup', mimeType: 'application/octet-stream', buffer: readFileSync(path) });
    await btn('Restore', page.locator('md-dialog[open]')).click();
    await page.locator('md-dialog[open]', { hasText: 'Backup restored' }).waitFor();
    const after = await titles(); assert.ok(after.includes('Backup keeper')); assert.ok(!after.includes('Added after the backup'));
    await page.locator('md-dialog[open] md-text-button', { hasText: 'Close' }).click(); await page.waitForTimeout(800);
  });


  const api = (method, path, body) => fetch(base + path, { method, headers: { authorization: 'Bearer ' + 't'.repeat(32), 'content-type': 'application/json' }, body: body && JSON.stringify(body) }).then((r) => r.json());
  const active = () => page.evaluate(() => { const a = document.activeElement; return a ? (a.getAttribute('label') || a.tagName) : ''; });
  const press = async (k) => { await page.keyboard.press(k); await page.waitForTimeout(250); };

  await step('keyboard: "/" always lands in the text box of the current page', async () => {
    await page.setViewportSize({ width: 1300, height: 900 });
    for (const [pg, expect] of [['home', 'What should I remember or track?'], ['items', 'Filter'], ['inbox', 'Search messages'], ['settings', 'Filter settings'], ['system', 'Filter the server log']]) {
      await goto(pg); await page.locator('body').click({ position: { x: 700, y: 5 } }); await press('/'); assert.equal(await active(), expect, pg);
      await page.keyboard.type('a/b'); const v = await page.locator(`md-outlined-text-field[label="${expect}"]`).evaluate((e) => e.value); assert.equal(v, 'a/b', pg + ': typing "/" inside a box must type it');
      await press('Escape'); assert.notEqual(await active(), expect, pg + ': Esc leaves the box');
    }
    await goto('chat'); await page.locator('h1').click(); await press('/'); assert.equal(await active(), 'TEXTAREA');
    for (const pg of ['approvals', 'connectors']) { await goto(pg); await page.locator('h1').click(); await press('/'); await dlg().waitFor(); assert.match(await dlg().innerText(), /Search/); await press('Escape'); await page.waitForTimeout(400); }
  });

  await step('keyboard: g-chords and number keys navigate; the hint appears', async () => {
    await goto('home'); await page.locator('h1').click();
    await press('g'); assert.ok(await page.locator('.chord-hint').isVisible()); await press('i'); await heading('Items');
    for (const [k, h] of [['h', /Good|Still/], ['c', 'Chat'], ['b', 'Inbox'], ['a', 'Approvals'], ['o', 'Connectors'], ['y', 'System'], ['s', 'Settings']]) { await page.locator('h1').first().click(); await press('g'); await press(k); await heading(h); }
    for (const [k, h] of [['2', 'Items'], ['3', 'Chat'], ['8', 'Settings'], ['1', /Good|Still/]]) { await page.locator('h1').first().click(); await press(k); await heading(h); }
    await page.locator('h1').first().click(); await press('g'); await press('z'); assert.equal(await page.locator('.chord-hint').count(), 0);          // unknown second key cancels
  });

  await step('keyboard: ? shows the list, Esc closes it; Ctrl+K searches from inside a text box', async () => {
    await goto('items'); await page.locator('h1').click(); await press('?'); await dlg().waitFor(); assert.match(await dlg().innerText(), /Keyboard shortcuts/); assert.match(await dlg().innerText(), /Jump to the text box/); await press('Escape'); await page.waitForTimeout(500);
    assert.equal(await dlg().count(), 0);
    await press('/'); await press('Control+k'); await dlg().waitFor(); assert.match(await dlg().innerText(), /Search/); await press('Escape'); await page.waitForTimeout(500);
    await page.getByRole('button', { name: 'Keyboard shortcuts' }).click(); await dlg().waitFor(); await press('Escape');
  });

  await step('keyboard: n creates, Ctrl+Enter submits, j/k select, x completes, e edits, Delete drops (with confirm)', async () => {
    for (const t of ['Alpha task', 'Bravo task', 'Charlie task']) await api('POST', '/items', { kind: 'task', title: t });
    await goto('items'); await page.locator('h1').click(); await press('n'); await dlg().waitFor();
    await setField('Title', 'Delta task'); await page.locator('md-outlined-text-field[label="Title"]').focus(); await page.keyboard.press('Control+Enter'); await row('Delta task').waitFor(); await page.waitForTimeout(800);
    assert.equal(await dlg().count(), 0);
    await page.locator('h1').click(); await press('j'); assert.ok((await page.locator(".row.sel").count()) === 1);
    const first = await page.locator('.row.sel .t').innerText(); await press('j'); const second = await page.locator('.row.sel .t').innerText(); assert.notEqual(first, second); await press('k'); assert.equal(await page.locator('.row.sel .t').innerText(), first);
    await press('j'); await press('x'); await toastText(/Done/); await page.waitForTimeout(900); assert.equal(await row(second).count(), 0);
    await page.locator('h1').click(); await press('j'); await press('e'); await dlg().waitFor(); assert.match(await dlg().innerText(), /Edit item/); await press('Escape'); await page.waitForTimeout(500);
    await press('j'); await press('Enter'); await dlg().waitFor(); await press('Escape'); await page.waitForTimeout(500);
    await press('Delete'); await dlg().waitFor(); assert.match(await dlg().innerText(), /Drop this item/); await btn('Cancel', dlg()).click(); await page.waitForTimeout(500);
    const n = await page.locator('.row').count(); await press('Delete'); await dlg().waitFor(); await btn('Drop', dlg()).click(); await toastText(/Dropped/); await page.waitForTimeout(900); assert.equal(await page.locator('.row').count(), n - 1);
    await press('Escape'); assert.equal(await page.locator('.row.sel').count(), 0);
  });

  await step('keyboard: shortcuts on Inbox and Approvals; settings filter narrows the groups', async () => {
    const d = db(); d.prepare("INSERT INTO approvals (created_at, kind, summary, reason, payload) VALUES (?, 'action', ?, 'money', ?)").run(new Date().toISOString(), 'Create task: Keyboard approve', JSON.stringify({ action: { op: 'create', kind: 'task', title: 'Keyboard approve', confidence: 1, flags: ['money'], why: 'x' } }));
    d.prepare("INSERT INTO approvals (created_at, kind, summary, reason, payload) VALUES (?, 'action', ?, 'money', ?)").run(new Date().toISOString(), 'Create task: Keyboard reject', JSON.stringify({ action: { op: 'create', kind: 'task', title: 'Keyboard reject', confidence: 1, flags: ['money'], why: 'x' } })); d.close();
    await goto('approvals'); await page.locator('.card', { hasText: 'Keyboard approve' }).waitFor(); await page.locator('h1').click();
    await press('j'); await press('x'); await toastText(/Approved/); await page.waitForTimeout(900); assert.equal(await page.locator('.card', { hasText: 'Keyboard approve' }).count(), 0);
    await press('j'); await press('Delete'); await toastText(/Rejected/); await page.waitForTimeout(900); assert.equal(await page.locator('.card.high').count(), 0);
    await goto('settings'); await page.locator('h1').click(); await press('/'); await page.keyboard.type('ntfy'); await page.waitForTimeout(400);
    const vis = await page.locator('details:visible').count(); assert.equal(vis, 1); assert.ok(await page.locator('md-outlined-text-field[label="ntfy topic"]').isVisible()); assert.ok(!(await page.locator('md-outlined-text-field[label="Time zone"]').isVisible()));
    await page.keyboard.press('Control+a'); await page.keyboard.type('zzzz-nothing'); await page.waitForTimeout(400); assert.equal(await page.locator('details:visible').count(), 0);
  });

  await step('keyboard: t toggles the theme, r refreshes, n opens the page-specific "new"', async () => {
    await goto('home'); await page.locator('h1').click(); const before = await page.evaluate(() => document.documentElement.dataset.theme); await press('t'); assert.notEqual(await page.evaluate(() => document.documentElement.dataset.theme), before); await press('t');
    await press('r'); await page.locator('.page-head').waitFor();
    await goto('inbox'); await page.locator('h1').click(); await press('n'); await dlg().waitFor(); assert.match(await dlg().innerText(), /Add to inbox/); await press('Escape'); await page.waitForTimeout(500);
    await goto('connectors'); await page.locator('h1').click(); await press('n'); await dlg().waitFor(); assert.match(await dlg().innerText(), /Add a connector/); await press('Escape'); await page.waitForTimeout(500);
    await goto('chat'); await page.locator('h1').click(); await press('n'); assert.equal(await active(), 'TEXTAREA');
  });


  await step('items: sort, time filters, quick add, relative dates, export, remembered view', async () => {
    const T = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 16);
    await api('POST', '/items', { kind: 'task', title: 'Zeta overdue', dueAt: T(-2), priority: 'low' });
    await api('POST', '/items', { kind: 'task', title: 'Yankee soon', dueAt: T(3), priority: 'urgent' });
    await goto('items'); await row('Zeta overdue').waitFor();
    assert.match(await row('Zeta overdue').innerText(), /overdue · 2 days ago/); assert.match(await row('Yankee soon').innerText(), /due in 3 days/);
    await page.getByRole('button', { name: /Overdue/ }).click(); await page.waitForTimeout(300); assert.equal(await row('Yankee soon').count(), 0); assert.ok(await row('Zeta overdue').count());
    await page.getByRole('button', { name: 'Any time' }).click();
    await page.locator('md-text-button', { hasText: 'Sort:' }).click(); await page.locator('md-menu-item:visible', { hasText: 'A–Z' }).click(); await page.waitForTimeout(300);
    const titles = await page.locator('.row .t').allInnerTexts(); assert.deepEqual(titles, [...titles].sort((a, b) => a.localeCompare(b)));
    await page.reload(); await page.waitForTimeout(900); assert.match(await page.locator('md-text-button', { hasText: 'Sort:' }).innerText(), /A–Z/);   // remembered
    await page.locator('md-text-button', { hasText: 'Sort:' }).click(); await page.locator('md-menu-item:visible', { hasText: 'Due date' }).click();
    await page.locator('md-outlined-text-field[label^="Quick add"]').click(); await page.keyboard.type('Quick added thing'); await page.keyboard.press('Enter'); await row('Quick added thing').waitFor();
    await page.evaluate(() => { const o = URL.createObjectURL; URL.createObjectURL = (b) => { window.__blob = b; return o.call(URL, b); }; });
    const [dl] = await Promise.all([page.waitForEvent('download'), (async () => { await page.locator('md-text-button', { hasText: 'Export' }).click(); await page.locator('md-menu-item:visible', { hasText: 'CSV' }).click(); })()]);
    assert.match(dl.suggestedFilename(), /^items-\d{4}-\d\d-\d\d\.csv$/);
    const csv = await page.evaluate(() => window.__blob.text()); assert.match(csv, /Quick added thing/); assert.match(csv, /^kind,title/);
  });

  await step('command palette: commands, Enter runs the first match; tab title shows counts', async () => {
    await goto('home'); await page.locator('h1').click(); await press('Control+k'); await dlg().waitFor();
    assert.match(await dlg().innerText(), /Go to Items/); await page.keyboard.type('sett'); await page.waitForTimeout(250); await page.keyboard.press('Enter'); await page.waitForTimeout(700);
    await heading('Settings'); assert.equal(await dlg().count(), 0); assert.match(await page.title(), /Settings · Assistant/);
    const d = db(); d.prepare("INSERT INTO approvals (created_at, kind, summary, reason, payload) VALUES (?, 'action', 'Title count', 'money', ?)").run(new Date().toISOString(), JSON.stringify({ action: { op: 'create', kind: 'task', title: 'Title count', confidence: 1, flags: ['money'], why: 'x' } })); d.close();
    await goto('approvals'); await page.waitForTimeout(900); assert.match(await page.title(), /^\(\d+\) Approvals/);
  });

  await step('unsaved settings: leaving asks first; Cancel stays, Discard leaves', async () => {
    await goto('settings'); await group('Notifications').click(); await setField('ntfy topic', 'unsaved-1'); await page.locator('.savebar').waitFor();
    await page.locator('.rail .dest[data-id=items]').click(); await dlg().waitFor(); assert.match(await dlg().innerText(), /Discard unsaved changes/);
    await btn('Cancel', dlg()).click(); await page.waitForTimeout(600); assert.match(page.url(), /#\/settings/); assert.ok(await page.locator('.savebar').count());
    await page.locator('.rail .dest[data-id=items]').click(); await dlg().waitFor(); await btn('Discard', dlg()).click(); await heading('Items'); assert.match(page.url(), /#\/items/);
  });

  await step('connection lost: banner appears and clears when the server answers again; chat ArrowUp recalls', async () => {
    await goto('home'); await ctx.setOffline(true); await page.getByRole('button', { name: 'Refresh' }).click(); await page.locator('.offline').waitFor();
    await ctx.setOffline(false); await page.getByRole('button', { name: 'Refresh' }).click(); await page.locator('.offline').waitFor({ state: 'detached' });
    await page.evaluate(() => localStorage.setItem('chat_history', JSON.stringify([{ role: 'me', text: 'previous message' }, { role: 'bot', text: 'ok' }])));
    await goto('chat'); await page.locator('textarea[aria-label=Message]').focus(); await page.keyboard.press('ArrowUp');
    assert.equal(await page.locator('textarea[aria-label=Message]').inputValue(), 'previous message');
  });


  await step('dialogs ignore clicks outside; proposed connectors can be approved right on their card', async () => {
    await page.setViewportSize({ width: 1300, height: 900 });
    await goto('connectors'); await page.locator('h1').click(); await press('n'); await dlg().waitFor();
    await page.locator('md-outlined-text-field[label^="Paste everything"]').click(); await page.keyboard.type('draft text');
    await page.mouse.click(6, 450); await page.waitForTimeout(500); assert.equal(await dlg().count(), 1, 'a click on the dim area must not close the dialog');
    assert.equal(await page.locator('md-outlined-text-field[label^="Paste everything"]').evaluate((e) => e.value), 'draft text');
    await press('Escape'); await page.waitForTimeout(600); assert.equal(await dlg().count(), 0, 'Esc still closes');
    const man = { id: 'proposed-co', name: 'Proposed Co', description: 'x', baseUrl: 'https://api.proposed.example', auth: { type: 'bearer', secret: 'PROPOSED_KEY' }, poll: { path: '/v1/a', intervalMinutes: 15, bodyFields: ['title'], itemsPath: '', idField: 'id', params: {} } };
    const d = db(); d.prepare("INSERT INTO connectors (id, manifest, status, created_at) VALUES ('proposed-co', ?, 'proposed', ?)").run(JSON.stringify(man), new Date().toISOString());
    d.prepare("INSERT INTO approvals (created_at, kind, summary, reason, payload) VALUES (?, 'connector', 'Connect Proposed Co', 'new outside service', ?)").run(new Date().toISOString(), JSON.stringify({ id: 'proposed-co' })); d.close();
    await page.reload(); await page.waitForTimeout(900); const card = page.locator('.card', { hasText: 'Proposed Co' }); await card.waitFor();
    await btn('Approve', card).click(); await toastText(/Approved/); await page.waitForTimeout(600);
    assert.ok(await btn('Set key', card).isVisible(), 'card moves on to the credential step');
    assert.equal((await api('GET', '/connectors/full')).connectors.find((c) => c.id === 'proposed-co').status, 'approved');
  });


  await step('connect wizard: one Connect button, live progress, clean failure (model is stubbed out), nothing left behind', async () => {
    await goto('home'); await goto('connectors'); await page.locator('h1').click(); await press('n'); await dlg().waitFor();
    assert.equal(await page.locator('md-filled-button', { hasText: /Propose|Review/ }).count(), 0);
    await btn('Connect', dlg()).click(); await page.waitForTimeout(300); assert.ok(await dlg().count(), 'empty paste does nothing');
    await page.locator('md-outlined-text-field[label^="Paste everything"]').click(); await page.keyboard.type('Acme API: GET https://api.acme.example/orders returns a list of orders');
    await btn('Connect', dlg()).click();
    await dlg().locator('.autolog .astep').first().waitFor(); await dlg().locator('.err').waitFor({ timeout: 20000 });
    assert.match(await dlg().innerText(), /Reading what you pasted/); assert.match(await dlg().innerText(), /build a safe connector|claude exited/);
    // what the owner SEES matters, not just what is in the page: the form and Connect button must be gone, the result on screen
    assert.equal(await page.locator('md-outlined-text-field[label^="Paste everything"]').isVisible(), false, 'paste form must be hidden while/after connecting');
    assert.equal(await btn('Connect', dlg()).isVisible(), false, 'Connect button must be hidden after it was pressed');
    assert.equal(await dlg().locator('.err').isVisible(), true); const eb = await dlg().locator('.err').boundingBox(), db_ = await dlg().evaluate((el) => { const r = el.shadowRoot.querySelector('.container').getBoundingClientRect(); return { y: r.y, height: r.height }; }); assert.ok(eb.y >= db_.y && eb.y + eb.height <= db_.y + db_.height, 'the error is inside the visible dialog');
    await btn('Edit and try again', dlg()).click(); await page.waitForTimeout(300);
    assert.equal(await page.locator('md-outlined-text-field[label^="Paste everything"]').isVisible(), true, 'form is back for the retry'); assert.equal(await btn('Connect', dlg()).isVisible(), true);
    assert.equal(await page.locator('md-outlined-text-field[label^="Paste everything"]').evaluate((e) => e.value), 'Acme API: GET https://api.acme.example/orders returns a list of orders', 'text is kept for the retry');
    await press('Escape'); await page.waitForTimeout(500);
  });


  await step('write connectors: card shows reads/writes, per-action "no need to ask" switch (DELETE always asks)', async () => {
    const man = { id: 'billing', name: 'Billing Co', description: 'x', baseUrl: 'https://api.billing.example', auth: { type: 'none' }, actions: [
      { id: 'create_invoice', name: 'Create invoice', description: 'Bill a customer', method: 'POST', path: '/invoices', params: [{ name: 'amount', description: 'dollars', in: 'body', required: true }] },
      { id: 'delete_invoice', name: 'Delete invoice', description: 'Remove one', method: 'DELETE', path: '/invoices/{id}', params: [{ name: 'id', description: 'id', in: 'path', required: true }] }] };
    const d = db(); d.prepare("INSERT INTO connectors (id, manifest, status, created_at) VALUES ('billing', ?, 'enabled', ?)").run(JSON.stringify(man), new Date().toISOString()); d.close();
    await goto('home'); await goto('connectors'); const card = page.locator('.card', { hasText: 'Billing Co' }); await card.waitFor();
    assert.match(await card.innerText(), /writes/i); assert.match(await card.innerText(), /Writes only/);
    await card.locator('summary', { hasText: '2 write actions' }).click();
    assert.match(await card.innerText(), /always asks/);
    await card.getByRole('switch', { name: /Allow Create invoice without asking/ }).click(); await toastText(/without asking/);
    assert.deepEqual((await api('GET', '/connectors/full')).connectors.find((c) => c.id === 'billing').autoActions, ['create_invoice']);
    await card.getByRole('switch', { name: /Allow Create invoice without asking/ }).click(); await toastText(/will ask first/);
    assert.deepEqual((await api('GET', '/connectors/full')).connectors.find((c) => c.id === 'billing').autoActions, []);
  });

  await step('MCP connectors: card shows the server and its tools; destructive tools always ask', async () => {
    const man = { id: 'mcp-notes', name: 'Notes MCP', description: 'MCP server notes.example.com', baseUrl: 'https://notes.example.com', auth: { type: 'bearer', secret: 'NOTES_MCP_KEY' }, mcp: { url: 'https://notes.example.com/mcp' }, actions: [
      { id: 'search_notes', name: 'search_notes', description: '(read-only) Search', method: 'POST', path: '/', tool: 'search_notes', readOnly: true, params: [{ name: 'query', description: 'text', in: 'body', required: true, type: 'string' }] },
      { id: 'delete_note', name: 'delete_note', description: 'Delete', method: 'DELETE', path: '/', tool: 'delete_note', params: [{ name: 'id', description: 'id', in: 'body', required: true, type: 'string' }] }] };
    const d = db(); d.prepare("INSERT INTO connectors (id, manifest, status, created_at) VALUES ('mcp-notes', ?, 'enabled', ?)").run(JSON.stringify(man), new Date().toISOString()); d.close();
    await goto('home'); await goto('connectors'); const card = page.locator('.card', { hasText: 'Notes MCP' }); await card.waitFor();
    assert.match(await card.innerText(), /MCP server · https:\/\/notes.example.com\/mcp/);
    await card.locator('summary', { hasText: '2 MCP tools' }).click();
    assert.match(await card.innerText(), /read-only/); assert.match(await card.innerText(), /always asks/);
  });

  await step('no JavaScript errors were logged during the whole run', async () => { assert.deepEqual(errors, []); });
} finally {
  await browser.close(); srv.kill();
}
const failed = results.filter((r) => !r[0]);
console.log(`\n${results.length - failed.length}/${results.length} passed`); if (failed.length) { console.log(log.split('\n').slice(-15).join('\n')); console.log('screenshots in', dir); process.exit(1); }
