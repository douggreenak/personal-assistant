import { api } from '../api.js';
import { h, icon, clear, ago, fmtDate, empty, chip, state, guarded, toast } from '../ui.js';
import { itemRow } from './items.js';

const greeting = () => { const hr = +new Intl.DateTimeFormat('en-US', { timeZone: state.tz, hour: 'numeric', hourCycle: 'h23' }).format(new Date()); return hr < 5 ? 'Still up?' : hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening'; };

export default async function home(view, { nav, refreshStatus }) {
  const load = async () => {
    const [s, { items }, { events }, { approvals }] = await Promise.all([api('/status'), api('/items?state=open'), api('/activity?limit=8'), api('/approvals')]);
    state.tz = s.tz;
    const now = Date.now();
    const urgent = items.filter((i) => i.dueAt && new Date(i.dueAt) < now || i.priority === 'urgent').slice(0, 5);
    const soon = items.filter((i) => i.dueAt && new Date(i.dueAt) >= now).slice(0, 5);
    const tile = (cls, n, label, ic, to) => h('button', { class: 'card stat ' + cls + (cls === 's4' && !n ? ' zero' : ''), onclick: () => nav(to) }, h('div', { class: 'lbl' }, icon(ic), label), h('div', { class: 'num' }, n));
    const refresh = () => { refreshStatus(); return load(); };
    clear(view).append(
      h('div', { class: 'page-head' }, h('div', { class: 'label' }, fmtDate(new Date(), { weekday: 'long', month: 'long', day: 'numeric' })), h('h1', { class: 'display' }, greeting() + '.'),
        h('p', { class: 'muted title-m' }, s.items.open ? `You have ${s.items.open} open item${s.items.open === 1 ? '' : 's'}${s.items.overdue ? `, ${s.items.overdue} overdue` : ''}.` : 'Nothing open. Enjoy it.')),
      h('div', { class: 'grid cols-3' }, tile('s1', s.items.tickets, 'Tickets', 'confirmation_number', 'items'), tile('s2', s.items.reminders, 'Reminders', 'alarm', 'items'), tile('s3', s.items.tasks, 'Tasks', 'checklist', 'items'),
        tile('s4', s.approvals, 'Need your OK', 'task_alt', 'approvals')),
      approvals.length ? h('div', { class: 'card high' }, h('h2', {}, icon('task_alt'), h('span', { class: 'grow' }, `${approvals.length} waiting for you`), h('md-text-button', { onclick: () => nav('approvals') }, 'Review')), h('div', { class: 'list' }, approvals.slice(0, 3).map((a) => h('div', { class: 'row static', style: 'grid-template-columns:1fr auto' }, h('div', {}, h('div', { class: 't' }, a.summary), h('div', { class: 's' }, a.reason)), h('div', { class: 'acts' },
        h('md-filled-tonal-button', { onclick: async () => { await guarded(() => api(`/approvals/${a.id}/approve`, { method: 'POST' }), 'Approved'); refresh(); } }, 'Approve')))))) : '',
      h('div', { class: 'grid cols-2' },
        h('div', { class: 'card' }, h('h2', {}, icon('bolt'), 'Needs attention'), urgent.length ? h('div', { class: 'list' }, urgent.map((i) => itemRow(i, refresh))) : empty('verified', 'All clear', 'Nothing overdue or urgent.')),
        h('div', { class: 'card' }, h('h2', {}, icon('event'), 'Coming up'), soon.length ? h('div', { class: 'list' }, soon.map((i) => itemRow(i, refresh))) : empty('event', 'Nothing scheduled', 'Items with a due date show up here.'))),
      h('div', { class: 'grid cols-2' },
        h('div', { class: 'card' }, h('h2', {}, icon('history'), 'Recent activity'), events.length ? h('div', { class: 'timeline' }, events.map((e) => h('div', {}, h('div', { class: 't' }, `${e.type} · ${e.title}`), h('div', { class: 'muted' }, `${e.actor} · ${ago(e.at)}`)))) : h('div', { class: 'muted' }, 'No activity yet.')),
        h('div', { class: 'card' }, h('h2', {}, icon('chat'), 'Tell the assistant'), h('p', { class: 'muted' }, 'Type or paste anything — it becomes tickets, reminders and tasks.'),
          (() => { const f = h('md-outlined-text-field', { label: 'e.g. remind me to call Sam tomorrow 9am', type: 'textarea', rows: 3 }); const b = h('md-filled-button', { onclick: async () => {
            if (!f.value.trim()) return; b.disabled = true; const r = await guarded(() => api('/chat', { method: 'POST', body: { text: f.value } })); b.disabled = false; if (r) { f.value = ''; toast(r.reply.slice(0, 200)); refresh(); } } }, icon('send'), 'Send');
            return h('div', { class: 'form' }, f, h('div', {}, b)); })())));
  };
  await load();
  const t = setInterval(() => !document.hidden && !document.querySelector('md-dialog') && load().catch(() => {}), 30000);
  return () => clearInterval(t);
}
