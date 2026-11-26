import { api, getToken } from '../api.js';
import { h, icon, clear, ago, fmtDate, empty, chip, confirmDialog, dialog, guarded, toast, spinner, copyText } from '../ui.js';

const dur = (s) => (s < 3600 ? `${Math.round(s / 60)} min` : s < 86400 ? `${(s / 3600).toFixed(1)} h` : `${(s / 86400).toFixed(1)} days`);

export async function restartServer() {
  if (!(await confirmDialog('Restart the assistant?', 'It restarts in a few seconds. Open requests are interrupted; nothing is lost.', 'Restart'))) return;
  await guarded(() => api('/admin/restart', { method: 'POST' }));
  toast('Restarting…');
  for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 1500)); try { if ((await fetch('/healthz')).ok && i > 1) { toast('Back online'); setTimeout(() => location.reload(), 600); return; } } catch { /* still down */ } }
}

/** Click a connection that is not set up: where to go, what to do, and a box to paste what it asks for. */
async function setupDialog(integ, done) {
  const { guides } = await guarded(() => api('/integrations/guides')) ?? {}; const g = guides?.find((x) => x.id === integ.id); if (!g) return;
  const box = h('md-outlined-text-field', { label: 'Paste the information here', type: 'textarea', rows: 7, 'data-primary': '', 'supporting-text': 'One value per line, like “' + g.fields[0].label + ': …”. Values are recognised by their label or by what they look like.' });
  const result = h('div', {});
  const content = h('div', { class: 'form setup-guide' }, h('p', { class: 'muted' }, g.summary),
    g.links?.length ? h('div', { class: 'setup-links' }, h('h3', { class: 'title-m' }, 'Go here'), ...g.links.map((l) => h('a', { class: 'setup-link', href: l.url, target: '_blank', rel: 'noopener noreferrer' }, icon('open_in_new'), l.label))) : '',
    h('h3', { class: 'title-m' }, 'What to do'), h('ol', { class: 'setup-steps' }, g.steps.map((t) => h('li', {}, t))),
    h('h3', { class: 'title-m' }, 'What I need from you'), h('ul', { class: 'setup-fields' }, g.fields.map((f) => h('li', {}, h('b', {}, f.label), f.optional ? h('span', { class: 'muted' }, ' (optional)') : '', h('span', { class: 'muted' }, ' — ' + f.hint)))),
    box, result);
  const save = h('md-filled-button', { onclick: async () => {
    const r = await guarded(() => api(`/integrations/${g.id}/setup`, { method: 'POST', body: { text: box.value } })); if (!r) return;
    save.hidden = true; box.hidden = true;
    clear(result).append(h('div', { class: 'card flat' }, h('b', {}, 'Saved: ' + r.saved.join(', ')), r.missing.length ? h('p', { class: 'muted' }, 'Still needed: ' + r.missing.join(', ') + '. Open this again and paste the rest.') : '', r.ignored.length ? h('p', { class: 'muted' }, 'I did not recognise: ' + r.ignored.join(' · ')) : '', h('p', { class: 'muted' }, 'Restart the assistant for it to start using this.'), h('md-filled-tonal-button', { onclick: () => { close(); restartServer(); } }, icon('restart_alt'), 'Restart now')));
    done?.(); } }, 'Save');
  const { close } = dialog({ title: 'Set up ' + g.name, content, actions: [h('md-text-button', { onclick: () => close() }, 'Close'), save] });
}

const size = (b) => (b > 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.round(b / 1e3) + ' KB');

/** Fetches the zip through the server (which asks GitHub for the newest release) and hands it to the browser as a file. */
async function downloadMacApp(btn, rel) {
  btn.disabled = true;
  try {
    const r = await fetch('/app/mac/download', { headers: { authorization: 'Bearer ' + getToken() } });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
    const url = URL.createObjectURL(await r.blob());
    const a = h('a', { href: url, download: rel.assetName || 'Assistant-Mac.zip' }); document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    toast('Downloaded — unzip it and move Assistant.app to Applications');
  } catch (e) { toast(e.message, { error: true }); } finally { btn.disabled = false; }
}

/** Everything the Mac app needs to connect: this server's address and the token this browser is signed in with. */
const macConfig = () => 'assistant-config:' + btoa(JSON.stringify({ v: 1, url: location.origin, token: getToken() }));
async function copyMacConfig() {
  if (await copyText(macConfig())) toast('Config copied — in the Mac app choose “Paste config”');
  else toast('Could not copy to the clipboard', { error: true });
}

function macClientsList(clients, rel, reload) {
  const ask = async (id, label) => {
    const r = await guarded(() => api(`/app/mac/clients/${id}/update`, { method: 'POST' }));
    if (r) { toast(r.asked ? `${label} will update within a minute` : 'Already up to date'); reload(); }
  };
  const behind = clients.filter((c) => c.updateAvailable && !c.updatePending && c.online);
  const rows = clients.map((c) => {
    const status = c.updatePending ? chip('updating…', 'warn') : c.updateAvailable ? chip('v' + c.version + ' · update available', 'warn') : chip('v' + c.version + ' · up to date', 'ok');
    return h('div', { class: 'row static', style: 'grid-template-columns:auto 1fr auto auto' },
      h('span', { class: 'dot ' + (c.online ? 'ok' : ''), title: c.online ? 'Online' : 'Not seen recently' }),
      h('div', {}, h('div', { class: 't' }, c.name), h('div', { class: 's' }, [c.os, c.online ? 'online' : 'last seen ' + ago(c.lastSeen)].filter(Boolean).join(' · ')), c.updateError && h('div', { class: 's', style: 'color:var(--md-sys-color-error)' }, 'Update failed: ' + c.updateError)),
      status,
      h('div', { style: 'display:flex;gap:4px' },
        c.updateAvailable && h('md-text-button', { disabled: c.updatePending || !c.online, title: c.online ? '' : 'The app must be running to update', onclick: () => ask(c.id, c.name) }, icon('system_update_alt'), 'Update'),
        !c.online && h('md-icon-button', { 'aria-label': 'Forget this Mac', title: 'Forget this Mac', onclick: async () => { if (await guarded(() => api('/app/mac/clients/' + c.id, { method: 'DELETE' }))) reload(); } }, icon('delete'))));
  });
  return h('div', {}, h('h3', { class: 'title-m', style: 'display:flex;align-items:center;gap:10px' }, h('span', { class: 'grow' }, 'Connected Macs'),
    behind.length > 1 && h('md-text-button', { onclick: () => ask('all', 'Every Mac') }, icon('system_update_alt'), 'Update all')),
    clients.length ? h('div', { class: 'list' }, rows) : h('div', { class: 'muted' }, 'No Mac has connected yet. Download the app, then use “Copy config” here and “Paste config” in the app.'));
}

function macAppCard(rel, clients, reload) {
  const body = [];
  const copyBtn = h('md-filled-tonal-button', { onclick: copyMacConfig, title: 'Copies this server\'s address and your token so the Mac app can connect with one paste' }, icon('content_copy'), 'Copy config');
  if (rel.available) {
    const btn = h('md-filled-button', { onclick: () => downloadMacApp(btn, rel) }, icon('download'), `Download v${rel.version}`);
    body.push(h('p', { class: 'muted' }, `Version ${rel.version} · ${size(rel.size)} · released ${fmtDate(rel.publishedAt, { dateStyle: 'medium' })}`),
      rel.notes && h('p', { class: 'muted', style: 'white-space:pre-wrap' }, rel.notes.replace(/\*\*/g, '').split('\n').slice(0, 6).join('\n')),
      h('div', { style: 'display:flex;gap:10px;flex-wrap:wrap' }, btn, copyBtn, h('md-text-button', { href: rel.releaseUrl, target: '_blank', rel: 'noopener' }, 'Release notes')));
  } else body.push(h('div', { class: 'muted' }, rel.error || 'No Mac app has been released yet.'), h('div', {}, copyBtn));
  if (rel.available && rel.error) body.push(h('div', { class: 'muted' }, rel.error));
  body.push(h('div', { class: 'muted' }, 'Unzip, drag Assistant.app to Applications, open it (first time: right-click → Open), then click “Paste config” in the app after pressing Copy config here. The config holds your access token — paste it only into your own Mac. See docs/mac-app.md.'), macClientsList(clients, rel, reload));
  return h('div', { class: 'card' }, h('h2', {}, icon('laptop_mac'), h('span', { class: 'grow' }, 'Mac app'), h('md-text-button', { onclick: reload }, icon('refresh'), 'Check again')), ...body.filter(Boolean));
}

export default async function system(view, { refreshStatus }) {
  const body = h('div', { class: 'grid masonry' });
  let level = 'all', q = '';
  const filter = h('md-outlined-text-field', { label: 'Filter the server log', 'data-primary': '', class: 'grow' }, h('span', { slot: 'leading-icon' }, icon('search')));
  let drawLogsNow = () => {}; filter.addEventListener('input', () => { q = filter.value.toLowerCase(); drawLogsNow(); });
  async function load() {
    const [s, integ, logs, act, mac, macClients] = await Promise.all([api('/status'), api('/status/integrations'), api('/logs?limit=250'), api('/activity?limit=25'), api('/app/mac/latest').catch((e) => ({ release: { available: false, error: e.message } })), api('/app/mac/clients').catch(() => ({ clients: [] }))]);
    const stat = (label, v, ic) => h('div', { class: 'card flat' }, h('div', { class: 'label' }, label), h('div', { class: 'title-l' }, v));
    const logBox = h('div', { class: 'logs mono' });
    const drawLogs = () => { clear(logBox).append(...logs.lines.filter((l) => (level === 'all' || l.level === 'error') && (!q || l.text.toLowerCase().includes(q))).map((l) => h('div', { class: l.level === 'error' ? 'e' : '' }, h('span', { class: 'at' }, fmtDate(l.at, { timeStyle: 'medium' }) + '  '), l.text))); logBox.scrollTop = logBox.scrollHeight; };
    const levels = h('div', { class: 'seg' }); const drawLevels = () => clear(levels).append(...[['all', 'All'], ['error', 'Errors']].map(([v, l]) => h('button', { 'aria-pressed': String(v === level), onclick: () => { level = v; drawLevels(); drawLogs(); } }, l))); drawLevels();
    clear(body).append(
      h('div', { class: 'grid cols-3' }, stat('Version', 'v' + s.version), stat('Uptime', dur(s.uptimeSec)), stat('Brain', s.model), stat('Time zone', s.tz)),
      (() => { const row = (i) => { const off = !i.configured; const el = h(off ? 'button' : 'div', { class: 'row' + (off ? ' setup-row' : ' static'), style: 'grid-template-columns:auto 1fr auto;text-align:left', ...(off ? { type: 'button', 'data-setup': i.id, onclick: () => setupDialog(i, load) } : {}) }, h('span', { class: 'dot ' + (off ? '' : i.ok === false ? 'bad' : 'ok') }), h('div', {}, h('div', { class: 't' }, i.name), h('div', { class: 's' }, off ? 'Not set up' : i.detail)), off ? h('span', { class: 'muted s', style: 'display:flex;align-items:center;gap:2px' }, 'Set up', icon('chevron_right')) : chip(i.ok === false ? 'problem' : 'on', i.ok === false ? 'bad' : 'ok')); return el; };
        return h('div', { class: 'card' }, h('h2', {}, icon('dns'), 'Connections'), h('div', { class: 'list' }, [...integ.integrations.filter((i) => i.configured), ...integ.integrations.filter((i) => !i.configured)].map(row))); })(),
      h('div', { class: 'grid ' + (s.bySource.length ? 'cols-2' : '') },
        s.bySource.length ? h('div', { class: 'card' }, h('h2', {}, icon('inbox'), 'Where messages come from'), s.bySource.length ? h('div', { class: 'list' }, s.bySource.map((r) => h('div', { class: 'row static', style: 'grid-template-columns:1fr auto' }, h('div', { class: 't' }, r.source), chip(String(r.n))))) : h('div', { class: 'muted' }, 'No messages yet.')) : null,
        h('div', { class: 'card' }, h('h2', {}, icon('history'), 'Recent changes'), act.events.length ? h('div', { class: 'timeline' }, act.events.slice(0, 10).map((e) => h('div', {}, h('div', { class: 't' }, `${e.type} · ${e.title}`), h('div', { class: 'muted' }, `${e.actor} · ${ago(e.at)}`)))) : h('div', { class: 'muted' }, 'Nothing yet.'))),
      macAppCard(mac.release, macClients.clients, async () => { if (await guarded(() => api('/app/mac/latest?refresh=1'))) load(); }),
      h('div', { class: 'card' }, h('h2', {}, icon('terminal'), h('span', { class: 'grow' }, 'Server log'), levels), logBox),
      h('div', { class: 'card' }, h('h2', {}, icon('tune'), 'Maintenance'), h('div', { style: 'display:flex;gap:10px;flex-wrap:wrap' },
        h('md-filled-tonal-button', { onclick: async () => { const r = await guarded(() => api('/admin/reindex', { method: 'POST' })); if (r) toast(`Indexed ${r.indexed} file(s), skipped ${r.skipped}`); load(); } }, icon('folder'), 'Re-index files'),
        h('md-outlined-button', { onclick: restartServer }, icon('restart_alt'), 'Restart assistant'))));
    drawLogs(); drawLogsNow = drawLogs;
  }
  clear(view).append(h('div', { class: 'page-head' }, h('h1', { class: 'display' }, 'System'), h('p', { class: 'muted title-m' }, 'Health, logs and maintenance.')), h('div', { class: 'toolbar' }, filter), body);
  clear(body).append(spinner()); await load();
  const t = setInterval(() => !document.hidden && load().catch(() => {}), 20000); return () => clearInterval(t);
}
