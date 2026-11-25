import { api } from '../api.js';
import { h, icon, clear, spinner } from '../ui.js';

const KEY = 'chat_history';
const load = () => { try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; } };
const SUGGEST = ['open', 'approvals'];

export default async function chat(view) {
  let hist = load(); let ask = false;
  const msgs = h('div', { class: 'msgs' });
  const bubble = (role, text) => { const b = h('div', { class: 'bubble ' + role }, text); msgs.append(b); msgs.scrollTop = msgs.scrollHeight; return b; };
  const ta = h('textarea', { rows: 1, placeholder: 'Tell me something, or ask a question…', 'aria-label': 'Message' });
  ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 160) + 'px'; });
  const send = async (text) => {
    text = (text ?? ta.value).trim(); if (!text) return;
    ta.value = ''; ta.style.height = 'auto'; hist.push({ role: 'me', text }); bubble('me', text);
    const wait = h('div', { class: 'bubble bot' }, spinner()); msgs.append(wait); msgs.scrollTop = msgs.scrollHeight; sendBtn.disabled = true;
    let reply;
    try { reply = ask ? (await api('/ask', { method: 'POST', body: { question: text } })).answer : (await api('/chat', { method: 'POST', body: { text } })).reply; } catch (e) { reply = 'Error: ' + e.message; }
    wait.remove(); bubble('bot', reply); hist.push({ role: 'bot', text: reply }); localStorage.setItem(KEY, JSON.stringify(hist.slice(-60))); sendBtn.disabled = false; ta.focus({ preventScroll: true });
  };
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
  const sendBtn = h('md-filled-icon-button', { 'aria-label': 'Send', onclick: () => send() }, icon('send'));
  const mode = h('div', { class: 'seg' }); const drawMode = () => clear(mode).append(...[[false, 'Capture / command'], [true, 'Ask a question']].map(([v, l]) => h('button', { 'aria-pressed': String(v === ask), onclick: () => { ask = v; drawMode(); } }, l))); drawMode();
  for (const m of hist) bubble(m.role, m.text);
  if (!hist.length) bubble('bot', 'Hi! Tell me what\'s going on and I\'ll turn it into tickets, reminders and tasks. Switch to “Ask a question” to search your messages and files.');
  clear(view).append(h('div', { class: 'page-head' }, h('h1', { class: 'display' }, 'Chat'), h('p', { class: 'muted title-m' }, 'The same assistant you reach from Google Chat.')),
    h('div', { class: 'toolbar' }, mode, h('div', { class: 'grow' }), h('md-text-button', { onclick: () => { hist = []; localStorage.removeItem(KEY); clear(msgs); bubble('bot', 'Cleared.'); } }, 'Clear')),
    h('div', { class: 'chat' }, msgs, h('div', {}, h('div', { class: 'suggest' }, SUGGEST.map((s) => h('md-assist-chip', { label: s, onclick: () => send(s) }))), h('div', { class: 'composer' }, ta, sendBtn))));
  setTimeout(() => ta.focus({ preventScroll: true }), 100);
}
