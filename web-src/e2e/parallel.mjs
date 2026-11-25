// Runs the three parts of the browser test at the same time, each against its own throwaway server.
//   usage: CHROMIUM=/usr/bin/chromium node web-src/e2e/parallel.mjs
import { spawn } from 'node:child_process';
const run = (g) => new Promise((res) => {
  const p = spawn('node', [new URL('./run.mjs', import.meta.url).pathname], { env: { ...process.env, E2E_GROUP: g }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d));
  p.on('close', (code) => res({ g, code, out }));
});
const t0 = Date.now();
const rs = await Promise.all(['a', 'b', 'c'].map(run));
let passed = 0, total = 0;
for (const r of rs) {
  console.log(r.out.split('\n').filter((l) => /^  [✔✖]|^ {5,}\S|screenshots in/.test(l)).join('\n'));
  const m = /(\d+)\/(\d+) passed/.exec(r.out); if (m) { passed += +m[1]; total += +m[2]; }
}
console.log(`\n${passed}/${total} passed in ${((Date.now() - t0) / 1000).toFixed(0)}s (3 workers)`);
process.exit(rs.every((r) => r.code === 0) ? 0 : 1);
