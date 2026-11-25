import { h, icon, dialog, page } from './ui.js';
import { prefs, isDark } from './theme.js';

const NAV = { h: 'home', i: 'items', c: 'chat', b: 'inbox', a: 'approvals', o: 'connectors', y: 'system', s: 'settings' };
const NAMES = { home: 'Home', items: 'Items', chat: 'Chat', inbox: 'Inbox', approvals: 'Approvals', connectors: 'Connectors', system: 'System', settings: 'Settings' };
const ORDER = ['home', 'items', 'chat', 'inbox', 'approvals', 'connectors', 'system', 'settings'];
let chord = null, chordTimer, hint;

const typing = (e) => {
  const t = e.composedPath()[0];
  return !!t && !!t.tagName && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable || /^MD-(OUTLINED|FILLED)-(TEXT-FIELD|SELECT)$/.test(t.tagName));
};
const overlayOpen = () => !!document.querySelector('md-dialog[open], md-menu[open]');
const sels = () => [...document.querySelectorAll('#view [data-sel]')];
const current = () => document.querySelector('#view [data-sel].sel');
function move(delta) {
  const l = sels(); if (!l.length) return;
  let i = l.findIndex((x) => x.classList.contains('sel')); l[i]?.classList.remove('sel');
  i = i < 0 ? (delta > 0 ? 0 : l.length - 1) : Math.max(0, Math.min(l.length - 1, i + delta));
  l[i].classList.add('sel'); l[i].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}
export function focusPrimary() {
  const el = document.querySelector('#view [data-primary]');
  if (!el) return false;
  el.focus(); el.scrollIntoView?.({ block: 'center', behavior: 'smooth' }); return true;
}
function showChord(on) {
  hint?.remove(); hint = null; clearTimeout(chordTimer);
  if (!on) { chord = null; return; }
  chord = 'g';
  hint = h('div', { class: 'chord-hint', role: 'status' }, h('b', {}, 'Go to'), ORDER.map((p) => { const k = Object.keys(NAV).find((x) => NAV[x] === p); return h('span', {}, h('kbd', {}, k), NAMES[p]); }));
  document.body.append(hint); chordTimer = setTimeout(() => showChord(false), 2500);
}

export const SHORTCUTS = [
  ['Anywhere', [['/', 'Jump to the text box on this page (opens search if there is none)'], ['Ctrl K', 'Search everything'], ['?', 'Show this list'], ['Esc', 'Leave a text box / close a dialog'],
    ['n', 'New (item, message or connector, depending on the page)'], ['r', 'Refresh this page'], ['t', 'Switch light / dark'], ['Ctrl Enter', 'Submit a dialog or the quick-capture box']]],
  ['Go to', [['g h', 'Home'], ['g i', 'Items'], ['g c', 'Chat'], ['g b', 'Inbox'], ['g a', 'Approvals'], ['g o', 'Connectors'], ['g y', 'System'], ['g s', 'Settings'], ['1 – 8', 'Jump to a page by its position in the menu']]],
  ['Lists (Items, Inbox, Approvals, Home)', [['j / k', 'Select next / previous'], ['Enter', 'Open the selected row'], ['x', 'Done (item) · approve (approval) · skip (message)'], ['e', 'Edit the selected item'], ['h', 'History of the selected item'],
    ['s', 'Snooze the selected reminder 2 hours'], ['Delete', 'Drop (item) · reject (approval)'], ['Shift R', 'Process the selected message again']]],
];
export function showHelp() {
  const { close } = dialog({ title: 'Keyboard shortcuts', fullscreen: true,
    content: SHORTCUTS.map(([g, rows]) => h('div', {}, h('div', { class: 'label', style: 'margin:6px 0 8px' }, g), h('div', { class: 'keys' }, rows.map(([k, d]) => [h('span', { class: 'keycaps' }, k.split(' ').map((x) => h('kbd', {}, x))), h('span', {}, d)])))),
    actions: [h('md-filled-button', { onclick: () => close() }, 'Got it')] });
}

/** Wires the global keyboard handler. Page code registers `page.newAction`, `data-primary` inputs and `data-sel` rows (with a `_keys` map). */
export function initShortcuts({ nav, refresh, openSearch, newDefault }) {
  window.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); if (!document.querySelector('md-dialog[open]')) openSearch(); return; }
    if (e.key === 'Escape') { if (typing(e)) document.activeElement?.blur?.(); else current()?.classList.remove('sel'); showChord(false); return; }
    if (mod || e.altKey || typing(e) || overlayOpen()) return;

    if (chord) {
      const to = NAV[e.key.toLowerCase()]; showChord(false);
      if (to) { e.preventDefault(); nav(to); } return;
    }
    const t = e.composedPath()[0], onControl = t?.tagName && /^(BUTTON|A|MD-[A-Z-]*BUTTON|MD-FAB|MD-MENU-ITEM|SUMMARY)$/.test(t.tagName);
    const row = current();
    switch (e.key) {
      case 'g': e.preventDefault(); showChord(true); return;
      case '/': e.preventDefault(); if (!focusPrimary()) openSearch(); return;
      case '?': e.preventDefault(); showHelp(); return;
      case 'n': e.preventDefault(); (page.newAction || newDefault)(); return;
      case 'r': e.preventDefault(); refresh(); return;
      case 't': e.preventDefault(); prefs.set('mode', isDark() ? 'light' : 'dark'); return;
      case 'j': e.preventDefault(); move(1); return;
      case 'k': e.preventDefault(); move(-1); return;
    }
    if (/^[1-8]$/.test(e.key)) { e.preventDefault(); nav(ORDER[+e.key - 1]); return; }
    const fn = row?._keys?.[e.key];
    if (fn && !(e.key === 'Enter' && onControl)) { e.preventDefault(); fn(); }
  });
  // clicking a row selects it too, so keyboard and mouse agree
  document.addEventListener('click', (e) => { const r = e.target.closest?.('[data-sel]'); if (r) { document.querySelectorAll('#view [data-sel].sel').forEach((x) => x.classList.remove('sel')); r.classList.add('sel'); } });
}
