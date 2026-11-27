import { noEmojiDeep, NO_EMOJI_RULE } from './text.ts';
import { spawn } from 'node:child_process';

export interface LlmImage { mediaType: string; data: string /* base64 */ }
/** `purpose` names what the call is for ('extract', 'extract-bg', 'plan', 'answer', 'help', 'setup', 'triage'): it picks the model (small jobs use the fast one) and labels the usage log. */
export interface LlmRequest { system: string; prompt: string; schema: Record<string, unknown>; images?: LlmImage[]; purpose?: string }
export interface LlmUsage { purpose: string; model: string; input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; ms: number; chars: number; ok: boolean }
/** Small, well-bounded jobs that do not need the main model. */
export const FAST_PURPOSES = new Set(['plan', 'triage']);
export interface Llm { json(req: LlmRequest): Promise<unknown>; }

/**
 * Runs Claude Code headless: `claude -p` with every tool disabled, no session saved, no settings/hooks
 * loaded, and the reply constrained by a JSON schema. The model can therefore only *return data*;
 * it cannot read files, run commands, or call anything — that is what makes it safe to feed it
 * untrusted texts and emails.
 */
export class ClaudeCliLlm implements Llm {
  bin: string; model?: string; fastModel?: string; timeoutMs: number; onUsage?: (u: LlmUsage) => void;
  constructor(o: { bin?: string; model?: string; fastModel?: string; timeoutMs?: number; onUsage?: (u: LlmUsage) => void } = {}) {
    this.bin = o.bin ?? 'claude'; this.model = o.model; this.fastModel = o.fastModel; this.timeoutMs = o.timeoutMs ?? 180000; this.onUsage = o.onUsage;
  }
  async json(req: LlmRequest): Promise<unknown> { return noEmojiDeep(await this.run({ ...req, system: req.system + NO_EMOJI_RULE })); }
  private run(req: LlmRequest): Promise<unknown> {
    const withImages = !!req.images?.length;
    const common = ['--tools', '', '--no-session-persistence', '--setting-sources', '', '--system-prompt', req.system, '--json-schema', JSON.stringify(req.schema)];
    // Images travel as content blocks over stdin (stream-json); plain prompts keep the simple form.
    const args = withImages ? ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', ...common] : ['-p', req.prompt, '--output-format', 'json', ...common];
    const model = (FAST_PURPOSES.has(req.purpose ?? '') && this.fastModel) || this.model; if (model) args.push('--model', model);
    const t0 = Date.now(); const chars = req.system.length + req.prompt.length;
    const meter = (j: { usage?: Record<string, number>; total_cost_usd?: number } | null, ok: boolean) => { try { this.onUsage?.({ purpose: req.purpose ?? 'other', model: model ?? '', input: j?.usage?.input_tokens ?? 0, output: j?.usage?.output_tokens ?? 0, cacheRead: j?.usage?.cache_read_input_tokens ?? 0, cacheWrite: j?.usage?.cache_creation_input_tokens ?? 0, cost: j?.total_cost_usd ?? 0, ms: Date.now() - t0, chars, ok }); } catch { /* metering never breaks a call */ } };
    return new Promise((resolve, reject) => {
      const p = spawn(this.bin, args, { stdio: [withImages ? 'pipe' : 'ignore', 'pipe', 'pipe'], cwd: '/tmp' });
      if (withImages) {
        const content = [...req.images!.map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.mediaType, data: i.data } })), { type: 'text', text: req.prompt }];
        p.stdin!.on('error', () => { /* the process may exit first; the close handler reports it */ });
        p.stdin!.end(JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n');
      }
      let out = '', err = '';
      const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('claude timed out')); }, this.timeoutMs);
      p.stdout!.on('data', (d) => (out += d));
      p.stderr!.on('data', (d) => (err += d));
      p.on('error', (e) => { clearTimeout(timer); meter(null, false); reject(e); });
      p.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0 && !out) { meter(null, false); return reject(new Error(`claude exited ${code}: ${err.slice(0, 300)}`)); }
        try {
          let text = out;
          if (withImages) {   // one JSON object per line; the last "result" line carries the answer
            const lines = out.split('\n').filter((l) => l.startsWith('{')); text = '';
            for (const l of lines.reverse()) { try { if ((JSON.parse(l) as { type?: string }).type === 'result') { text = l; break; } } catch { /* skip */ } }
          }
          const j = JSON.parse(text) as { is_error?: boolean; result?: string; structured_output?: unknown; usage?: Record<string, number>; total_cost_usd?: number };
          meter(j as never, !j.is_error);
          if (j.is_error) return reject(new Error(`claude error: ${String(j.result).slice(0, 300)}`));
          if (j.structured_output !== undefined && j.structured_output !== null) return resolve(j.structured_output);
          resolve(parseLooseJson(j.result ?? ''));
        } catch (e) { reject(new Error(`unparseable claude output: ${(e as Error).message}`)); }
      });
    });
  }
}

/** Parses JSON from model text, tolerating code fences or leading/trailing prose. */
export function parseLooseJson(text: string): unknown {
  const t = text.trim();
  try { return JSON.parse(t); } catch { /* fall through */ }
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(t);
  if (fenced) return JSON.parse(fenced[1]);
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) return JSON.parse(t.slice(a, b + 1));
  throw new Error('no JSON found');
}

/** Test double: returns scripted responses in order (or via a function). */
export class FakeLlm implements Llm {
  calls: LlmRequest[] = [];
  responder: unknown[] | ((req: LlmRequest) => unknown);
  constructor(responder: unknown[] | ((req: LlmRequest) => unknown)) { this.responder = responder; }
  async json(req: LlmRequest): Promise<unknown> {
    this.calls.push(req);
    if (typeof this.responder === 'function') return this.responder(req);
    if (!this.responder.length) throw new Error('FakeLlm: no more scripted responses');
    return this.responder.shift();
  }
}
