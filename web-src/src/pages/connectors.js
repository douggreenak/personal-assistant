import { api } from '../api.js';
import { h, icon, clear, ago, empty, chip, dialog, confirmDialog, guarded, spinner, toast, page, fab } from '../ui.js';

let health = {};
export default async function connectors(view, { refreshStatus }) {
  const list = h('div', { class: 'masonry' });
  let pending = {};   // connector id -> pending approval id
  const run = async (fn, okMsg) => { const r = await guarded(fn, okMsg); load(); refreshStatus(); return r; };
  function secretDialog(c) {
    const v = h('md-outlined-text-field', { label: c.secretName, type: 'password', 'supporting-text': 'Stored on the server only; the model never sees it.' });
    const { close } = dialog({ title: `Credential for ${c.manifest.name}`, content: v, actions: [h('md-text-button', { onclick: () => close() }, 'Cancel'), h('md-filled-button', { onclick: async () => { if (!v.value) return; if (await run(() => api('/secrets/' + c.secretName, { method: 'PUT', body: { value: v.value } }), 'Saved')) close(); } }, 'Save')] });
  }
  function instructionsDialog(c) {
    const t = h('md-outlined-text-field', { label: `Instructions for ${c.manifest.name}`, type: 'textarea', rows: 9, maxlength: 4000, value: c.manifest.instructions || '', 'data-primary': '',
      'supporting-text': 'Plain sentences. Shown to the assistant every time it reads this service\'s messages, picks lookups, or answers about it.' });
    const ex = h('div', { class: 'help' }, 'Examples: “Ignore anything under 5 points.” · “Treat HW as homework and Quiz as a test; remind me the evening before.” · “When I ask about grades, show percentages and letters.” · “Amounts are in dollars; flag anything over 500.”');
    const save = async (text) => { const r = await guarded(() => api(`/connectors/${c.id}/instructions`, { method: 'PUT', body: { text } }), text.trim() ? 'Instructions saved' : 'Instructions cleared'); if (r) { close(); load(); } };
    const { close } = dialog({ title: 'Instructions', content: h('div', { class: 'form' }, h('p', { class: 'muted' }, 'Your own standing instructions for this connector — like a system prompt that applies only to it. They cannot override the approval rules: writes still ask first.'), t, ex),
      actions: [h('md-text-button', { onclick: () => close() }, 'Cancel'), c.manifest.instructions ? h('md-text-button', { onclick: () => save('') }, 'Clear') : '', h('md-filled-button', { onclick: () => save(t.value) }, 'Save')] });
  }
  async function showResult(title, text) { const { close } = dialog({ title, content: h('p', { style: 'white-space:pre-wrap;overflow-wrap:anywhere' }, text), actions: [h('md-filled-button', { onclick: () => close() }, 'OK')] }); }
  function card(c) {
    const m = c.manifest, needsKey = m.auth.type !== 'none';
    const steps = [['Proposed', true], ['Approved', c.status !== 'proposed'], ['Credential', !needsKey || c.secretSet], ['Tested', c.tested], ['Enabled', c.status === 'enabled']];
    const caps = [m.mcp && chip('MCP', ''), m.poll && chip('reads', ''), (m.reads?.length || (m.mcp && m.actions?.some((a) => a.readOnly))) && chip('live lookups', ''), m.actions?.length && !m.mcp && chip('writes', 'warn'), m.instructions && chip('instructions', '')];
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
    btns.push(h('md-outlined-button', { onclick: () => instructionsDialog(c) }, icon('edit'), m.instructions ? 'Edit instructions' : 'Instructions'));
    btns.push(h('md-icon-button', { 'aria-label': 'Delete', onclick: async () => { if (await confirmDialog('Delete connector?', `${m.name} will stop polling. Its past messages stay.`, 'Delete')) run(() => api('/connectors/' + c.id, { method: 'DELETE' }), 'Deleted'); } }, icon('delete')));
    return h('div', { class: 'card high' }, h('div', { style: 'display:flex;gap:10px 14px;align-items:center;flex-wrap:wrap' }, h('div', { class: 'lead k-task' }, icon('extension')), h('div', { style: 'flex:1 1 180px;min-width:0;overflow-wrap:anywhere' }, h('div', { class: 'title-m', style: 'display:flex;gap:8px;align-items:center' }, c.status === 'enabled' && health[c.id] ? h('span', { class: 'dot ' + (health[c.id].ok === false ? 'bad' : 'ok'), role: 'img', 'aria-label': health[c.id].ok === false ? 'Not answering' : 'Connected', title: health[c.id].detail }) : '', m.name), h('div', { class: 'muted' }, m.description)), h('div', { style: 'display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end;margin-left:auto' }, caps, chip(c.status, tone))),
      h('div', { class: 'mono muted', style: 'overflow-wrap:anywhere' }, m.mcp ? `MCP server · ${m.mcp.url}` : m.poll ? `Reads: GET ${m.baseUrl}${m.poll.path} · every ${m.poll.intervalMinutes} min` : `Writes only · ${m.baseUrl}`),
      m.actions?.length ? h('details', { class: 'acts-list' }, h('summary', {}, m.mcp ? `${m.actions.length} MCP tool${m.actions.length === 1 ? '' : 's'} — each call asks you first` : `Can do ${m.actions.length} write action${m.actions.length === 1 ? '' : 's'} — asks you first`),
        m.actions.map((a) => h('div', { class: 'actrow' },
          h('div', {}, h('div', { class: 'title-s' }, a.name, ' ', h('span', { class: 'mono muted' }, a.tool ? (a.readOnly ? 'read-only' : a.method === 'DELETE' ? 'may change things' : 'tool') : `${a.method} ${a.path}`)), h('div', { class: 'muted s' }, a.description)),
          a.method === 'DELETE' ? h('span', { class: 'muted s' }, 'always asks') : h('label', { class: 's muted', style: 'display:flex;gap:8px;align-items:center' }, 'no need to ask',
            h('md-switch', { 'aria-label': 'Allow ' + a.name + ' without asking', selected: c.autoActions?.includes(a.id) || undefined, onchange: async (e) => {
              const allow = e.target.selected; const ok = await guarded(() => api(`/connectors/${c.id}/actions/${a.id}/auto`, { method: 'POST', body: { allow } }), allow ? `${a.name} will run without asking (only for things you tell me yourself)` : `${a.name} will ask first`); if (!ok) e.target.selected = !allow; } }))))) : null,
      h('div', { class: 'steps' }, steps.map(([l, on]) => h('span', { class: 'step' + (on ? ' on' : '') }, (on ? '✓ ' : '') + l))),
      c.lastRunAt && h('div', { class: 'muted' }, 'Last run ' + ago(c.lastRunAt)), c.lastError && h('div', { class: 'err' }, c.lastError),
      h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end;align-items:center' }, btns));
  }
  async function decide(id, ok) {
    const r = await guarded(() => api(`/approvals/${id}/${ok ? 'approve' : 'reject'}`, { method: 'POST' }));
    if (r) toast(ok ? 'Approved — now add the key, test it, then enable' : 'Rejected'); load(); refreshStatus(); return !!r;
  }
  let loaded = false;
  async function load() {
    if (!loaded) clear(list).append(spinner());
    health = Object.fromEntries((((await api('/status/integrations').catch(() => null)) ?? { integrations: [] }).integrations).map((i) => [i.id, i]));
    pending = Object.fromEntries(((await guarded(() => api('/approvals'))) ?? { approvals: [] }).approvals.filter((a) => a.kind === 'connector').map((a) => [a.payload.id, a.id])); const { connectors: cs } = (await guarded(() => api('/connectors/full'))) ?? { connectors: [] };
    loaded = true; clear(list).append(...(cs.length ? cs.map(card) : [empty('extension', 'No connectors yet', 'Paste a service\'s docs and key, or an MCP server\'s URL, and I\'ll connect it for you.')])); }
  function add() {
    const t = h('md-outlined-text-field', { label: 'Paste everything — docs, example requests, your key', type: 'textarea', rows: 8, 'data-primary': '' });
    const key = h('md-outlined-text-field', { label: 'API key (optional — I also find keys inside the paste)', type: 'password', autocomplete: 'off', 'supporting-text': 'Keys are stored on the server only; the model never sees them.' });
    const label = h('md-outlined-text-field', { label: 'Name (optional)', maxlength: 80, 'supporting-text': 'Already connected to this service? Add it again for another account — give it a name to tell them apart.' });
    const log = h('div', { class: 'autolog', 'aria-live': 'polite' }), tail = h('div', { class: 'form' });
    const form = h('div', { class: 'form' }, h('p', { class: 'muted' }, 'Paste whatever the service gave you — docs, a curl example, the key, all in one go. For an MCP server, paste its URL (or its config / the claude mcp add line) and I’ll list its tools. I’ll pull the key out and keep it on the server, work out how the service logs in, build the connector (it can read, write, or both — every write asks you first), try it for real, fix whatever goes wrong, and switch it on.'), t, key, label);
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
      go.disabled = true; const r = await guarded(() => api('/connectors/auto', { method: 'POST', body: { input: t.value, apiKey: key.value || undefined, label: label.value.trim() || undefined } }));
      if (!r) { go.disabled = false; return; }
      key.value = ''; form.hidden = true; go.hidden = true; watch(r.job.id);
    }
    const { close } = dialog({ title: 'Add a connector', fullscreen: true, onClose: stopPoll, content: [form, log, tail], actions: [h('md-text-button', { onclick: () => close() }, 'Close'), go] });
  }
  page.newAction = add;
  clear(view).append(h('div', { class: 'page-head' }, h('h1', { class: 'display' }, 'Connectors'), h('p', { class: 'muted title-m' }, 'Connect other services so the assistant can read from them and, with your OK, act in them.')), list, h('div', { class: 'fab-slot' }, fab('Add', 'Add connector', add)));
  await load();
}
