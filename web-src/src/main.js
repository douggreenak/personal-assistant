import '@material/web/button/filled-button.js'; import '@material/web/button/filled-tonal-button.js'; import '@material/web/button/outlined-button.js'; import '@material/web/button/text-button.js';
import '@material/web/iconbutton/icon-button.js'; import '@material/web/iconbutton/filled-icon-button.js'; import '@material/web/iconbutton/filled-tonal-icon-button.js';
import '@material/web/fab/fab.js'; import '@material/web/textfield/outlined-text-field.js'; import '@material/web/switch/switch.js';
import '@material/web/dialog/dialog.js'; import '@material/web/menu/menu.js'; import '@material/web/menu/menu-item.js';
import '@material/web/select/outlined-select.js'; import '@material/web/select/select-option.js'; import '@material/web/chips/chip-set.js'; import '@material/web/chips/filter-chip.js'; import '@material/web/chips/assist-chip.js';
import '@material/web/progress/linear-progress.js';
import '@material/web/progress/circular-progress.js';
import { api, hasToken, clearToken, login } from './api.js';
import { h, icon, clear, state, spinner, dialog, toast, page, confirmDialog } from './ui.js';
import { initShortcuts, showHelp } from './shortcuts.js';
import { itemDialog } from './pages/items.js';
import { applyTheme, prefs, isDark } from './theme.js';
import home from './pages/home.js'; import items from './pages/items.js'; import chat from './pages/chat.js'; import inbox from './pages/inbox.js';
import code from './pages/code.js'; import tickets from './pages/tickets.js';
import approvals from './pages/approvals.js'; import connectors from './pages/connectors.js'; import system from './pages/system.js'; import settings from './pages/settings.js';

applyTheme();
const PAGES = [
  { id: 'home', label: 'Home', icon: 'home', fn: home }, { id: 'items', label: 'Items', icon: 'checklist', fn: items }, { id: 'tickets', label: 'Tickets', icon: 'confirmation_number', fn: tickets }, { id: 'chat', label: 'Chat', icon: 'chat', fn: chat }, { id: 'code', label: 'Code', icon: 'code', fn: code },
  { id: 'inbox', label: 'Inbox', icon: 'inbox', fn: inbox }, { id: 'approvals', label: 'Approvals', icon: 'task_alt', fn: approvals },
  { id: 'connectors', label: 'Connect', icon: 'extension', fn: connectors }, { id: 'system', label: 'System', icon: 'monitor_heart', fn: system }, { id: 'settings', label: 'Settings', icon: 'settings', fn: settings },
];
const MOBILE = ['home', 'items', 'chat', 'approvals'];
const root = document.getElementById('root');
let cleanup = null, badges = {}, navEls = [], curLabel = 'Home', lastHash = location.hash, hiddenAt = 0;
const setTitle = () => { const n = (badges.approvals || 0) + (badges.inbox || 0); document.title = (n ? `(${n}) ` : '') + curLabel + ' · Assistant'; };

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
    const s = await api('/status'); state.tz = s.tz; badges = { approvals: s.approvals, inbox: s.queue.failing, status: s }; setTitle();
    navEls.forEach((d) => { const b = d.querySelector('.badge'); const n = badges[d.dataset.id] || 0; if (b) { b.textContent = n; b.hidden = !n; } });
  } catch { /* offline */ }
}

function destination(p, badge = true) {
  const a = h('a', { class: 'dest', href: '#/' + p.id, 'data-id': p.id }, h('span', { class: 'pill' }, icon(p.icon), badge && h('span', { class: 'badge', hidden: true })), h('span', {}, p.label));
  navEls.push(a); return a;
}

let curId = '', routeSeq = 0;
function route(hard = true) {
  const id = (location.hash.match(/^#\/(\w+)/) || [])[1] || 'home';
  const p = PAGES.find((x) => x.id === id) || PAGES[0];
  // Same page, different part (e.g. another Code session): the page swaps only what changed instead of rebuilding.
  if (hard && p.id === curId && page.soft) { lastHash = location.hash; Promise.resolve(page.soft()).then((ok) => { if (ok === false) route(false); }).catch(() => route(false)); return; }
  curId = p.id;
  navEls.forEach((d) => d.toggleAttribute('aria-current', d.dataset.id === p.id)); navEls.forEach((d) => d.dataset.id === p.id ? d.setAttribute('aria-current', 'page') : d.removeAttribute('aria-current'));
  cleanup?.(); cleanup = null; refreshStatus(); page.newAction = null; page.guard = null; page.soft = null; curLabel = p.label === 'Connect' ? 'Connectors' : p.label; setTitle(); lastHash = location.hash;
  const view = document.getElementById('view'); clear(view).append(spinner());
  // The entrance animation is for arriving on a page only: once it has played, in-page redraws (ticking off a task, the 30s refresh) must not replay it.
  view.classList.remove('settled'); const navSeq = ++routeSeq;
  window.scrollTo(0, 0);
  Promise.resolve(p.fn(view, { nav, refreshStatus })).then((c) => { cleanup = typeof c === 'function' ? c : null; setTimeout(() => { if (navSeq === routeSeq) view.classList.add('settled'); }, 600); }).catch((e) => clear(view).append(h('div', { class: 'card' }, h('h2', {}, 'Something went wrong'), h('p', { class: 'muted' }, e.message))));
}

function searchDialog() {
  const go = (id) => () => { close(); nav(id); };
  const COMMANDS = [
    ...PAGES.map((p) => ({ label: 'Go to ' + (p.label === 'Connect' ? 'Connectors' : p.label), icon: p.icon, run: go(p.id) })),
    { label: 'New item', icon: 'add', run: () => { close(); (page.newAction || (() => itemDialog(null, () => route())))(); } },
    { label: isDark() ? 'Switch to light mode' : 'Switch to dark mode', icon: isDark() ? 'light_mode' : 'dark_mode', run: () => { close(); prefs.set('mode', isDark() ? 'light' : 'dark'); } },
    { label: 'Keyboard shortcuts', icon: 'keyboard', run: () => { close(); setTimeout(showHelp, 250); } },
    { label: 'Refresh this page', icon: 'refresh', run: () => { close(); route(); } },
    { label: 'Sign out', icon: 'logout', run: () => { close(); clearToken(); showLogin(); } },
  ];
  const cmds = h('div', { class: 'list cmds' }), out = h('div', { class: 'list' });
  const q = h('md-outlined-text-field', { label: 'Search messages, items and files', 'supporting-text': 'Or type a command — “settings”, “new”, “dark”… Enter runs the first one' });
  let shown = [];
  const drawCmds = () => {
    const t = q.value.trim().toLowerCase();
    shown = COMMANDS.filter((c) => !t || c.label.toLowerCase().includes(t)).slice(0, t ? 5 : 6);
    clear(cmds).append(...shown.map((c, n) => h('div', { class: 'row static cmd' + (t && n === 0 ? ' first' : ''), tabindex: 0, role: 'button', onclick: c.run, onkeydown: (e) => e.key === 'Enter' && c.run() }, h('div', { class: 'lead k-task' }, icon(c.icon)), h('div', { class: 't' }, c.label), icon('arrow_forward'))));
  };
  drawCmds();
  q.addEventListener('keydown', (e) => { if (e.key === 'Enter' && shown.length && q.value.trim()) { e.preventDefault(); shown[0].run(); } });
  let t; q.addEventListener('input', () => { drawCmds(); clearTimeout(t); t = setTimeout(async () => {
    if (q.value.trim().length < 3) return clear(out);
    try { const { hits } = await api('/search?q=' + encodeURIComponent(q.value)); clear(out).append(...(hits.length ? hits.map((x) => h('div', { class: 'row static' }, h('div', { class: 'lead k-task' }, icon(x.kind === 'item' ? 'checklist' : x.kind === 'doc' ? 'folder' : 'mail')), h('div', {}, h('div', { class: 't' }, x.title || x.kind), h('div', { class: 's' }, x.snippet.slice(0, 220))), h('span', { class: 'tag' }, x.kind))) : [h('div', { class: 'muted' }, 'No matches in your messages, items or files.')])); } catch (e) { toast(e.message, { error: true }); }
  }, 300); });
  const { close } = dialog({ title: 'Search & commands', fullscreen: true, dismissable: true, content: [q, cmds, out], actions: [h('md-text-button', { onclick: () => close() }, 'Close')] });
  setTimeout(() => q.focus(), 100);
}

async function start() {
  await refreshStatus();
  navEls = [];
  const rail = h('nav', { class: 'rail', 'aria-label': 'Main' }, h('div', { class: 'brand' }, icon('bolt-fill')), PAGES.map((p) => destination(p)), h('div', { class: 'spacer' }));
  const more = h('md-menu', { anchor: 'moreBtn', positioning: 'popover' }, PAGES.filter((p) => !MOBILE.includes(p.id)).map((p) => h('md-menu-item', { onclick: () => nav(p.id) }, h('div', { slot: 'headline' }, p.label), h('span', { slot: 'start' }, icon(p.icon)))));
  const moreBtn = h('button', { class: 'dest', id: 'moreBtn', onclick: () => { more.open = !more.open; } }, h('span', { class: 'pill' }, icon('more_horiz')), h('span', {}, 'More'));
  const bottom = h('nav', { class: 'bottom-nav', 'aria-label': 'Main' }, PAGES.filter((p) => MOBILE.includes(p.id)).map((p) => destination(p)), moreBtn, more);
  const top = h('div', { class: 'topbar' }, h('div', { class: 'grow' }), h('md-icon-button', { 'aria-label': 'Search', onclick: searchDialog }, icon('search')), 
    h('md-icon-button', { 'aria-label': 'Sign out', onclick: () => { clearToken(); showLogin(); } }, icon('logout')));
  clear(root).append(h('div', { id: 'app' }, rail, h('main', {}, top, h('div', { id: 'view', class: 'page' })), bottom));
  refreshStatus(); route();
}
initShortcuts({ nav, refresh: () => route(), openSearch: searchDialog, newDefault: () => itemDialog(null, () => route()) });
let reverting = false;
window.addEventListener('hashchange', async () => {
  if (!hasToken() || reverting) { reverting = false; return; }
  if (page.guard?.() && !(await confirmDialog('Discard unsaved changes?', 'You have settings changes that are not saved yet.', 'Discard'))) { reverting = true; location.hash = lastHash; return; }
  route();
});
window.addEventListener('beforeunload', (e) => { if (hasToken() && page.guard?.()) { e.preventDefault(); e.returnValue = ''; } });
let banner;
window.addEventListener('net', (e) => {
  if (!e.detail && !banner) { banner = h('div', { class: 'offline', role: 'alert' }, icon('wifi_off'), 'Cannot reach the server — retrying…'); document.body.append(banner); }
  if (e.detail && banner) { banner.remove(); banner = null; toast('Back online'); }
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { hiddenAt = Date.now(); return; }
  if (!hasToken()) return; refreshStatus();
  const typing = document.activeElement && /^(INPUT|TEXTAREA|MD-)/.test(document.activeElement.tagName);
  if (Date.now() - hiddenAt > 300000 && !page.guard?.() && !typing && !document.querySelector('md-dialog[open]') && !/^#\/(chat|settings|code)/.test(location.hash)) { const y = scrollY; route(); setTimeout(() => scrollTo(0, y), 500); }   // coming back to the tab after a long time: refresh the data, keep your place
});
window.addEventListener('auth-lost', () => { clearToken(); showLogin(); });
setInterval(() => { if (hasToken() && !document.hidden) refreshStatus(); }, 20000);
if (hasToken()) start().catch(showLogin); else showLogin();

if ('serviceWorker' in navigator && location.protocol === 'https:' || location.hostname === 'localhost') navigator.serviceWorker?.register('/sw.js').catch(() => {});   // offline shell for the home-screen app
