import { loadConfig } from '../src/config.ts';
import { openDb } from '../src/db.ts';
import { ItemStore } from '../src/items.ts';
import { FakeLlm } from '../src/llm.ts';
import { MemoryNotifier } from '../src/notify.ts';
import { TicketingClient } from '../src/backends/ticketing.ts';
import { CanopyClient } from '../src/backends/canopy.ts';
import { DEFAULT_STAGES } from '../src/stages.ts';
import type { Ctx } from '../src/ctx.ts';

type Responder = unknown[] | ((req: { system: string; prompt: string }) => unknown);

export interface Fakes { tickets: { id: number; title: string; stageId: string; priority: string }[]; canopyTasks: { id: string; title: string; classId?: string; dueDate?: string; completed?: boolean }[]; calls: string[] }

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });

export function makeCtx(responder: Responder = [], opts: { now?: Date; env?: Record<string, string> } = {}): { ctx: Ctx; llm: FakeLlm; notify: MemoryNotifier; fakes: Fakes } {
  const fakes: Fakes = { tickets: [], canopyTasks: [], calls: [] };
  const ticketingFetch = (async (url: string, init: RequestInit = {}) => {
    const path = new URL(url).pathname; const m = init.method ?? 'GET'; const body = init.body ? JSON.parse(init.body as string) : {};
    fakes.calls.push(`T ${m} ${path}`);
    const view = (t: Fakes['tickets'][number]) => ({ ...t, stageLabel: DEFAULT_STAGES.find((s) => s.id === t.stageId)!.label, open: t.stageId !== 'closed' });
    if (path === '/api/pipelines') return json({ pipelines: [{ id: 'it', name: 'IT', stages: DEFAULT_STAGES, isDefault: true }] });
    if (path === '/api/tickets' && m === 'POST') { const t = { id: fakes.tickets.length + 1, title: body.title, stageId: 'reported', priority: body.priority ?? 'normal' }; fakes.tickets.push(t); return json({ ticket: view(t) }, 201); }
    let mm = /^\/api\/tickets\/(\d+)\/stage$/.exec(path);
    if (mm && m === 'POST') { const t = fakes.tickets.find((x) => x.id === +mm![1])!; t.stageId = body.stageId; return json({ ticket: view(t) }); }
    mm = /^\/api\/tickets\/(\d+)$/.exec(path);
    if (mm && m === 'PATCH') { const t = fakes.tickets.find((x) => x.id === +mm![1])!; Object.assign(t, body); return json({ ticket: view(t) }); }
    return json({ error: 'nope' }, 404);
  }) as unknown as typeof fetch;
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
  const ctx: Ctx = {
    cfg, db, llm, items: new ItemStore(db), notify, now: () => opts.now ?? new Date(),
    ticketing: new TicketingClient('http://tickets.test', 't', ticketingFetch),
    canopy: new CanopyClient('http://canopy.test', 'r', 'w', canopyFetch),
  };
  return { ctx, llm, notify, fakes };
}
