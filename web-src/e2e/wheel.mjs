// Screenshots every page (desktop + phone) into $SHOTS (default scratch dir) so they can be looked at. Throwaway server, stand-in Claude.
import { chromium } from 'playwright-core';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const root = new URL('../../', import.meta.url).pathname; const dir = mkdtempSync(join(tmpdir(), 'shots-')); const out = process.env.SHOTS; mkdirSync(out, { recursive: true });
const port = 20000 + Math.floor(Math.random() * 20000), base = `http://127.0.0.1:${port}`; const PW = 'e2e-password-1', TOK = 't'.repeat(32);
const srv = spawn('node', ['src/main.ts'], { cwd: root, env: { PATH: process.env.PATH, PORT: String(port), HOST: '127.0.0.1', ASSISTANT_DATA: dir, ASSISTANT_TOKEN: TOK, INGEST_TOKEN: 'i'.repeat(32), WEB_PASSWORD: PW, CLAUDE_BIN: '/bin/false', CODE_ROOT: join(dir, 'projects'), CODE_CLAUDE_BIN: join(root, 'test/fixtures/code/fake-claude.mjs'), CODE_TMUX_SOCKET: 'shots' + port, CLAUDE_CONFIG_DIR: join(dir, 'cfg'), TZ_NAME: 'America/Anchorage' }, stdio: 'ignore' });
for (let i = 0; i < 50; i++) { try { if ((await fetch(base + '/healthz')).ok) break; } catch { /* */ } await new Promise((r) => setTimeout(r, 200)); }
const api = async (p, body, m = 'POST') => (await fetch(base + p, { method: m, headers: { authorization: 'Bearer ' + TOK, 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// some data
for (const t of ['Call the plumber', 'Renew passport', 'Pick up dry cleaning']) await api('/items', { kind: 'task', title: t, due: '2026-11-30' }).catch(() => {});
await api('/items', { kind: 'reminder', title: 'Take out the trash', remindAt: '2026-11-27T17:00:00Z' }).catch(() => {});
const p = (await api('/code/projects', { folder: 'demo', create: true })).project; const s = (await api(`/code/projects/${p.id}/sessions`, { title: 'Demo session' })).session; await wait(4000);
await api(`/code/sessions/${s.id}/send`, { text: 'hello' }); await wait(2500); await api(`/code/sessions/${s.id}/send`, { text: 'PERMISSION go' }); await wait(2500);
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/snap/bin/chromium', args: ['--no-sandbox'] });
const page = await (await browser.newContext({ viewport: { width: 1100, height: 760 } })).newPage(); await page.goto(base + '/'); await page.locator('md-outlined-text-field[label="Password"]').first().evaluate((el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }, PW); await page.locator('md-filled-button', { hasText: 'Sign in' }).click(); await wait(1500);
const delays = { items: 0, chat: 0 }; await page.route('**/*', async (route) => { const u = new URL(route.request().url()); const k = u.pathname === '/items' ? 'items' : u.pathname === '/chat' ? 'chat' : null; if (k && delays[k]) await wait(delays[k]); await route.continue().catch(() => {}); });
// 1. a slow page: the whole-page loader
delays.items = 4000; await page.goto(base + '/#/items'); await wait(1000); await page.screenshot({ path: process.env.SHOTS + '/wheel-page.png' });
console.log('1s into a slow page   : opacity', await page.evaluate(() => getComputedStyle(document.querySelector('.loading')).opacity));
await wait(3500); delays.items = 0;
// 2. a FAST page must not flash the loader: sample opacity every 20ms during the change
await page.goto(base + '/#/inbox'); const seen = await page.evaluate(() => new Promise((res) => { let max = 0; const t0 = performance.now(); const tick = () => { const e = document.querySelector('.loading'); if (e) max = Math.max(max, Number(getComputedStyle(e).opacity)); if (performance.now() - t0 < 700) requestAnimationFrame(tick); else res(max); }; location.hash = '#/tickets'; tick(); }));
console.log('fast page change      : max loader opacity seen', seen.toFixed(2), '(0 = never visible)');
// 3. chat: typing dots while waiting for a reply
delays.chat = 3500; await page.goto(base + '/#/chat'); await wait(800); await page.locator('.composer textarea').fill('hello'); await page.keyboard.press('Enter'); await wait(1200);
await page.screenshot({ path: process.env.SHOTS + '/wheel-chat.png' });
// 4. dark theme + the 8 second "still working" note
delays.chat = 0; await page.emulateMedia({ colorScheme: 'dark' }); delays.items = 12000; await page.goto(base + '/#/items'); await wait(9500);
console.log('9.5s: slow note opacity', await page.evaluate(() => getComputedStyle(document.querySelector('.loading-slow')).opacity));
await page.screenshot({ path: process.env.SHOTS + '/wheel-slow-dark.png' });
// 5. reduced motion
delays.items = 4000; await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'light' }); await page.goto(base + '/#/items'); await wait(600);
console.log('reduced motion        : opacity', await page.evaluate(() => getComputedStyle(document.querySelector('.loading')).opacity), '| wheel animation', await page.evaluate(() => getComputedStyle(document.querySelector('.wheel')).animationName));
await browser.close(); srv.kill(); try { execFileSync('tmux', ['-L', 'shots' + port, 'kill-server'], { stdio: 'ignore' }); } catch { /* */ }
