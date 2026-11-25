import { api, clearToken, getToken } from '../api.js';
import { h, icon, clear, chip, guarded, toast, dialog, confirmDialog, page, fmtDate } from '../ui.js';
import { PRESETS, prefs, applyTheme } from '../theme.js';
import { restartServer } from './system.js';

const GROUP_ICON = { General: 'tune', Brain: 'smart_toy', Ticketing: 'confirmation_number', Canopy: 'public', Google: 'mail', Notifications: 'notifications', 'Files & voice': 'folder', Access: 'key', Backup: 'inventory_2' };

export default async function settings(view) {
  const { settings: defs } = await api('/settings');
  const dirty = new Map(); const bar = h('div', {});
  page.guard = () => dirty.size > 0;
  const touch = (k, v) => { dirty.set(k, v); drawBar(); };
  function drawBar() {
    clear(bar); if (!dirty.size) return;
    bar.append(h('div', { class: 'savebar' }, h('span', {}, `${dirty.size} unsaved change${dirty.size === 1 ? '' : 's'}`), h('md-text-button', { onclick: () => { dirty.clear(); route(); } }, 'Discard'),
      h('md-filled-tonal-button', { onclick: save }, 'Save'), h('md-filled-button', { onclick: async () => { if (await save()) restartServer(); } }, 'Save & restart')));
  }
  async function save() { const ok = await guarded(() => api('/settings', { method: 'PUT', body: { values: Object.fromEntries(dirty) } }), 'Saved — restart to apply'); if (ok) { dirty.clear(); drawBar(); } return !!ok; }
  const route = () => settings(view);

  function control(d) { const el = control0(d); el.dataset.q = `${d.label} ${d.key} ${d.help || ''} ${d.group}`.toLowerCase(); return el; }
  function control0(d) {
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
  const filter = h('md-outlined-text-field', { label: 'Filter settings', 'data-primary': '' }, h('span', { slot: 'leading-icon' }, icon('search')));
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

  const keep = h('md-switch', { selected: true, 'aria-label': 'Include keys and passwords' });
  async function exportBackup(btn) {
    btn.disabled = true;
    try {
      const r = await fetch('/backup/export?secrets=' + (keep.selected ? '1' : '0'), { headers: { authorization: 'Bearer ' + getToken() } });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
      const blob = await r.blob(); const name = /filename="([^"]+)"/.exec(r.headers.get('content-disposition') || '')?.[1] || 'assistant.backup';
      const a = h('a', { href: URL.createObjectURL(blob), download: name }); document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      toast('Backup downloaded: ' + name);
    } catch (e) { toast('Backup failed: ' + e.message, { error: true }); } finally { btn.disabled = false; }
  }
  const pick = h('input', { type: 'file', accept: '.backup,application/octet-stream', hidden: true, 'aria-label': 'Choose a backup file' });
  pick.addEventListener('change', async () => {
    const f = pick.files[0]; pick.value = ''; if (!f) return;
    if (!(await confirmDialog('Replace everything with this backup?', `“${f.name}” (${(f.size / 1048576).toFixed(1)} MB) will replace ALL current messages, items, approvals, connectors, pictures and settings. A safety copy of what is here now is saved first.`, 'Restore'))) return;
    const r = await guarded(() => api('/backup/import', { method: 'POST', raw: f }));
    if (!r) return;
    const c = r.counts || {};
    const { close } = dialog({ title: 'Backup restored', content: h('div', { class: 'form' }, h('p', {}, `From ${r.createdAt ? new Date(r.createdAt).toLocaleString() : 'the file'}: ${c.items ?? 0} items, ${c.messages ?? 0} messages, ${c.connectors ?? 0} connectors, ${c.approvals ?? 0} approvals, ${c.attachments ?? 0} pictures.`),
      h('p', { class: 'muted' }, 'A safety copy of the previous data was saved in the data folder (backups/). ' + (r.restartNeeded ? 'Restart so the restored settings take effect.' : '')), r.includesSecrets ? h('p', { class: 'muted' }, 'Keys and the web password came from the backup — sign in with the password it had.') : ''),
      actions: [h('md-text-button', { onclick: () => { close(); location.reload(); } }, 'Close'), r.restartNeeded ? h('md-filled-button', { onclick: () => { close(); restartServer(); } }, 'Restart now') : ''] });
  });
  const saved = h('div', { class: 'list' }); const status = h('p', { class: 'muted' });
  const kb = (n) => (n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');
  async function downloadSaved(name) {
    try {
      const r = await fetch('/backup/file/' + encodeURIComponent(name), { headers: { authorization: 'Bearer ' + getToken() } }); if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
      const a = h('a', { href: URL.createObjectURL(await r.blob()), download: name }); document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    } catch (e) { toast('Download failed: ' + e.message, { error: true }); }
  }
  async function loadSaved() {
    try {
      const j = await api('/backup/list');
      status.textContent = (j.auto ? `Nightly backup is on: every day after ${String(j.hour).padStart(2, '0')}:00, keeping the last ${j.keep}. ` : 'Nightly backup is off (turn it on in the Backup settings below). ')
        + (j.last ? (j.last.ok ? `Last one: ${fmtDate(j.last.at)}.` : `The last attempt failed: ${j.last.error}`) : 'None made yet.');
      clear(saved).append(...(j.backups.length ? j.backups.slice(0, 8).map((b) => h('div', { class: 'row static', style: 'grid-template-columns:1fr auto' }, h('div', {}, h('div', { class: 't' }, b.name), h('div', { class: 's' }, `${b.kind === 'before-restore' ? 'safety copy before a restore' : b.kind} · ${fmtDate(b.at)} · ${kb(b.size)}`)), h('md-text-button', { onclick: () => downloadSaved(b.name) }, icon('download'), 'Download'))) : [h('div', { class: 'muted' }, 'Nothing saved on the server yet.')]));
    } catch { /* the page still works without the list */ }
  }
  const backup = h('div', { class: 'card high' }, h('h2', {}, icon('inventory_2'), 'Backup'), h('p', { class: 'muted' }, 'One file with everything: messages, items, approvals, connectors, pictures and settings. Restore it here or on a new install.'),
    h('div', { class: 'field-row' }, h('div', {}, h('div', { class: 't' }, 'Include keys and passwords'), h('div', { class: 'help' }, 'API keys, the web password and the Google service account. Keep such a file private. Leave this off to share a copy safely; restoring it then keeps this machine’s own keys.')), keep),
    h('div', { style: 'display:flex;gap:10px;flex-wrap:wrap;margin-top:10px' }, h('md-filled-tonal-button', { onclick: (e) => exportBackup(e.currentTarget) }, icon('download'), 'Download backup'), h('md-outlined-button', { onclick: () => pick.click() }, icon('upload'), 'Restore from a file…'), h('md-outlined-button', { onclick: async () => { const r = await guarded(() => api('/backup/run', { method: 'POST' }), 'Saved on the server'); if (r) loadSaved(); } }, icon('inventory_2'), 'Back up now (on the server)'), pick),
    h('h3', { class: 'label', style: 'margin-top:16px' }, 'Saved on the server'), status, saved);
  loadSaved();

  clear(view).append(h('div', { class: 'page-head' }, h('h1', { class: 'display' }, 'Settings'), h('p', { class: 'muted title-m' }, 'Everything that used to live in the .env file. Changes apply after a restart.')),
    h('div', { class: 'grid cols-2' }, appearance, security), backup, filter, h('div', { class: 'grid' }, cards), bar);
  const groupOf = new Map(cards.map((c) => [c, [...c.querySelectorAll('[data-q]')]]));
  filter.addEventListener('input', () => {
    const q = filter.value.trim().toLowerCase();
    for (const [card, fields] of groupOf) {
      let any = false; for (const f of fields) { const hit = !q || f.dataset.q.includes(q); f.hidden = !hit; any ||= hit; }
      card.hidden = !!q && !any; if (q && any) card.open = true;
    }
  });
}
