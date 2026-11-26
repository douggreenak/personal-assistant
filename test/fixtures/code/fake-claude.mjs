#!/usr/bin/env node
// A stand-in for the Claude Code TUI used by tests: same screens (copied from real captures), same transcript format, no model, no cost.
import { appendFileSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const args = process.argv.slice(2); const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const sid = flag('--session-id') ?? flag('--resume') ?? randomUUID(); const mode = flag('--permission-mode') ?? 'manual'; const model = flag('--model') ?? 'fake-sonnet';
const cwd = process.cwd(); const cfg = process.env.CLAUDE_CONFIG_DIR; const FX = new URL('.', import.meta.url).pathname;
const dir = join(cfg, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-')); const file = join(dir, sid + '.jsonl');
if (flag('--resume') && !existsSync(file)) { console.log('No conversation found with session ID: ' + sid); process.exit(1); }
const cfgJson = process.env.CLAUDE_CONFIG_DIR ? join(process.env.CLAUDE_CONFIG_DIR, '.claude.json') : null;
if (cfgJson && existsSync(cfgJson)) { const j = JSON.parse(readFileSync(cfgJson, 'utf8')); if (!j.projects?.[cwd]?.hasTrustDialogAccepted) { /* the real one would ask */ } }

let lines = [], input = '', state = 'idle', pending = null, timer = null, usageOpen = false, seq = 0;
const CYCLE = ['manual', 'acceptEdits', 'plan', 'auto']; let curMode = mode;
const MODES = { manual: '⏸ manual mode on · ? for shortcuts', auto: '⏵⏵ auto mode on (shift+tab to cycle)', plan: '⏸ plan mode on', acceptEdits: '⏵⏵ accept edits on', dontAsk: "⏵⏵ don't ask on", bypassPermissions: '⏵⏵ bypass permissions on' };
const modeText = () => MODES[curMode] ?? curMode;
const RULE = '─'.repeat(110);
const write = (e) => { mkdirSync(dir, { recursive: true }); appendFileSync(file, JSON.stringify({ sessionId: sid, cwd, timestamp: new Date().toISOString(), uuid: randomUUID(), ...e }) + '\n'); };
const render = () => {
  let out = '\x1b[2J\x1b[H';
  if (usageOpen) { out += readFileSync(FX + 'screen-usage.txt', 'utf8'); process.stdout.write(out); return; }
  out += ` ▐▛███▛█   Claude Code v0.0.0-fake\n▝▜██████▀  ${model}\n ▝▝   ▝▝   ${cwd}\n\n` + lines.join('\n') + '\n';
  if (state === 'permission') { out += RULE + '\n Create file\n ' + pending.file + '\n╌╌╌╌╌╌╌╌╌╌╌╌\n  1 ok\n╌╌╌╌╌╌╌╌╌╌╌╌\n Do you want to create ' + pending.file + '?\n ❯ 1. Yes\n   2. Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session (shift+tab)\n   3. No\n\n Esc to cancel · Tab to amend\n'; }
  else { if (state === 'working') out += '✶ Pondering… (' + (seq++ % 9 + 1) + 's · ↓ 5 tokens)\n'; out += RULE + '\n❯ ' + input + '\n' + RULE + '\n  ' + modeText() + (state === 'working' ? ' · esc to interrupt' : '') + '\n'; }
  process.stdout.write(out);
};
const usage = (i, o) => ({ input_tokens: i, output_tokens: o, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200 });
const reply = (text) => { const id = 'msg_' + randomUUID().slice(0, 8); write({ type: 'assistant', message: { id, model, role: 'assistant', content: [{ type: 'text', text }], usage: usage(10, 20) } }); lines.push('● ' + text); state = 'idle'; render(); };
const submit = (text) => {
  input = '';
  if (text === '/exit') process.exit(0);
  if (text === '/context') { lines.push('❯ /context', '  ⎿  Context window: 1k of 200k used', '     Messages: 10 tokens'); return render(); }
  if (text === '/usage') { usageOpen = true; return render(); }
  write({ type: 'user', message: { role: 'user', content: text } }); lines.push('❯ ' + text);
  if (text.includes('PERMISSION')) {
    const id = 'toolu_' + randomUUID().slice(0, 8); pending = { id, file: 'perm.txt' };
    write({ type: 'assistant', message: { id: 'msg_' + randomUUID().slice(0, 8), model, role: 'assistant', content: [{ type: 'text', text: 'I will create the file.' }, { type: 'tool_use', id, name: 'Write', input: { file_path: join(cwd, 'perm.txt'), content: 'ok' } }], usage: usage(12, 30) } });
    lines.push('● Write(perm.txt)'); state = 'permission'; return render();
  }
  state = 'working'; render(); const slow = text.includes('SLOW');
  timer = setInterval(render, 500); setTimeout(() => { if (state !== 'working') return; clearInterval(timer); reply('Echo: ' + text.split('\n')[0]); }, slow ? 8000 : 1200);
};
const decide = (yes) => {
  const { id, file: f } = pending; pending = null;
  if (yes) { writeFileSync(join(cwd, f), 'ok'); write({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'File created successfully at: ' + join(cwd, f) }] } }); lines.push('  ⎿  Wrote 1 line to ' + f); reply('Created ' + f + '.'); }
  else { write({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content: "The user doesn't want to proceed with this tool use. The tool use was rejected." }] } }); lines.push('  ⎿  Rejected write to ' + f); state = 'idle'; render(); }
};
process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.setEncoding('utf8');
let paste = false;
process.stdin.on('data', (d) => {
  for (let i = 0; i < d.length; i++) {
    if (d.startsWith('\x1b[Z', i)) { curMode = CYCLE[(CYCLE.indexOf(curMode) + 1) % CYCLE.length]; i += 2; render(); continue; }
    if (d.startsWith('\x1b[200~', i)) { paste = true; i += 5; continue; } if (d.startsWith('\x1b[201~', i)) { paste = false; i += 5; continue; }
    const c = d[i];
    if (state === 'permission') { if (c === '1') decide(true); else if (c === '3' || c === '\x1b') decide(false); continue; }
    if (usageOpen) { if (c === '\x1b') { usageOpen = false; render(); } continue; }
    if (c === '\x1b') { if (state === 'working') { clearInterval(timer); state = 'idle'; lines.push('  ⎿  Interrupted'); render(); } continue; }
    if (c === '\r' && !paste) { if (input.trim()) submit(input); continue; }
    if (c === '\x03') { input = ''; render(); continue; } if (c === '\x7f') { input = input.slice(0, -1); render(); continue; }
    input += c === '\r' ? '\n' : c;
  }
  if (state !== 'working') render();
});
process.stdout.write('\x1b[?2004h'); process.on('SIGHUP', () => process.exit(0)); render();
