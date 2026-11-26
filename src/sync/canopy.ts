import type { Ctx } from '../ctx.ts';
import { kvGet, kvSet } from '../db.ts';

const flagged = (f: unknown, word: string): boolean => JSON.stringify(f ?? '').toLowerCase().includes(word);

/**
 * Two-way sync with Canopy. Reads use the read-only token.
 *  - Assignments/tasks due soon or overdue become nagging reminders (deduped by external key).
 *  - Grade drops and missing work become alerts.
 *  - Things finished in Canopy close their local mirror and any pending due-reminder.
 */
export async function canopySync(ctx: Ctx): Promise<{ created: number; closed: number }> {
  const c = ctx.canopy; if (!c) return { created: 0, closed: 0 };
  let created = 0, closed = 0;
  const today = (await c.upcoming(2));
  // PowerSchool assignments use `canopy:ps…` keys so the Tasks page can hide them (they still nag).
  const mkPs = (kind: 'psdue' | 'psoverdue', id: string, suffix: string, title: string, priority = 'normal') => {
    const old = `canopy:${kind === 'psdue' ? 'due' : 'overdue'}:${id}${suffix}`; const key = `canopy:${kind}:${id}${suffix}`;
    ctx.db.prepare('UPDATE items SET external_key = ? WHERE external_key = ?').run(key, old); // migrate pre-existing rows
    mk(key, title, '', priority);
  };
  const mk = (key: string, title: string, detail = '', priority = 'normal') => {
    const r = ctx.items.create({ kind: 'reminder', title, detail, priority, externalKey: key, backend: 'local' }, 'canopy-sync');
    if (r.created) created++;
  };

  const stillDue = new Set<string>();
  for (const a of today.assignments) {
    stillDue.add(a.id);
    const when = a.dueDate.slice(0, 10) === today.today ? 'today' : a.dueDate.slice(0, 10);
    mkPs('psdue', a.id, `:${a.dueDate.slice(0, 10)}`, `Due ${when}: ${a.className ?? 'class'} — ${a.title}`);
  }
  for (const t of today.tasks) { stillDue.add(t.id); mk(`canopy:due:${t.id}:${t.dueDate.slice(0, 10)}`, `Due ${t.dueDate.slice(0, 10)}: ${t.title}`); }
  for (const a of today.overdue.assignments) { stillDue.add(a.id); mkPs('psoverdue', a.id, '', `OVERDUE: ${a.className ?? 'class'} — ${a.title} (was due ${a.dueDate.slice(0, 10)})`, 'high'); }
  for (const t of today.overdue.tasks) { stillDue.add(t.id); mk(`canopy:overdue:${t.id}`, `OVERDUE: ${t.title} (was due ${t.dueDate.slice(0, 10)})`, '', 'high'); }
  for (const a of [...today.assignments, ...today.overdue.assignments]) {
    if (flagged(a.flags, 'missing')) mk(`canopy:missing:${a.id}`, `Missing in PowerSchool: ${a.className ?? 'class'} — ${a.title}`, '', 'high');
  }
  for (const e of today.exams) mk(`canopy:exam:${e.id}:${e.date.slice(0, 10)}`, `Exam ${e.date.slice(0, 10)}: ${e.title}`);

  // Anything with a due-reminder that is no longer upcoming/overdue was completed (or moved) in Canopy: stop nagging.
  const open = ctx.db.prepare("SELECT id, external_key FROM items WHERE state = 'open' AND (external_key LIKE 'canopy:due:%' OR external_key LIKE 'canopy:overdue:%' OR external_key LIKE 'canopy:missing:%' OR external_key LIKE 'canopy:psdue:%' OR external_key LIKE 'canopy:psoverdue:%')").all() as { id: string; external_key: string }[];
  for (const o of open) {
    const cid = o.external_key.split(':')[2];
    if (!stillDue.has(cid)) { ctx.items.patch(o.id, { state: 'done', nextNagAt: null }, 'canopy-sync', { type: 'completed', data: { reason: 'no longer due in Canopy' } }); closed++; }
  }

  // Tasks the assistant created that were completed on the Canopy side.
  const mirrors = ctx.db.prepare("SELECT id, backend_ref FROM items WHERE state = 'open' AND backend = 'canopy'").all() as { id: string; backend_ref: string }[];
  if (mirrors.length) {
    const doneIds = new Set((await c.tasks(true)).map((t) => t.id));
    for (const mi of mirrors) if (doneIds.has(mi.backend_ref)) { ctx.items.patch(mi.id, { state: 'done', nextNagAt: null }, 'canopy-sync', { type: 'completed', data: { reason: 'completed in Canopy' } }); closed++; }
  }

  // Grade drops: compare the newest snapshot per class with the last one we looked at.
  const names = new Map((await c.classes()).map((k) => [k.id, k.name]));
  const latest = new Map<string, { pct: number; at: string }>();
  for (const h of await c.gradeHistory()) {
    if (h.gradePercent == null) continue;
    const cur = latest.get(h.classId);
    if (!cur || h.capturedAt > cur.at) latest.set(h.classId, { pct: h.gradePercent, at: h.capturedAt });
  }
  for (const [classId, snap] of latest) {
    const key = `canopy.grade.${classId}`; const prev = kvGet(ctx.db, key);
    if (prev !== undefined && Number(prev) - snap.pct >= ctx.cfg.canopyGradeDropPct) {
      mk(`canopy:grade:${classId}:${snap.at}`, `Grade drop in ${names.get(classId) ?? 'a class'}: ${Number(prev).toFixed(1)}% → ${snap.pct.toFixed(1)}%`, '', 'high');
    }
    kvSet(ctx.db, key, String(snap.pct));
  }
  return { created, closed };
}
