import { api, clearToken } from '../api.js';
import { h, icon, clear, chip, guarded, toast, dialog, confirmDialog } from '../ui.js';
import { PRESETS, prefs, applyTheme } from '../theme.js';
import { restartServer } from './system.js';

const GROUP_ICON = { General: 'tune', Brain: 'smart_toy', Ticketing: 'confirmation_number', Canopy: 'public', Google: 'mail', Notifications: 'notifications', 'Files & voice': 'folder', Access: 'key' };

export default async function settings(view) {
  const { settings: defs } = await api('/settings');
  const dirty = new Map(); const bar = h('div', {});
  const touch = (k, v) => { dirty.set(k, v); drawBar(); };
  function drawBar() {
    clear(bar); if (!dirty.size) return;
    bar.append(h('div', { class: 'savebar' }, h('span', {}, `${dirty.size} unsaved change${dirty.size === 1 ? '' : 's'}`), h('md-text-button', { onclick: () => { dirty.clear(); route(); } }, 'Discard'),
      h('md-filled-tonal-button', { onclick: save }, 'Save'), h('md-filled-button', { onclick: async () => { if (await save()) restartServer(); } }, 'Save & restart')));
  }
  async function save() { const ok = await guarded(() => api('/settings', { method: 'PUT', body: { values: Object.fromEntries(dirty) } }), 'Saved — restart to apply'); if (ok) { dirty.clear(); drawBar(); } return !!ok; }
  const route = () => settings(view);

  function control(d) {
    const hint = d.help ? h('div', { class: 'help' }, d.help) : null;
    if (d.type === 'bool') { const sw = h('md-switch', { selected: d.value === '1' || d.value === 'true' }); sw.addEventListener('change', () => touch(d.key, sw.selected ? '1' : '0')); return h('div', {}, h('div', { class: 'field-row' }, h('div', {}, h('div', { class: 't' }, d.label), hint), sw)); }
    if (d.type === 'secret') {
      const f = h('md-outlined-text-field', { label: d.label, type: 'password', placeholder: d.isSet ? '•••••••• (set — type to replace)' : 'not set', autocomplete: 'off' });
      f.addEventListener('input', () => touch(d.key, f.value));
      return h('div', {}, h('div', { style: 'display:flex;gap:8px;align-items:center' }, f, d.isSet && h('md-icon-button', { title: 'Clear', 'aria-label': 'Clear ' + d.label, onclick: () => { touch(d.key, '__clear__'); f.placeholder = 'will be cleared'; } }, icon('delete'))), hint);
    }
    const f = h('md-outlined-text-field', { label: d.label, value: d.value, placeholder: d.placeholder || '', type: d.type === 'number' ? 'number' : 'text', 'supporting-text': d.overridden ? 'Changed here (overrides .env)' : (!d.value && d.placeholder ? `Not set — default: ${d.placeholder}` : '') });
    f.addEventListener('input', () => touch(d.key, f.value)); return h('div', {}, f, hint);
  }
  const groups = [...new Set(defs.map((d) => d.group))];
  const cards = groups.map((g, i) => h('details', { class: 'card high', open: i === 0 }, h('summary', { class: 'title-m', style: 'display:flex;align-items:center;gap:10px' }, icon(GROUP_ICON[g] || 'tune'), g,
    g === 'Google' && h('span', { style: 'flex:1' })), h('div', { class: 'form', style: 'margin-top:14px' }, defs.filter((d) => d.group === g).map(control),
    g === 'Google' && h('div', {}, h('div', { class: 'label', style: 'margin-bottom:6px' }, 'Chat service-account key'), (() => { const inp = h('input', { type: 'file', accept: '.json,application/json', class: 'sr', onchange: async (e) => { const t = await e.target.files[0]?.text(); if (!t) return; const r = await guarded(() => api('/admin/service-account', { method: 'POST', raw: t }), 'Key uploaded — restart to apply'); if (r) route(); } }); return h('div', {}, inp, h('md-outlined-button', { onclick: () => inp.click() }, icon('upload'), 'Upload key file')); })()))));

  // appearance + security (browser-side and password)
  const seed = h('input', { type: 'color', value: prefs.seed, 'aria-label': 'Custom color', style: 'width:52px;height:52px;border:0;background:none;padding:0;cursor:pointer' });
  seed.addEventListener('input', () => { prefs.set('seed', seed.value); sw.forEach((b) => b.setAttribute('aria-pressed', 'false')); });
  const sw = PRESETS.map(([n, c]) => h('button', { class: 'swatch', title: n, 'aria-label': n, style: `background:${c}`, 'aria-pressed': String(prefs.seed.toLowerCase() === c.toLowerCase()), onclick: () => { prefs.set('seed', c); seed.value = c; sw.forEach((b) => b.setAttribute('aria-pressed', String(b === sw[PRESETS.findIndex((p) => p[1] === c)]))); } }));
  const modes = h('div', { class: 'seg' }); const drawModes = () => clear(modes).append(...[['auto', 'Auto'], ['light', 'Light'], ['dark', 'Dark']].map(([v, l]) => h('button', { 'aria-pressed': String(prefs.mode === v), onclick: () => { prefs.set('mode', v); drawModes(); } }, l))); drawModes();
  const appearance = h('div', { class: 'card high' }, h('h2', {}, icon('palette'), 'Appearance'), h('div', { class: 'label' }, 'Theme'), modes, h('div', { class: 'label' }, 'Color'), h('div', { class: 'swatches' }, sw, seed), h('div', { class: 'help' }, 'Saved in this browser. The whole palette is generated from one color.'));

  function pwDialog() {
    const cur = h('md-outlined-text-field', { label: 'Current password', type: 'password' }), n1 = h('md-outlined-text-field', { label: 'New password (8+ characters)', type: 'password' }), n2 = h('md-outlined-text-field', { label: 'Repeat new password', type: 'password' });
    const { close } = dialog({ title: 'Change password', content: h('div', { class: 'form' }, cur, n1, n2), actions: [h('md-text-button', { onclick: () => close() }, 'Cancel'), h('md-filled-button', { onclick: async () => {
      if (n1.value !== n2.value) return toast('The new passwords do not match.', { error: true });
      if (await guarded(() => api('/auth/password', { method: 'POST', body: { current: cur.value, new: n1.value } }), 'Password changed')) close(); } }, 'Change')] });
  }
  const security = h('div', { class: 'card high' }, h('h2', {}, icon('lock_reset'), 'Security'), h('p', { class: 'muted' }, 'The web password only protects this page. Scripts and devices use the access tokens in the Access section.'),
    h('div', { style: 'display:flex;gap:10px;flex-wrap:wrap' }, h('md-filled-tonal-button', { onclick: pwDialog }, icon('key'), 'Change password'), h('md-outlined-button', { onclick: () => { clearToken(); location.reload(); } }, icon('logout'), 'Sign out')));

  clear(view).append(h('div', { class: 'page-head' }, h('h1', { class: 'display' }, 'Settings'), h('p', { class: 'muted title-m' }, 'Everything that used to live in the .env file. Changes apply after a restart.')),
    h('div', { class: 'grid cols-2' }, appearance, security), h('div', { class: 'grid', style: 'margin-top:16px' }, cards), bar);
}
