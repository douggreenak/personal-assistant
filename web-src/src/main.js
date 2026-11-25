import '@material/web/button/filled-button.js'; import '@material/web/button/filled-tonal-button.js'; import '@material/web/button/outlined-button.js'; import '@material/web/button/text-button.js';
import '@material/web/iconbutton/icon-button.js'; import '@material/web/iconbutton/filled-icon-button.js'; import '@material/web/iconbutton/filled-tonal-icon-button.js';
import '@material/web/fab/fab.js'; import '@material/web/textfield/outlined-text-field.js'; import '@material/web/switch/switch.js';
import '@material/web/dialog/dialog.js'; import '@material/web/menu/menu.js'; import '@material/web/menu/menu-item.js';
import '@material/web/select/outlined-select.js'; import '@material/web/select/select-option.js'; import '@material/web/chips/chip-set.js'; import '@material/web/chips/filter-chip.js'; import '@material/web/chips/assist-chip.js';
import '@material/web/progress/linear-progress.js';
import { api, hasToken, clearToken, login } from './api.js';
import { h, icon, clear, state, spinner, dialog, toast } from './ui.js';
import { applyTheme } from './theme.js';
import home from './pages/home.js'; import items from './pages/items.js'; import chat from './pages/chat.js'; import inbox from './pages/inbox.js';
import approvals from './pages/approvals.js'; import connectors from './pages/connectors.js'; import system from './pages/system.js'; import settings from './pages/settings.js';

applyTheme();
const PAGES = [
  { id: 'home', label: 'Home', icon: 'home', fn: home }, { id: 'items', label: 'Items', icon: 'checklist', fn: items }, { id: 'chat', label: 'Chat', icon: 'chat', fn: chat },
  { id: 'inbox', label: 'Inbox', icon: 'inbox', fn: inbox }, { id: 'approvals', label: 'Approvals', icon: 'task_alt', fn: approvals },
  { id: 'connectors', label: 'Connect', icon: 'extension', fn: connectors }, { id: 'system', label: 'System', icon: 'monitor_heart', fn: system }, { id: 'settings', label: 'Settings', icon: 'settings', fn: settings },
];
const MOBILE = ['home', 'items', 'chat', 'approvals'];
const root = document.getElementById('root');
let cleanup = null, badges = {}, navEls = [];

export const nav = (id) => { location.hash = '#/' + id; };
export const counts = () => badges;

function showLogin() {
  cleanup?.(); cleanup = null;
  const pw = h('md-outlined-text-field', { label: 'Password', type: 'password', autocomplete: 'current-password' });
  const err = h('div', { class: 'err', role: 'alert' });
  const go = async () => {
    err.textContent = ''; btn.disabled = true;
    try { await login(pw.value.trim()); await start(); } catch (e) { err.textContent = e.message; btn.disabled = false; }
  };
  const btn = h('md-filled-button', { onclick: go }, 'Sign in');
  pw.addEventListener('keydown', (e) => e.key === 'Enter' && go());
  clear(root).append(h('div', { class: 'login' }, h('div', { class: 'card' },
    h('div', { class: 'logo' }, icon('bolt-fill')), h('div', {}, h('h1', { class: 'headline' }, 'Personal Assistant'), h('p', { class: 'muted' }, 'Sign in to manage your tickets, reminders and tasks.')), pw, err, btn)));
  setTimeout(() => pw.focus(), 50);
}

async function refreshStatus() {
  try {
    const s = await api('/status'); state.tz = s.tz; badges = { approvals: s.approvals, inbox: s.queue.failing, status: s };
    navEls.forEach((d) => { const b = d.querySelector('.badge'); const n = badges[d.dataset.id] || 0; if (b) { b.textContent = n; b.hidden = !n; } });
  } catch { /* offline */ }
}

function destination(p, badge = true) {
  const a = h('a', { class: 'dest', href: '#/' + p.id, 'data-id': p.id }, h('span', { class: 'pill' }, icon(p.icon), badge && h('span', { class: 'badge', hidden: true })), h('span', {}, p.label));
  navEls.push(a); return a;
}

function route() {
  const id = (location.hash.match(/^#\/(\w+)/) || [])[1] || 'home';
  const p = PAGES.find((x) => x.id === id) || PAGES[0];
  navEls.forEach((d) => d.toggleAttribute('aria-current', d.dataset.id === p.id)); navEls.forEach((d) => d.dataset.id === p.id ? d.setAttribute('aria-current', 'page') : d.removeAttribute('aria-current'));
  cleanup?.(); cleanup = null; refreshStatus();
  const view = document.getElementById('view'); clear(view).append(spinner());
  window.scrollTo(0, 0);
  Promise.resolve(p.fn(view, { nav, refreshStatus })).then((c) => { cleanup = typeof c === 'function' ? c : null; }).catch((e) => clear(view).append(h('div', { class: 'card' }, h('h2', {}, 'Something went wrong'), h('p', { class: 'muted' }, e.message))));
}

function searchDialog() {
  const out = h('div', { class: 'list' }); const q = h('md-outlined-text-field', { label: 'Search messages, items and files', 'supporting-text': 'Keyword search over everything the assistant has seen' });
  let t; q.addEventListener('input', () => { clearTimeout(t); t = setTimeout(async () => {
    if (q.value.trim().length < 3) return clear(out);
    try { const { hits } = await api('/search?q=' + encodeURIComponent(q.value)); clear(out).append(...(hits.length ? hits.map((x) => h('div', { class: 'row static' }, h('div', { class: 'lead k-task' }, icon(x.kind === 'item' ? 'checklist' : x.kind === 'doc' ? 'folder' : 'mail')), h('div', {}, h('div', { class: 't' }, x.title || x.kind), h('div', { class: 's' }, x.snippet.slice(0, 220))), h('span', { class: 'tag' }, x.kind))) : [h('div', { class: 'muted' }, 'No matches.')])); } catch (e) { toast(e.message, { error: true }); }
  }, 300); });
  const { close } = dialog({ title: 'Search', fullscreen: true, content: [q, out], actions: [h('md-text-button', { onclick: () => close() }, 'Close')] });
  setTimeout(() => q.focus(), 100);
}

async function start() {
  await refreshStatus();
  navEls = [];
  const rail = h('nav', { class: 'rail', 'aria-label': 'Main' }, h('div', { class: 'brand' }, icon('bolt-fill')), PAGES.map((p) => destination(p)), h('div', { class: 'spacer' }));
  const more = h('md-menu', { anchor: 'moreBtn', positioning: 'popover' }, PAGES.filter((p) => !MOBILE.includes(p.id)).map((p) => h('md-menu-item', { onclick: () => nav(p.id) }, h('div', { slot: 'headline' }, p.label), h('span', { slot: 'start' }, icon(p.icon)))));
  const moreBtn = h('button', { class: 'dest', id: 'moreBtn', onclick: () => { more.open = !more.open; } }, h('span', { class: 'pill' }, icon('more_horiz')), h('span', {}, 'More'));
  const bottom = h('nav', { class: 'bottom-nav', 'aria-label': 'Main' }, PAGES.filter((p) => MOBILE.includes(p.id)).map((p) => destination(p)), moreBtn, more);
  const top = h('div', { class: 'topbar' }, h('div', { class: 'grow' }), h('md-icon-button', { 'aria-label': 'Search', onclick: searchDialog }, icon('search')), h('md-icon-button', { 'aria-label': 'Refresh', onclick: () => route() }, icon('refresh')),
    h('md-icon-button', { 'aria-label': 'Sign out', onclick: () => { clearToken(); showLogin(); } }, icon('logout')));
  clear(root).append(h('div', { id: 'app' }, rail, h('main', {}, top, h('div', { id: 'view', class: 'page' })), bottom));
  refreshStatus(); route();
}
window.addEventListener('hashchange', () => hasToken() && route());
window.addEventListener('auth-lost', () => { clearToken(); showLogin(); });
setInterval(() => { if (hasToken() && !document.hidden) refreshStatus(); }, 20000);
if (hasToken()) start().catch(showLogin); else showLogin();
