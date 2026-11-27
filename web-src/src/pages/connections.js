import { api } from '../api.js';
import { h, icon, clear, chip, dialog, guarded, toast, spinner } from '../ui.js';
import { helpChat } from './helpchat.js';
import { settingControl } from './settingControl.js';

const restart = async (skipConfirm) => (await import('./system.js')).restartServer(skipConfirm);

/** Guided setup for one service: what it is, where to go, what to do, and a box to paste what you got. */
export async function setupDialog(integ, done) {
  const { guides } = await guarded(() => api('/integrations/guides')) ?? {}; const g = guides?.find((x) => x.id === integ.id); if (!g) { toast('No setup guide for ' + integ.name + '.', { error: true }); return; }
  const box = h('md-outlined-text-field', { label: 'Paste the information here', type: 'textarea', rows: 7, 'data-primary': '', 'supporting-text': 'One value per line, like “' + g.fields[0].label + ': …”. Values are recognised by their label or by what they look like.' });
  const result = h('div', {});
  const content = h('div', { class: 'setup-guide' }, h('div', { class: 'form sg-info' }, h('p', { class: 'muted' }, g.summary),
    integ.configured && integ.ok === false ? h('div', { class: 'card flat', style: 'border-left:4px solid var(--md-sys-color-error)' }, h('b', {}, 'What is wrong'), h('p', {}, integ.detail || 'It is set up but not working.'), h('p', { class: 'muted' }, 'Re-paste the missing values below (or ask the helper) and save.')) : '',
    g.links?.length ? h('div', { class: 'setup-links' }, h('h3', { class: 'title-m' }, 'Go here'), ...g.links.map((l) => h('a', { class: 'setup-link', href: l.url, target: '_blank', rel: 'noopener noreferrer' }, icon('open_in_new'), l.label))) : '',
    h('h3', { class: 'title-m' }, 'What to do'), h('ol', { class: 'setup-steps' }, g.steps.map((t) => h('li', {}, t))),
    h('h3', { class: 'title-m' }, 'What I need from you'), h('ul', { class: 'setup-fields' }, g.fields.map((f) => h('li', {}, h('b', {}, f.label), f.optional ? h('span', { class: 'muted' }, ' (optional)') : '', h('span', { class: 'muted' }, ' — ' + f.hint)))),
    ), h('div', { class: 'form sg-act' }, box, result, helpChat(g.id)));
  const save = h('md-filled-button', { onclick: async () => {
    const r = await guarded(() => api(`/integrations/${g.id}/setup`, { method: 'POST', body: { text: box.value } })); if (!r) return;
    save.hidden = true; box.hidden = true;
    clear(result).append(h('div', { class: 'card flat' }, h('b', {}, 'Saved: ' + r.saved.join(', ')), r.missing.length ? h('p', { class: 'muted' }, 'Still needed: ' + r.missing.join(', ') + '. Open this again and paste the rest.') : '', r.ignored.length ? h('p', { class: 'muted' }, 'I did not recognise: ' + r.ignored.join(' · ')) : '', h('p', { class: 'muted' }, 'Restart the assistant for it to start using this.'), h('md-filled-tonal-button', { onclick: () => { close(); restartServer(); } }, icon('restart_alt'), 'Restart now')));
    done?.(); } }, 'Save');
  const { close } = dialog({ title: 'Set up ' + g.name, fullscreen: true, content, actions: [h('md-text-button', { onclick: () => close() }, 'Close'), save] });
}

/** Signing in to your Google account without a terminal (Gmail, Drive and Chat reading). */
export function connectGoogleDialog() {
  const pasted = h('md-outlined-text-field', { label: 'The address the browser ended up on', type: 'textarea', rows: 3, placeholder: 'http://localhost:1/?code=4/0A…', 'data-primary': '' });
  const err = h('div', { class: 'err-box', hidden: true }); const link = h('md-filled-tonal-button', { target: '_blank', disabled: true }, icon('open_in_new'), 'Open Google and approve');
  let url = ''; api('/google/connect/url', { method: 'POST' }).then((r) => { url = r.url; link.href = url; link.disabled = false; }).catch((e) => { err.hidden = false; err.textContent = e.message; });
  const { close } = dialog({ title: 'Connect your Google account', content: h('div', { class: 'form' },
    h('p', {}, h('b', {}, '1. '), 'Open the Google page and approve access to Gmail, Drive and Chat (read only).'), h('div', {}, link),
    h('p', {}, h('b', {}, '2. '), 'Your browser then lands on a page that fails to load (localhost). That is expected. Copy the whole address from the address bar.'),
    h('p', {}, h('b', {}, '3. '), 'Paste it here:'), pasted, err,
    h('p', { class: 'muted s' }, 'Needs an OAuth client of type “Desktop app”. The token is stored on the server like your other secrets.')),
    actions: [h('md-text-button', { onclick: () => close() }, 'Cancel'), h('md-filled-button', { onclick: async () => {
      err.hidden = true; const ok = await (async () => { try { return await api('/google/connect/finish', { method: 'POST', body: { pasted: pasted.value } }); } catch (e) { err.hidden = false; err.textContent = e.message; return null; } })();
      if (!ok) return; close(); toast('Google connected — restarting so Gmail can start'); setTimeout(() => restart(true), 600); } }, 'Connect')] });
}

/** The built-in connections: everything about reaching an outside service lives here, not in Settings. */
const CONNECTIONS = [
  { id: 'google', name: 'Your Google account', ic: 'mail', what: 'Sign in once so the assistant can read your Gmail, Drive and Chat.' },
  { id: 'gmail', name: 'Gmail', ic: 'mail', what: 'Reads your mail so it can find things to track.' },
  { id: 'chat', name: 'Google Chat bot', ic: 'chat', what: 'Lets you message the assistant from Google Chat.' },
  { id: 'drive', name: 'Google Drive index', ic: 'folder', what: 'Indexes chosen Drive folders so questions can use them.' },
  { id: 'canopy', name: 'Canopy', ic: 'public', what: 'Your school planner: classes, assignments and grades.' },
  { id: 'whisper', name: 'Speech-to-text', ic: 'mic', what: 'Turns voice notes into text.' },
  { id: 'ntfy', name: 'Phone push (ntfy)', ic: 'notifications', what: 'Sends reminders and nags to your phone.' },
  { id: 'files', name: 'File index', ic: 'folder', what: 'Indexes folders on the server so you can ask questions about them.' },
  { id: 'github', name: 'Mac app downloads', ic: 'download', what: 'Where the Mac app is downloaded from.' },
];

/** Edit all the settings of one connection in a dialog. */
async function editDialog(conn, done) {
  const { settings: defs } = await guarded(() => api('/settings')) ?? {}; if (!defs) return;
  const mine = defs.filter((d) => d.connection === conn.id); const dirty = new Map(); const touch = (k, v) => dirty.set(k, v);
  const extras = [];
  if (conn.id === 'google') {
    const tokenSet = !!mine.find((d) => d.key === 'GOOGLE_REFRESH_TOKEN')?.isSet; const idSet = !!mine.find((d) => d.key === 'GOOGLE_CLIENT_ID')?.value && !!mine.find((d) => d.key === 'GOOGLE_CLIENT_SECRET')?.isSet;
    extras.push(h('div', { class: 'card flat' }, h('div', { class: 't' }, tokenSet ? 'Connected' : 'Not connected yet'), h('p', { class: 'muted' }, tokenSet ? 'Gmail, Drive and Chat reading use this account.' : 'Save the OAuth client ID and secret below first, then connect.'),
      h('md-filled-tonal-button', { disabled: !idSet || undefined, onclick: () => { close(); connectGoogleDialog(); } }, icon('link'), tokenSet ? 'Connect again' : 'Connect Google account')));
  }
  if (conn.id === 'chat') {
    const inp = h('input', { type: 'file', accept: '.json,application/json', class: 'sr', onchange: async (e) => { const t = await e.target.files[0]?.text(); if (!t) return; const r = await guarded(() => api('/admin/service-account', { method: 'POST', raw: t }), 'Key uploaded. Restart to apply.'); if (r) { close(); done?.(); } } });
    extras.push(h('div', {}, h('div', { class: 'label', style: 'margin-bottom:6px' }, 'Service-account key file'), inp, h('md-outlined-button', { onclick: () => inp.click() }, icon('upload'), 'Upload key file')));
  }
  const save = async () => { if (!dirty.size) { close(); return true; } const ok = await guarded(() => api('/settings', { method: 'PUT', body: { values: Object.fromEntries(dirty) } }), 'Saved. Restart to apply.'); if (ok) { close(); done?.(); } return !!ok; };
  const { close } = dialog({ title: conn.name, content: h('div', { class: 'form' }, h('p', { class: 'muted' }, conn.what), ...extras, ...mine.map((d) => settingControl(d, touch)), h('p', { class: 'muted s' }, 'Changes apply after a restart.')),
    actions: [h('md-text-button', { onclick: () => close() }, 'Cancel'), h('md-filled-tonal-button', { onclick: save }, 'Save'), h('md-filled-button', { onclick: async () => { if (await save()) restart(); } }, 'Save & restart')] });
}

/** The card of built-in connections for the top of the Connect page. */
export function builtInCard() {
  const list = h('div', { class: 'list' }, spinner());
  const card = h('div', { class: 'card high' }, h('h2', {}, icon('dns'), 'Built-in connections'), h('p', { class: 'muted' }, 'Services the assistant already knows how to use. Set one up here; there are no connection settings anywhere else.'), list);
  async function load() {
    const [integ, st, guides] = await Promise.all([api('/status/integrations').catch(() => ({ integrations: [] })), api('/settings').catch(() => ({ settings: [] })), api('/integrations/guides').catch(() => ({ guides: [] }))]);
    const by = Object.fromEntries(integ.integrations.map((i) => [i.id, i])); const guide = new Set(guides.guides.map((g) => g.id));
    const val = (k) => st.settings.find((d) => d.key === k);
    clear(list).append(...CONNECTIONS.map((c) => {
      let state, detail;
      if (c.id === 'google') { const on = !!val('GOOGLE_REFRESH_TOKEN')?.isSet; state = on ? 'on' : 'off'; detail = on ? 'Connected' : 'Not connected'; }
      else if (c.id === 'github') { state = 'on'; detail = val('GITHUB_REPO')?.value || 'Default'; }
      else { const i = by[c.id]; state = !i || !i.configured ? 'off' : i.ok === false ? 'bad' : 'on'; detail = !i || !i.configured ? 'Not set up' : i.detail; }
      return h('div', { class: 'row static', style: 'grid-template-columns:auto 1fr auto;align-items:center', 'data-conn': c.id },
        h('span', { class: 'dot ' + (state === 'off' ? '' : state === 'bad' ? 'bad' : 'ok') }),
        h('div', {}, h('div', { class: 't' }, c.name), h('div', { class: 's' }, detail)),
        h('div', { style: 'display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end' },
          guide.has(c.id) && state !== 'on' ? h('md-filled-tonal-button', { onclick: () => setupDialog(by[c.id] || { id: c.id, name: c.name, configured: false }, load) }, 'Guided setup') : '',
          h('md-outlined-button', { onclick: () => editDialog(c, load) }, icon('edit'), state === 'off' ? 'Set up' : 'Edit')));
    }));
  }
  load();
  return card;
}
