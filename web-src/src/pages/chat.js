import { api } from '../api.js';
import { h, icon, clear, spinner, page, pictureAttach, toast } from '../ui.js';
import { md } from '../markdown.js';

const KEY = 'chat_history';
const KEEP_MS = 6 * 3600 * 1000;   // the page shows the last 6 hours; the server keeps every exchange in data/chat-log/
const fresh = (list) => list.filter((m) => m.at && Date.now() - m.at < KEEP_MS);   // (entries from before timestamps existed are dropped too)
const load = () => { try { return fresh(JSON.parse(localStorage.getItem(KEY) || '[]')); } catch { return []; } };
const SUGGEST = ['open', 'approvals'];

export default async function chat(view) {
  let hist = load();
  const msgs = h('div', { class: 'msgs' });
  const bubble = (role, text, thumbs = [], at) => {
    const b = h('div', { class: 'bubble ' + role, 'data-at': String(at ?? Date.now()) }, thumbs.length ? h('div', { class: 'bubble-pics' }, thumbs.map((t) => h('img', { src: t, alt: 'attached picture' }))) : '', text ? md(text) : '');
    msgs.append(b); msgs.scrollTop = msgs.scrollHeight; return b;
  };
  const ta = h('textarea', { 'data-primary': '', rows: 1, placeholder: 'Message… (Markdown, pictures)', 'aria-label': 'Message' });
  ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 160) + 'px'; });
  const pics = pictureAttach(ta, (m) => toast(m));
  const send = async (text) => {
    text = (text ?? ta.value).trim(); const images = pics.images(); if (!text && !images.length) return;
    const thumbs = images.map((p) => p.thumb); pics.clear();
    ta.value = ''; ta.style.height = 'auto'; hist.push({ role: 'me', text, thumbs, at: Date.now() }); bubble('me', text, thumbs);
    const wait = h('div', { class: 'bubble bot' }, spinner()); msgs.append(wait); msgs.scrollTop = msgs.scrollHeight; sendBtn.disabled = true;
    let reply;
    const pay = images.map(({ name, data }) => ({ name, data }));
    try { reply = (await api('/chat', { method: 'POST', body: { text: text || 'What is in this picture?', images: pay } })).reply; } catch (e) { reply = 'Error: ' + e.message; }
    wait.remove(); bubble('bot', reply); hist.push({ role: 'bot', text: reply, at: Date.now() });
    try { hist = fresh(hist); localStorage.setItem(KEY, JSON.stringify(hist.slice(-40))); } catch { /* storage full or blocked: history just won't persist */ } sendBtn.disabled = false; ta.focus({ preventScroll: true });
  };
  ta.addEventListener('keydown', (e) => { if (e.key === 'ArrowUp' && !ta.value) { const last = [...hist].reverse().find((m) => m.role === 'me'); if (last && last.text) { e.preventDefault(); ta.value = last.text; ta.dispatchEvent(new Event('input')); } } if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
  const sendBtn = h('md-filled-icon-button', { 'aria-label': 'Send', onclick: () => send() }, icon('send'));
  for (const m of hist) bubble(m.role, m.text, m.thumbs ?? [], m.at);
  if (!hist.length) bubble('bot', 'Hi! Tell me what\'s going on and I\'ll turn it into tickets, reminders and tasks. Ask me a question and I\'ll search your messages and files.');
  clear(view).append(h('div', { class: 'page-head' }, h('h1', { class: 'display' }, 'Chat'), h('p', { class: 'muted title-m' }, 'The same assistant you reach from Google Chat.')),
    h('div', { class: 'toolbar' }, h('div', { class: 'grow' }), h('md-text-button', { onclick: () => { hist = []; localStorage.removeItem(KEY); clear(msgs); bubble('bot', 'Cleared.'); } }, 'Clear')),
    h('div', { class: 'chat' }, msgs, h('div', {}, pics.strip, h('div', { class: 'composer' }, pics.button, ta, sendBtn), pics.input)));
  // Messages older than 6 hours disappear from the page as time passes (they stay in the server's chat log).
  const sweep = setInterval(() => { const keep = fresh(hist); if (keep.length === hist.length) return; const gone = hist.length - keep.length; hist = keep; try { localStorage.setItem(KEY, JSON.stringify(hist)); } catch { /* ignore */ }
    for (const el of [...msgs.querySelectorAll('.bubble[data-at]')]) if (Date.now() - Number(el.dataset.at) >= KEEP_MS) el.remove(); }, 60000);
  page.newAction = () => ta.focus();
  setTimeout(() => ta.focus({ preventScroll: true }), 100);
  return () => clearInterval(sweep);
}
