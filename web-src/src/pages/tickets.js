import { api } from '../api.js';
import { h, icon, clear, fmtDate, ago, empty, dialog, confirmDialog, guarded, chip, debounce, page, toast, fab, loadFailed, spinner } from '../ui.js';

/** The ticket tracker: each ticket moves along its pipeline's stages like a parcel being tracked. */
let pipelinesCache;
const pipelines = async (force) => (!force && pipelinesCache) || (pipelinesCache = (await api('/tickets/pipelines')).pipelines);

function tracker(t, p, onPick) {
  const box = h('div', { class: 'track' });
  p.stages.forEach((s, i) => {
    const reached = i <= t.stageIndex, cur = i === t.stageIndex;
    if (i) box.append(h('div', { class: 'bridge' + (reached ? ' filled' : '') }));
    const dot = onPick
      ? h('button', { class: 'dot', type: 'button', title: 'Move to ' + s.label, 'aria-label': 'Move to ' + s.label, onclick: () => onPick(cur ? p.stages[Math.max(i - 1, 0)].id : s.id) }, reached ? icon('check') : '')
      : h('div', { class: 'dot' }, reached ? icon('check') : '');
    box.append(h('div', { class: 'step' + (reached ? ' reached' : '') + (cur ? ' current' : '') }, dot, h('span', {}, s.label)));
  });
  return box;
}

async function ticketDialog(id, changed) {
  const j = await guarded(() => api('/tickets/' + id)); if (!j) return;
  const { ticket: t, events } = j; const p = (await pipelines()).find((x) => x.id === t.pipelineId);
  const move = async (stageId) => { if (await guarded(() => api(`/tickets/${id}/stage`, { method: 'POST', body: { stageId } }))) { close(); changed(); ticketDialog(id, changed); } };
  const comment = h('md-outlined-text-field', { label: 'Add a comment', type: 'textarea', rows: 2 });
  const line = (e) => e.type === 'comment' ? e.data.body : e.type === 'stage_changed' ? `Moved ${e.data.from} → ${e.data.to}` : e.type === 'created' ? 'Created' : 'Updated ' + Object.keys(e.data.changes || {}).join(', ');
  const body = h('div', { class: 'form' },
    h('div', { class: 'muted s' }, [t.priority !== 'normal' && t.priority, t.requester, t.dueAt && 'due ' + fmtDate(t.dueAt), 'created ' + ago(t.createdAt)].filter(Boolean).join(' · ')),
    p && tracker(t, p, move), t.description && h('p', {}, t.description),
    comment, h('div', {}, h('md-filled-tonal-button', { onclick: async () => { if (!comment.value.trim()) return; if (await guarded(() => api(`/tickets/${id}/comments`, { method: 'POST', body: { body: comment.value } }))) { close(); changed(); ticketDialog(id, changed); } } }, 'Comment')),
    h('div', { class: 'timeline' }, events.slice().reverse().map((e) => h('div', {}, h('div', { class: 't' }, line(e)), h('div', { class: 'muted' }, `${e.actor} · ${ago(e.at)}`)))));
  const { close } = dialog({ title: `#${t.id} ${t.title}`, fullscreen: true, dismissable: true, content: body, actions: [
    h('md-text-button', { class: 'danger', onclick: async () => { if (await confirmDialog('Delete this ticket?', t.title, 'Delete')) { if (await guarded(() => api('/tickets/' + id, { method: 'DELETE' }), 'Deleted')) { close(); changed(); } } } }, 'Delete'),
    h('md-filled-button', { onclick: () => close() }, 'Close')] });
}

function newDialog(changed) {
  const title = h('md-outlined-text-field', { label: 'Title' });
  const desc = h('md-outlined-text-field', { label: 'Details', type: 'textarea', rows: 3 });
  const prio = h('md-outlined-select', { label: 'Priority' }, ['low', 'normal', 'high', 'urgent'].map((x) => h('md-select-option', { value: x, selected: x === 'normal' }, h('div', { slot: 'headline' }, x))));
  const { close } = dialog({ title: 'New ticket', content: h('div', { class: 'form' }, title, desc, prio), actions: [
    h('md-text-button', { onclick: () => close() }, 'Cancel'),
    h('md-filled-button', { onclick: async () => { if (!title.value.trim()) { title.focus(); return; } if (await guarded(() => api('/tickets', { method: 'POST', body: { title: title.value, description: desc.value, priority: prio.value } }), 'Ticket created')) { close(); changed(); } } }, 'Create')] });
  setTimeout(() => title.focus(), 80);
}

export default async function tickets(view) {
  let st = 'open', q = '', data = [], loaded = false;
  const list = h('div', { class: 'list' });
  const search = h('md-outlined-text-field', { label: 'Filter', class: 'grow', 'data-primary': '' }, h('span', { slot: 'leading-icon' }, icon('search')));
  const seg = h('div', { class: 'seg', role: 'group' });
  const drawSeg = () => clear(seg).append(...[['open', 'Open'], ['closed', 'Closed'], ['all', 'All']].map(([v, l]) => h('button', { 'aria-pressed': String(v === st), onclick: () => { st = v; drawSeg(); load(); } }, l)));
  const draw = async () => {
    const ps = await pipelines().catch(() => []); const rows = data.filter((t) => !q || (t.title + ' ' + t.description + ' ' + t.requester).toLowerCase().includes(q));
    clear(list).append(...(rows.length ? rows.map((t) => { const p = ps.find((x) => x.id === t.pipelineId);
      const row = h('div', { class: 'row', onclick: () => ticketDialog(t.id, load) }, h('div', { class: 'lead k-ticket' }, icon('confirmation_number')),
        h('div', { class: 'grow' }, h('div', { class: 't' }, `#${t.id} ${t.title}`), p && tracker(t, p), h('div', { class: 's' }, t.priority !== 'normal' && chip(t.priority, t.priority === 'urgent' || t.priority === 'high' ? 'bad' : ''), chip(t.stageLabel, t.open ? '' : 'ok'), t.dueAt && h('span', { class: 'due' }, icon('schedule'), 'due ' + fmtDate(t.dueAt)), h('span', { class: 'muted' }, ago(t.updatedAt)))));
      return row; }) : [empty('confirmation_number', 'No tickets', q ? 'Nothing matches that filter.' : 'Create one with the New button.')]));
  };
  async function load() { if (!loaded) clear(list).append(spinner()); const r = await guarded(() => api('/tickets?status=' + st + '&limit=500')); if (!r) { if (!loaded) clear(list).append(loadFailed(load)); return; } loaded = true; data = r.tickets; draw(); }
  search.addEventListener('input', debounce(() => { q = search.value.toLowerCase(); draw(); }, 120));
  page.newAction = () => newDialog(load);
  drawSeg();
  clear(view).append(h('div', { class: 'page-head' }, h('h1', { class: 'display' }, 'Tickets'), h('p', { class: 'muted title-m' }, 'Track issues through their stages. The assistant creates and moves these too.')),
    h('div', { class: 'toolbar' }, seg, search), list, h('div', { class: 'fab-slot' }, fab('New', 'New ticket', () => newDialog(load))));
  await load(); const t = setInterval(() => !document.hidden && !document.querySelector('md-dialog, md-menu[open]') && load(), 30000); return () => clearInterval(t);
}
