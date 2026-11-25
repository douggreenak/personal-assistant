import { api } from '../api.js';
import { h, icon, clear, ago, fmtDate, empty, chip, confirmDialog, guarded, toast, spinner } from '../ui.js';

const dur = (s) => (s < 3600 ? `${Math.round(s / 60)} min` : s < 86400 ? `${(s / 3600).toFixed(1)} h` : `${(s / 86400).toFixed(1)} days`);

export async function restartServer() {
  if (!(await confirmDialog('Restart the assistant?', 'It restarts in a few seconds. Open requests are interrupted; nothing is lost.', 'Restart'))) return;
  await guarded(() => api('/admin/restart', { method: 'POST' }));
  toast('Restarting…');
  for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 1500)); try { if ((await fetch('/healthz')).ok && i > 1) { toast('Back online'); setTimeout(() => location.reload(), 600); return; } } catch { /* still down */ } }
}

export default async function system(view, { refreshStatus }) {
  const body = h('div', { class: 'grid' });
  let level = 'all';
  async function load() {
    const [s, integ, logs, act] = await Promise.all([api('/status'), api('/status/integrations'), api('/logs?limit=250'), api('/activity?limit=25')]);
    const stat = (label, v, ic) => h('div', { class: 'card flat' }, h('div', { class: 'label' }, label), h('div', { class: 'title-l' }, v));
    const logBox = h('div', { class: 'logs mono' });
    const drawLogs = () => { clear(logBox).append(...logs.lines.filter((l) => level === 'all' || l.level === 'error').map((l) => h('div', { class: l.level === 'error' ? 'e' : '' }, h('span', { class: 'at' }, fmtDate(l.at, { timeStyle: 'medium' }) + '  '), l.text))); logBox.scrollTop = logBox.scrollHeight; };
    const levels = h('div', { class: 'seg' }); const drawLevels = () => clear(levels).append(...[['all', 'All'], ['error', 'Errors']].map(([v, l]) => h('button', { 'aria-pressed': String(v === level), onclick: () => { level = v; drawLevels(); drawLogs(); } }, l))); drawLevels();
    clear(body).append(
      h('div', { class: 'grid cols-3' }, stat('Version', 'v' + s.version), stat('Uptime', dur(s.uptimeSec)), stat('Brain', s.model), stat('Time zone', s.tz), stat('Messages processed', `${s.queue.total - s.queue.pending - s.queue.failing} of ${s.queue.total}`), stat('Indexed files', s.indexedFiles)),
      h('div', { class: 'card' }, h('h2', {}, icon('dns'), 'Integrations'), h('div', { class: 'list' }, integ.integrations.map((i) => h('div', { class: 'row static', style: 'grid-template-columns:auto 1fr auto' }, h('span', { class: 'dot ' + (!i.configured ? '' : i.ok === false ? 'bad' : 'ok') }), h('div', {}, h('div', { class: 't' }, i.name), h('div', { class: 's' }, i.detail)), chip(!i.configured ? 'off' : i.ok === false ? 'problem' : 'on', !i.configured ? '' : i.ok === false ? 'bad' : 'ok'))))),
      h('div', { class: 'grid cols-2' },
        h('div', { class: 'card' }, h('h2', {}, icon('inbox'), 'Where messages come from'), s.bySource.length ? h('div', { class: 'list' }, s.bySource.map((r) => h('div', { class: 'row static', style: 'grid-template-columns:1fr auto' }, h('div', { class: 't' }, r.source), chip(String(r.n))))) : h('div', { class: 'muted' }, 'No messages yet.')),
        h('div', { class: 'card' }, h('h2', {}, icon('history'), 'Recent changes'), act.events.length ? h('div', { class: 'timeline' }, act.events.slice(0, 10).map((e) => h('div', {}, h('div', { class: 't' }, `${e.type} · ${e.title}`), h('div', { class: 'muted' }, `${e.actor} · ${ago(e.at)}`)))) : h('div', { class: 'muted' }, 'Nothing yet.'))),
      h('div', { class: 'card' }, h('h2', {}, icon('terminal'), h('span', { class: 'grow' }, 'Server log'), levels), logBox),
      h('div', { class: 'card' }, h('h2', {}, icon('tune'), 'Maintenance'), h('div', { style: 'display:flex;gap:10px;flex-wrap:wrap' },
        h('md-filled-tonal-button', { onclick: async () => { const r = await guarded(() => api('/admin/reindex', { method: 'POST' })); if (r) toast(`Indexed ${r.indexed} file(s), skipped ${r.skipped}`); load(); } }, icon('folder'), 'Re-index files'),
        h('md-outlined-button', { onclick: restartServer }, icon('restart_alt'), 'Restart assistant'))));
    drawLogs();
  }
  clear(view).append(h('div', { class: 'page-head' }, h('h1', { class: 'display' }, 'System'), h('p', { class: 'muted title-m' }, 'Health, logs and maintenance.')), body);
  clear(body).append(spinner()); await load();
  const t = setInterval(() => !document.hidden && load().catch(() => {}), 20000); return () => clearInterval(t);
}
