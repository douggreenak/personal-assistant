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
const page = await (await browser.newContext({ viewport: { width: 1100, height: 760 } })).newPage(); page.on('pageerror', (e) => console.log('PAGEERROR', e.message)); page.on('console', (m) => m.type() === 'error' && console.log('CONSOLE', m.text()));
await page.goto(base + '/'); await page.locator('md-outlined-text-field[label="Password"]').first().evaluate((el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }, PW); await page.locator('md-filled-button', { hasText: 'Sign in' }).click(); await wait(1500);
await page.goto(base + '/#/settings'); await wait(1500);
const navNames = await page.locator('.set-nav-item').allInnerTexts(); console.log('settings sections:', navNames.join(' | '));
const labels = async () => (await page.locator('.set-pane:not([hidden]) [data-q]').evaluateAll((els) => els.map((e) => e.dataset.q.split(' ')[0] + (e.closest('.set-adv') ? '*' : ''))));
for (const n of navNames) { await page.locator('.set-nav-item', { hasText: n }).first().click(); await wait(250); console.log(' ', n.padEnd(18), (await page.locator('.set-pane:not([hidden]) [data-q]').count()), 'fields;', 'advanced fold:', await page.locator('.set-pane:not([hidden]) .set-adv').count()); }
const all = await page.locator('[data-q]').evaluateAll((els) => els.map((e) => e.dataset.q)); console.log('any connection words left in Settings?', all.filter((q) => /gmail|canopy|ntfy|oauth|pubsub|drive folder|transcri|github/.test(q)));
await page.locator('.set-nav-item', { hasText: 'Brain' }).first().click(); await wait(300); await page.screenshot({ path: process.env.SHOTS + '/settings-brain.png' });
await page.goto(base + '/#/connectors'); await wait(2500);
console.log('connect rows:', await page.locator('[data-conn]').evaluateAll((els) => els.map((e) => e.dataset.conn + ':' + e.querySelector('.s').textContent)).then((a) => a.join(', ')));
await page.screenshot({ path: process.env.SHOTS + '/connect.png' });
await page.locator('[data-conn=canopy] md-outlined-button').click(); await wait(1200);
console.log('editor fields:', await page.locator('md-dialog[open] md-outlined-text-field').evaluateAll((els) => els.map((e) => e.label)));
await page.screenshot({ path: process.env.SHOTS + '/connect-edit.png' });
await browser.close(); srv.kill(); try { execFileSync('tmux', ['-L', 'shots' + port, 'kill-server'], { stdio: 'ignore' }); } catch { /* */ }
