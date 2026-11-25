import icons from './icons.generated.js';

/** Tiny DOM helper: h('div', {class:'x', onclick}, child, 'text'). Text is always added as text nodes (never HTML). */
export function h(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'value' || k === 'checked' || k === 'selected' || k === 'disabled') e[k] = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  add(e, kids); return e;
}
function add(e, kids) {
  const btn = /^MD-(FILLED|FILLED-TONAL|OUTLINED|TEXT)-BUTTON$/.test(e.tagName);       // icons inside Material buttons belong in the icon slot
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) {
    if (btn && c.nodeType && c.namespaceURI === 'http://www.w3.org/2000/svg') c.setAttribute('slot', 'icon');
    e.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
}
export const clear = (e) => { e.replaceChildren(); return e; };

export function icon(name, cls = '') {
  const d = icons[name] ?? icons[name.replace(/-fill$/, '')];
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 -960 960 960'); s.setAttribute('class', 'ic ' + cls); s.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path'); p.setAttribute('d', d || ''); s.append(p);
  return s;
}

// ---- formatting (all in the server's time zone) ----
export const state = { tz: Intl.DateTimeFormat().resolvedOptions().timeZone };
export const fmtDate = (iso, opts = { dateStyle: 'medium', timeStyle: 'short' }) => (iso ? new Intl.DateTimeFormat([], { timeZone: state.tz, ...opts }).format(new Date(iso)) : '');
export function ago(iso) {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000), a = Math.abs(s);
  const u = a < 60 ? [a, 's'] : a < 3600 ? [Math.round(a / 60), 'm'] : a < 86400 ? [Math.round(a / 3600), 'h'] : [Math.round(a / 86400), 'd'];
  return s >= 0 ? `${u[0]}${u[1]} ago` : `in ${u[0]}${u[1]}`;
}
/** ISO instant -> value for <input type=datetime-local> in the server's zone. */
export function toLocalInput(iso) {
  if (!iso) return '';
  return new Intl.DateTimeFormat('sv-SE', { timeZone: state.tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso)).replace(' ', 'T');
}

// ---- toasts ----
let toastBox;
export function toast(text, { action, onAction, error } = {}) {
  toastBox ??= document.body.appendChild(h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' }));
  const t = h('div', { class: 'toast' + (error ? ' error' : '') }, h('span', {}, text), action && h('md-text-button', { onclick: () => { onAction?.(); t.remove(); } }, action));
  toastBox.append(t); setTimeout(() => t.classList.add('out'), error ? 6500 : 3800); setTimeout(() => t.remove(), error ? 7000 : 4300);
}
export async function guarded(fn, okMsg) {
  try { const r = await fn(); if (okMsg) toast(okMsg); return r; } catch (e) { if (e.message !== 'Signed out') toast(e.message, { error: true }); return undefined; }
}

// ---- dialogs ----
/** Opens an md-dialog; `build(close)` returns {content, actions}. Resolves when closed. */
export function dialog({ title, content, actions = [], fullscreen = false, onClose }) {
  const dlg = h('md-dialog', { class: fullscreen ? 'full' : '' },
    h('div', { slot: 'headline' }, title),
    h('div', { slot: 'content' }, content),
    h('div', { slot: 'actions' }, actions));
  const close = () => dlg.close();
  dlg.addEventListener('closed', () => { dlg.remove(); onClose?.(); });
  document.body.append(dlg); dlg.show();
  return { dlg, close };
}
export function confirmDialog(title, text, okLabel = 'Confirm') {
  return new Promise((res) => {
    let result = false;
    const { close } = dialog({ title, content: h('p', {}, text), onClose: () => res(result), actions: [
      h('md-text-button', { onclick: () => close() }, 'Cancel'),
      h('md-filled-button', { onclick: () => { result = true; close(); } }, okLabel)] });
  });
}

// ---- small components ----
export const spinner = (label = 'Loading') => h('div', { class: 'wavy', role: 'progressbar', 'aria-label': label }, h('span'), h('span'), h('span'), h('span'), h('span'));
export const empty = (iconName, title, sub) => h('div', { class: 'empty' }, h('div', { class: 'empty-art' }, icon(iconName)), h('div', { class: 'title-m' }, title), sub && h('div', { class: 'muted' }, sub));
export const chip = (text, cls = '') => h('span', { class: 'tag ' + cls }, text);
export function field(label, props = {}, type = 'md-outlined-text-field') {
  const f = h(type, { label, ...props }); return f;
}
export function menu(anchorBtn, entries) {
  const id = 'm' + Math.random().toString(36).slice(2, 8);
  anchorBtn.id = id;
  const m = h('md-menu', { anchor: id, 'positioning': 'popover' }, entries.map((e) => h('md-menu-item', { onclick: e.onclick }, h('div', { slot: 'headline' }, e.label), e.icon && h('span', { slot: 'start' }, icon(e.icon)))));
  anchorBtn.addEventListener('click', (ev) => { ev.stopPropagation(); m.open = !m.open; });
  return m;
}
export const debounce = (fn, ms = 250) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
