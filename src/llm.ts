import { spawn } from 'node:child_process';

export interface LlmRequest { system: string; prompt: string; schema: Record<string, unknown> }
export interface Llm { json(req: LlmRequest): Promise<unknown>; }

/**
 * Runs Claude Code headless: `claude -p` with every tool disabled, no session saved, no settings/hooks
 * loaded, and the reply constrained by a JSON schema. The model can therefore only *return data*;
 * it cannot read files, run commands, or call anything — that is what makes it safe to feed it
 * untrusted texts and emails.
 */
export class ClaudeCliLlm implements Llm {
  bin: string; model?: string; timeoutMs: number;
  constructor(o: { bin?: string; model?: string; timeoutMs?: number } = {}) {
    this.bin = o.bin ?? 'claude'; this.model = o.model; this.timeoutMs = o.timeoutMs ?? 180000;
  }
  json(req: LlmRequest): Promise<unknown> {
    const args = ['-p', req.prompt, '--output-format', 'json', '--tools', '', '--no-session-persistence',
      '--setting-sources', '', '--system-prompt', req.system, '--json-schema', JSON.stringify(req.schema)];
    if (this.model) args.push('--model', this.model);
    return new Promise((resolve, reject) => {
      const p = spawn(this.bin, args, { stdio: ['ignore', 'pipe', 'pipe'], cwd: '/tmp' });
      let out = '', err = '';
      const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('claude timed out')); }, this.timeoutMs);
      p.stdout.on('data', (d) => (out += d));
      p.stderr.on('data', (d) => (err += d));
      p.on('error', (e) => { clearTimeout(timer); reject(e); });
      p.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0 && !out) return reject(new Error(`claude exited ${code}: ${err.slice(0, 300)}`));
        try {
          const j = JSON.parse(out) as { is_error?: boolean; result?: string; structured_output?: unknown };
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
