// Code tab chat: sends a picture and a file, then screenshots the session (desktop + phone) into $SHOTS.
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
await fetch(`${base}/code/sessions/${s.id}/keys`, { method: 'POST', headers: { authorization: 'Bearer ' + TOK, 'content-type': 'application/json' }, body: JSON.stringify({ keys: ['1'] }) }); await wait(2000);
const up = async (name, buf) => (await (await fetch(`${base}/code/sessions/${s.id}/upload?name=${name}`, { method: 'POST', headers: { authorization: 'Bearer ' + TOK }, body: buf })).json()).path;
// a real PNG: a gradient drawn by the browser
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/snap/bin/chromium', args: ['--no-sandbox'] });
const pg0 = await (await browser.newContext()).newPage(); const png = Buffer.from((await pg0.evaluate(() => { const c = document.createElement('canvas'); c.width = 800; c.height = 500; const x = c.getContext('2d'); const g = x.createLinearGradient(0, 0, 800, 500); g.addColorStop(0, '#4f8cff'); g.addColorStop(1, '#ff7a59'); x.fillStyle = g; x.fillRect(0, 0, 800, 500); x.fillStyle = '#fff'; x.font = '48px sans-serif'; x.fillText('demo screenshot', 220, 260); return c.toDataURL('image/png').split(',')[1]; })), 'base64'); await pg0.close();
const img = await up('Screenshot 2026-11-27 at 4.23.13 PM.png', png); const pdf = await up('quarterly-report.pdf', Buffer.from('%PDF-1.4 demo'));
await api(`/code/sessions/${s.id}/send`, { text: `Here is the picture and the report, please look.\n@${img}\n@${pdf}` }); await wait(3000);
for (const [tag, w, h] of [['d', 1600, 900], ['m', 390, 844]]) {
  const page = await (await browser.newContext({ viewport: { width: w, height: h } })).newPage(); await page.goto(base + '/'); await page.locator('md-outlined-text-field[label="Password"]').first().evaluate((el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }, PW);
  await page.locator('md-filled-button', { hasText: 'Sign in' }).click(); await wait(1500);
  await page.goto(`${base}/#/code/s/${s.id}`); await wait(2500); await page.screenshot({ path: join(out, `${tag}-session.png`) });
  await page.locator('.code-att.pic').first().click(); await wait(800); await page.screenshot({ path: join(out, `${tag}-viewer.png`) }); await page.keyboard.press('Escape');
  await page.locator('input[aria-label="Choose files"]').setInputFiles({ name: 'notes.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 hi') }); await wait(1200); await page.screenshot({ path: join(out, `${tag}-attaching.png`) });
  await page.locator('.code-composer textarea').fill('SLOW please'); await page.keyboard.press('Enter'); await wait(2500); await page.screenshot({ path: join(out, `${tag}-working.png`) });
  await page.close();
}
await browser.close(); srv.kill(); try { execFileSync('tmux', ['-L', 'shots' + port, 'kill-server'], { stdio: 'ignore' }); } catch { /* */ }
console.log('done', out);
