import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Claude Code writes every conversation to <config>/projects/<cwd with / and . → ->/<session-id>.jsonl. We read that file
 * (never the screen) for the chat view and for token usage. Lines are verbose; only a few types matter.
 */
export type Block = { type: 'text'; text: string } | { type: 'thinking'; text: string } | { type: 'tool'; id: string; name: string; input: Record<string, unknown> };
export interface Usage { input: number; output: number; cacheRead: number; cacheWrite: number }
export type Msg =
  | { t: 'user'; id: string; ts: string; text: string; command?: string }
  | { t: 'assistant'; id: string; msgId: string; ts: string; model: string; blocks: Block[]; usage?: Usage }
  | { t: 'result'; id: string; toolUseId: string; ts: string; text: string; isError: boolean }
  | { t: 'note'; id: string; ts: string; text: string }
  | { t: 'title'; id: string; title: string }
  | { t: 'mode'; id: string; mode: string };

export const encodeCwd = (cwd: string): string => cwd.replace(/[^a-zA-Z0-9]/g, '-');

export function transcriptPath(configDir: string, cwd: string, sessionId: string): string | null {
  const direct = join(configDir, 'projects', encodeCwd(cwd), `${sessionId}.jsonl`); if (existsSync(direct)) return direct;
  const root = join(configDir, 'projects');
  try { for (const d of readdirSync(root)) { const p = join(root, d, `${sessionId}.jsonl`); if (existsSync(p)) return p; } } catch { /* no projects yet */ }
  return null;
}

const toText = (c: unknown): string => typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => (x && typeof x === 'object' && (x as { type?: string }).type === 'text' ? String((x as { text?: unknown }).text ?? '') : x && typeof x === 'object' && (x as { type?: string }).type === 'image' ? '[image]' : '')).filter(Boolean).join('\n') : '';
const usageOf = (u: Record<string, unknown> | undefined): Usage | undefined => u ? { input: Number(u.input_tokens ?? 0), output: Number(u.output_tokens ?? 0), cacheRead: Number(u.cache_read_input_tokens ?? 0), cacheWrite: Number(u.cache_creation_input_tokens ?? 0) } : undefined;
const MAX_RESULT = 6000;

/** One transcript line → zero or more display messages. */
export function normalize(e: Record<string, any>): Msg[] {   // eslint-disable-line @typescript-eslint/no-explicit-any
  const id = String(e.uuid ?? ''); const ts = String(e.timestamp ?? '');
  if (e.type === 'ai-title' && e.aiTitle) return [{ t: 'title', id: 'title', title: String(e.aiTitle) }];
  if (e.type === 'permission-mode' && e.permissionMode) return [{ t: 'mode', id: 'mode', mode: String(e.permissionMode) }];
  if (e.isSidechain || e.isMeta) return [];
  if (e.type === 'system') return e.subtype === 'turn_duration' && Number(e.durationMs) >= 1000 ? [{ t: 'note', id, ts, text: `Worked for ${Math.round(Number(e.durationMs) / 1000)}s` }] : e.subtype === 'compact_boundary' ? [{ t: 'note', id, ts, text: 'Conversation compacted' }] : [];
  const c = e.message?.content;
  if (e.type === 'user') {
    if (typeof c === 'string') return userText(id, ts, c);
    const out: Msg[] = [];
    for (const b of Array.isArray(c) ? c : []) {
      if (b?.type === 'tool_result') out.push({ t: 'result', id: id + ':' + b.tool_use_id, toolUseId: String(b.tool_use_id), ts, text: toText(b.content).slice(0, MAX_RESULT), isError: !!b.is_error });
      else if (b?.type === 'text') out.push(...userText(id, ts, String(b.text ?? '')));
      else if (b?.type === 'image') out.push({ t: 'user', id: id + ':img', ts, text: '[image]' });
    }
    return out;
  }
  if (e.type === 'assistant' && Array.isArray(c)) {
    const blocks: Block[] = [];
    for (const b of c) {
      if (b?.type === 'text' && String(b.text ?? '').trim()) blocks.push({ type: 'text', text: String(b.text) });
      else if (b?.type === 'thinking' && String(b.thinking ?? '').trim()) blocks.push({ type: 'thinking', text: String(b.thinking) });
      else if (b?.type === 'tool_use') blocks.push({ type: 'tool', id: String(b.id), name: String(b.name), input: (b.input && typeof b.input === 'object' ? b.input : {}) as Record<string, unknown> });
    }
    if (!blocks.length) return [];
    return [{ t: 'assistant', id, msgId: String(e.message?.id ?? id), ts, model: String(e.message?.model ?? ''), blocks, usage: usageOf(e.message?.usage) }];
  }
  return [];
}
function userText(id: string, ts: string, text: string): Msg[] {
  const t = text.trim(); if (!t) return [];
  const cmd = /<command-name>\s*([^<]+?)\s*<\/command-name>/.exec(t);
  if (cmd) { const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(t)?.[1]?.trim(); return [{ t: 'user', id, ts, text: args ? `${cmd[1]} ${args}` : cmd[1], command: cmd[1] }]; }
  const out = /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/.exec(t); if (out) return out[1].trim() ? [{ t: 'note', id, ts, text: out[1].trim().slice(0, 1500) }] : [];
  if (/^<(system-reminder|local-command-caveat|task-notification)/.test(t)) return [];
  return [{ t: 'user', id, ts, text: t }];
}

/** Reads complete lines from byte `offset`; returns the messages and the offset to continue from. */
export function readDelta(file: string, offset: number, maxBytes = 4_000_000): { msgs: Msg[]; next: number; size: number } {
  const size = statSync(file).size; if (offset > size) offset = 0;   // file was replaced
  if (offset >= size) return { msgs: [], next: offset, size };
  const len = Math.min(size - offset, maxBytes); const buf = Buffer.alloc(len); const fd = openSync(file, 'r');
  try { readSync(fd, buf, 0, len, offset); } finally { closeSync(fd); }
  const lastNl = buf.lastIndexOf(0x0a); if (lastNl < 0) return { msgs: [], next: offset, size };
  const msgs: Msg[] = [];
  for (const line of buf.subarray(0, lastNl).toString('utf8').split('\n')) { if (!line.trim()) continue; try { msgs.push(...normalize(JSON.parse(line))); } catch { /* skip a damaged line */ } }
  return { msgs, next: offset + lastNl + 1, size };
}

/** The newest `limit` conversation lines that end at byte `before` (default: the end of the file), read from the back with a growing window,
 *  so a long chat costs about the same as a short one. `start` is where the first returned line begins (0 = the beginning of the file);
 *  `next` is where the data ended (continue with readDelta from there). */
export function readBack(file: string, limit: number, before?: number): { msgs: Msg[]; start: number; next: number } {
  const size = statSync(file).size; const fd = openSync(file, 'r');
  try {
    let end = before === undefined ? size : Math.min(before, size);
    if (before === undefined && end > 0) {   // ignore a half-written last line
      let p = end; end = 0;
      while (p > 0) { const len = Math.min(65536, p); const buf = Buffer.alloc(len); readSync(fd, buf, 0, len, p - len); const i = buf.lastIndexOf(0x0a); if (i >= 0) { end = p - len + i + 1; break; } p -= len; }
    }
    for (let win = 128 * 1024; ; win *= 4) {
      const from = Math.max(0, end - win); const len = end - from; const buf = Buffer.alloc(len); if (len) readSync(fd, buf, 0, len, from);
      let first = 0; if (from > 0) { const nl = buf.indexOf(0x0a); if (nl < 0) { if (from === 0) break; continue; } first = nl + 1; }   // drop the partial first line
      const lines: { off: number; text: string }[] = []; let o = first;
      while (o < len) { let e = buf.indexOf(0x0a, o); if (e < 0) e = len; lines.push({ off: from + o, text: buf.subarray(o, e).toString('utf8') }); o = e + 1; }
      const groups: { off: number; ms: Msg[] }[] = []; let count = 0, start = from + first;
      for (let i = lines.length - 1; i >= 0 && count < limit; i--) {
        start = lines[i].off; if (!lines[i].text.trim()) continue;
        try { const ms = normalize(JSON.parse(lines[i].text)); if (ms.length) { groups.unshift({ off: start, ms }); if (ms.some((m) => m.t === 'user' || m.t === 'assistant')) count++; } } catch { /* skip a damaged line */ }
      }
      if (count >= limit || from === 0) return { msgs: groups.flatMap((g) => g.ms), start: from === 0 && count < limit ? 0 : start, next: end };
    }
    return { msgs: [], start: 0, next: end };
  } finally { closeSync(fd); }
}

export interface UsageRow { day: string; model: string; input: number; output: number; cacheRead: number; cacheWrite: number; messages: number }
/** Token usage per day and model. A message is written once per content block with the same usage: count each API message once (the last record wins). */
export function scanUsage(file: string): { rows: UsageRow[]; lastContext: number; lastModel: string } {
  const byMsg = new Map<string, { day: string; model: string; u: Usage }>(); let lastContext = 0, lastModel = '';
  let text = ''; try { text = readFileUtf8(file); } catch { return { rows: [], lastContext: 0, lastModel: '' }; }
  for (const line of text.split('\n')) {
    if (!line.includes('"usage"')) continue;
    try { const e = JSON.parse(line); if (e.type !== 'assistant' || e.isSidechain) continue; const u = usageOf(e.message?.usage); if (!u) continue;
      const key = String(e.message?.id ?? e.uuid); const model = String(e.message?.model ?? '');
      if (model.startsWith('<')) continue;   // synthetic messages
      byMsg.set(key, { day: String(e.timestamp ?? '').slice(0, 10), model, u }); lastContext = u.input + u.cacheRead + u.cacheWrite; lastModel = model; } catch { /* skip */ }
  }
  const agg = new Map<string, UsageRow>();
  for (const { day, model, u } of byMsg.values()) {
    const k = `${day}|${model}`; const r = agg.get(k) ?? { day, model, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: 0 };
    r.input += u.input; r.output += u.output; r.cacheRead += u.cacheRead; r.cacheWrite += u.cacheWrite; r.messages++; agg.set(k, r);
  }
  return { rows: [...agg.values()], lastContext, lastModel };
}
import { readFileSync } from 'node:fs';
const readFileUtf8 = (f: string) => readFileSync(f, 'utf8');

/** Approximate list prices in USD per million tokens — an ESTIMATE shown as such (a subscription is not billed per token). */
const PRICES: [RegExp, { in: number; out: number; read: number; write: number }][] = [
  [/opus/i, { in: 15, out: 75, read: 1.5, write: 18.75 }],
  [/haiku/i, { in: 1, out: 5, read: 0.1, write: 1.25 }],
  [/sonnet|fable/i, { in: 3, out: 15, read: 0.3, write: 3.75 }],
];
export const estimateCost = (r: { model: string; input: number; output: number; cacheRead: number; cacheWrite: number }): number => {
  const p = PRICES.find(([re]) => re.test(r.model))?.[1] ?? PRICES[2][1];
  return (r.input * p.in + r.output * p.out + r.cacheRead * p.read + r.cacheWrite * p.write) / 1e6;
};
