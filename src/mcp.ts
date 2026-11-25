import { isIP } from 'node:net';
import type { ConnAction, Manifest } from './connectors.ts';

/**
 * Minimal MCP client (Streamable HTTP, JSON-RPC 2.0): initialize → notifications/initialized → tools/list | tools/call.
 * Remote servers only (https, public addresses — the caller checks that). A server that wants OAuth sign-in is reported
 * as such; a plain key (bearer or a named header) works. Servers that need a local process (npx/stdio) cannot be used here.
 */
export interface McpTool { name: string; description?: string; inputSchema?: { properties?: Record<string, { type?: string | string[]; description?: string }>; required?: string[] }; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } }
export class McpError extends Error { auth = false; notMcp = false; }
const fail = (msg: string, o: { auth?: boolean; notMcp?: boolean } = {}): McpError => Object.assign(new McpError(msg), o);

const PROTOCOL = '2025-03-26';

/** Streamable HTTP answers either with plain JSON or an SSE stream carrying the JSON-RPC response. */
function readRpc(text: string, contentType: string, id: number): { result?: unknown; error?: { message?: string } } {
  const pick = (v: unknown): { result?: unknown; error?: { message?: string } } | undefined => {
    const list = Array.isArray(v) ? v : [v];
    return list.find((x) => x && typeof x === 'object' && (x as { id?: unknown }).id === id) as never;
  };
  if (contentType.includes('text/event-stream')) {
    for (const block of text.split(/\r?\n\r?\n/)) {
      const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
      if (!data) continue;
      try { const hit = pick(JSON.parse(data)); if (hit) return hit; } catch { /* keep looking */ }
    }
    throw fail('the server stream had no answer', { notMcp: true });
  }
  let body: unknown; try { body = JSON.parse(text); } catch { throw fail('the server did not answer with JSON-RPC', { notMcp: true }); }
  const hit = pick(body); if (!hit) throw fail('the server did not answer with JSON-RPC', { notMcp: true });
  return hit;
}

export interface McpSession { serverName: string; call(method: string, params?: Record<string, unknown>): Promise<unknown> }

/** Opens a session. `url` already carries any query-string key; `headers` carry any header key. */
export async function mcpOpen(url: URL, headers: Record<string, string>, fetchImpl: typeof fetch = fetch): Promise<McpSession> {
  let nextId = 1; let session = '';
  const post = async (payload: Record<string, unknown>, expectAnswer: boolean): Promise<unknown> => {
    const id = expectAnswer ? nextId++ : 0;
    const h: Record<string, string> = { ...headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': PROTOCOL };
    if (session) h['mcp-session-id'] = session;
    const res = await fetchImpl(url, { method: 'POST', headers: h, body: JSON.stringify({ jsonrpc: '2.0', ...(expectAnswer && { id }), ...payload }), redirect: 'manual', signal: AbortSignal.timeout(25000) });
    if (res.status === 401 || res.status === 403) throw fail(`the server wants credentials (HTTP ${res.status}). ${res.headers.get('www-authenticate')?.includes('resource_metadata') ? 'It uses OAuth sign-in, which a headless assistant cannot do — use a server that accepts an API key or token.' : 'Check the key.'}`, { auth: true });
    if (res.status >= 300 && res.status < 400) throw fail('the server redirected (not followed for safety)', { notMcp: true });
    if (!res.ok) throw fail(`HTTP ${res.status}`, { notMcp: res.status === 404 || res.status === 405 || res.status === 415 });
    const sid = res.headers.get('mcp-session-id'); if (sid) session = sid;
    const text = await res.text(); if (text.length > 4_000_000) throw fail('response too large');
    if (!expectAnswer) return undefined;
    const r = readRpc(text, res.headers.get('content-type') ?? '', id);
    if (r.error) throw fail(String(r.error.message ?? 'the server returned an error'));
    return r.result;
  };
  const init = await post({ method: 'initialize', params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'personal-assistant', version: '1' } } }, true) as { serverInfo?: { name?: string } } | undefined;
  await post({ method: 'notifications/initialized' }, false).catch(() => { /* some servers answer oddly to notifications; the session is still usable */ });
  return { serverName: String(init?.serverInfo?.name ?? '').slice(0, 80), call: (method, params = {}) => post({ method, params }, true) };
}

export async function mcpTools(s: McpSession): Promise<McpTool[]> {
  const tools: McpTool[] = []; let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const r = await s.call('tools/list', cursor ? { cursor } : {}) as { tools?: McpTool[]; nextCursor?: string };
    for (const t of r?.tools ?? []) if (t && typeof t.name === 'string') tools.push(t);
    if (!r?.nextCursor) break; cursor = r.nextCursor;
  }
  return tools;
}

const PARAM_NAME = /^[A-Za-z0-9_.-]{1,60}$/;
const kindOf = (t: string | string[] | undefined): 'string' | 'number' | 'integer' | 'boolean' | 'json' => {
  const x = Array.isArray(t) ? t.find((y) => y !== 'null') : t;
  return x === 'number' || x === 'integer' || x === 'boolean' ? x : x === 'object' || x === 'array' ? 'json' : 'string';
};
export const MAX_MCP_TOOLS = 40;

/** MCP tools → connector actions. Tools that are not marked read-only and not explicitly non-destructive count as destructive (the spec's default) and so always ask. */
export function toolsToActions(tools: McpTool[]): ConnAction[] {
  const out: ConnAction[] = []; const used = new Set<string>();
  const ordered = [...tools].sort((a, b) => Number(!!b.annotations?.readOnlyHint) - Number(!!a.annotations?.readOnlyHint));   // read-only tools first when truncating
  for (const t of ordered) {
    if (out.length >= MAX_MCP_TOOLS) break;
    let id = t.name.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^[^a-z]+/, '').slice(0, 38); if (id.length < 2) id = `tool_${out.length + 1}`;
    for (let n = 2; used.has(id); n++) id = `${id.slice(0, 36)}_${n}`;
    const props = t.inputSchema?.properties ?? {}; const req = new Set(t.inputSchema?.required ?? []);
    const params = Object.entries(props).filter(([n]) => PARAM_NAME.test(n)).slice(0, 20).map(([n, p]) => ({ name: n, description: String(p?.description ?? '').slice(0, 200), in: 'body' as const, required: req.has(n), type: kindOf(p?.type) }));
    if ([...req].some((n) => !params.some((p) => p.name === n))) continue;   // cannot be called without a parameter we cannot express
    used.add(id);
    const ro = t.annotations?.readOnlyHint === true; const destructive = !ro && t.annotations?.destructiveHint !== false;
    out.push({ id, name: t.name.slice(0, 80), description: `${ro ? '(read-only) ' : ''}${String(t.description ?? '').replace(/\s+/g, ' ').slice(0, 280)}`, method: destructive ? 'DELETE' : 'POST', path: '/', params, tool: t.name, readOnly: ro });
  }
  return out;
}

export function coerceArgs(a: ConnAction, args: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of a.params) {
    const v = args[p.name]; if (v === undefined || v === '') continue;
    if (p.type === 'number' || p.type === 'integer') { const n = Number(v); if (!Number.isFinite(n)) throw new Error(`"${p.name}" must be a number`); out[p.name] = p.type === 'integer' ? Math.trunc(n) : n; }
    else if (p.type === 'boolean') out[p.name] = /^(true|yes|1|on)$/i.test(v);
    else if (p.type === 'json') { try { out[p.name] = JSON.parse(v); } catch { throw new Error(`"${p.name}" must be JSON`); } }
    else out[p.name] = v;
  }
  return out;
}

export async function mcpCallTool(s: McpSession, tool: string, args: Record<string, unknown>): Promise<string> {
  const r = await s.call('tools/call', { name: tool, arguments: args }) as { content?: { type?: string; text?: string }[]; isError?: boolean; structuredContent?: unknown };
  const text = (r?.content ?? []).map((c) => (c.type === 'text' ? c.text ?? '' : `[${c.type ?? 'content'}]`)).join(' ').replace(/\s+/g, ' ').trim() || (r?.structuredContent ? JSON.stringify(r.structuredContent) : '');
  if (r?.isError) throw new Error(`the tool reported an error${text ? `: ${text.slice(0, 300)}` : ''}`);
  return text.slice(0, 600);
}

// ---- recognizing what the owner pasted ----
export interface McpCandidate { url: string; authHeader?: string; queryParam?: string; hasKey: boolean; explicit: boolean }
const KEYREF = /<API_KEY_\d+>/;

/**
 * Looks for an MCP server in pasted text (already scrubbed of keys: they appear as <API_KEY_n>). Recognizes a bare URL, a
 * `mcpServers` JSON snippet ({"url": …, "headers": {…}}), and `claude mcp add --transport http name URL --header "X: …"`.
 * `explicit` = the paste itself says MCP (so failing to talk MCP is an error, not a cue to treat it as REST docs).
 */
export function parseMcpInput(clean: string): McpCandidate | null {
  const text = clean.trim();
  const urls = [...text.matchAll(/https:\/\/[^\s"'`<>)\]},]+(?:<API_KEY_\d+>)?[^\s"'`)\]},]*/g)].map((m) => m[0]);
  if (!urls.length) return null;
  // Only a clear signal makes this MCP: an MCP config snippet / `claude mcp add`, or a SHORT paste (a URL and a few words).
  // Long pasted API docs that merely mention "MCP" or contain a /sse URL stay API docs.
  const structured = /mcpServers|claude\s+mcp\s+add|--transport\s+(?:http|sse|streamable)|"type"\s*:\s*"(?:http|sse|streamable)/i.test(text);
  const short = text.length < 400 && new Set(urls).size === 1;
  const bare = /^https:\/\/\S+$/.test(text);
  const pathy = urls.find((u) => /\/mcp(\/|\?|$)/i.test(u));
  const wordMcp = /\bmcp\b/i.test(text);
  const url = structured ? (pathy ?? urls[0]) : short && (bare || wordMcp || /\/sse(\/|\?|$)/i.test(urls[0])) ? urls[0] : undefined;
  if (!url) return null;
  const explicit = structured || (short && (wordMcp || !!pathy));
  let authHeader: string | undefined; let hasKey = KEYREF.test(text);
  const hdr = /["']?([A-Za-z][A-Za-z0-9-]{1,40})["']?\s*[:=]\s*["']?(?:Bearer\s+|Token\s+)?<API_KEY_\d+>/.exec(text);
  if (hdr && !/^(key|token|api_?key|secret)$/i.test(hdr[1])) authHeader = hdr[1];
  let queryParam: string | undefined;
  try { const u = new URL(url); for (const [k, v] of u.searchParams) if (KEYREF.test(decodeURIComponent(v))) { queryParam = k; hasKey = true; } } catch { return null; }
  return { url, authHeader, queryParam, hasKey, explicit };
}

export const mcpIdFor = (url: string): string => {
  const h = new URL(url).hostname; const parts = isIP(h) ? [h.replace(/\./g, '-')] : h.split('.').filter((p) => !['www', 'mcp', 'api', 'com', 'net', 'org', 'io', 'ai', 'app', 'dev'].includes(p));
  const base = (parts[0] ?? h).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'server';
  return `mcp-${base}`;
};

export const buildManifest = (id: string, name: string, url: URL, auth: Manifest['auth'], actions: ConnAction[]): Manifest => ({
  id, name, description: `MCP server ${url.hostname}`, baseUrl: url.origin, auth, mcp: { url: url.origin + url.pathname },
  actions,
});
