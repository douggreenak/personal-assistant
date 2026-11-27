import { api } from '../api.js';
import { h, icon, clear, ago, empty, chip, guarded, toast, loadFailed, spinner } from '../ui.js';

export default async function approvals(view, { refreshStatus }) {
  let status = 'pending';
  const body = h('div', { class: 'grid cols-2' }); const seg = h('div', { class: 'seg' });
  const drawSeg = () => clear(seg).append(...[['pending', 'Waiting'], ['approved', 'Approved'], ['rejected', 'Rejected']].map(([v, l]) => h('button', { 'aria-pressed': String(v === status), onclick: () => { status = v; drawSeg(); load(); } }, l)));
  const note = h('div', { 'aria-live': 'polite' });
  // the result of each decision stays on the page (popups are off): green when it worked, red when it failed
  const showNote = (text, bad) => { clear(note).append(h('div', { class: 'card flat ' + (bad ? 'err-box' : 'ok-box'), style: 'display:flex;gap:10px;align-items:flex-start;overflow-wrap:anywhere' }, icon(bad ? 'error' : 'check'), h('span', { style: 'flex:1' }, text), h('md-icon-button', { 'aria-label': 'Dismiss', onclick: () => clear(note) }, icon('close')))); };
  async function decide(a, yes) { const r = await guarded(() => api(`/approvals/${a.id}/${yes ? 'approve' : 'reject'}`, { method: 'POST' })); if (r) showNote(r.result, /but it failed/.test(r.result)); await load(); refreshStatus(); }
  const keyed = (a, el) => { if (status === 'pending') { el.dataset.sel = ''; el._keys = { x: () => decide(a, true), y: () => decide(a, true), Delete: () => decide(a, false), Backspace: () => decide(a, false) }; } return el; };
  let loaded = false;
  async function load() {
    if (!loaded) clear(body).append(spinner());
    const r = await guarded(() => api('/approvals?status=' + status)); if (!r) { if (!loaded) clear(body).append(loadFailed(load)); return; } loaded = true; const { approvals: list } = r;
    clear(body).append(...(list.length ? list.map((a) => keyed(a, h('div', { class: 'card high' },
      h('div', { class: 's muted', style: 'display:flex;gap:8px;align-items:center' }, chip(a.kind === 'connector' ? 'connector' : 'action', a.kind === 'connector' ? 'warn' : ''), `#${a.id} · ${ago(a.createdAt)}`),
      h('div', { class: 'title-m' }, a.summary), h('div', { class: 'muted' }, 'Why I asked: ' + (a.reason || '—')),
      a.payload?.trigger ? h('div', { class: 'approval-from' }, h('div', { class: 's muted' }, 'The message that caused this' + (a.payload.trigger.sender ? ' (from ' + (a.payload.trigger.sender === 'me' ? 'you' : a.payload.trigger.sender) + ')' : '') + ':'), h('div', {}, a.payload.trigger.excerpt)) : null,
      h('details', {}, h('summary', {}, 'Details'), h('pre', { class: 'payload mono' }, JSON.stringify(a.payload, null, 2))),
      status === 'pending' ? h('div', { style: 'display:flex;gap:8px;justify-content:flex-end' }, h('md-text-button', { onclick: () => decide(a, false) }, 'Reject'), h('md-filled-button', { onclick: () => decide(a, true) }, icon('check'), 'Approve')) : chip(a.status, a.status === 'approved' ? 'ok' : 'bad'))))
      : [empty('task_alt', status === 'pending' ? 'Nothing needs your OK' : 'Nothing here', status === 'pending' ? 'I ask before touching money, other people\'s deadlines, anything outbound, or when unsure.' : '')]));
  }
  drawSeg();
  clear(view).append(h('div', { class: 'page-head' }, h('h1', { class: 'display' }, 'Approvals'), h('p', { class: 'muted title-m' }, 'Decisions the assistant won\'t make without you.')),
    h('div', { class: 'toolbar' }, seg, h('div', { class: 'grow' }), h('md-filled-tonal-button', { onclick: async () => { const { approvals: l } = await api('/approvals'); const out = []; for (const a of l) { const r = await api(`/approvals/${a.id}/approve`, { method: 'POST' }).catch((e) => ({ result: `#${a.id}: ${e.message} but it failed` })); out.push(r.result); } showNote(out.join('\n') || 'Nothing to approve.', out.some((t) => /but it failed/.test(t))); load(); refreshStatus(); } }, icon('done_all'), 'Approve all')), note, body);
  await load();
}
