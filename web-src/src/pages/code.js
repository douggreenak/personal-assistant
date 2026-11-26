import { api, getToken } from '../api.js';
import { h, icon, clear, spinner, empty, chip, dialog, confirmDialog, toast, guarded, ago, fmtDate, pictureAttach, menu } from '../ui.js';
import { md } from '../markdown.js';
import { prepareImage } from '../ui.js';

// Code tab: Claude Code agents running in tmux, with a web-style conversation view. Separate from the assistant's own chat.
const LAST = 'code_last_project';
const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } };
const kfmt = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'k' : String(Math.round(n || 0)));
const usd = (n) => '$' + (n < 10 ? n.toFixed(2) : n.toFixed(0));
const STATE = { stopped: ['Stopped', ''], idle: ['Ready', 'ok'], working: ['Working', 'warn'], permission: ['Needs you', 'bad'], dialog: ['Needs you', 'bad'], unknown: ['Running', ''] };
const stateChip = (s, running) => { const [t, c] = running === false ? STATE.stopped : STATE[s] || STATE.unknown; return h('span', { class: 'tag code-state ' + c, 'data-state': running === false ? 'stopped' : s }, t); };
const route = () => { const m = /^#\/code(?:\/(p|s|u|t)(?:\/([\w-]+))?)?/.exec(location.hash) || []; return { kind: m[1] || '', id: m[2] || '' }; };
const go = (path) => { location.hash = '#/code' + (path ? '/' + path : ''); };

export default async function code(view) {
  const status = await api('/code/status');
  const timers = []; const cleanup = () => timers.forEach(clearInterval);
  if (!status.enabled) { clear(view).append(head(), h('div', { class: 'card' }, empty('terminal', 'The Code tab is turned off', 'Turn it on in Settings → Code.'))); return cleanup; }
  const { projects } = await api('/code/projects'); const r = route();

  // ---- tabs: one per project, then Usage and Server ----
  const tabs = h('div', { class: 'seg code-tabs', role: 'tablist', 'aria-label': 'Projects' });
  const curProject = r.kind === 'p' ? r.id : r.kind === 's' ? projects.find((p) => p.sessions.some((s) => s.id === r.id))?.id : null;
  const add = (label, on, path, id) => tabs.append(h('button', { role: 'tab', 'aria-pressed': String(on), 'data-tab': id || path, onclick: () => go(path) }, label));
  for (const p of projects) add(p.name, curProject === p.id, 'p/' + p.id, p.id);
  add('Usage', r.kind === 'u', 'u'); add('Server', r.kind === 't', 't');
  tabs.append(h('button', { class: 'code-add', 'aria-label': 'Add a project', onclick: () => addProjectDialog(), title: 'Add a project' }, icon('add'), ' Project'));
  const body = h('div', { class: 'code-body' });
  clear(view).append(head(!status.tmux), tabs, body);

  if (r.kind === 'u') usagePage(body, timers);
  else if (r.kind === 't') serverPage(body, status, timers);
  else if (r.kind === 's') await sessionPage(body, r.id, projects, status, timers);
  else {
    const pid = r.kind === 'p' ? r.id : (projects.find((p) => p.id === lsGet(LAST)) || projects[0])?.id;
    if (!pid) clear(body).append(h('div', { class: 'card' }, empty('terminal', 'No projects yet', 'A project is a folder Claude Code works in. Add one to start sessions.'), h('div', { style: 'text-align:center;margin-top:12px' }, h('md-filled-button', { onclick: () => addProjectDialog() }, icon('add'), 'Add a project'))));
    else { lsSet(LAST, pid); projectPage(body, projects.find((p) => p.id === pid), status, timers); }
  }
  return cleanup;

  function head(warn) { return h('div', { class: 'page-head' }, h('h1', { class: 'display' }, 'Code'), h('p', { class: 'muted title-m' }, 'Claude Code agents in tmux — separate from the assistant. Each session is a real terminal session you can also reach with `tmux`.'),
    warn ? h('div', { class: 'card high', style: 'border-left:4px solid var(--md-sys-color-error)' }, h('b', {}, 'tmux is not installed on the server'), h('p', { class: 'muted' }, 'Sessions cannot run until it is. In Docker, rebuild the image (it installs tmux).')) : ''); }

  // ---- add project ----
  function addProjectDialog() {
    let cwd = ''; const list = h('div', { class: 'list code-folders' }); const where = h('div', { class: 'mono muted' });
    const folder = h('md-outlined-text-field', { label: 'Folder (inside the projects folder)', 'data-primary': '', placeholder: 'my-app', 'supporting-text': `Projects live under ${status.root}` });
    const name = h('md-outlined-text-field', { label: 'Name (optional)' }); const clone = h('md-outlined-text-field', { label: 'Clone from a Git URL (optional, https://…)', placeholder: 'https://github.com/you/repo.git' });
    const create = h('md-switch', { selected: true, 'aria-label': 'Create the folder if it does not exist' });
    async function browse(rel) { const j = await guarded(() => api('/code/folders?path=' + encodeURIComponent(rel))); if (!j) return; cwd = j.path; where.textContent = '/' + (j.path || '');
      clear(list).append(...(j.parent !== null ? [h('div', { class: 'row static code-dir', onclick: () => browse(j.parent) }, icon('arrow_back'), ' ..')] : []), ...j.dirs.map((d) => h('div', { class: 'row static code-dir', 'data-dir': d.rel, onclick: () => { folder.value = d.rel; browse(d.rel); } }, icon('folder'), ' ', d.name)), ...(j.dirs.length ? [] : [h('div', { class: 'muted s', style: 'padding:8px' }, 'No sub-folders here.')])); }
    const { close } = dialog({ title: 'Add a project', content: h('div', { class: 'form' }, folder, h('div', { class: 'field-row' }, h('div', {}, h('div', { class: 't' }, 'Create the folder if it does not exist')), create), name, clone, h('div', { class: 'label' }, 'Or pick an existing folder'), where, list),
      actions: [h('md-text-button', { onclick: () => close() }, 'Cancel'), h('md-filled-button', { onclick: async () => {
        const j = await guarded(() => api('/code/projects', { method: 'POST', body: { folder: folder.value, name: name.value, create: create.selected, cloneUrl: clone.value.trim() || undefined } }), 'Project added'); if (j) { close(); lsSet(LAST, j.project.id); go('p/' + j.project.id); } } }, 'Add')] });
    browse('');
  }

  // ---- one project: its sessions ----
  function projectPage(el, p, st, tm) {
    const list = h('div', { class: 'list' });
    const draw = (ps) => { const rows = ps.sessions; clear(list).append(...(rows.length ? rows.map((s) => sessionRow(p, s)) : [empty('terminal', 'No sessions yet', 'Start one to talk to Claude Code in this folder.')])); };
    const menuBtn = h('md-icon-button', { 'aria-label': 'Project options' }, icon('more_horiz'));
    clear(el).append(h('div', { class: 'card high' }, h('div', { class: 'code-ph' }, h('div', { class: 'lead k-task' }, icon('code')), h('div', { style: 'flex:1 1 200px;min-width:0' }, h('div', { class: 'title-m' }, p.name), h('div', { class: 'mono muted', style: 'overflow-wrap:anywhere' }, p.path)),
      h('md-filled-button', { onclick: () => newSessionDialog(p, st) }, icon('add'), 'New session'), menuBtn), list));
    menu(menuBtn, [['Rename project', () => renameDialog('Rename project', p.name, (n) => api('/code/projects/' + p.id, { method: 'PATCH', body: { name: n } }), () => go('p/' + p.id))],
      ['Remove project', async () => { if (await confirmDialog('Remove this project?', 'Its running sessions are stopped and it disappears from here. The folder and the conversations on disk are not touched.', 'Remove')) { await guarded(() => api('/code/projects/' + p.id, { method: 'DELETE' }), 'Project removed'); go(''); } }]]);
    draw(p);
    const tick = async () => { if (document.hidden || document.querySelector('md-dialog[open]')) return; try { const j = await api('/code/projects'); const np = j.projects.find((x) => x.id === p.id); if (np) draw(np); } catch { /* retry */ } };
    tm.push(setInterval(tick, 4000));
  }
  function sessionRow(p, s) {
    const title = s.aiTitle || s.title;
    return h('div', { class: 'row code-session', 'data-session': s.id, tabindex: 0, onclick: (e) => { if (!e.target.closest('md-text-button,md-icon-button,md-filled-tonal-button')) go('s/' + s.id); } },
      h('div', { class: 'lead k-task' }, icon('terminal')),
      h('div', { class: 'body' }, h('div', { class: 't' }, title), h('div', { class: 's' }, [s.permissionMode || 'default mode', s.model || 'default model', s.startedAt ? 'started ' + ago(s.startedAt) : 'not started yet'].join(' · '))),
      h('div', { class: 'acts' }, stateChip(s.state, s.running),
        s.running ? h('md-text-button', { onclick: async () => { await guarded(() => api(`/code/sessions/${s.id}/stop`, { method: 'POST' }), 'Stopped'); go('p/' + p.id); location.reload(); } }, icon('stop'), 'Stop')
          : h('md-text-button', { onclick: async () => { const ok = await guarded(() => api(`/code/sessions/${s.id}/start`, { method: 'POST', body: {} }), 'Started'); if (ok) go('s/' + s.id); } }, icon('play_arrow'), 'Start')));
  }
  function newSessionDialog(p, st) {
    const title = h('md-outlined-text-field', { label: 'Name (optional)', 'data-primary': '' });
    const mode = h('md-outlined-select', { label: 'Permissions' }, h('md-select-option', { value: '', selected: true }, h('div', { slot: 'headline' }, 'Default (asks before risky steps)')), ...st.modes.map((m) => h('md-select-option', { value: m }, h('div', { slot: 'headline' }, { manual: 'Manual — ask for everything', acceptEdits: 'Accept edits automatically', auto: 'Auto — Claude judges risk', plan: 'Plan only — no changes', dontAsk: "Don't ask", bypassPermissions: 'Bypass permissions (dangerous)' }[m] || m))));
    const model = h('md-outlined-select', { label: 'Model' }, ...[['', 'Default'], ['sonnet', 'Sonnet'], ['opus', 'Opus'], ['haiku', 'Haiku']].map(([v, l]) => h('md-select-option', { value: v, selected: v === '' || undefined }, h('div', { slot: 'headline' }, l))));
    const prompt = h('md-outlined-text-field', { label: 'First message (optional)', type: 'textarea', rows: 4 });
    const { close } = dialog({ title: 'New session', content: h('div', { class: 'form' }, title, mode, model, prompt, h('div', { class: 'help' }, 'A session is a Claude Code conversation running in its own tmux session in this project\'s folder. You can stop and start it any time; starting it again picks the conversation up where it was.')),
      actions: [h('md-text-button', { onclick: () => close() }, 'Cancel'), h('md-filled-button', { onclick: async () => {
        const j = await guarded(() => api(`/code/projects/${p.id}/sessions`, { method: 'POST', body: { title: title.value, permissionMode: mode.value, model: model.value, prompt: prompt.value.trim() || undefined } })); if (j) { close(); go('s/' + j.session.id); } } }, 'Start')] });
  }
  function renameDialog(titleText, cur, call, done) {
    const f = h('md-outlined-text-field', { label: 'Name', value: cur, 'data-primary': '' });
    const { close } = dialog({ title: titleText, content: f, actions: [h('md-text-button', { onclick: () => close() }, 'Cancel'), h('md-filled-button', { onclick: async () => { const ok = await guarded(() => call(f.value), 'Renamed'); if (ok) { close(); done(); } } }, 'Save')] });
  }

  // ---- Server: every tmux session ----
  function serverPage(el, st, tm) {
    const box = h('div', { class: 'list' });
    const draw = async () => { const j = await guarded(() => api('/code/tmux')); if (!j) return;
      clear(box).append(...(j.sessions.length ? j.sessions.map((t) => h('div', { class: 'row static', 'data-tmux': t.name }, h('div', { class: 'lead k-task' }, icon('terminal')), h('div', { class: 'body' }, h('div', { class: 't' }, t.title || t.name), h('div', { class: 's mono' }, `tmux session ${t.name}${t.known ? '' : ' (not in the app)'}`)),
        h('div', { class: 'acts' }, t.sessionId ? h('md-text-button', { onclick: () => go('s/' + t.sessionId) }, 'Open') : '', h('md-text-button', { onclick: async () => { if (await confirmDialog('Stop this tmux session?', 'The terminal and anything running in it ends. A session from this app can be started again later and resumes its conversation.', 'Stop')) { await guarded(() => api(`/code/tmux/${t.name}/kill`, { method: 'POST' }), 'Stopped'); draw(); } } }, icon('stop'), 'Stop')))) : [empty('terminal', 'Nothing is running', 'Start a session from a project tab.')])); };
    clear(el).append(h('div', { class: 'card high' }, h('h2', {}, icon('dns'), 'Running tmux sessions'), h('p', { class: 'muted' }, `Up to ${st.maxSessions} sessions can run at once. They live in the assistant's container: restarting the assistant ends them, and the ones that were running are started again (conversation resumed) afterwards.`), box,
      st.allowBypass ? h('p', { class: 'muted' }, '“Bypass permissions” mode is allowed (Settings → Code).') : ''));
    draw(); tm.push(setInterval(() => { if (!document.hidden) draw(); }, 4000));
  }

  // ---- Usage ----
  function usagePage(el, tm) {
    const planBox = h('div', {}, spinner('Reading plan usage')); const tokBox = h('div', {});
    const loadPlan = async (force) => { clear(planBox).append(spinner('Reading plan usage')); try { const p = await api('/code/usage/plan' + (force ? '?force=1' : ''));
      clear(planBox).append(...(p.data ? [...p.data.sections.map((s) => h('div', { class: 'ubar' }, h('div', { class: 'field-row' }, h('div', { class: 't' }, s.label), h('div', { class: 'muted' }, s.percent + '% used' + (s.resets ? ' · resets ' + s.resets : ''))), h('div', { class: 'bar', role: 'progressbar', 'aria-valuenow': s.percent, 'aria-label': s.label }, h('div', { style: `width:${Math.min(100, s.percent)}%`, class: s.percent >= 90 ? 'hot' : '' })))),
        h('div', { class: 'help' }, `Read from Claude Code's /usage screen ${p.cached ? '(cached) ' : ''}at ${fmtDate(new Date(p.at).toISOString())}. Reading it costs nothing.`)] : [h('div', { class: 'err' }, p.error || 'Not available.')])); } catch (e) { clear(planBox).append(h('div', { class: 'err' }, e.message)); } };
    const loadTok = async () => { const u = await guarded(() => api('/code/usage?days=14')); if (!u) return;
      const max = Math.max(1, ...u.days.map((d) => d.input + d.output + d.cacheWrite));
      const tot = (x) => `${kfmt(x.input + x.output)} in/out · ${kfmt(x.cacheRead + x.cacheWrite)} cached · ≈${usd(x.cost)}`;
      const table = (rows, label) => h('table', { class: 'utable' }, h('thead', {}, h('tr', {}, h('th', {}, label), h('th', {}, 'Tokens in/out'), h('th', {}, 'Cached'), h('th', {}, 'Est. cost'))), h('tbody', {}, rows.length ? rows.map((r) => h('tr', {}, h('td', {}, r.key ?? r.title + ' · ' + r.project), h('td', {}, kfmt((r.input ?? 0) + (r.output ?? 0) || r.tokens)), h('td', {}, kfmt((r.cacheRead ?? 0) + (r.cacheWrite ?? 0))), h('td', {}, usd(r.cost)))) : [h('tr', {}, h('td', { colspan: 4, class: 'muted' }, 'Nothing yet.'))]));
      clear(tokBox).append(h('div', { class: 'grid cols-3' }, ['Today', 'Last 7 days', 'All time'].map((l, i) => { const x = [u.today, u.week, u.total][i]; return h('div', { class: 'card ucard' }, h('div', { class: 'muted' }, l), h('div', { class: 'title-l' }, kfmt(x.input + x.output + x.cacheRead + x.cacheWrite) + ' tokens'), h('div', { class: 'muted s' }, tot(x))); })),
        h('div', { class: 'card' }, h('h2', {}, icon('bar_chart'), 'Last 14 days'), h('div', { class: 'chart', role: 'img', 'aria-label': 'Tokens per day' }, u.days.map((d) => h('div', { class: 'col', title: `${d.day}: ${kfmt(d.input + d.output + d.cacheWrite)} tokens (≈${usd(d.cost)})` }, h('div', { class: 'bar', style: `height:${Math.max(2, Math.round(((d.input + d.output + d.cacheWrite) / max) * 100))}%` }), h('div', { class: 'lbl' }, d.day.slice(8))))),
          h('div', { class: 'help' }, 'Counted from the conversation files of sessions run here (each API message once). Cost is an estimate from list prices — a subscription is not billed per token.')),
        h('div', { class: 'grid cols-2' }, h('div', { class: 'card' }, h('h2', {}, 'By project'), table(u.byProject, 'Project')), h('div', { class: 'card' }, h('h2', {}, 'By model'), table(u.byModel, 'Model'))),
        h('div', { class: 'card' }, h('h2', {}, 'Busiest sessions'), table(u.sessions, 'Session'))); };
    clear(el).append(h('div', { class: 'card high' }, h('h2', {}, icon('speed'), 'Plan limits', h('span', { class: 'grow' }), h('md-text-button', { onclick: () => loadPlan(true) }, icon('refresh'), 'Refresh')), planBox), tokBox);
    loadPlan(false); loadTok(); tm.push(setInterval(() => { if (!document.hidden) loadTok(); }, 20000));
  }

  // ---- a session: conversation, terminal, composer ----
  async function sessionPage(el, sid, projects, st, tm) {
    const info = await guarded(() => api('/code/sessions/' + sid)); if (!info) { go(''); return; }
    const { session: s, project: p } = info; lsSet(LAST, p.id);
    let title = s.aiTitle || s.title, running = false, scr = null, after = 0, view = 'chat', started = false, hidden = 0, stick = true;
    const msgs = h('div', { class: 'msgs code-msgs', role: 'log', 'aria-live': 'polite' }); const tools = new Map();
    const stateEl = h('span', {}); const infoEl = h('div', { class: 'muted s code-info' }); const titleEl = h('h2', { class: 'code-title' }, title);
    const permBox = h('div', {}); const term = h('pre', { class: 'term', 'aria-label': 'Terminal' }, ''); const termKeys = h('div', { class: 'term-keys' });
    const ta = h('textarea', { rows: 1, 'data-primary': '', placeholder: 'Message Claude Code…  (Enter to send, Shift+Enter for a new line)', 'aria-label': 'Message' });
    const grow = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 200) + 'px'; }; ta.addEventListener('input', grow);
    const pics = pictureAttach(ta, (m) => toast(m)); pics.input.accept = 'image/*';
    const sendBtn = h('md-filled-icon-button', { 'aria-label': 'Send', onclick: () => send() }, icon('send'));
    const startBtn = h('md-filled-button', { onclick: async () => { await guarded(() => api(`/code/sessions/${sid}/start`, { method: 'POST', body: {} }), 'Starting…'); poll(); } }, icon('play_arrow'), 'Start session');
    const composer = h('div', { class: 'composer code-composer' }, pics.button, ta, sendBtn);

    async function send(text) {
      text = (text ?? ta.value).trim(); const images = pics.images(); if (!text && !images.length) return; sendBtn.disabled = true;
      try {
        let full = text; for (const im of images) { const r = await fetchUpload(im); full = `${full}${full ? '\n' : ''}@${r.path}`; }
        await api(`/code/sessions/${sid}/send`, { method: 'POST', body: { text: full } }); ta.value = ''; grow(); pics.clear(); stick = true; poll();
      } catch (e) { toast(e.message, { error: true }); } finally { sendBtn.disabled = false; ta.focus({ preventScroll: true }); }
    }
    async function fetchUpload(im) { const bytes = Uint8Array.from(atob(im.data), (c) => c.charCodeAt(0)); return api(`/code/sessions/${sid}/upload?name=${encodeURIComponent(im.name)}`, { method: 'POST', raw: bytes }); }
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } });
    const key = async (...keys) => { await guarded(() => api(`/code/sessions/${sid}/keys`, { method: 'POST', body: { keys } })); poll(); };

    // header
    const act = (label, ic, fn, cls = 'md-outlined-button') => h(cls, { onclick: fn }, icon(ic), label);
    const headBtns = h('div', { class: 'code-head-btns' });
    const drawHead = () => { clear(headBtns).append(running ? act('Stop', 'stop', async () => { if (await confirmDialog('Stop this session?', 'The tmux session ends. Start it again later and the conversation resumes.', 'Stop')) { await guarded(() => api(`/code/sessions/${sid}/stop`, { method: 'POST' }), 'Stopped'); poll(); } }) : startBtn,
      running ? act('Restart', 'refresh', async () => { await guarded(() => api(`/code/sessions/${sid}/restart`, { method: 'POST' }), 'Restarted'); poll(); }) : '',
      h('md-icon-button', { id: 'sessMenu', 'aria-label': 'More' }, icon('more_horiz')));
      menu(headBtns.querySelector('#sessMenu'), [['Rename', () => renameDialog('Rename session', title, (n) => api('/code/sessions/' + sid, { method: 'PATCH', body: { title: n } }), () => { titleEl.textContent = title = ''; location.reload(); })],
        ['Delete session', async () => { if (await confirmDialog('Delete this session?', 'It is stopped and removed from the list. The conversation file stays on disk.', 'Delete')) { await guarded(() => api('/code/sessions/' + sid, { method: 'DELETE' }), 'Deleted'); go('p/' + p.id); } }]]); };
    const seg = h('div', { class: 'seg' }); const drawSeg = () => clear(seg).append(...[['chat', 'Conversation'], ['term', 'Terminal']].map(([v, l]) => h('button', { 'aria-pressed': String(view === v), 'data-view': v, onclick: () => { view = v; drawSeg(); layout(); if (v === 'term') pollTerm(); } }, l))); drawSeg();
    const chatPane = h('div', { class: 'code-chat' }, msgs, permBox);
    const termPane = h('div', { class: 'code-term' }, term, termKeys, h('div', { class: 'code-term-send' }, (() => { const f = h('md-outlined-text-field', { label: 'Type into the terminal', class: 'grow' }); const go2 = async (enter) => { const t = f.value; f.value = ''; await guarded(() => api(`/code/sessions/${sid}/keys`, { method: 'POST', body: { text: t, keys: enter ? ['Enter'] : undefined } })); pollTerm(); }; f.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go2(true); } }); return [f, h('md-filled-tonal-button', { onclick: () => go2(true) }, 'Send + Enter'), h('md-text-button', { onclick: () => go2(false) }, 'Type only')]; })()));
    for (const [l, k] of [['Enter', 'Enter'], ['Esc', 'Escape'], ['↑', 'Up'], ['↓', 'Down'], ['←', 'Left'], ['→', 'Right'], ['Tab', 'Tab'], ['⇧Tab', 'BTab'], ['Ctrl+C', 'C-c'], ['1', '1'], ['2', '2'], ['3', '3'], ['y', 'y'], ['n', 'n']]) termKeys.append(h('md-outlined-button', { 'data-key': k, onclick: () => key(k) }, l));
    const quick = h('div', { class: 'code-quick' }, ...[['Interrupt', 'stop', () => key('Escape')], ['Cycle mode', 'sync', () => key('BTab')], ['/compact', 'inventory_2', () => send('/compact')], ['/clear', 'delete', () => send('/clear')]].map(([l, ic, fn]) => h('md-assist-chip', { label: l, onclick: fn })));
    const layout = () => { chatPane.hidden = view !== 'chat'; termPane.hidden = view !== 'term'; composer.hidden = view !== 'chat' || !running; quick.hidden = view !== 'chat' || !running; startNote.hidden = running; };
    const startNote = h('div', { class: 'card code-stopped' }, h('b', {}, 'This session is stopped.'), h('span', { class: 'muted' }, ' Start it to continue the conversation — everything said so far is kept.'));
    clear(el).append(h('div', { class: 'card high code-session-head' }, h('div', { class: 'code-ph' }, h('md-icon-button', { 'aria-label': 'Back to ' + p.name, onclick: () => go('p/' + p.id) }, icon('arrow_back')), h('div', { style: 'flex:1 1 180px;min-width:0' }, titleEl, h('div', { class: 'muted s' }, p.name + ' · ' + (s.permissionMode || 'default permissions') + (s.model ? ' · ' + s.model : ''))), stateEl, headBtns), infoEl, seg),
      chatPane, termPane, startNote, quick, composer, pics.strip, pics.input); drawHead(); layout();

    // rendering the conversation
    const near = () => msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 80;
    msgs.addEventListener('scroll', () => { stick = near(); });
    const fileOf = (i) => String(i.file_path || i.path || i.notebook_path || '');
    const toolBody = (b) => { const i = b.input || {}; const n = b.name;
      if (n === 'Bash') return h('pre', { class: 'code-pre' }, i.command || '');
      if (n === 'Edit' || n === 'MultiEdit') { const eds = n === 'Edit' ? [i] : i.edits || []; return h('div', {}, eds.slice(0, 6).map((e) => h('pre', { class: 'code-pre diff' }, ...String(e.old_string ?? '').split('\n').slice(0, 40).map((l) => h('div', { class: 'del' }, '- ' + l)), ...String(e.new_string ?? '').split('\n').slice(0, 40).map((l) => h('div', { class: 'add' }, '+ ' + l))))); }
      if (n === 'Write') return h('pre', { class: 'code-pre' }, String(i.content ?? '').split('\n').slice(0, 60).join('\n'));
      if (n === 'TodoWrite') return h('ul', { class: 'code-todos' }, (i.todos || []).map((t) => h('li', { class: t.status }, (t.status === 'completed' ? '☑ ' : t.status === 'in_progress' ? '◐ ' : '☐ ') + (t.content || ''))));
      return h('pre', { class: 'code-pre' }, JSON.stringify(i, null, 2).slice(0, 2500)); };
    const toolSummary = (b) => { const i = b.input || {}; return b.name === 'Bash' ? String(i.description || i.command || '').split('\n')[0] : fileOf(i) || i.pattern || i.query || i.url || i.description || i.prompt?.slice?.(0, 80) || ''; };
    function addMsg(m) {
      if (m.t === 'title') { title = m.title; titleEl.textContent = title; return; }
      if (m.t === 'mode') return;
      if (m.t === 'user') return void msgs.append(h('div', { class: 'bubble me code-user' + (m.command ? ' cmd' : '') }, m.command ? h('code', {}, m.text) : md(m.text)));
      if (m.t === 'note') return void msgs.append(h('div', { class: 'code-note' }, m.text));
      if (m.t === 'assistant') for (const b of m.blocks) {
        if (b.type === 'text') msgs.append(h('div', { class: 'bubble bot code-bot' }, md(b.text)));
        else if (b.type === 'thinking') msgs.append(h('details', { class: 'code-think' }, h('summary', {}, 'Thinking'), h('div', { class: 'muted' }, md(b.text))));
        else { const out = h('div', { class: 'code-out' }); const card = h('details', { class: 'code-tool', 'data-tool': b.name }, h('summary', {}, h('span', { class: 'code-dot' }, '●'), h('b', {}, b.name), ' ', h('span', { class: 'mono muted' }, toolSummary(b).slice(0, 140))), toolBody(b), out); tools.set(b.id, out); if (b.name === 'TodoWrite') card.open = true; msgs.append(card); }
      }
      if (m.t === 'result') { const out = tools.get(m.toolUseId); const pre = h('pre', { class: 'code-pre' + (m.isError ? ' err' : '') }, m.text.length > 3000 ? m.text.slice(0, 3000) + '\n…' : m.text || '(no output)'); if (out) { out.append(pre); if (m.isError) out.closest('details')?.classList.add('error'); } else msgs.append(h('details', { class: 'code-tool' }, h('summary', {}, h('b', {}, 'Result')), pre)); }
    }
    function drawLive(l) {
      running = l.running; scr = l.screen; const sc = l.screen?.state || 'stopped';
      clear(stateEl).append(stateChip(sc, running)); drawHead(); layout();
      infoEl.textContent = [scr?.working && '✻ ' + scr.working, scr?.mode, l.lastActivity && 'last activity ' + ago(l.lastActivity)].filter(Boolean).join(' · ');
      // permission question / dialog
      clear(permBox);
      if (scr?.state === 'permission') permBox.append(h('div', { class: 'card code-perm', role: 'alertdialog', 'aria-label': 'Claude is asking' }, h('b', {}, scr.permission.question), scr.permission.detail ? h('pre', { class: 'code-pre' }, scr.permission.detail) : '', h('div', { class: 'code-perm-btns' }, ...scr.permission.options.map((o) => h(o.selected ? 'md-filled-button' : 'md-outlined-button', { 'data-opt': o.key, onclick: () => key(o.key) }, o.label.replace(/\s*\(shift\+tab\)\s*$/, ''))), h('md-text-button', { onclick: () => key('Escape') }, 'Cancel'))));
      else if (scr?.state === 'dialog') permBox.append(h('div', { class: 'card code-perm' }, h('b', {}, 'Claude Code is asking something in the terminal'), h('pre', { class: 'code-pre' }, scr.hint || ''), h('md-filled-tonal-button', { onclick: () => { view = 'term'; drawSeg(); layout(); pollTerm(); } }, 'Open the terminal')));
      composer.classList.toggle('busy', scr?.state === 'working');
    }
    async function poll() {
      if (document.hidden) return;
      try {
        const l = await api(`/code/sessions/${sid}/live?after=${after}`); after = l.next || after; const first = !started; started = true;
        let list = l.msgs; if (first && list.length > 300) { hidden = list.length - 300; list = list.slice(-300); msgs.append(h('div', { class: 'code-note' }, `${hidden} earlier messages are not shown here (they are in the terminal's scrollback and the conversation file).`)); }
        for (const m of list) addMsg(m); if (list.length && stick) msgs.scrollTop = msgs.scrollHeight;
        if (first && !l.msgs.length && !l.transcript) msgs.append(h('div', { class: 'code-note', id: 'emptyNote' }, l.running ? 'Session is up. Say something to Claude Code below.' : ''));
        if (l.msgs.length) msgs.querySelector('#emptyNote')?.remove();
        drawLive(l);
      } catch (e) { infoEl.textContent = e.message; }
    }
    async function pollTerm() { if (view !== 'term' || document.hidden) return; try { const j = await api(`/code/sessions/${sid}/screen`); term.textContent = j.running ? j.text.replace(/\n{3,}/g, '\n\n') : '(stopped)'; term.scrollTop = term.scrollHeight; } catch { /* retry */ } }
    async function usageInfo() { try { const u = await api(`/code/sessions/${sid}/usage`); if (u.messages) { chipHost.replaceChildren(chip(`context ${kfmt(u.context)}`), chip(`${kfmt(u.input + u.output)} in/out`), chip(`≈${usd(u.cost)}`)); } } catch { /* ignore */ } }
    const chipHost = h('div', { class: 'code-chips' }); infoEl.after(chipHost);
    await poll(); usageInfo(); setTimeout(() => { msgs.scrollTop = msgs.scrollHeight; }, 50);
    tm.push(setInterval(poll, 1500), setInterval(pollTerm, 1200), setInterval(() => { if (!document.hidden) usageInfo(); }, 15000));
    if (running) setTimeout(() => ta.focus({ preventScroll: true }), 100);
  }
}
