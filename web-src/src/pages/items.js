import { api } from '../api.js';
import { h, icon, clear, fmtDate, ago, toLocalInput, empty, dialog, confirmDialog, guarded, chip, menu, debounce, state, page, rel, download, toast, fab } from '../ui.js';

const KIND_ICON = { ticket: 'confirmation_number', reminder: 'alarm', task: 'checklist' };
const KIND_LABEL = { ticket: 'Ticket', reminder: 'Reminder', task: 'Task' };
let stagesCache;
const stages = async () => (stagesCache ??= (await api('/stages')).stages);

export function itemMeta(it) {
  const overdue = it.state === 'open' && it.dueAt && new Date(it.dueAt) < Date.now();
  return [chip(KIND_LABEL[it.kind]), it.stageLabel && chip(it.stageLabel, 'ok'), it.priority !== 'normal' && chip(it.priority, it.priority === 'urgent' || it.priority === 'high' ? 'bad' : ''),
    it.dueAt && h('span', { class: 'due' + (overdue ? ' tag bad' : ''), title: fmtDate(it.dueAt) }, icon('schedule'), (overdue ? 'overdue · ' : 'due ') + rel(it.dueAt) + ' · ' + fmtDate(it.dueAt, { month: 'short', day: 'numeric', ...(Math.abs(new Date(it.dueAt) - Date.now()) > 300 * 864e5 && { year: 'numeric' }), hour: 'numeric', minute: '2-digit' })),
    it.snoozeUntil && new Date(it.snoozeUntil) > Date.now() && h('span', { class: 'tag warn' }, icon('snooze'), 'until ' + fmtDate(it.snoozeUntil)),
    it.nagCount > 0 && it.state === 'open' && h('span', { class: 'tag warn' }, `nagged ${it.nagCount}×`),
    it.backend !== 'local' && chip(it.backend)];
}

/** One list row with the quick actions; `changed()` is called after any mutation. */
export function itemRow(it, changed) {
  const act = async (fn, msg) => { await guarded(fn, msg); changed(); };
  const more = h('md-icon-button', { 'aria-label': 'More actions' }, icon('more_horiz'));
  const entries = [{ label: 'Edit', icon: 'edit', onclick: () => itemDialog(it, changed) }, { label: 'History', icon: 'history', onclick: () => historyDialog(it) }];
  if (it.state === 'open') {
    if (it.kind === 'reminder') entries.push({ label: 'Acknowledge', icon: 'done_all', onclick: () => act(() => api(`/items/${it.id}/ack`, { method: 'POST' }), 'Acknowledged') });
    for (const f of ['30m', '2h', 'tomorrow']) if (it.kind === 'reminder') entries.push({ label: 'Snooze ' + f, icon: 'snooze', onclick: () => act(() => api(`/items/${it.id}/snooze`, { method: 'POST', body: { for: f } }), 'Snoozed ' + f) });
    entries.push({ label: 'Drop', icon: 'delete', onclick: async () => { if (await confirmDialog('Drop this item?', it.title, 'Drop')) act(() => api(`/items/${it.id}/drop`, { method: 'POST' }), 'Dropped'); } });
  }
  const row = h('div', { class: 'row ' + (it.state !== 'open' ? 'done' : ''), onclick: (e) => { if (!e.target.closest('.acts')) itemDialog(it, changed); } },
    h('div', { class: 'lead k-' + it.kind }, icon(KIND_ICON[it.kind])),
    h('div', {}, h('div', { class: 't' }, it.title), h('div', { class: 's' }, itemMeta(it))),
    h('div', { class: 'acts' }, it.state === 'open' && h('md-filled-tonal-icon-button', { 'aria-label': 'Mark done', title: 'Mark done', onclick: () => act(() => api(`/items/${it.id}/complete`, { method: 'POST' }), 'Done'), }, icon('check')), more, menu(more, entries)));
  const drop = async () => { if (await confirmDialog('Drop this item?', it.title, 'Drop')) act(() => api(`/items/${it.id}/drop`, { method: 'POST' }), 'Dropped'); };
  row.dataset.sel = '';
  row._keys = { Enter: () => itemDialog(it, changed), e: () => itemDialog(it, changed), h: () => historyDialog(it),
    ...(it.state === 'open' && { x: () => act(() => api(`/items/${it.id}/complete`, { method: 'POST' }), 'Done'), Delete: drop, Backspace: drop,
      ...(it.kind === 'reminder' && { s: () => act(() => api(`/items/${it.id}/snooze`, { method: 'POST', body: { for: '2h' } }), 'Snoozed 2h') }) }) };
  return row;
}

async function historyDialog(it) {
  const j = await guarded(() => api('/items/' + it.id)); if (!j) return;
  const { close } = dialog({ title: it.title, fullscreen: true, content: [it.detail && h('p', { style: 'white-space:pre-wrap' }, it.detail),
    h('div', { class: 'label' }, 'History'), h('div', { class: 'timeline' }, j.events.map((e) => h('div', {}, h('div', { class: 't' }, e.type), h('div', { class: 'muted' }, `${e.actor} · ${fmtDate(e.at)}`), e.data?.why && h('div', { class: 's muted' }, e.data.why))).reverse())],
    actions: [h('md-text-button', { onclick: () => close() }, 'Close')] });
}

/** Create (it = null) or edit an item. */
export async function itemDialog(it, changed) {
  const isNew = !it;
  const kind = h('md-outlined-select', { label: 'Type', disabled: !isNew }, ['task', 'reminder', 'ticket'].map((k) => h('md-select-option', { value: k, selected: (it?.kind ?? 'task') === k }, h('div', { slot: 'headline' }, KIND_LABEL[k]))));
  const title = h('md-outlined-text-field', { label: 'Title', value: it?.title ?? '' });
  const detail = h('md-outlined-text-field', { label: 'Details', type: 'textarea', rows: 3, value: it?.detail ?? '' });
  const due = h('md-outlined-text-field', { label: 'Due', type: 'datetime-local', value: toLocalInput(it?.dueAt) , 'supporting-text': `Time zone: ${state.tz}` });
  const prio = h('md-outlined-select', { label: 'Priority' }, ['low', 'normal', 'high', 'urgent'].map((p) => h('md-select-option', { value: p, selected: (it?.priority ?? 'normal') === p }, h('div', { slot: 'headline' }, p))));
  const stageSel = h('md-outlined-select', { label: 'Stage' });
  const stageBox = h('div', {});
  if (!isNew && it.backend === 'ticketing') {
    const st = await stages();
    if (st.length) { st.forEach((s) => stageSel.append(h('md-select-option', { value: s.id, selected: s.id === it.stageId }, h('div', { slot: 'headline' }, s.label)))); stageBox.append(stageSel); }
  }
  const save = async () => {
    if (!title.value.trim()) return;
    const body = { kind: kind.value, title: title.value, detail: detail.value, dueAt: due.value || undefined, priority: prio.value };
    const ok = await guarded(async () => {
      if (isNew) await api('/items', { method: 'POST', body });
      else {
        if (it.state === 'open') await api('/items/' + it.id, { method: 'PATCH', body });
        if (stageSel.value && stageSel.value !== it.stageId) await api(`/items/${it.id}/stage`, { method: 'POST', body: { stageId: stageSel.value } });
      }
      return true;
    }, isNew ? 'Created' : 'Saved');
    if (ok) { close(); changed(); }
  };
  const { close } = dialog({ title: isNew ? 'New item' : 'Edit item', fullscreen: true, content: h('div', { class: 'form' }, kind, title, detail, h('div', { class: 'two' }, due, prio), stageBox,
    !isNew && h('div', { class: 'muted' }, `Created ${ago(it.createdAt)} · ${it.state}`)),
    actions: [!isNew && h('md-text-button', { onclick: () => { close(); historyDialog(it); } }, 'History'), h('md-text-button', { onclick: () => close() }, 'Cancel'), h('md-filled-button', { onclick: save }, isNew ? 'Create' : 'Save')] });
  setTimeout(() => title.focus(), 120);
}

const SORTS = { due: 'Due date', newest: 'Newest', priority: 'Priority', title: 'A–Z' };
const PRANK = { urgent: 0, high: 1, normal: 2, low: 3 };
const sorters = {
  due: (a, b) => (a.dueAt ? 0 : 1) - (b.dueAt ? 0 : 1) || (a.dueAt && b.dueAt ? new Date(a.dueAt) - new Date(b.dueAt) : 0) || new Date(b.createdAt) - new Date(a.createdAt),
  newest: (a, b) => new Date(b.createdAt) - new Date(a.createdAt),
  priority: (a, b) => PRANK[a.priority] - PRANK[b.priority] || sorters.due(a, b),
  title: (a, b) => a.title.localeCompare(b.title),
};
const day = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: state.tz }).format(new Date(d));
const WHEN = { '': () => true, overdue: (i) => i.state === 'open' && i.dueAt && new Date(i.dueAt) < Date.now(), today: (i) => i.dueAt && day(i.dueAt) === day(Date.now()), week: (i) => i.dueAt && day(i.dueAt) >= day(Date.now()) && day(i.dueAt) <= day(Date.now() + 7 * 864e5) };
const csvCell = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';

export default async function items(view) {
  const saved = (() => { try { return JSON.parse(localStorage.getItem('items_view') || '{}'); } catch { return {}; } })();
  let st = saved.st || 'open', kind = saved.kind ?? '', when = saved.when ?? '', sort = SORTS[saved.sort] ? saved.sort : 'due', q = '';
  const remember = () => localStorage.setItem('items_view', JSON.stringify({ st, kind, when, sort }));
  const list = h('div', { class: 'list' });
  const segs = (opts, cur, set) => { const box = h('div', { class: 'seg', role: 'group' }); const draw = () => clear(box).append(...opts.map(([v, l]) => h('button', { 'aria-pressed': String(v === cur), onclick: () => { cur = v; set(v); remember(); draw(); load(); } }, l))); draw(); return box; };
  const search = h('md-outlined-text-field', { label: 'Filter', class: 'grow', 'data-primary': '', 'supporting-text': '' }, h('span', { slot: 'leading-icon' }, icon('search')));
  search.addEventListener('input', debounce(() => { q = search.value.toLowerCase(); draw(); }, 120));
  let data = [];
  const visible = () => data.filter((i) => (!q || (i.title + ' ' + i.detail).toLowerCase().includes(q)) && WHEN[when](i)).sort(sorters[sort]);
  const draw = () => {
    const rows = visible();
    clear(list).append(...(rows.length ? rows.map((i) => itemRow(i, load)) : [empty('checklist', 'Nothing here', q || when ? 'No items match those filters.' : 'Nothing in this view yet. Press n to add something.')]));
    search.setAttribute('supporting-text', data.length ? `${rows.length} of ${data.length}` : '');
  };
  async function load() { const p = new URLSearchParams({ state: st, limit: 500 }); if (kind) p.set('kind', kind); data = (await guarded(() => api('/items?' + p)))?.items ?? []; draw(); }
  const sortBtn = h('md-text-button', {}, icon('sort'), h('span', {}, 'Sort: ' + SORTS[sort]));
  const sortMenu = menu(sortBtn, Object.entries(SORTS).map(([k, l]) => ({ label: l, onclick: () => { sort = k; remember(); sortBtn.lastChild.textContent = 'Sort: ' + l; draw(); } })));
  const exportBtn = h('md-text-button', {}, icon('download'), h('span', {}, 'Export'));
  const stamp = () => new Date().toISOString().slice(0, 10);
  const exportMenu = menu(exportBtn, [
    { label: 'CSV (these rows)', icon: 'download', onclick: () => { const r = visible(); download(`items-${stamp()}.csv`, ['kind,title,detail,state,priority,due,created'].concat(r.map((i) => [i.kind, i.title, i.detail, i.state, i.priority, i.dueAt, i.createdAt].map(csvCell).join(','))).join('\n'), 'text/csv'); toast(`Exported ${r.length} items`); } },
    { label: 'JSON (these rows)', icon: 'download', onclick: () => { const r = visible(); download(`items-${stamp()}.json`, JSON.stringify(r, null, 2), 'application/json'); toast(`Exported ${r.length} items`); } }]);
  const quick = h('md-outlined-text-field', { label: 'Quick add a task — type and press Enter', 'aria-label': 'Quick add' }, h('span', { slot: 'leading-icon' }, icon('add')));
  quick.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter' || !quick.value.trim()) return; e.preventDefault(); const title = quick.value.trim(); quick.value = '';
    if (await guarded(() => api('/items', { method: 'POST', body: { kind: 'task', title } }), 'Added')) load();
  });
  page.newAction = () => itemDialog(null, load);
  clear(view).append(h('div', { class: 'page-head' }, h('h1', { class: 'display' }, 'Items'), h('p', { class: 'muted title-m' }, 'Tickets, reminders and tasks in one place.')),
    quick,
    h('div', { class: 'toolbar' }, segs([['open', 'Open'], ['done', 'Done'], ['dropped', 'Dropped'], ['all', 'All']], st, (v) => (st = v)), segs([['', 'Everything'], ['ticket', 'Tickets'], ['reminder', 'Reminders'], ['task', 'Tasks']], kind, (v) => (kind = v)), search),
    h('div', { class: 'toolbar' }, segs([['', 'Any time'], ['overdue', 'Overdue'], ['today', 'Today'], ['week', 'Next 7 days']], when, (v) => (when = v)), h('div', { class: 'grow' }), sortBtn, sortMenu, exportBtn, exportMenu),
    list,
    h('div', { class: 'fab-slot' }, fab('New', 'New item', () => itemDialog(null, load))));
  await load(); const t = setInterval(() => !document.hidden && !document.querySelector('md-dialog') && load(), 30000); return () => clearInterval(t);
}
