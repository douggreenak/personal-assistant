import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { Ctx } from './ctx.ts';
import { decide, listApprovals } from './approvals.ts';
import { handleOwnerText } from './commands.ts';
import { ingestMacRows, type MacRow } from './mac.ts';
import { ack, parseSnooze, snooze } from './nag.ts';
import { storeMessage } from './pipeline.ts';
import { ask } from './qa.ts';
import { applyTicketingEvent, verifySignature } from './sync/ticketing.ts';
import { ingestVoice } from './voice.ts';
import { listConnectors } from './connectors.ts';

class HttpError extends Error { status: number; constructor(status: number, m: string) { super(m); this.status = status; } }
const JSON_LIMIT = 1024 * 1024, AUDIO_LIMIT = 60 * 1024 * 1024;

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const c of req) { size += (c as Buffer).length; if (size > limit) throw new HttpError(413, 'Body too large.'); chunks.push(c as Buffer); }
  return Buffer.concat(chunks);
}
async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const b = await readBody(req, JSON_LIMIT);
  if (!b.length) return {};
  try { const v = JSON.parse(b.toString('utf8')); if (v && typeof v === 'object' && !Array.isArray(v)) return v; } catch { /* below */ }
  throw new HttpError(400, 'Body must be a JSON object.');
}
const send = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};
const tokenOk = (h: string | undefined, token: string): boolean => {
  const m = /^Bearer (.+)$/.exec(h ?? ''); if (!m) return false;
  const a = Buffer.from(m[1]), b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
};

export interface HttpDeps { wake: () => void; ticketingSecret?: string; fetchImpl?: typeof fetch }

export function createHttp(ctx: Ctx, deps: HttpDeps): Server {
  if (ctx.cfg.token.length < 16) throw new Error('ASSISTANT_TOKEN must be at least 16 chars.');

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://x'); const path = url.pathname.replace(/\/+$/, '') || '/'; const method = req.method ?? 'GET';
    if (path === '/healthz') return send(res, 200, { ok: true });

    if (path === '/hooks/ticketing' && method === 'POST') {          // authenticated by HMAC, not the bearer token
      const raw = (await readBody(req, JSON_LIMIT)).toString('utf8');
      if (!verifySignature(deps.ticketingSecret ?? '', raw, req.headers['x-tickets-signature'] as string | undefined)) throw new HttpError(401, 'Bad signature.');
      return send(res, 200, { applied: applyTicketingEvent(ctx, JSON.parse(raw)) });
    }
    if (!tokenOk(req.headers.authorization, ctx.cfg.token)) throw new HttpError(401, 'Missing or invalid bearer token.');
    let m: RegExpExecArray | null;

    if (path === '/ingest/message' && method === 'POST') {
      const b = await readJson(req);
      const id = storeMessage(ctx, { source: String(b.source ?? 'api'), sourceId: String(b.sourceId ?? ''), sender: String(b.sender ?? ''), subject: String(b.subject ?? ''), body: String(b.body ?? ''), receivedAt: typeof b.receivedAt === 'string' ? b.receivedAt : undefined });
      if (!b.sourceId) throw new HttpError(400, 'sourceId is required.');
      deps.wake(); return send(res, 202, { queued: id !== null });
    }
    if (path === '/ingest/mac' && method === 'POST') {
      const b = await readJson(req); if (!Array.isArray(b.rows)) throw new HttpError(400, 'rows[] required.');
      const r = ingestMacRows(ctx, b.rows as MacRow[]); deps.wake(); return send(res, 200, r);
    }
    if (path === '/ingest/voice' && method === 'POST') {
      const captureId = String(req.headers['x-capture-id'] ?? ''); if (!/^[A-Za-z0-9-]{8,64}$/.test(captureId)) throw new HttpError(400, 'X-Capture-Id (8-64 chars) required.');
      const audio = await readBody(req, AUDIO_LIMIT); if (!audio.length) throw new HttpError(400, 'Empty body.');
      try {
        const r = await ingestVoice(ctx, { captureId, audio, filename: String(req.headers['x-filename'] ?? 'capture.m4a').replace(/[^\w.\-]/g, '_'), recordedAt: req.headers['x-recorded-at'] as string | undefined, fetchImpl: deps.fetchImpl });
        deps.wake(); return send(res, 200, { ok: true, duplicate: r.duplicate, text: r.text });
      } catch (e) { throw new HttpError(503, `Transcription unavailable, retry later: ${(e as Error).message}`); }   // phone keeps it queued
    }
    if (path === '/chat' && method === 'POST') { const b = await readJson(req); return send(res, 200, { reply: await handleOwnerText(ctx, String(b.text ?? '')) }); }
    if (path === '/ask' && method === 'POST') { const b = await readJson(req); return send(res, 200, { answer: await ask(ctx, String(b.question ?? '')) }); }

    if (path === '/items' && method === 'GET') return send(res, 200, { items: ctx.items.list({ state: url.searchParams.get('state') ?? 'open', kind: url.searchParams.get('kind') ?? undefined }) });
    if ((m = /^\/items\/([0-9a-f-]+)$/.exec(path)) && method === 'GET') {
      const it = ctx.items.find(m[1]); if (!it) throw new HttpError(404, 'Not found.');
      return send(res, 200, { item: it, events: ctx.items.events(it.id) });
    }
    if ((m = /^\/items\/([0-9a-f-]+)\/(ack|snooze)$/.exec(path)) && method === 'POST') {
      const it = ctx.items.find(m[1]); if (!it) throw new HttpError(404, 'Not found.');
      if (m[2] === 'ack') return send(res, 200, { item: ack(ctx, it) });
      const until = parseSnooze(String((await readJson(req)).for ?? ''), ctx.now(), ctx.cfg.tz, ctx.cfg.quietHours);
      if (!until) throw new HttpError(400, 'for must look like 30m, 2h, 1d or tomorrow.');
      return send(res, 200, { item: snooze(ctx, it, until) });
    }
    if (path === '/approvals' && method === 'GET') return send(res, 200, { approvals: listApprovals(ctx) });
    if ((m = /^\/approvals\/(\d+)\/(approve|reject)$/.exec(path)) && method === 'POST') return send(res, 200, { result: await decide(ctx, Number(m[1]), m[2] === 'approve', 'api') });
    if (path === '/connectors' && method === 'GET') return send(res, 200, { connectors: listConnectors(ctx).map((c) => ({ id: c.id, status: c.status, name: c.manifest.name, lastError: c.lastError })) });
    throw new HttpError(404, 'Not found.');
  }

  return createServer(async (req, res) => {
    try { await route(req, res); }
    catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message });
      console.error(e); send(res, 500, { error: 'Internal error.' });
    }
  });
}
