import { api } from '../api.js';
import { h, icon, clear, ago, fmtDate, empty, chip, dialog, guarded, debounce, page, fab, loadFailed, spinner } from '../ui.js';

export default async function inbox(view, { refreshStatus }) {
  let filter = 'all', q = '';
  const list = h('div', { class: 'list' });
  const seg = h('div', { class: 'seg' });
  const drawSeg = () => clear(seg).append(...[['all', 'All'], ['pending', 'Waiting'], ['failed', 'Failing'], ['done', 'Processed']].map(([v, l]) => h('button', { 'aria-pressed': String(v === filter), onclick: () => { filter = v; drawSeg(); load(); } }, l)));
  const search = h('md-outlined-text-field', { label: 'Search messages', class: 'grow', 'data-primary': '' }, h('span', { slot: 'leading-icon' }, icon('search')));
  search.addEventListener('input', debounce(() => { q = search.value; load(); }, 300));
  let loaded = false;
  async function load() {
    if (!loaded) clear(list).append(spinner());
    const r = await guarded(() => api(`/messages?filter=${filter}&limit=150&q=${encodeURIComponent(q)}`)); if (!r) { if (!loaded) clear(list).append(loadFailed(load)); return; } loaded = true; const { messages } = r;
    clear(list).append(...(messages.length ? messages.map((m) => {
      const state = m.processedAt ? (m.error ? chip('skipped', 'warn') : chip('processed', 'ok')) : m.error ? chip(`failing · ${m.attempts} tries`, 'bad') : chip('waiting', 'warn');
      const skip = async () => { await guarded(() => api(`/messages/${m.id}/skip`, { method: 'POST' }), 'Skipped'); load(); refreshStatus(); };
      const again = async () => { await guarded(() => api(`/messages/${m.id}/retry`, { method: 'POST' }), 'Queued again'); setTimeout(load, 1500); refreshStatus(); };
      const rowEl = h('div', { class: 'row', onclick: (e) => { if (!e.target.closest('.acts')) detail(m); } }, h('div', { class: 'lead k-task' }, icon(m.source === 'voice' ? 'mic' : m.source.startsWith('connector') ? 'extension' : 'mail')),
        h('div', {}, h('div', { class: 't' }, m.subject || m.body.slice(0, 90)), h('div', { class: 's' }, chip(m.source), m.sender && h('span', {}, m.sender), h('span', {}, ago(m.receivedAt)), state), m.error && !m.processedAt && h('div', { class: 's', style: 'color:var(--md-sys-color-error)' }, m.error)),
        h('div', { class: 'acts' }, !m.processedAt && h('md-icon-button', { title: 'Skip', 'aria-label': 'Skip', onclick: async () => { await guarded(() => api(`/messages/${m.id}/skip`, { method: 'POST' }), 'Skipped'); load(); refreshStatus(); } }, icon('block')),
          (m.error || m.processedAt) && h('md-icon-button', { title: 'Process again', 'aria-label': 'Process again', onclick: async () => { await guarded(() => api(`/messages/${m.id}/retry`, { method: 'POST' }), 'Queued again'); setTimeout(load, 1500); refreshStatus(); } }, icon('restart_alt'))));
      rowEl.dataset.sel = ''; rowEl._keys = { Enter: () => detail(m), ...(!m.processedAt && { x: skip }), R: again };
      return rowEl;
    }) : [empty('inbox', 'Nothing here', 'Messages from texts, Gmail, Chat, voice and connectors show up as they arrive.')]));
  }
  function detail(m) { const { close } = dialog({ title: m.subject || `Message #${m.id}`, fullscreen: true, content: [h('div', { class: 's muted' }, `${m.source}${m.sender ? ' · ' + m.sender : ''} · ${fmtDate(m.receivedAt)}`), h('p', { style: 'white-space:pre-wrap;overflow-wrap:anywhere' }, m.body), m.error && h('p', { class: 'err' }, m.error)], actions: [h('md-text-button', { onclick: () => close() }, 'Close')] }); }
  function compose() {
    const body = h('md-outlined-text-field', { label: 'Message', type: 'textarea', rows: 5, 'supporting-text': 'Queued like any other message; the assistant will extract items from it.' }); const subj = h('md-outlined-text-field', { label: 'Subject (optional)' });
    const { close } = dialog({ title: 'Add to inbox', content: h('div', { class: 'form' }, subj, body), actions: [h('md-text-button', { onclick: () => close() }, 'Cancel'), h('md-filled-button', { onclick: async () => {
      if (!body.value.trim()) return; const ok = await guarded(() => api('/ingest/message', { method: 'POST', body: { source: 'web', sourceId: crypto.randomUUID(), sender: 'me', subject: subj.value, body: body.value } }), 'Queued'); if (ok) { close(); setTimeout(load, 800); } } }, 'Add')] });
  }
  drawSeg(); page.newAction = compose;
  clear(view).append(h('div', { class: 'page-head' }, h('h1', { class: 'display' }, 'Inbox'), h('p', { class: 'muted title-m' }, 'Everything the assistant has been sent, and what happened to it.')),
    h('div', { class: 'toolbar' }, seg, search), list, h('div', { class: 'fab-slot' }, fab('Add', 'Add message', compose)));
  await load(); const t = setInterval(() => !document.hidden && !document.querySelector('md-dialog') && load(), 15000); return () => clearInterval(t);
}
