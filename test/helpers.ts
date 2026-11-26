import { loadConfig } from '../src/config.ts';
import { openDb } from '../src/db.ts';
import { ItemStore } from '../src/items.ts';
import { FakeLlm } from '../src/llm.ts';
import { MemoryNotifier } from '../src/notify.ts';
import { LocalTicketing } from '../src/tickets/local.ts';
import { openDb as openTicketsDb } from '../src/tickets/db.ts';
import { CanopyClient } from '../src/backends/canopy.ts';
import { DEFAULT_STAGES } from '../src/stages.ts';
import type { Ctx } from '../src/ctx.ts';

type Responder = unknown[] | ((req: { system: string; prompt: string }) => unknown);

export interface Fakes { tickets: { id: number; title: string; stageId: string; priority: string }[]; canopyTasks: { id: string; title: string; classId?: string; dueDate?: string; completed?: boolean }[]; calls: string[] }

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });

export function makeCtx(responder: Responder = [], opts: { now?: Date; env?: Record<string, string> } = {}): { ctx: Ctx; llm: FakeLlm; notify: MemoryNotifier; fakes: Fakes } {
  const fakes = { canopyTasks: [], calls: [] } as unknown as Fakes;
  const canopyFetch = (async (url: string, init: RequestInit = {}) => {
    const path = new URL(url).pathname.replace('/api/v1', ''); const m = init.method ?? 'GET'; const body = init.body ? JSON.parse(init.body as string) : {};
    fakes.calls.push(`C ${m} ${path}`);
    if (path === '/classes') return json({ classes: [{ id: 'c-bio', name: 'AP Biology' }, { id: 'c-calc', name: 'Calculus' }] });
    if (path === '/tasks' && m === 'POST') { const t = { id: `ct${fakes.canopyTasks.length + 1}`, ...body }; fakes.canopyTasks.push(t); return json({ task: { ...t, completed: false } }, 201); }
    const mm = /^\/tasks\/(.+)$/.exec(path);
    if (mm && m === 'PATCH') { const t = fakes.canopyTasks.find((x) => x.id === mm[1])!; Object.assign(t, body); return json({ task: t }); }
    return json({ error: 'nope' }, 404);
  }) as unknown as typeof fetch;

  const db = openDb(':memory:');
  const llm = new FakeLlm(responder as never);
  const notify = new MemoryNotifier();
  const cfg = loadConfig({ TZ_NAME: 'America/Anchorage', QUIET_HOURS: '22-7', ...opts.env } as NodeJS.ProcessEnv);
  const ticketing = new LocalTicketing(openTicketsDb(':memory:'));
  Object.defineProperty(fakes, 'tickets', { get: () => ticketing.service.listTickets({ status: 'all' }).sort((a, b) => a.id - b.id) });   // the real tracker, seen as a plain list
  const ctx: Ctx = {
    cfg, db, llm, items: new ItemStore(db), notify, now: () => opts.now ?? new Date(),
    ticketing,
    canopy: new CanopyClient('http://canopy.test', 'r', 'w', canopyFetch),
  };
  return { ctx, llm, notify, fakes };
}
