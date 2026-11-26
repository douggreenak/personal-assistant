// Renders icon.svg into the PNG icons a phone needs (run by hand when the icon changes; the PNGs are committed).
import { chromium } from 'playwright-core';
import { readFileSync, writeFileSync } from 'node:fs';
const svg = readFileSync('icon.svg', 'utf8');
const bolt = /<path d="([^"]+)" fill="#fff"\/>/.exec(svg)[1]; const colour = /fill="(#[0-9A-Fa-f]{6})"/.exec(svg)[1];
// full-bleed square (iOS rounds the corners itself; Android "maskable" keeps the bolt in the safe zone)
const page = (size, scale) => `<html><body style="margin:0"><svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 64 64"><rect width="64" height="64" fill="${colour}"/><g transform="translate(32 32) scale(${scale}) translate(-32 -32)"><path d="${bolt}" fill="#fff"/></g></svg></body></html>`;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/usr/bin/chromium', args: ['--no-sandbox'] });
for (const [file, size, scale] of [['apple-touch-icon.png', 180, 1], ['icon-192.png', 192, 1], ['icon-512.png', 512, 1], ['icon-maskable-512.png', 512, 0.72]]) {
  const p = await browser.newPage({ viewport: { width: size, height: size } }); await p.setContent(page(size, scale));
  writeFileSync('public/' + file, await p.screenshot({ type: 'png' })); await p.close();
}
await browser.close(); console.log('icons written');
