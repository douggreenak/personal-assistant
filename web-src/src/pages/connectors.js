import { api } from '../api.js';
import { h, icon, clear, ago, empty, chip, dialog, confirmDialog, guarded, spinner, toast } from '../ui.js';

export default async function connectors(view, { refreshStatus }) {
  const list = h('div', { class: 'grid cols-2' });
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
    if (c.status === 'proposed') btns.push(h('md-filled-tonal-button', { onclick: () => { location.hash = '#/approvals'; } }, 'Review approval'));
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
  async function load() { const { connectors: cs } = (await guarded(() => api('/connectors/full'))) ?? { connectors: [] };
    clear(list).append(...(cs.length ? cs.map(card) : [empty('extension', 'No connectors yet', 'Paste an API\'s docs (or a docs URL) and I\'ll propose a read-only connector for you to approve.')])); }
  function add() {
    const t = h('md-outlined-text-field', { label: 'API docs text, or an https:// docs URL', type: 'textarea', rows: 8 }); const out = h('div', {});
    const go = h('md-filled-button', { onclick: async () => { if (!t.value.trim()) return; go.disabled = true; clear(out).append(spinner('Reading the docs')); const r = await guarded(() => api('/connectors/propose', { method: 'POST', body: { input: t.value } })); go.disabled = false; clear(out);
      if (r) { out.append(h('p', { style: 'white-space:pre-wrap;overflow-wrap:anywhere' }, r.result)); load(); refreshStatus(); } } }, icon('bolt'), 'Propose connector');
    const { close } = dialog({ title: 'Add a connector', fullscreen: true, content: [h('p', { class: 'muted' }, 'It can only read: one HTTPS GET endpoint, polled on a schedule. You approve the design, add the credential yourself, dry-run it, then enable it.'), t, out], actions: [h('md-text-button', { onclick: () => close() }, 'Close'), go] });
  }
  clear(view).append(h('div', { class: 'page-head' }, h('h1', { class: 'display' }, 'Connectors'), h('p', { class: 'muted title-m' }, 'Teach the assistant to read other services, safely.')), list, h('div', { class: 'fab-slot' }, h('md-fab', { label: 'Add', 'aria-label': 'Add connector', onclick: add }, h('span', { slot: 'icon' }, icon('add')))));
  await load();
}
