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
/** Per-page hooks for the keyboard layer: the page sets `page.newAction`; main.js resets it on every navigation. */
export const page = { newAction: null, guard: null };
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
export function dialog({ title, content, actions = [], fullscreen = false, onClose, dismissable = false }) {
  const dlg = h('md-dialog', { class: fullscreen ? 'full' : '' },
    h('div', { slot: 'headline' }, title),
    h('div', { slot: 'content' }, content),
    h('div', { slot: 'actions' }, actions));
  const close = () => dlg.close();
  dlg.addEventListener('keydown', (e) => {            // Ctrl/Cmd+Enter submits whatever the dialog's main button is
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { const b = [...dlg.querySelectorAll('[slot=actions] md-filled-button')].pop(); if (b && !b.disabled) { e.preventDefault(); b.click(); } }
  });
  // A click on the dimmed area must not throw away what you typed; Esc and the Close/Cancel buttons still work.
  let escAt = 0; dlg.addEventListener('keydown', (e) => { if (e.key === 'Escape') escAt = Date.now(); });
  if (!dismissable) dlg.addEventListener('cancel', (e) => { if (Date.now() - escAt > 400) e.preventDefault(); });
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

/** "in 3 days", "yesterday", "5 hours ago" — the exact date goes in a tooltip next to it. */
export function rel(iso) {
  const ms = new Date(iso) - Date.now(), a = Math.abs(ms), f = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  if (a < 6e4) return 'now';
  if (a < 36e5) return f.format(Math.round(ms / 6e4), 'minute');
  if (a < 864e5) return f.format(Math.round(ms / 36e5), 'hour');
  if (a < 45 * 864e5) return f.format(Math.round(ms / 864e5), 'day');
  if (a < 540 * 864e5) return f.format(Math.round(ms / (30.4 * 864e5)), 'month');
  return f.format(Math.round(ms / (365 * 864e5)), 'year');
}
export function download(name, text, type) {
  const a = h('a', { href: URL.createObjectURL(new Blob([text], { type })), download: name }); document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

/** Floating action button: labelled on wide screens, icon-only on phones (so it covers as little of the list as possible). */
export const fab = (label, ariaLabel, onclick) => h('md-fab', { ...(matchMedia('(max-width: 839px)').matches ? {} : { label }), 'aria-label': ariaLabel, onclick }, h('span', { slot: 'icon' }, icon('add')));

// ---- pictures for chat boxes ----
const MAX_SIDE = 1600, MAX_PICS = 5;
/** Reads an image file, shrinks it (long side ≤1600px) and returns {name, data (base64), url (preview), thumb}. GIFs/WebP become a still PNG/JPEG. */
export async function prepareImage(file) {
  if (!/^image\/(png|jpe?g|gif|webp)$/.test(file.type)) throw new Error(`“${file.name || 'That file'}” is not a PNG, JPEG, GIF or WebP picture.`);
  const bmp = await createImageBitmap(file).catch(() => { throw new Error(`I couldn't read “${file.name || 'that picture'}”.`); });
  const k = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  const draw = (s) => { const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(bmp.width * s)); c.height = Math.max(1, Math.round(bmp.height * s)); const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.drawImage(bmp, 0, 0, c.width, c.height); return c; };
  const png = file.type === 'image/png' && k === 1 && file.size < 1.5e6;
  const big = draw(k); const full = png ? big.toDataURL('image/png') : big.toDataURL('image/jpeg', 0.85);
  const thumb = draw(Math.min(1, 160 / Math.max(bmp.width, bmp.height))).toDataURL('image/jpeg', 0.7); bmp.close?.();
  return { name: (file.name || 'picture').replace(/\.[^.]+$/, '') + (png ? '.png' : '.jpg'), data: full.split(',')[1], url: full, thumb };
}
/**
 * Picture attaching for a text box: a 📎 button, paste and drag-and-drop. `onError(msg)` reports problems.
 * Returns {button, strip, images(), clear()}: put `button` and `strip` wherever they fit; send `images()` with the text.
 */
export function pictureAttach(target, onError = () => {}) {
  let pics = []; const strip = h('div', { class: 'pics', hidden: true });
  const input = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp', multiple: true, hidden: true, 'aria-label': 'Choose pictures' });
  const draw = () => { strip.replaceChildren(...pics.map((p, n) => h('div', { class: 'pic' }, h('img', { src: p.thumb, alt: p.name }), h('button', { type: 'button', 'aria-label': `Remove ${p.name}`, onclick: () => { pics.splice(n, 1); draw(); } }, icon('close'))))); strip.hidden = !pics.length; };
  const add = async (files) => { for (const f of files) { if (pics.length >= MAX_PICS) { onError(`At most ${MAX_PICS} pictures per message.`); break; } try { pics.push(await prepareImage(f)); draw(); } catch (e) { onError(e.message); } } };
  input.addEventListener('change', async () => { await add([...input.files]); input.value = ''; });
  const button = h('md-icon-button', { 'aria-label': 'Attach pictures', title: 'Attach pictures (or paste / drop them)', onclick: () => input.click() }, icon('attach_file'));
  target.addEventListener('paste', (e) => { const fs = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/')); if (fs.length) { e.preventDefault(); add(fs); } });
  const host = target.closest?.('.composer, .form') ?? target;
  host.addEventListener('dragover', (e) => { if ([...(e.dataTransfer?.types ?? [])].includes('Files')) { e.preventDefault(); host.classList.add('drop'); } });
  host.addEventListener('dragleave', () => host.classList.remove('drop'));
  host.addEventListener('drop', (e) => { host.classList.remove('drop'); const fs = [...(e.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith('image/')); if (fs.length) { e.preventDefault(); add(fs); } });
  return { button, strip, input, images: () => pics.slice(), clear: () => { pics = []; draw(); } };
}
