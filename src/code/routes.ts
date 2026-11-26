import * as C from './manager.ts';
import * as X from './external.ts';
import { ALLOWED_KEYS } from './tmux.ts';
import { makeTmux } from './tmux.ts';
import type { Ctx } from '../ctx.ts';

export interface RouteHelpers { json(limit?: number): Promise<Record<string, unknown>>; body(limit: number): Promise<Buffer>; send(status: number, body: unknown): void }

/** The Code tab's API (everything under /code). Returns false when the path is not one of ours. */
export async function codeRoutes(ctx: Ctx, path: string, method: string, query: URLSearchParams, h: RouteHelpers): Promise<boolean> {
  if (!path.startsWith('/code')) return false;
  const ok = (v: unknown) => { h.send(200, v); return true; };
  try {
    let m: RegExpExecArray | null;
    if (path === '/code/status' && method === 'GET') {
      const t = makeTmux(ctx.cfg.code.tmuxBin, ctx.cfg.code.socket); const tmux = await t.available();
      return ok({ enabled: ctx.cfg.code.enabled, tmux, root: ctx.cfg.code.root, maxSessions: ctx.cfg.code.maxSessions, allowBypass: ctx.cfg.code.allowBypass, modes: C.PERMISSION_MODES.filter((x) => x !== 'bypassPermissions' || ctx.cfg.code.allowBypass), keys: [...ALLOWED_KEYS] });
    }
    if (path === '/code/projects' && method === 'GET') {
      const states = new Map((await C.sessionSummaries(ctx)).map((s) => [s.id, s]));
      return ok({ projects: C.listProjects(ctx).map((p) => ({ ...p, sessions: C.listSessionRows(ctx, p.id).map((s) => ({ ...s, running: states.get(s.id)?.running ?? false, state: states.get(s.id)?.state ?? 'stopped' })) })) });
    }
    if (path === '/code/projects' && method === 'POST') { const b = await h.json(); return ok({ project: await C.addProject(ctx, { name: String(b.name ?? ''), folder: String(b.folder ?? ''), create: !!b.create, cloneUrl: b.cloneUrl ? String(b.cloneUrl) : undefined }) }); }
    if (path === '/code/folders' && method === 'GET') return ok(C.listFolders(ctx, query.get('path') ?? ''));
    if ((m = /^\/code\/projects\/([\w-]+)$/.exec(path))) {
      if (method === 'PATCH') return ok({ project: C.renameProject(ctx, m[1], String((await h.json()).name ?? '')) });
      if (method === 'DELETE') { await C.removeProject(ctx, m[1]); return ok({ ok: true }); }
    }
    if ((m = /^\/code\/projects\/([\w-]+)\/sessions$/.exec(path)) && method === 'POST') {
      const b = await h.json(); const s = C.createSession(ctx, m[1], { title: String(b.title ?? ''), model: String(b.model ?? ''), permissionMode: String(b.permissionMode ?? '') });
      if (b.start !== false) await C.startSession(ctx, s.id, b.prompt ? String(b.prompt) : undefined);
      return ok({ session: s });
    }
    if ((m = /^\/code\/sessions\/([\w-]+)$/.exec(path))) {
      if (method === 'GET') { const s = C.getSession(ctx, m[1]); return ok({ session: s, project: C.getProject(ctx, s.projectId) }); }
      if (method === 'PATCH') return ok({ session: C.renameSession(ctx, m[1], String((await h.json()).title ?? '')) });
      if (method === 'DELETE') { await C.deleteSession(ctx, m[1]); return ok({ ok: true }); }
    }
    if ((m = /^\/code\/sessions\/([\w-]+)\/(start|stop|restart)$/.exec(path)) && method === 'POST') {
      const b = m[2] === 'start' ? await h.json() : {};
      if (m[2] === 'start') await C.startSession(ctx, m[1], b.prompt ? String(b.prompt) : undefined); else if (m[2] === 'stop') await C.stopSession(ctx, m[1]); else await C.restartSession(ctx, m[1]);
      return ok({ ok: true });
    }
    if ((m = /^\/code\/sessions\/([\w-]+)\/live$/.exec(path)) && method === 'GET') return ok(await C.live(ctx, m[1], Math.max(0, Number(query.get('after') ?? 0) || 0)));
    if ((m = /^\/code\/sessions\/([\w-]+)\/send$/.exec(path)) && method === 'POST') { await C.sendMessage(ctx, m[1], String((await h.json()).text ?? '')); return ok({ ok: true }); }
    if ((m = /^\/code\/sessions\/([\w-]+)\/keys$/.exec(path)) && method === 'POST') { const b = await h.json(); if (typeof b.text === 'string') await C.typeText(ctx, m[1], b.text); if (b.keys) await C.pressKeys(ctx, m[1], b.keys); return ok({ ok: true }); }
    if ((m = /^\/code\/sessions\/([\w-]+)\/screen$/.exec(path)) && method === 'GET') return ok(await C.screenText(ctx, m[1], Number(query.get('scrollback') ?? 0) || 0));
    if ((m = /^\/code\/sessions\/([\w-]+)\/output$/.exec(path)) && method === 'GET') return ok({ text: await C.commandOutput(ctx, m[1], query.get('cmd') ?? '') });
    if ((m = /^\/code\/sessions\/([\w-]+)\/commands$/.exec(path)) && method === 'GET') return ok({ commands: C.listCommands(ctx, m[1]) });
    if ((m = /^\/code\/sessions\/([\w-]+)\/usage$/.exec(path)) && method === 'GET') return ok(C.sessionUsage(ctx, m[1]));
    if ((m = /^\/code\/sessions\/([\w-]+)\/upload$/.exec(path)) && method === 'POST') return ok({ path: C.saveUpload(ctx, m[1], await h.body(12 * 1024 * 1024), query.get('name') ?? 'picture') });
    if (path === '/code/usage' && method === 'GET') return ok(C.usageOverview(ctx, Math.min(90, Math.max(1, Number(query.get('days') ?? 14) || 14))));
    if (path === '/code/usage/plan' && method === 'GET') return ok(await C.planUsage(ctx, query.get('force') === '1'));
    if (path === '/code/external' && method === 'GET') return ok({ sessions: (await X.discover(ctx)).map(({ socket, ...e }) => ({ ...e, socketName: socket.split('/').pop() })) });
    if ((m = /^\/code\/external\/([\w-]+)\/(info|live|send|keys|screen|output|commands|usage)$/.exec(path))) {
      const [, key, what] = m;
      if (what === 'info' && method === 'GET') return ok(await X.info(ctx, key));
      if (what === 'live' && method === 'GET') return ok(await X.live(ctx, key, Math.max(0, Number(query.get('after') ?? 0) || 0)));
      if (what === 'send' && method === 'POST') { await X.send(ctx, key, String((await h.json()).text ?? '')); return ok({ ok: true }); }
      if (what === 'keys' && method === 'POST') { const b = await h.json(); await X.keys(ctx, key, Array.isArray(b.keys) ? b.keys.map(String) : [], ALLOWED_KEYS, typeof b.text === 'string' ? b.text : undefined); return ok({ ok: true }); }
      if (what === 'screen' && method === 'GET') return ok(await X.screen(ctx, key, Number(query.get('scrollback') ?? 0) || 0));
      if (what === 'output' && method === 'GET') return ok({ text: await X.output(ctx, key, query.get('cmd') ?? '') });
      if (what === 'commands' && method === 'GET') return ok({ commands: await X.commands(ctx, key) });
      if (what === 'usage' && method === 'GET') return ok(await X.usage(ctx, key));
    }
    if (path === '/code/tmux' && method === 'GET') return ok({ sessions: await C.tmuxSessions(ctx) });
    if ((m = /^\/code\/tmux\/([\w-]+)\/kill$/.exec(path)) && method === 'POST') { await C.killTmux(ctx, m[1]); return ok({ ok: true }); }
  } catch (e) { if (e instanceof C.CodeError) { h.send(e.status, { error: e.message }); return true; } throw e; }
  return false;
}
