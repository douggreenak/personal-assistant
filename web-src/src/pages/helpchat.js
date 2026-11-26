import { api } from '../api.js';
import { h, icon, spinner, pictureAttach, toast } from '../ui.js';
import { md } from '../markdown.js';

/** A small help chat for connecting services: ask a question, attach a screenshot of what you see, get the next step.
 *  `topic` is the connection being set up (gmail, chat, …) so the answer matches that guide. History lives only in this panel. */
export function helpChat(topic) {
  const turns = []; const msgs = h('div', { class: 'help-msgs', 'aria-live': 'polite' });
  const bubble = (role, text, thumbs = []) => { const b = h('div', { class: 'bubble ' + role }, thumbs.length ? h('div', { class: 'bubble-pics' }, thumbs.map((t) => h('img', { src: t, alt: 'screenshot' }))) : '', text ? md(text) : ''); msgs.append(b); msgs.scrollTop = msgs.scrollHeight; return b; };
  const ta = h('textarea', { rows: 1, placeholder: 'Ask for help… paste or attach a screenshot of what you see', 'aria-label': 'Ask for help' });
  ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 120) + 'px'; });
  const pics = pictureAttach(ta, (m) => toast(m));
  const sendBtn = h('md-filled-icon-button', { 'aria-label': 'Send', onclick: () => send() }, icon('send'));
  async function send() {
    const question = ta.value.trim(); const images = pics.images(); if (!question && !images.length) return;
    bubble('me', question, images.map((p) => p.thumb)); const history = turns.slice(-6); turns.push({ role: 'me', text: question });
    ta.value = ''; ta.style.height = 'auto'; pics.clear(); sendBtn.disabled = true;
    const wait = bubble('bot', ''); wait.append(spinner('Thinking'));
    let reply; try { reply = (await api('/help', { method: 'POST', body: { question, topic, history, images: images.map(({ name, data }) => ({ name, data })) } })).answer; } catch (e) { reply = 'Error: ' + e.message; }
    wait.remove(); bubble('bot', reply); turns.push({ role: 'bot', text: reply }); sendBtn.disabled = false; ta.focus({ preventScroll: true });
  }
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
  return h('div', { class: 'help-chat' }, h('h3', { class: 'title-m' }, icon('support_agent'), ' Stuck? Ask for help'),
    h('p', { class: 'muted s' }, 'Describe what you see or attach a screenshot, and I\'ll tell you what to do next. Don\'t include keys or secrets in the screenshot if you can avoid it.'),
    msgs, pics.strip, h('div', { class: 'composer' }, pics.button, ta, sendBtn), pics.input);
}
