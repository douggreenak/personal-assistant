import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Ctx } from './ctx.ts';
import { decide, listApprovals } from './approvals.ts';
import { handleOwnerText } from './commands.ts';
import { parseUploads, toLlmImages } from './images.ts';
import { codeRoutes } from './code/routes.ts';
import { createBackup, restoreBackup, listBackups, backupPath, saveBackupFile, lastBackup } from './backup.ts';
import { ingestMacRows, type MacRow } from './mac.ts';
import { ack, parseSnooze, snooze } from './nag.ts';
import { storeMessage } from './pipeline.ts';
import { ask } from './qa.ts';
import { applyTicketingEvent, verifySignature } from './sync/ticketing.ts';
import { ingestVoice } from './voice.ts';
import { listConnectors, proposeConnector, testConnector, enableConnector, setAutoAllowed, setConnectorInstructions } from './connectors.ts';
import { startAutoConnect, continueWithKey, getJob, type AutoJob } from './autoconnect.ts';
import { applyAction, type Action } from './actions.ts';
import { search } from './qa.ts';
import { indexPaths } from './index/indexer.ts';
import { activity, connectorsFull, deleteConnector, integrations, listMessages, retryMessage, saveServiceAccount, setConnectorStatus, setSecret, skipMessage, status } from './admin.ts';
import { saveSettings, viewSettings } from './settings.ts';
import { GUIDES, applySetup } from './setup.ts';
import { getLogs } from './logs.ts';
import { latestMacRelease, openMacDownload, publicRelease, macHeartbeat, listMacClients, requestMacUpdate, forgetMacClient } from './macapp.ts';

class HttpError extends Error { status: number; constructor(status: number, m: string) { super(m); this.status = status; } }
const BACKUP_LIMIT = 400 * 1024 * 1024, IMAGE_BODY_LIMIT = 30 * 1024 * 1024, JSON_LIMIT = 1024 * 1024, AUDIO_LIMIT = 60 * 1024 * 1024;

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const c of req) { size += (c as Buffer).length; if (size > limit) throw new HttpError(413, 'Body too large.'); chunks.push(c as Buffer); }
  return Buffer.concat(chunks);
}
async function readJson(req: IncomingMessage, limit = JSON_LIMIT): Promise<Record<string, unknown>> {
  const b = await readBody(req, limit);
  if (!b.length) return {};
  try { const v = JSON.parse(b.toString('utf8')); if (v && typeof v === 'object' && !Array.isArray(v)) return v; } catch { /* below */ }
  throw new HttpError(400, 'Body must be a JSON object.');
}
const pub = (j: AutoJob) => ({ id: j.id, state: j.state, steps: j.steps, connectorId: j.connectorId, secret: j.secret, result: j.result });
const send = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};
const tokenOk = (h: string | undefined, token: string): boolean => {
  const m = /^Bearer (.+)$/.exec(h ?? ''); if (!m) return false;
  const a = Buffer.from(m[1]), b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
};

// The web UI is static files (built from web-src/); they hold no data and every API call needs the bearer token.
const WEB_DIR = new URL('./web/', import.meta.url).pathname;
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.json': 'application/json' };
const CSP = "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'";
const assetCache = new Map<string, Buffer>();
function webFile(rel: string): { body: Buffer; type: string } | null {
  if (!/^[\w./-]+$/.test(rel) || rel.includes('..')) return null;
  const file = join(WEB_DIR, rel); if (!file.startsWith(WEB_DIR) || !existsSync(file)) return null;
  let body = assetCache.get(file); if (!body) { body = readFileSync(file); assetCache.set(file, body); }
  return { body, type: MIME[extname(file)] ?? 'application/octet-stream' };
}

// Web-UI password: a changed password is stored as a scrypt hash in the data dir and overrides WEB_PASSWORD from .env.
const pwFile = (ctx: Ctx) => join(ctx.cfg.dataDir, 'web-password.json');
function passwordMatches(ctx: Ctx, given: string): boolean | null {   // null = password login not set up
  let salt: Buffer, hash: Buffer;
  if (existsSync(pwFile(ctx))) { const j = JSON.parse(readFileSync(pwFile(ctx), 'utf8')); salt = Buffer.from(j.salt, 'hex'); hash = Buffer.from(j.hash, 'hex'); }
  else if (ctx.cfg.webPassword.length >= 8) { salt = Buffer.alloc(16); hash = scryptSync(ctx.cfg.webPassword, salt, 32); }
  else return null;
  const g = scryptSync(given, salt, 32);
  return timingSafeEqual(g, hash);
}
function setPassword(ctx: Ctx, pw: string): void {
  const salt = randomBytes(16);
  writeFileSync(pwFile(ctx), JSON.stringify({ salt: salt.toString('hex'), hash: scryptSync(pw, salt, 32).toString('hex') }), { mode: 0o600 });
}

export interface HttpDeps { wake: () => void; restart?: () => void; ticketingSecret?: string; fetchImpl?: typeof fetch }

export function createHttp(ctx: Ctx, deps: HttpDeps): Server {
  if (ctx.cfg.token.length < 16) throw new Error('ASSISTANT_TOKEN must be at least 16 chars.');

  let failures = 0, lockedUntil = 0;

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://x'); const path = url.pathname.replace(/\/+$/, '') || '/'; const method = req.method ?? 'GET';
    if (path === '/healthz') return send(res, 200, { ok: true });
    if (method === 'GET' && (path === '/' || path.startsWith('/assets/'))) {
      const f = webFile(path === '/' ? 'index.html' : path.slice(1));
      if (!f) throw new HttpError(404, 'Not found.');
      res.writeHead(200, { 'content-type': f.type, 'cache-control': 'no-cache', 'content-security-policy': CSP, 'x-content-type-options': 'nosniff' });
      return void res.end(f.body);
    }
    if (path === '/auth/login' && method === 'POST') {                // web UI password -> the API token (password is optional; unset = disabled)
      if (Date.now() < lockedUntil) throw new HttpError(429, 'Too many attempts. Try again in a minute.');
      const ok = passwordMatches(ctx, String((await readJson(req)).password ?? ''));
      if (ok === null) throw new HttpError(404, 'Password login is not enabled (set WEB_PASSWORD, 8+ chars).');
      if (!ok) {
        await new Promise((r) => setTimeout(r, 1000));
        if (++failures >= 5) { failures = 0; lockedUntil = Date.now() + 60_000; }
        throw new HttpError(401, 'Wrong password.');
      }
      failures = 0; return send(res, 200, { token: ctx.cfg.token });
    }
    if (path === '/hooks/ticketing' && method === 'POST') {          // authenticated by HMAC, not the bearer token
      const raw = (await readBody(req, JSON_LIMIT)).toString('utf8');
      if (!verifySignature(deps.ticketingSecret ?? '', raw, req.headers['x-tickets-signature'] as string | undefined)) throw new HttpError(401, 'Bad signature.');
      return send(res, 200, { applied: applyTicketingEvent(ctx, JSON.parse(raw)) });
    }
    // Two credentials: the full token, and an optional ingest-only token for devices (Mac agent, phone) that only ever need to send input.
    const full = tokenOk(req.headers.authorization, ctx.cfg.token);
    const ingestOnly = !full && ctx.cfg.ingestToken.length >= 16 && (path.startsWith('/ingest/') || path === '/app/mac/heartbeat' || path === '/app/mac/download') && tokenOk(req.headers.authorization, ctx.cfg.ingestToken);
    if (!full && !ingestOnly) throw new HttpError(401, 'Missing or invalid bearer token.');
    let m: RegExpExecArray | null;

    if (path === '/auth/password' && method === 'POST' && full) {
      const b = await readJson(req); const next = String(b.new ?? '');
      if (next.length < 8) throw new HttpError(400, 'New password must be at least 8 characters.');
      if (passwordMatches(ctx, String(b.current ?? '')) === false) throw new HttpError(401, 'Current password is wrong.');
      setPassword(ctx, next); return send(res, 200, { ok: true });
    }
    if (path === '/ingest/message' && method === 'POST') {
      const b = await readJson(req);
      if (typeof b.sourceId !== 'string' || !b.sourceId) throw new HttpError(400, 'sourceId is required.');
      if (typeof b.body !== 'string' || !b.body.trim()) throw new HttpError(400, 'body is required.');
      const id = storeMessage(ctx, { source: String(b.source ?? 'api'), sourceId: b.sourceId, sender: String(b.sender ?? ''), subject: String(b.subject ?? ''), body: b.body, receivedAt: typeof b.receivedAt === 'string' ? b.receivedAt : undefined });
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

    // ---- management API used by the web UI ----
    if (path === '/app/mac/latest' && method === 'GET') return send(res, 200, { release: publicRelease(await latestMacRelease(ctx, deps.fetchImpl, url.searchParams.get('refresh') === '1')) });
    if (path === '/app/mac/heartbeat' && method === 'POST') {          // the Mac app checks in (either token): version in, "update now?" out
      const b = await readJson(req);
      try { return send(res, 200, macHeartbeat(ctx, b, await latestMacRelease(ctx, deps.fetchImpl))); } catch (e) { throw new HttpError(400, (e as Error).message); }
    }
    if (path === '/app/mac/clients' && method === 'GET' && full) return send(res, 200, { clients: listMacClients(ctx, await latestMacRelease(ctx, deps.fetchImpl)) });
    if ((m = /^\/app\/mac\/clients\/([\w-]{1,64})\/update$/.exec(path)) && method === 'POST' && full) {
      try { return send(res, 200, { asked: requestMacUpdate(ctx, m[1], await latestMacRelease(ctx, deps.fetchImpl)) }); } catch (e) { throw new HttpError(409, (e as Error).message); }
    }
    if ((m = /^\/app\/mac\/clients\/([\w-]{1,64})$/.exec(path)) && method === 'DELETE' && full) {
      if (!forgetMacClient(ctx, m[1])) throw new HttpError(404, 'No such Mac.'); return send(res, 200, { ok: true });
    }
    if (path === '/app/mac/download' && method === 'GET') {
      let dl: Awaited<ReturnType<typeof openMacDownload>>;
      try { dl = await openMacDownload(ctx, deps.fetchImpl); } catch (e) { throw new HttpError(502, (e as Error).message); }
      if (!dl) throw new HttpError(404, 'No Mac app has been released yet.');
      res.writeHead(200, { 'content-type': 'application/zip', 'content-disposition': `attachment; filename="${dl.rel.assetName}"`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...(dl.rel.size ? { 'content-length': String(dl.rel.size) } : {}) });
      try { await pipeline(Readable.fromWeb(dl.res.body as never), res); } catch { res.destroy(); }
      return;
    }
    if (path === '/status' && method === 'GET') return send(res, 200, status(ctx));
    if (path === '/status/integrations' && method === 'GET') return send(res, 200, { integrations: await integrations(ctx) });
    if (path === '/activity' && method === 'GET') return send(res, 200, { events: activity(ctx, Number(url.searchParams.get('limit') ?? 60)) });
    if (path === '/logs' && method === 'GET') return send(res, 200, { lines: getLogs(Number(url.searchParams.get('limit') ?? 200)) });
    if (path === '/search' && method === 'GET') return send(res, 200, { hits: search(ctx, url.searchParams.get('q') ?? '', 25) });
    if (path === '/stages' && method === 'GET') {
      if (!ctx.ticketing) return send(res, 200, { stages: [] });
      try { return send(res, 200, { stages: (await ctx.ticketing.defaultPipeline()).stages }); } catch { return send(res, 200, { stages: [] }); }
    }
    if (path === '/messages' && method === 'GET') return send(res, 200, { messages: listMessages(ctx, { filter: url.searchParams.get('filter') ?? 'all', q: url.searchParams.get('q') ?? undefined, limit: Number(url.searchParams.get('limit') ?? 100) }) });
    if ((m = /^\/messages\/(\d+)\/(retry|skip)$/.exec(path)) && method === 'POST') {
      const ok = m[2] === 'retry' ? retryMessage(ctx, Number(m[1])) : skipMessage(ctx, Number(m[1]));
      if (!ok) throw new HttpError(404, 'No such pending message.'); deps.wake(); return send(res, 200, { ok: true });
    }
    if (path === '/items' && method === 'POST') {
      const b = await readJson(req);
      if (!['ticket', 'reminder', 'task'].includes(String(b.kind))) throw new HttpError(400, 'kind must be ticket, reminder or task.');
      if (!String(b.title ?? '').trim()) throw new HttpError(400, 'title is required.');
      const a: Action = { op: 'create', kind: b.kind as Action['kind'], title: String(b.title).trim().slice(0, 300), detail: String(b.detail ?? '').slice(0, 5000), dueAt: b.dueAt ? String(b.dueAt) : undefined,
        priority: (['low', 'normal', 'high', 'urgent'].includes(String(b.priority)) ? b.priority : 'normal') as Action['priority'], classHint: b.classHint ? String(b.classHint) : undefined, confidence: 1, flags: [], why: 'created in web UI' };
      const r = await applyAction(ctx, a, null, 'owner'); return send(res, 200, { summary: r.summary, item: r.item });
    }
    if ((m = /^\/items\/([0-9a-f-]+)$/.exec(path)) && method === 'PATCH') {
      const it = ctx.items.find(m[1]); if (!it) throw new HttpError(404, 'Not found.');
      const b = await readJson(req);
      const a: Action = { op: 'update', itemId: it.id, confidence: 1, flags: [], why: 'edited in web UI',
        ...(typeof b.title === 'string' && b.title.trim() && { title: b.title.trim().slice(0, 300) }), ...(typeof b.detail === 'string' && { detail: b.detail.slice(0, 5000) }),
        ...(typeof b.dueAt === 'string' && b.dueAt && { dueAt: b.dueAt }), ...(['low', 'normal', 'high', 'urgent'].includes(String(b.priority)) && { priority: b.priority as Action['priority'] }) };
      const r = await applyAction(ctx, a, null, 'owner'); return send(res, 200, { summary: r.summary, item: r.item });
    }
    if ((m = /^\/items\/([0-9a-f-]+)\/(complete|drop|stage)$/.exec(path)) && method === 'POST') {
      const it = ctx.items.find(m[1]); if (!it) throw new HttpError(404, 'Not found.');
      const b = m[2] === 'stage' ? await readJson(req) : {};
      const a: Action = m[2] === 'stage' ? { op: 'stage', itemId: it.id, stageId: String(b.stageId ?? ''), confidence: 1, flags: [], why: 'set in web UI' }
        : { op: m[2] === 'complete' ? 'complete' : 'drop', itemId: it.id, confidence: 1, flags: [], why: 'set in web UI' };
      const r = await applyAction(ctx, a, null, 'owner'); return send(res, 200, { summary: r.summary, item: r.item });
    }
    if ((m = /^\/connectors\/([\w-]+)\/instructions$/.exec(path)) && method === 'PUT') {
      try { return send(res, 200, { instructions: setConnectorInstructions(ctx, m[1], String((await readJson(req)).text ?? '')) }); } catch (e) { throw new HttpError(400, (e as Error).message); }
    }
    if (path === '/connectors/full' && method === 'GET') return send(res, 200, { connectors: connectorsFull(ctx) });
    if ((m = /^\/connectors\/([\w-]+)\/actions\/(\w+)\/auto$/.exec(path)) && method === 'POST') {
      try { setAutoAllowed(ctx, m[1], m[2], !!(await readJson(req)).allow); } catch (e) { throw new HttpError(400, (e as Error).message); }
      return send(res, 200, { ok: true });
    }
    if (path === '/connectors/auto' && method === 'POST') { const b = await readJson(req); const j = startAutoConnect(ctx, String(b.input ?? ''), b.apiKey ? String(b.apiKey) : undefined); return send(res, 202, { job: pub(j) }); }
    if ((m = /^\/connectors\/auto\/(\w+)(\/key)?$/.exec(path))) {
      const j = getJob(m[1]); if (!j) throw new HttpError(404, 'unknown job');
      if (m[2] && method === 'POST') { try { return send(res, 200, { job: pub(continueWithKey(ctx, m[1], String((await readJson(req)).apiKey ?? ''))) }); } catch (e) { throw new HttpError(400, (e as Error).message); } }
      if (!m[2] && method === 'GET') return send(res, 200, { job: pub(j) });
    }
    if (path === '/connectors/propose' && method === 'POST') return send(res, 200, { result: await proposeConnector(ctx, String((await readJson(req)).input ?? '')) });
    if ((m = /^\/connectors\/([\w-]+)\/(test|enable|disable)$/.exec(path)) && method === 'POST') {
      if (m[2] === 'test') return send(res, 200, { result: await testConnector(ctx, m[1]) });
      if (m[2] === 'enable') return send(res, 200, { result: enableConnector(ctx, m[1]) });
      return send(res, 200, { ok: setConnectorStatus(ctx, m[1], 'disabled') });
    }
    if ((m = /^\/connectors\/([\w-]+)$/.exec(path)) && method === 'DELETE') return send(res, 200, { ok: deleteConnector(ctx, m[1]) });
    if ((m = /^\/secrets\/([A-Z0-9_]+)$/.exec(path)) && method === 'PUT') {
      try { setSecret(ctx, m[1], String((await readJson(req)).value ?? '') || null); } catch (e) { throw new HttpError(400, (e as Error).message); }
      return send(res, 200, { ok: true });
    }
    if (path === '/integrations/guides' && method === 'GET') return send(res, 200, { guides: GUIDES });
    if ((m = /^\/integrations\/([a-z]+)\/setup$/.exec(path)) && method === 'POST') {
      try { return send(res, 200, applySetup(ctx, m[1], String((await readJson(req)).text ?? ''))); } catch (e) { throw new HttpError(400, (e as Error).message); }
    }
    if (path === '/settings' && method === 'GET') return send(res, 200, { settings: viewSettings(ctx.cfg.dataDir) });
    if (path === '/settings' && method === 'PUT') {
      try { return send(res, 200, { changed: saveSettings(ctx.cfg.dataDir, (await readJson(req)).values as Record<string, unknown> ?? {}) }); } catch (e) { throw new HttpError(400, (e as Error).message); }
    }
    if (path === '/admin/service-account' && method === 'POST') {
      try { const p = saveServiceAccount(ctx, (await readBody(req, JSON_LIMIT)).toString('utf8')); saveSettings(ctx.cfg.dataDir, { GOOGLE_SERVICE_ACCOUNT_FILE: p }); return send(res, 200, { path: p }); } catch (e) { throw new HttpError(400, (e as Error).message); }
    }
    if (path === '/admin/reindex' && method === 'POST') {
      if (!ctx.cfg.indexPaths.length) throw new HttpError(400, 'No index paths configured.');
      return send(res, 200, await indexPaths(ctx.db, ctx.cfg.indexPaths));
    }
    if (path.startsWith('/code') && await codeRoutes(ctx, path, method, url.searchParams, { json: (limit) => readJson(req, limit), body: (limit) => readBody(req, limit), send: (st, b) => send(res, st, b) })) return;
    if (path === '/backup/export' && method === 'GET') {
      const { data, info } = createBackup(ctx, url.searchParams.get('secrets') !== '0');
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': data.length, 'cache-control': 'no-store', 'content-disposition': `attachment; filename="assistant-backup-${info.createdAt.slice(0, 10)}.backup"`, 'x-backup-info': JSON.stringify(info) });
      return void res.end(data);
    }
    if (path === '/backup/list' && method === 'GET') return send(res, 200, { auto: ctx.cfg.backup.auto, hour: ctx.cfg.backup.hour, keep: ctx.cfg.backup.keep, last: lastBackup(ctx), backups: listBackups(ctx) });
    if (path === '/backup/run' && method === 'POST') { const d = new Date(); return send(res, 200, { backup: saveBackupFile(ctx, 'manual', d.toISOString().replace(/[:.]/g, '-')) }); }
    if ((m = /^\/backup\/file\/([\w.-]+)$/.exec(path)) && method === 'GET') {
      const f = backupPath(ctx, m[1]); if (!f) throw new HttpError(404, 'No such backup.');
      const data = readFileSync(f); res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': data.length, 'cache-control': 'no-store', 'content-disposition': `attachment; filename="${m[1]}"` }); return void res.end(data);
    }
    if (path === '/backup/import' && method === 'POST') {
      const body = await readBody(req, BACKUP_LIMIT); if (!body.length) throw new HttpError(400, 'Empty file.');
      try { const r = restoreBackup(ctx, body); return send(res, 200, { ok: true, createdAt: r.info.createdAt, counts: r.info.counts, includesSecrets: r.info.includesSecrets, restartNeeded: r.restartNeeded, safetyCopy: r.safetyCopy }); } catch (e) { throw new HttpError(400, (e as Error).message); }
    }
    if (path === '/admin/restart' && method === 'POST') {
      send(res, 200, { ok: true }); setTimeout(() => (deps.restart ?? (() => process.exit(0)))(), 400); return;
    }
    if (path === '/chat' && method === 'POST') { const b = await readJson(req, IMAGE_BODY_LIMIT); let images; try { images = parseUploads(b.images); } catch (e) { throw new HttpError(400, (e as Error).message); } return send(res, 200, { reply: await handleOwnerText(ctx, String(b.text ?? ''), undefined, images) }); }
    if (path === '/ask' && method === 'POST') { const b = await readJson(req, IMAGE_BODY_LIMIT); let images; try { images = parseUploads(b.images); } catch (e) { throw new HttpError(400, (e as Error).message); } return send(res, 200, { answer: await ask(ctx, String(b.question ?? ''), toLlmImages(images)) }); }

    if (path === '/items' && method === 'GET') return send(res, 200, { items: ctx.items.list({ state: url.searchParams.get('state') ?? 'open', kind: url.searchParams.get('kind') ?? undefined, limit: Number(url.searchParams.get('limit') ?? 200) }) });
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
    if (path === '/approvals' && method === 'GET') { const st = url.searchParams.get('status') ?? 'pending'; return send(res, 200, { approvals: listApprovals(ctx, ['pending', 'approved', 'rejected'].includes(st) ? st : 'pending') }); }
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
