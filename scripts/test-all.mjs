// Everything, as fast as the machine allows: unit-test files run in parallel (one process each) while the browser
// test runs in two parallel halves at the same time.
import { spawn } from 'node:child_process';
import { availableParallelism } from 'node:os';
const run = (name, cmd, args) => new Promise((res) => {
  const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] }); let out = '';
  p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d));
  p.on('close', (code) => res({ name, code, out }));
});
const t0 = Date.now();
const jobs = [run('unit', 'node', ['--test', `--test-concurrency=${availableParallelism()}`, 'test/*.test.ts'])];
if (!process.argv.includes('--no-browser') && (process.env.CHROMIUM || process.platform === 'linux')) jobs.push(run('browser', 'node', ['web-src/e2e/parallel.mjs']));
const rs = await Promise.all(jobs);
for (const r of rs) {
  const tail = r.name === 'unit' ? r.out.split('\n').filter((l) => /^(✖|ℹ (tests|pass|fail))|not ok/.test(l)).join('\n') : r.out.trim();
  console.log(`\n== ${r.name}: ${r.code === 0 ? 'PASS' : 'FAIL'} ==\n${tail}`);
}
console.log(`\nTotal ${((Date.now() - t0) / 1000).toFixed(0)}s`);
process.exit(rs.every((r) => r.code === 0) ? 0 : 1);
