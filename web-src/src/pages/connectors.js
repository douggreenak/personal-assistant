import { api } from '../api.js';
import { h, icon, clear, ago, empty, chip, dialog, confirmDialog, guarded, spinner, toast, page } from '../ui.js';

export default async function connectors(view, { refreshStatus }) {
  const list = h('div', { class: 'grid cols-2' });
  let pending = {};   // connector id -> pending approval id
  const run = async (fn, okMsg) => { const r = await guarded(fn, okMsg); load(); refreshStatus(); return r; };
  function secretDialog(c) {
    const v = h('md-outlined-text-field', { label: c.secretName, type: 'password', 'supporting-text': 'Stored on the server only; the model never sees it.' });
    const { close } = dialog({ title: `Credential for ${c.manifest.name}`, content: v, actions: [h('md-text-button', { onclick: () => close() }, 'Cancel'), h('md-filled-button', { onclick: async () => { if (!v.value) return; if (await run(() => api('/secrets/' + c.secretName, { method: 'PUT', body: { value: v.value } }), 'Saved')) close(); } }, 'Save')] });
  }
  async function showResult(title, text) { const { close } = dialog({ title, content: h('p', { style: 'white-space:pre-wrap;overflow-wrap:anywhere' }, text), actions: [h('md-filled-button', { onclick: () => close() }, 'OK')] }); }
  function card(c) {
    const m = c.manifest, needsKey = m.auth.type !== 'none';
    const steps = [['Proposed', true], ['Approved', c.status !== 'proposed'], ['Credential', !needsKey || c.secretSet], ['Tested', c.tested], ['Enabled', c.status === 'enabled']];
    const tone = c.status === 'enabled' ? 'ok' : c.lastError ? 'bad' : 'warn';
    const btns = [];
    if (c.status === 'proposed') {
      const aid = pending[c.id];
      if (aid) btns.push(h('md-text-button', { onclick: () => decide(aid, false) }, 'Reject'), h('md-filled-button', { onclick: () => decide(aid, true) }, icon('check'), 'Approve'));
      else btns.push(h('md-filled-tonal-button', { onclick: () => { location.hash = '#/approvals'; } }, 'Review approval'));
    }
    else {
      if (needsKey) btns.push(h('md-outlined-button', { onclick: () => secretDialog(c) }, icon('key'), c.secretSet ? 'Change key' : 'Set key'));
      btns.push(h('md-outlined-button', { onclick: async () => { const r = await run(() => api(`/connectors/${c.id}/test`, { method: 'POST' })); if (r) showResult('Dry run', r.result); } }, icon('play_arrow'), 'Test'));
      btns.push(c.status === 'enabled' ? h('md-filled-tonal-button', { onclick: () => run(() => api(`/connectors/${c.id}/disable`, { method: 'POST' }), 'Disabled') }, icon('block'), 'Disable')
        : h('md-filled-button', { onclick: async () => { const r = await run(() => api(`/connectors/${c.id}/enable`, { method: 'POST' })); if (r) toast(r.result.slice(0, 160)); } }, 'Enable'));
    }
    btns.push(h('md-icon-button', { 'aria-label': 'Delete', onclick: async () => { if (await confirmDialog('Delete connector?', `${m.name} will stop polling. Its past messages stay.`, 'Delete')) run(() => api('/connectors/' + c.id, { method: 'DELETE' }), 'Deleted'); } }, icon('delete')));
    return h('div', { class: 'card high' }, h('div', { style: 'display:flex;gap:14px;align-items:center' }, h('div', { class: 'lead k-task' }, icon('extension')), h('div', { style: 'flex:1;min-width:0' }, h('div', { class: 'title-m' }, m.name), h('div', { class: 'muted' }, m.description)), chip(c.status, tone)),
      h('div', { class: 'mono muted', style: 'overflow-wrap:anywhere' }, `GET ${m.baseUrl}${m.poll.path} · every ${m.poll.intervalMinutes} min`),
      h('div', { class: 'steps' }, steps.map(([l, on]) => h('span', { class: 'step' + (on ? ' on' : '') }, (on ? '✓ ' : '') + l))),
      c.lastRunAt && h('div', { class: 'muted' }, 'Last run ' + ago(c.lastRunAt)), c.lastError && h('div', { class: 'err' }, c.lastError),
      h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end;align-items:center' }, btns));
  }
  async function decide(id, ok) {
    const r = await guarded(() => api(`/approvals/${id}/${ok ? 'approve' : 'reject'}`, { method: 'POST' }));
    if (r) toast(ok ? 'Approved — now add the key, test it, then enable' : 'Rejected'); load(); refreshStatus(); return !!r;
  }
  async function load() {
    pending = Object.fromEntries(((await guarded(() => api('/approvals'))) ?? { approvals: [] }).approvals.filter((a) => a.kind === 'connector').map((a) => [a.payload.id, a.id])); const { connectors: cs } = (await guarded(() => api('/connectors/full'))) ?? { connectors: [] };
    clear(list).append(...(cs.length ? cs.map(card) : [empty('extension', 'No connectors yet', 'Paste an API\'s docs (or a docs URL) and I\'ll propose a read-only connector for you to approve.')])); }
  function add() {
    const t = h('md-outlined-text-field', { label: 'Paste the API docs, or a link to them', type: 'textarea', rows: 8, 'data-primary': '' });
    const key = h('md-outlined-text-field', { label: 'API key (leave empty if the service needs none)', type: 'password', autocomplete: 'off', 'supporting-text': 'Stored on the server only; the model never sees it.' });
    const log = h('div', { class: 'autolog', 'aria-live': 'polite' }), tail = h('div', { class: 'form' });
    const form = h('div', { class: 'form' }, h('p', { class: 'muted' }, 'Paste what the service’s docs say and, if it needs one, the key. I’ll design a read-only connector, try it against the real service, fix whatever goes wrong, and switch it on.'), t, key);
    let poll, cur = null;
    const go = h('md-filled-button', { onclick: start }, icon('bolt'), 'Connect');
    const stopPoll = () => clearInterval(poll);
    const draw = (j) => {
      clear(log).append(...j.steps.map((x, n) => h('div', { class: 'astep' + (/didn.t work|Could not|couldn.t|Stopped/.test(x) ? ' bad' : n === j.steps.length - 1 && j.state === 'running' ? ' now' : ' ok') }, h('span', { class: 'dot' }), x)));
      if (j.state === 'running') return;
      stopPoll(); clear(tail);
      if (j.state === 'needs_key') {
        const k2 = h('md-outlined-text-field', { label: j.secret, type: 'password', autocomplete: 'off' });
        const cont = h('md-filled-button', { onclick: async () => { if (!k2.value) return; cont.disabled = true; const r = await guarded(() => api(`/connectors/auto/${j.id}/key`, { method: 'POST', body: { apiKey: k2.value } })); if (r) { clear(tail); watch(j.id); } else cont.disabled = false; } }, 'Continue');
        tail.append(k2, h('div', {}, cont)); setTimeout(() => k2.focus(), 50);
      } else if (j.state === 'done') { tail.append(h('div', { class: 'ok-box' }, icon('check'), j.result), h('div', {}, h('md-filled-button', { onclick: () => close() }, 'Done'))); load(); refreshStatus(); }
      else { tail.append(h('div', { class: 'err' }, j.result), h('div', {}, h('md-filled-tonal-button', { onclick: reset }, 'Edit and try again'))); load(); }
    };
    const watch = (id) => { stopPoll(); const tick = async () => { try { draw((await api('/connectors/auto/' + id)).job); } catch { /* keep trying */ } }; tick(); poll = setInterval(tick, 700); };
    function reset() { stopPoll(); clear(log); clear(tail); form.hidden = false; go.disabled = false; go.hidden = false; t.focus(); }
    async function start() {
      if (!t.value.trim()) { t.focus(); return; }
      go.disabled = true; const r = await guarded(() => api('/connectors/auto', { method: 'POST', body: { input: t.value, apiKey: key.value || undefined } }));
      if (!r) { go.disabled = false; return; }
      key.value = ''; form.hidden = true; go.hidden = true; watch(r.job.id);
    }
    const { close } = dialog({ title: 'Add a connector', fullscreen: true, onClose: stopPoll, content: [form, log, tail], actions: [h('md-text-button', { onclick: () => close() }, 'Close'), go] });
  }
  page.newAction = add;
  clear(view).append(h('div', { class: 'page-head' }, h('h1', { class: 'display' }, 'Connectors'), h('p', { class: 'muted title-m' }, 'Teach the assistant to read other services, safely.')), list, h('div', { class: 'fab-slot' }, h('md-fab', { label: 'Add', 'aria-label': 'Add connector', onclick: add }, h('span', { slot: 'icon' }, icon('add')))));
  await load();
}
