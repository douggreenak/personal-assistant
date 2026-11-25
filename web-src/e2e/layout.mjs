// Layout test: measures real geometry in a real browser across many screen sizes, both themes, every page, scrolled
// positions, dialogs and menus. Catches "the UI falls apart when you interact with it" problems that behaviour tests cannot:
// things hidden under fixed bars, off-screen controls, sideways scrolling, dialogs taller than the screen, stuck scrolling.
//   usage: CHROMIUM=/snap/bin/chromium node web-src/e2e/layout.mjs
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('../../', import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), 'assistant-layout-'));
const port = 20000 + Math.floor(Math.random() * 20000), base = `http://127.0.0.1:${port}`;
const PW = 'layout-password-1', TOKEN = 't'.repeat(32);
const srv = spawn('node', ['src/main.ts'], { cwd: root, env: { PATH: process.env.PATH, PORT: String(port), HOST: '127.0.0.1', ASSISTANT_DATA: dir, ASSISTANT_TOKEN: TOKEN, INGEST_TOKEN: 'i'.repeat(32), WEB_PASSWORD: PW, CLAUDE_BIN: '/bin/false', TZ_NAME: 'America/Anchorage' }, stdio: 'ignore' });
for (let i = 0; i < 50; i++) { try { if ((await fetch(base + '/healthz')).ok) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 200)); }

// ---- seed: enough data to make every page long, plus awkward content (long titles, unbroken words) ----
const api = (m, p, b) => fetch(base + p, { method: m, headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }).then((r) => r.json());
const day = (n) => new Date(Date.now() + n * 864e5).toISOString();
await api('POST', '/items', { kind: 'task', title: 'Replace the compressor on the walk-in cooler before the inspection next week', priority: 'urgent', dueAt: day(-2) });
await api('POST', '/items', { kind: 'reminder', title: 'Call Sam', dueAt: day(1) });
await api('POST', '/items', { kind: 'task', title: 'A_very_long_unbroken_title_that_goes_on_and_on_and_on_and_on_and_on_and_on_and_on_and_on_and_on_forever_and_ever', priority: 'high', dueAt: day(400) });
for (let i = 0; i < 12; i++) await api('POST', '/items', { kind: 'task', title: 'Task number ' + i });
for (let i = 0; i < 8; i++) await api('POST', '/ingest/message', { source: 'web', sourceId: 'm' + i, sender: 'someone.with.a.very.long.address@example-company.com', subject: 'Message ' + i + ' with a fairly long subject line that should wrap', body: 'Hello there, this is a fairly long message body. '.repeat(8) });
{
  const d = new DatabaseSync(join(dir, 'assistant.db'));
  const ins = d.prepare("INSERT INTO approvals (created_at, kind, summary, reason, payload) VALUES (?, 'action', ?, 'money', ?)");
  for (let i = 0; i < 6; i++) ins.run(new Date().toISOString(), `Create task: Pay invoice number ${i} to the supplier before the end of the month`, JSON.stringify({ action: { op: 'create', kind: 'task', title: 'Pay invoice ' + i, confidence: 1, flags: ['money'], why: 'x' } }));
  const man = { id: 'mcp-notes', name: 'Notes MCP', description: 'MCP server notes.example.com', baseUrl: 'https://notes.example.com', auth: { type: 'bearer', secret: 'NOTES_MCP_KEY' }, mcp: { url: 'https://notes.example.com/mcp' }, actions: [
    { id: 'search_notes', name: 'search_notes', description: '(read-only) Search all of your notes by text', method: 'POST', path: '/', tool: 'search_notes', readOnly: true, params: [{ name: 'query', description: 'text', in: 'body', required: true }] },
    { id: 'delete_note', name: 'delete_note', description: 'Delete a note', method: 'DELETE', path: '/', tool: 'delete_note', params: [{ name: 'id', description: 'id', in: 'body', required: true }] }] };
  const c = d.prepare("INSERT INTO connectors (id, manifest, status, created_at) VALUES (?, ?, 'enabled', ?)");
  c.run('mcp-notes', JSON.stringify(man), new Date().toISOString());
  for (let i = 0; i < 3; i++) c.run('svc-' + i, JSON.stringify({ ...man, id: 'svc-' + i, name: 'Service number ' + i + ' with a long name', description: 'Reads orders and creates invoices for the accounting team' }), new Date().toISOString());
  d.close();
}

const VIEWPORTS = [[320, 568], [360, 640], [390, 844], [412, 915], [768, 1024], [839, 900], [840, 900], [1024, 768], [1300, 900], [1920, 1080], [800, 360], [2560, 1300]];
const PAGES = ['home', 'items', 'chat', 'inbox', 'approvals', 'connectors', 'system', 'settings'];
const problems = [];
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/usr/bin/chromium', args: ['--no-sandbox'] });

/** Everything measured inside the page; returns a list of human-readable problems. */
const MEASURE = () => {
  const out = []; const W = innerWidth, H = innerHeight;
  const vis = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const nameOf = (e) => (e.id ? '#' + e.id : e.localName + (e.className && typeof e.className === 'string' ? '.' + e.className.trim().split(/\s+/)[0] : '')) + ` "${(e.getAttribute('aria-label') || e.textContent || '').trim().slice(0, 24)}"`;
  if (document.documentElement.scrollWidth - W > 1) out.push(`page scrolls sideways by ${document.documentElement.scrollWidth - W}px`);
  // anything poking out of the screen, unless it sits inside its own scroller
  const scrollerOf = (e) => { for (let p = e.parentElement; p; p = p.parentElement) { const o = getComputedStyle(p).overflowX; if (o === 'auto' || o === 'scroll' || o === 'hidden' || o === 'clip') return p; } return null; };
  for (const e of document.querySelectorAll('main *, .bottom-nav *, .rail *')) {
    if (!vis(e) || e.closest('md-dialog, md-menu, .toast, svg, md-ripple, md-focus-ring, md-elevation, .offline') || (e.closest('details:not([open])') && !e.closest('summary') && e.localName !== 'summary')) continue;
    const r = e.getBoundingClientRect();
    if ((r.right > W + 1 || r.left < -1) && !scrollerOf(e)) { out.push(`${nameOf(e)} sticks out of the screen (${Math.round(r.left)}..${Math.round(r.right)} of ${W})`); if (out.length > 6) break; }
  }
  const top = document.querySelector('.topbar'); if (top) { const bg = getComputedStyle(top).backgroundColor; if (/rgba\(.*,\s*0\)$|transparent/.test(bg)) out.push('top bar is see-through, content shows under the icons'); }
  return out;
};
const AT_BOTTOM = () => {
  const out = []; const nav = document.querySelector('.bottom-nav'); const navTop = nav && getComputedStyle(nav).display !== 'none' ? nav.getBoundingClientRect().top : innerHeight;
  const view = document.getElementById('view'); const last = [...view.querySelectorAll('*')].filter((e) => { const r = e.getBoundingClientRect(); return r.height > 0 && !e.closest('.fab-slot') && !e.closest('.msgs') && !e.closest('md-dialog') && !(e.closest('details:not([open])') && e.localName !== 'summary' && !e.closest('summary')); }).sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom)[0];
  if (last && last.getBoundingClientRect().bottom > navTop + 1) out.push(`the end of the page is hidden under the bottom bar (content ends ${Math.round(last.getBoundingClientRect().bottom)}, bar starts ${Math.round(navTop)})`);
  const fab = document.querySelector('.fab-slot md-fab'); if (fab) { const r = fab.getBoundingClientRect(); if (r.bottom > navTop + 1 || r.top < 0 || r.right > innerWidth + 1) out.push(`the + button is off-screen or under the bar (${Math.round(r.top)}..${Math.round(r.bottom)})`); }
  return out;
};
const DIALOG = () => {
  const out = []; const d = document.querySelector('md-dialog[open]'); if (!d) return ['dialog did not open'];
  const box = d.shadowRoot?.querySelector('.container') ?? d; const r = box.getBoundingClientRect();
  if (r.left < -1 || r.right > innerWidth + 1 || r.top < -1 || r.bottom > innerHeight + 1) out.push(`dialog does not fit the screen (${Math.round(r.left)},${Math.round(r.top)} → ${Math.round(r.right)},${Math.round(r.bottom)} in ${innerWidth}x${innerHeight})`);
  for (const b of d.querySelectorAll('[slot=actions] > *')) { const br = b.getBoundingClientRect(); if (br.width && (br.bottom > innerHeight + 1 || br.right > innerWidth + 1 || br.left < -1)) out.push(`dialog button "${b.textContent.trim()}" is off-screen`); }
  if (getComputedStyle(document.documentElement).overflow !== 'hidden') out.push('page behind the dialog can still scroll');
  return out;
};

async function runViewport([w, h], scheme) {
  const tag = `${w}x${h} ${scheme}`;
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: scheme }); const page = await ctx.newPage();
  const bad = (what, list) => { for (const p of list) problems.push(`[${tag}] ${what}: ${p}`); };
  page.on('pageerror', (e) => problems.push(`[${tag}] JS error: ${e.message}`));
  await page.goto(base + '/'); await page.locator('md-outlined-text-field[label="Password"]').waitFor();
  await page.locator('md-outlined-text-field[label="Password"]').evaluate((e, v) => { e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); }, PW);
  bad('login', await page.evaluate(MEASURE));
  await page.locator('md-filled-button', { hasText: 'Sign in' }).click(); await page.locator('h1.display').waitFor();
  const open = async (p) => { await page.goto(`${base}/#/${p}`); await page.reload(); await page.locator('h1.display').waitFor(); await page.waitForTimeout(700); await page.evaluate(() => scrollTo(0, 0)); };
  for (const p of PAGES) {
    await open(p); bad(p, await page.evaluate(MEASURE));
    if (p === 'chat') {   // the composer must be usable: inside the screen, above the bottom bar, and typing must not push anything off
      const r = await page.evaluate(() => { const t = document.querySelector('.composer textarea').getBoundingClientRect(); const n = document.querySelector('.bottom-nav'); return { bottom: t.bottom, top: t.top, navTop: n && getComputedStyle(n).display !== 'none' ? n.getBoundingClientRect().top : innerHeight, h: innerHeight }; });
      if (h >= 640 && (r.bottom > r.navTop + 1 || r.top < 0)) problems.push(`[${tag}] chat: message box is not visible without scrolling (box ${Math.round(r.top)}..${Math.round(r.bottom)}, bar at ${Math.round(r.navTop)})`);
      await page.locator('.composer textarea').fill('line one\nline two\nline three\nline four'); await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight)); await page.waitForTimeout(100); bad('chat typing', await page.evaluate(AT_BOTTOM).then((x) => x.filter((m) => !/\+ button/.test(m)))); await page.locator('.composer textarea').fill('');
      // wide Markdown (long code line, wide table, long URL) and five attached pictures must not break the layout
      const wide = '# Heading\n\n```\n' + 'x'.repeat(200) + '\n```\n\n| ' + Array.from({ length: 12 }, (_, i) => 'column' + i).join(' | ') + ' |\n|' + '---|'.repeat(12) + '\n| ' + Array(12).fill('value').join(' | ') + ' |\n\nhttps://example.com/' + 'a'.repeat(150) + '\n\n- item';
      await page.evaluate((t) => localStorage.setItem('chat_history', JSON.stringify([{ role: 'bot', text: t }, { role: 'me', text: 'look', thumbs: [] }])), wide); await open('chat');
      await page.locator('input[type=file]').setInputFiles(Array.from({ length: 5 }, (_, i) => ({ name: `p${i}.png`, mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGN4oKCAFTEMLQkAUmxIATH3sAAAAAAASUVORK5CYII=', 'base64') })));
      await page.locator('.pics .pic').nth(4).waitFor(); await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight)); await page.waitForTimeout(150);
      if (process.env.LAYOUT_SHOT) await page.screenshot({ path: `${process.env.LAYOUT_SHOT}/chat-${tag.replace(/\W+/g, '_')}.png`, fullPage: true });
      bad('chat with Markdown and pictures', await page.evaluate(MEASURE)); bad('chat with Markdown and pictures (end)', await page.evaluate(AT_BOTTOM));
      const r2 = await page.evaluate(() => { const t = document.querySelector('.composer textarea').getBoundingClientRect(); const n = document.querySelector('.bottom-nav'); return { bottom: t.bottom, navTop: n && getComputedStyle(n).display !== 'none' ? n.getBoundingClientRect().top : innerHeight }; });
      if (h >= 640 && r2.bottom > r2.navTop + 1) problems.push(`[${tag}] chat with pictures: message box is hidden under the bottom bar`);
      await page.evaluate(() => localStorage.removeItem('chat_history'));
    }
    await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight)); await page.waitForTimeout(150);
    bad(p + ' (scrolled to the end)', await page.evaluate(AT_BOTTOM)); bad(p + ' (scrolled)', await page.evaluate(MEASURE));
  }
  // dialogs: each must fit, show its buttons, lock the page behind, and give scrolling back when closed
  const dialogs = [['items', async () => page.locator('md-fab').click(), 'new item'], ['items', async () => page.locator('.row').first().click(), 'edit item'], ['connectors', async () => page.locator('md-fab').click(), 'add connector'],
    ['settings', async () => page.locator('md-filled-tonal-button', { hasText: 'Change password' }).click(), 'change password'], ['inbox', async () => page.locator('.row').first().click(), 'message'], ['home', async () => page.keyboard.press('Control+k'), 'search'], ['home', async () => page.keyboard.press('?'), 'shortcuts']];
  for (const [p, doOpen, name] of dialogs) {
    await open(p);
    if (p === 'settings') await page.locator('md-filled-tonal-button', { hasText: 'Change password' }).waitFor({ state: 'attached', timeout: 10000 }).catch(() => {});
    if (p === 'settings') await page.locator('md-filled-tonal-button', { hasText: 'Change password' }).scrollIntoViewIfNeeded();
    try { await doOpen(); await page.locator('md-dialog[open]').waitFor({ timeout: 4000 }); await page.waitForTimeout(450); } catch { problems.push(`[${tag}] ${name}: could not open`); continue; }
    bad(`dialog ${name}`, await page.evaluate(DIALOG));
    await page.keyboard.press('Escape'); await page.waitForTimeout(450);
    if (await page.evaluate(() => getComputedStyle(document.documentElement).overflow === 'hidden')) problems.push(`[${tag}] ${name}: page is stuck unscrollable after closing`);
  }
  // the connect wizard after pressing Connect: the form must be gone and the outcome visible inside the dialog
  await open('connectors'); await page.locator('md-fab').click(); await page.locator('md-dialog[open]').waitFor(); await page.waitForTimeout(400);
  await page.locator('md-outlined-text-field[label^="Paste everything"]').click(); await page.keyboard.type('Acme API: GET https://api.acme.example/orders');
  await page.locator('md-filled-button', { hasText: 'Connect' }).click(); await page.locator('md-dialog[open] .err').waitFor({ timeout: 25000 }).catch(() => problems.push(`[${tag}] wizard: no result shown`));
  const wz = await page.evaluate(() => { const d = document.querySelector('md-dialog[open]'); const f = d.querySelector('md-outlined-text-field[label^="Paste everything"]'); const e = d.querySelector('.err'); const box = d.shadowRoot.querySelector('.container').getBoundingClientRect(); const er = e?.getBoundingClientRect();
    return [f && f.getBoundingClientRect().height > 0 ? 'the paste form is still showing after Connect' : '', er && (er.top < box.top || er.bottom > box.bottom) ? 'the result is outside the visible dialog' : ''].filter(Boolean); });
  bad('wizard', wz); bad('wizard dialog', await page.evaluate(DIALOG)); await page.keyboard.press('Escape'); await page.waitForTimeout(300);
  // row menu at the top and the bottom of a long list
  await open('items');
  for (const where of ['top', 'bottom']) {
    if (where === 'bottom') { await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight)); await page.waitForTimeout(150); }
    const btn = where === 'top' ? page.locator('.row md-icon-button').nth(1) : page.locator('.row md-icon-button').last();
    await btn.click(); await page.waitForTimeout(400);
    const m = await page.evaluate(() => { const mm = document.querySelector('md-menu[open]'); if (!mm) return 'no menu'; const r = (mm.shadowRoot.querySelector('.menu') ?? mm).getBoundingClientRect(); return r.left < -1 || r.right > innerWidth + 1 || r.top < -1 || r.bottom > innerHeight + 1 ? `menu is off-screen (${Math.round(r.left)},${Math.round(r.top)} → ${Math.round(r.right)},${Math.round(r.bottom)})` : ''; });
    if (m) problems.push(`[${tag}] row menu (${where}): ${m}`);
    await page.keyboard.press('Escape'); await page.waitForTimeout(250);
  }
  // mobile More menu
  if (w < 840) { await page.locator('#moreBtn').click(); await page.waitForTimeout(400);
    const m = await page.evaluate(() => { const mm = document.querySelector('md-menu[open]'); if (!mm) return 'no menu'; const r = (mm.shadowRoot.querySelector('.menu') ?? mm).getBoundingClientRect(); return r.left < -1 || r.right > innerWidth + 1 || r.top < -1 || r.bottom > innerHeight + 1 ? 'More menu is off-screen' : ''; });
    if (m) problems.push(`[${tag}] ${m}`); await page.keyboard.press('Escape'); }
  await ctx.close();
}

// a few viewports at a time (each has its own browser context)
const jobs = VIEWPORTS.filter(([w, h]) => !process.env.LAYOUT_ONLY || process.env.LAYOUT_ONLY === `${w}x${h}`).flatMap((v) => ['light', 'dark'].map((s) => [v, s]));
let next = 0; const CONC = Math.max(2, Math.min(6, Number(process.env.LAYOUT_WORKERS) || 4));
const t0 = Date.now();
await Promise.all(Array.from({ length: CONC }, async () => { while (next < jobs.length) { const [v, s] = jobs[next++]; try { await runViewport(v, s); } catch (e) { problems.push(`[${v.join('x')} ${s}] test crashed: ${String(e.message).split('\n')[0]}`); } } }));
await browser.close(); srv.kill();
const uniq = [...new Set(problems)];
console.log(uniq.length ? uniq.map((p) => '  ✖ ' + p).join('\n') : '  ✔ no layout problems');
console.log(`\nlayout: ${jobs.length} screen/theme combinations checked in ${((Date.now() - t0) / 1000).toFixed(0)}s — ${uniq.length ? uniq.length + ' problem(s)' : 'all good'}`);
process.exit(uniq.length ? 1 : 0);
