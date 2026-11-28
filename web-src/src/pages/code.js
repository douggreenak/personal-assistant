import { api, getToken } from '../api.js';
import { page, h, icon, clear, spinner, wheel, empty, chip, dialog, confirmDialog, toast, guarded, ago, fmtDate, pictureAttach, noEmoji, menu as uiMenu } from '../ui.js';
/** Attaches a ⋯ menu of [label, action] pairs to its button (the menu element has to be in the page to show). */
const menu = (btn, pairs) => { const m = uiMenu(btn, pairs.map(([label, onclick]) => ({ label, onclick }))); btn.after(m); return m; };
import { md } from '../markdown.js';
import { prepareImage } from '../ui.js';

// Code tab: Claude Code agents running in tmux, with a web-style conversation view. Separate from the assistant's own chat.
const LAST = 'code_last_project';
const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } };
const kfmt = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'k' : String(Math.round(n || 0)));
const usd = (n) => '$' + (n < 10 ? n.toFixed(2) : n.toFixed(0));
/** Question options that ask for words rather than a choice. */
const FREE_TEXT = /type something|tell claude what to do|something else|chat about this|^other\b|\bother\b\.?$/i;
const STATE = { stopped: ['Stopped', ''], idle: ['Ready', 'ok'], working: ['Working', 'warn'], permission: ['Needs you', 'bad'], dialog: ['Needs you', 'bad'], unknown: ['Running', ''] };
const stateChip = (s, running) => { const [t, c] = running === false ? STATE.stopped : STATE[s] || STATE.unknown; return h('span', { class: 'tag code-state ' + c, 'data-state': running === false ? 'stopped' : s }, t); };
const route = () => { const m = /^#\/code(?:\/(p|s|u|t|x)(?:\/([\w-]+))?)?/.exec(location.hash) || []; return { kind: m[1] || '', id: m[2] || '' }; };
const go = (path) => { location.hash = '#/code' + (path ? '/' + path : ''); };

export default async function code(view) {
  const status = await api('/code/status');
  const timers = []; let mainTimers = []; document.body.classList.add('code-page'); const cleanup = () => { page.soft = null; mainTimers.forEach(clearInterval); timers.forEach(clearInterval); document.body.classList.remove('code-page'); };
  if (!status.enabled) { clear(view).append(head(), h('div', { class: 'card' }, empty('terminal', 'The Code tab is turned off', 'Turn it on in Settings → Code.'))); return cleanup; }
  let { projects } = await api('/code/projects'); let r = route();

  // ---- layout like Claude Code on the web: sessions grouped by project on the left, the open session on the right ----
  let curProject = null; const setCur = () => { curProject = r.kind === 'p' ? r.id : r.kind === 's' ? projects.find((p) => p.sessions.some((s) => s.id === r.id))?.id : null; }; setCur();
  const side = h('aside', { class: 'code-side', 'aria-label': 'Sessions' }); const body = h('div', { class: 'code-main' });
  const layout = h('div', { class: 'code-layout', 'data-pane': ['s', 'u', 't', 'x', 'p'].includes(r.kind) ? 'main' : 'list' }, side, body);
  clear(view).append(head(!status.tmux), layout);
  let externals = [];
  let sideSig = '';
  function drawSide(list, force) {
    projects = list; const sig = JSON.stringify([list, externals, r.kind, r.id, curProject]); if (!force && sig === sideSig) return; sideSig = sig;   // only touch the sidebar when something in it changed
    const rows = [];
    for (const p of list) {
      rows.push(h('div', { class: 'code-proj' + (curProject === p.id && r.kind === 'p' ? ' sel' : ''), 'data-project': p.id },
        h('button', { class: 'code-proj-name', title: p.path, onclick: () => go('p/' + p.id) }, icon('folder'), h('span', {}, p.name)),
        h('md-icon-button', { 'aria-label': 'New session in ' + p.name, title: 'New session', onclick: () => newSessionDialog(p, status) }, icon('add'))));
      for (const s of p.sessions) rows.push(h('button', { class: 'code-srow' + (r.kind === 's' && r.id === s.id ? ' sel' : ''), 'data-session': s.id, onclick: () => go('s/' + s.id) },
        h('span', { class: 'sdot ' + (s.running ? (s.state === 'working' ? 'work' : s.state === 'permission' || s.state === 'dialog' ? 'ask' : 'on') : ''), title: (STATE[s.running ? s.state : 'stopped'] || STATE.unknown)[0] }), h('span', { class: 'stitle' }, s.aiTitle || s.title)));
    }
    if (externals.length) { rows.push(h('div', { class: 'code-proj ext-head' }, h('span', { class: 'code-proj-name' }, icon('terminal'), h('span', {}, 'On this computer')))); for (const x of externals) rows.push(h('button', { class: 'code-srow' + (r.kind === 'x' && r.id === x.key ? ' sel' : ''), 'data-ext': x.key, title: x.cwd, onclick: () => go('x/' + x.key) }, h('span', { class: 'sdot' + (x.claude ? (x.state === 'working' ? ' work' : x.state === 'permission' || x.state === 'dialog' ? ' ask' : ' on') : ''), title: x.claude ? (STATE[x.state || 'unknown'] || STATE.unknown)[0] : '' }), h('span', { class: 'stitle' }, x.name + ' · ' + x.session + (x.claude ? '' : ' (' + x.command + ')')))); }
    clear(side).append(
      h('div', { class: 'code-side-top' }, h('md-filled-tonal-button', { class: 'grow', onclick: () => (list.length === 1 ? newSessionDialog(list[0], status) : list.length ? pickProjectDialog(list) : addProjectDialog()) }, icon('add'), 'New session')),
      h('div', { class: 'code-side-list' }, ...(rows.length ? rows : [h('p', { class: 'muted s', style: 'padding:8px 12px' }, 'No projects yet. Add a folder to start.')]),
        h('button', { class: 'code-addproj', onclick: () => addProjectDialog() }, icon('add'), 'Add project')),
      h('div', { class: 'code-side-foot' }, h('button', { class: r.kind === 'u' ? 'sel' : '', 'data-nav': 'usage', onclick: () => go('u') }, icon('speed'), 'Usage'), h('button', { class: r.kind === 't' ? 'sel' : '', 'data-nav': 'server', onclick: () => go('t') }, icon('dns'), 'Server')));
  }
  const refreshSide = async () => { try { const [pj, ex] = await Promise.all([api('/code/projects'), api('/code/external').catch(() => ({ sessions: [] }))]); externals = ex.sessions; drawSide(pj.projects); } catch { /* retry */ } };
  drawSide(projects); refreshSide();
  timers.push(setInterval(() => { if (!document.hidden && !document.querySelector('md-dialog[open], md-menu[open]')) refreshSide(); }, 4000));
  function pickProjectDialog(list) {
    const sel = h('md-outlined-select', { label: 'Project' }, ...list.map((p, i) => h('md-select-option', { value: p.id, selected: i === 0 || undefined }, h('div', { slot: 'headline' }, p.name))));
    const { close } = dialog({ title: 'New session in…', content: sel, actions: [h('md-text-button', { onclick: () => close() }, 'Cancel'), h('md-filled-button', { onclick: () => { const p = list.find((x) => x.id === sel.value) || list[0]; close(); newSessionDialog(p, status); } }, 'Next')] });
  }

  let mainToken = 0;
  let creating = false;   // declared up here: everything below `return cleanup` is only functions, and a `let` there would never be set
  async function renderMain() {
    const tok = ++mainToken; mainTimers.forEach(clearInterval); mainTimers = []; const tm = mainTimers;
    layout.dataset.pane = ['s', 'u', 't', 'x', 'p'].includes(r.kind) ? 'main' : 'list';
  if (r.kind === 'u') usagePage(body, tm);
  else if (r.kind === 't') serverPage(body, status, tm);
  else if (r.kind === 's') await sessionPage(body, r.id, projects, status, tm);
  else if (r.kind === 'x') await sessionPage(body, r.id, projects, status, tm, true);
  else {
    const pid = r.kind === 'p' ? r.id : (projects.find((p) => p.id === lsGet(LAST)) || projects[0])?.id;
    if (!pid) clear(body).append(h('div', { class: 'card' }, empty('terminal', 'No projects yet', 'A project is a folder Claude Code works in. Add one to start sessions.'), h('div', { style: 'text-align:center;margin-top:12px' }, h('md-filled-button', { onclick: () => addProjectDialog() }, icon('add'), 'Add a project'))));
    else { lsSet(LAST, pid); projectPage(body, projects.find((p) => p.id === pid), status, tm); }
  }
    if (tok !== mainToken) tm.forEach(clearInterval);   // a newer navigation took over while this one was loading
  }
  await renderMain();
  // Moving between sessions, projects, Usage and Server swaps only the right-hand panel; the sidebar, the page and its scroll stay put.
  page.soft = async () => { r = route(); setCur(); drawSide(projects, true); await renderMain(); return true; };
  return cleanup;

  function head(warn) { return warn ? h('div', { class: 'card high', style: 'border-left:4px solid var(--md-sys-color-error);margin-bottom:12px' }, h('b', {}, 'The tmux server for Claude Code is not reachable'), h('p', { class: 'muted' }, 'Sessions cannot run until it is. See Settings → Code, or docs/web-ui.md (Code tab).')) : ''; }

  // ---- add project ----
  // Three plain choices: use a folder that exists, make a new one, or copy one from Git. Browse to where you want, then press the button.
  function addProjectDialog() {
    let mode = 'existing', cwd = '';
    const root = status.root; const crumb = h('div', { class: 'code-crumb mono muted' }); const list = h('div', { class: 'list code-folders' });
    const seg = h('div', { class: 'seg', role: 'group' }); const body = h('div', { class: 'form' });
    const newName = h('md-outlined-text-field', { label: 'Name of the new folder', placeholder: 'my-app', 'data-primary': '' });
    const gitUrl = h('md-outlined-text-field', { label: 'Git address', placeholder: 'https://github.com/you/repo.git', 'supporting-text': 'Public https:// repositories. It is copied into a new folder here.' });
    const here = () => '/' + (cwd ? cwd : '');
    const folderOf = (n) => (cwd ? cwd + '/' : '') + n;
    async function browse(rel) {
      const j = await guarded(() => api('/code/folders?path=' + encodeURIComponent(rel))); if (!j) return; cwd = j.path; crumb.textContent = 'In ' + root + (cwd ? '/' + cwd : ''); refresh();
      clear(list).append(...(j.parent !== null ? [h('div', { class: 'row static code-dir', onclick: () => browse(j.parent) }, icon('arrow_back'), h('span', {}, 'Up one level'))] : []),
        ...j.dirs.map((d) => h('div', { class: 'row static code-dir', 'data-dir': d.rel, onclick: () => browse(d.rel) }, icon('folder'), h('span', { class: 'grow' }, d.name), icon('chevron_right'))),
        ...(j.dirs.length ? [] : [h('div', { class: 'muted s', style: 'padding:8px' }, 'No folders in here.')]));
    }
    const drawSeg = () => clear(seg).append(...[['existing', 'Use a folder'], ['new', 'New folder'], ['git', 'From Git']].map(([v, l]) => h('button', { type: 'button', 'aria-pressed': String(v === mode), onclick: () => { mode = v; drawSeg(); drawBody(); } }, l)));
    const drawBody = () => { clear(body).append(...(mode === 'existing' ? [h('p', { class: 'muted s' }, 'Open the folder Claude should work in, then press “Use this folder”.'), crumb, list] : mode === 'new' ? [h('p', { class: 'muted s' }, 'A new empty folder is created in the place you are browsing:'), crumb, newName, list] : [gitUrl, h('p', { class: 'muted s' }, 'It is copied into a new folder in the place you are browsing:'), crumb, list])); refresh(); if (mode !== 'existing') setTimeout(() => (mode === 'new' ? newName : gitUrl).focus(), 50); };
    const go2 = h('md-filled-button', { onclick: submit }, 'Add');
    const refresh = () => { go2.textContent = mode === 'existing' ? (cwd ? 'Use this folder' : 'Use the main folder') : mode === 'new' ? 'Create and add' : 'Copy and add'; };
    async function submit() {
      let b;
      if (mode === 'existing') b = { folder: cwd || '.', create: false };
      else if (mode === 'new') { const n = newName.value.trim(); if (!n) { newName.focus(); return; } b = { folder: folderOf(n), create: true }; }
      else { const u = gitUrl.value.trim(); if (!u) { gitUrl.focus(); return; } const guess = (u.replace(/\.git$/, '').split('/').pop() || 'repo').replace(/[^\w.-]/g, '-'); b = { folder: folderOf(guess), cloneUrl: u }; go2.disabled = true; }
      const j = await guarded(() => api('/code/projects', { method: 'POST', body: b }), 'Project added'); go2.disabled = false;
      if (j) { close(); lsSet(LAST, j.project.id); go('p/' + j.project.id); }
    }
    const { close } = dialog({ title: 'Add a project', content: h('div', { class: 'form' }, seg, body), actions: [h('md-text-button', { onclick: () => close() }, 'Cancel'), go2] });
    drawSeg(); drawBody(); browse('');
  }

  // ---- one project: its sessions ----
  function projectPage(el, p, st, tm) {
    const list = h('div', { class: 'list' });
    const draw = (ps) => { const rows = ps.sessions; clear(list).append(...(rows.length ? rows.map((s) => sessionRow(p, s)) : [empty('terminal', 'No sessions yet', 'Start one to talk to Claude Code in this folder.')])); };
    const menuBtn = h('md-icon-button', { 'aria-label': 'Project options' }, icon('more_horiz'));
    clear(el).append(h('div', { class: 'card high' }, h('div', { class: 'code-ph' }, h('md-icon-button', { class: 'code-back-narrow', 'aria-label': 'Back to projects', onclick: () => go('') }, icon('arrow_back')), h('div', { class: 'lead k-task' }, icon('code')), h('div', { style: 'flex:1 1 200px;min-width:0' }, h('div', { class: 'title-m' }, p.name), h('div', { class: 'mono muted', style: 'overflow-wrap:anywhere' }, p.path)),
      h('md-filled-button', { onclick: () => newSessionDialog(p, st) }, icon('add'), 'New session'), menuBtn), list));
    menu(menuBtn, [['Rename project', () => renameDialog('Rename project', p.name, (n) => api('/code/projects/' + p.id, { method: 'PATCH', body: { name: n } }), () => go('p/' + p.id))],
      ['Remove project', async () => { if (await confirmDialog('Remove this project?', 'Its running sessions are stopped and it disappears from here. The folder and the conversations on disk are not touched.', 'Remove')) { await guarded(() => api('/code/projects/' + p.id, { method: 'DELETE' }), 'Project removed'); go(''); } }]]);
    draw(p);
    const tick = async () => { if (document.hidden || document.querySelector('md-dialog[open], md-menu[open]')) return; try { const j = await api('/code/projects'); const np = j.projects.find((x) => x.id === p.id); if (np) draw(np); } catch { /* retry */ } };
    tm.push(setInterval(tick, 4000));
  }
  function sessionRow(p, s) {
    const title = s.aiTitle || s.title;
    return h('div', { class: 'row code-session', 'data-session': s.id, tabindex: 0, onclick: (e) => { if (!e.target.closest('md-text-button,md-icon-button,md-filled-tonal-button')) go('s/' + s.id); } },
      h('div', { class: 'lead k-task' }, icon('terminal')),
      h('div', { class: 'body' }, h('div', { class: 't' }, title), h('div', { class: 's' }, [s.permissionMode || 'default mode', s.model || 'default model', s.startedAt ? 'started ' + ago(s.startedAt) : 'not started yet'].join(' · '))),
      h('div', { class: 'acts' }, stateChip(s.state, s.running),
        s.running ? h('md-text-button', { onclick: async () => { await guarded(() => api(`/code/sessions/${s.id}/stop`, { method: 'POST' }), 'Stopped'); go('p/' + p.id); location.reload(); } }, icon('stop'), 'Stop')
          : h('md-text-button', { onclick: async () => { const ok = await guarded(() => api(`/code/sessions/${s.id}/start`, { method: 'POST', body: {} }), 'Started'); if (ok) go('s/' + s.id); } }, icon('play_arrow'), 'Start'),
        h('md-icon-button', { 'aria-label': 'Delete session', title: 'Delete session', onclick: async () => { if (await confirmDialog('Delete this session?', `“${title}” is stopped and removed from the list. The conversation file stays on disk.`, 'Delete')) { if (await guarded(() => api('/code/sessions/' + s.id, { method: 'DELETE' }), 'Deleted')) { const j = await api('/code/projects'); const np = j.projects.find((x) => x.id === p.id); if (np) draw(np); } } } }, icon('delete'))));
  }
  /** No form: a new session starts at once (Sonnet, permission prompts skipped — the server's defaults) and opens straight to the chat. */
  async function newSessionDialog(p) {
    if (creating) return; creating = true;
    try { const j = await guarded(() => api(`/code/projects/${p.id}/sessions`, { method: 'POST', body: {} })); if (j) go('s/' + j.session.id); } finally { creating = false; }
  }
  function renameDialog(titleText, cur, call, done) {
    const f = h('md-outlined-text-field', { label: 'Name', value: cur, 'data-primary': '' });
    const { close } = dialog({ title: titleText, content: f, actions: [h('md-text-button', { onclick: () => close() }, 'Cancel'), h('md-filled-button', { onclick: async () => { const ok = await guarded(() => call(f.value), 'Renamed'); if (ok) { close(); done(); } } }, 'Save')] });
  }

  // ---- Server: every tmux session ----
  function serverPage(el, st, tm) {
    const box = h('div', { class: 'list' }, spinner());
    const draw = async () => { const j = await guarded(() => api('/code/tmux')); if (!j) return;
      clear(box).append(...(j.sessions.length ? j.sessions.map((t) => h('div', { class: 'row static', 'data-tmux': t.name }, h('div', { class: 'lead k-task' }, icon('terminal')), h('div', { class: 'body' }, h('div', { class: 't' }, t.title || t.name), h('div', { class: 's mono' }, `tmux session ${t.name}${t.known ? '' : ' (not in the app)'}`)),
        h('div', { class: 'acts' }, t.sessionId ? h('md-text-button', { onclick: () => go('s/' + t.sessionId) }, 'Open') : '', h('md-text-button', { onclick: async () => { if (await confirmDialog('Stop this tmux session?', 'The terminal and anything running in it ends. A session from this app can be started again later and resumes its conversation.', 'Stop')) { await guarded(() => api(`/code/tmux/${t.name}/kill`, { method: 'POST' }), 'Stopped'); draw(); } } }, icon('stop'), 'Stop')))) : [empty('terminal', 'Nothing is running', 'Start a session from a project tab.')])); };
    clear(el).append(h('div', { class: 'card high' }, h('h2', {}, h('md-icon-button', { class: 'code-back-narrow', 'aria-label': 'Back to projects', onclick: () => go('') }, icon('arrow_back')), icon('dns'), 'Running tmux sessions'), h('p', { class: 'muted' }, `Up to ${st.maxSessions} sessions can run at once. They live in the assistant's container: restarting the assistant ends them, and the ones that were running are started again (conversation resumed) afterwards.`), box,
      st.allowBypass ? h('p', { class: 'muted' }, '“Bypass permissions” mode is allowed (Settings → Code).') : ''));
    draw(); tm.push(setInterval(() => { if (!document.hidden && !document.querySelector('md-dialog[open], md-menu[open]')) draw(); }, 4000));
  }

  // ---- Usage ----
  function usagePage(el, tm) {
    const planBox = h('div', {}, spinner('Reading plan usage')); const tokBox = h('div', {}, spinner());
    const loadPlan = async (force) => { clear(planBox).append(spinner('Reading plan usage')); try { const p = await api('/code/usage/plan' + (force ? '?force=1' : ''));
      clear(planBox).append(...(p.data ? [...p.data.sections.map((s) => h('div', { class: 'ubar' }, h('div', { class: 'field-row' }, h('div', { class: 't' }, s.label), h('div', { class: 'muted' }, s.percent + '% used' + (s.resets ? ' · resets ' + s.resets : ''))), h('div', { class: 'bar', role: 'progressbar', 'aria-valuenow': s.percent, 'aria-label': s.label }, h('div', { style: `width:${Math.min(100, s.percent)}%`, class: s.percent >= 90 ? 'hot' : '' })))),
        h('div', { class: 'help' }, `Read from Claude Code's /usage screen ${p.cached ? '(cached) ' : ''}at ${fmtDate(new Date(p.at).toISOString())}. Reading it costs nothing.`)] : [h('div', { class: 'err' }, p.error || 'Not available.')])); } catch (e) { clear(planBox).append(h('div', { class: 'err' }, e.message)); } };
    const loadTok = async () => { const u = await guarded(() => api('/code/usage?days=14')); if (!u) return;
      const max = Math.max(1, ...u.days.map((d) => d.input + d.output + d.cacheWrite));
      const tot = (x) => `${kfmt(x.input + x.output)} in/out · ${kfmt(x.cacheRead + x.cacheWrite)} cached · ≈${usd(x.cost)}`;
      const table = (rows, label) => h('table', { class: 'utable' }, h('thead', {}, h('tr', {}, h('th', {}, label), h('th', {}, 'Tokens'), h('th', {}, 'Cached'), h('th', {}, 'Cost'))), h('tbody', {}, rows.length ? rows.map((r) => h('tr', {}, h('td', {}, r.key ?? r.title + ' · ' + r.project), h('td', {}, kfmt(r.tokens ?? (r.input + r.output))), h('td', {}, r.tokens != null ? '' : kfmt(r.cacheRead + r.cacheWrite)), h('td', {}, usd(r.cost)))) : [h('tr', {}, h('td', { colspan: 4, class: 'muted' }, 'Nothing yet.'))]));
      clear(tokBox).append(h('div', { class: 'grid cols-3' }, ['Today', 'Last 7 days', 'All time'].map((l, i) => { const x = [u.today, u.week, u.total][i]; return h('div', { class: 'card ucard' }, h('div', { class: 'muted' }, l), h('div', { class: 'title-l' }, kfmt(x.input + x.output + x.cacheRead + x.cacheWrite) + ' tokens'), h('div', { class: 'muted s' }, tot(x))); })),
        h('div', { class: 'card' }, h('h2', {}, icon('bar_chart'), 'Last 14 days'), h('div', { class: 'chart', role: 'img', 'aria-label': 'Tokens per day' }, u.days.map((d) => h('div', { class: 'col', title: `${d.day}: ${kfmt(d.input + d.output + d.cacheWrite)} tokens (≈${usd(d.cost)})` }, h('div', { class: 'bar', style: `height:${Math.max(2, Math.round(((d.input + d.output + d.cacheWrite) / max) * 100))}%` }), h('div', { class: 'lbl' }, d.day.slice(8))))),
          h('div', { class: 'help' }, 'Counted from the conversation files of sessions run here (each API message once). Cost is an estimate from list prices — a subscription is not billed per token.')),
        h('div', { class: 'grid cols-2' }, h('div', { class: 'card' }, h('h2', {}, 'By project'), table(u.byProject, 'Project')), h('div', { class: 'card' }, h('h2', {}, 'By model'), table(u.byModel, 'Model'))),
        h('div', { class: 'card' }, h('h2', {}, 'Busiest sessions'), table(u.sessions, 'Session'))); };
    clear(el).append(h('div', { class: 'card high' }, h('h2', {}, h('md-icon-button', { class: 'code-back-narrow', 'aria-label': 'Back to projects', onclick: () => go('') }, icon('arrow_back')), icon('speed'), 'Plan limits', h('span', { class: 'grow' }), h('md-text-button', { onclick: () => loadPlan(true) }, icon('refresh'), 'Refresh')), planBox), tokBox);
    loadPlan(false); loadTok(); tm.push(setInterval(() => { if (!document.hidden) loadTok(); }, 20000));
  }

  // ---- a session: conversation, terminal, composer ----
  async function sessionPage(el, sid, projects, st, tm, ext = false) {
    const base = ext ? '/code/external/' + sid : '/code/sessions/' + sid;
    const info = await guarded(() => api(ext ? base + '/info' : '/code/sessions/' + sid)); if (!info) { go(''); return; }
    const { session: s, project: p } = ext ? { session: { title: info.title, aiTitle: '', permissionMode: 'started outside the app', model: '' }, project: { id: '', name: info.name, path: info.path } } : info; if (!ext) lsSet(LAST, p.id);
    let permSig = '', pendingCmd = null, title = s.aiTitle || s.title, running = false, scr = null, after = 0, view = 'chat', started = false, hidden = 0, stick = true;
    const msgs = h('div', { class: 'msgs code-msgs', role: 'log', 'aria-live': 'polite' }); const tools = new Map();
    const chipHost = h('div', { class: 'code-chips' }); const stateEl = h('span', {}); const infoEl = h('div', { class: 'muted s code-info' }); const titleEl = h('h2', { class: 'code-title' }, title);
    const permBox = h('div', {}); const term = h('pre', { class: 'term', 'aria-label': 'Terminal' }, ''); const termKeys = h('div', { class: 'term-keys' });
    const ta = h('textarea', { rows: 1, 'data-primary': '', placeholder: 'Message Claude Code…', title: 'Enter sends · Shift+Enter adds a line · / for commands', 'aria-label': 'Message' });
    const KEY_D = 'code-draft:' + (ext ? 'x:' : '') + sid; try { ta.value = lsGet(KEY_D) || ''; } catch { /* none */ }
    ta.addEventListener('input', () => { if (ta.value) lsSet(KEY_D, ta.value); else try { localStorage.removeItem(KEY_D); } catch { /* ignore */ } });
    const grow = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 200) + 'px'; }; ta.addEventListener('input', grow); if (ta.value) requestAnimationFrame(grow); { let w = 0; new ResizeObserver(() => { if (ta.clientWidth !== w) { w = ta.clientWidth; grow(); } }).observe(ta); }   // (measuring an empty box before it is on screen made the first line jump)
    // Attachments: any file, uploaded as soon as it is picked/pasted/dropped; the message then carries @path for each.
    let files = []; const strip = h('div', { class: 'pics code-files', hidden: true }); const fin = h('input', { type: 'file', multiple: true, hidden: true, 'aria-label': 'Choose files' });
    const uploading = () => files.some((f) => !f.path && !f.error);
    const drawFiles = () => { strip.hidden = !files.length; sendBtn.disabled = uploading(); sendBtn.title = uploading() ? 'Uploading… one moment' : '';
      clear(strip).append(...files.map((f, n) => { const busy = !f.path && !f.error; const sz = f.size >= 1e6 ? (f.size / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(f.size / 1e3)) + ' KB';
        return h('div', { class: 'code-file' + (f.error ? ' bad' : busy ? ' busy' : ''), 'aria-busy': String(busy) },
          busy ? h('span', { class: 'code-file-wheel', role: 'status', 'aria-label': 'Uploading ' + f.name }, wheel('sm')) : icon(f.error ? 'error' : f.type.startsWith('image/') ? 'image' : 'description'),
          h('span', { class: 'fname' }, f.name), h('span', { class: 'muted s' }, f.error ? 'failed' : busy ? 'uploading… ' + sz : sz),
          h('button', { type: 'button', 'aria-label': 'Remove ' + f.name, onclick: () => { files.splice(n, 1); drawFiles(); } }, icon('close'))); })); };
    const addFiles = (list) => { for (const file of list) { if (files.length >= 10) { toast('At most 10 files per message.'); break; } const f = { name: file.name || 'file', type: file.type || '', size: file.size, path: '', error: false }; files.push(f); api(`${base}/upload?name=${encodeURIComponent(f.name)}`, { method: 'POST', raw: file }).then((r) => { f.path = r.path; }).catch((e) => { f.error = true; toast(e.message, { error: true }); }).finally(drawFiles); } drawFiles(); };
    fin.addEventListener('change', () => { addFiles([...fin.files]); fin.value = ''; });
    ta.addEventListener('paste', (e) => { const fs = [...(e.clipboardData?.files ?? [])]; if (fs.length) { e.preventDefault(); addFiles(fs); } });
    const attachBtn = h('md-icon-button', { 'aria-label': 'Attach files', title: 'Attach files (or paste / drop them)', onclick: () => fin.click() }, icon('attach_file'));
    const dropHost = () => composer; setTimeout(() => { composer.addEventListener('dragover', (e) => { if ([...(e.dataTransfer?.types ?? [])].includes('Files')) { e.preventDefault(); composer.classList.add('drop'); } }); composer.addEventListener('dragleave', () => composer.classList.remove('drop')); composer.addEventListener('drop', (e) => { composer.classList.remove('drop'); if (e.dataTransfer?.files?.length) { e.preventDefault(); addFiles([...e.dataTransfer.files]); } }); });
    const pics = { button: attachBtn, strip, input: fin };
    const sendBtn = h('md-filled-icon-button', { 'aria-label': 'Send', onclick: () => send() }, icon('send'));
    const stopBtn = h('md-filled-tonal-icon-button', { 'aria-label': 'Stop Claude', title: 'Stop what Claude is doing (Esc)', hidden: true, onclick: async () => { await guarded(() => api(`${base}/${ext ? 'keys' : 'interrupt'}`, { method: 'POST', body: ext ? { keys: ['Escape'] } : {} })); poll(); } }, icon('stop'));
    const startBtn = h('md-filled-button', { onclick: async () => { await guarded(() => api(`/code/sessions/${sid}/start`, { method: 'POST', body: {} }), 'Starting…'); poll(); } }, icon('play_arrow'), 'Start session');
    let cmds = []; const cmdBox = h('div', { class: 'code-cmds', role: 'listbox', 'aria-label': 'Commands', hidden: true });
    api(`${base}/commands`).then((j) => { cmds = j.commands; }).catch(() => {});
    const matches = () => { const v = ta.value; if (!v.startsWith('/') || /\s/.test(v)) return []; return cmds.filter((c) => c.name.startsWith(v.toLowerCase())).slice(0, 8); };
    const drawCmds = () => { const m = matches(); cmdBox.hidden = !m.length || (m.length === 1 && m[0].name === ta.value); clear(cmdBox).append(...m.map((c) => h('button', { type: 'button', role: 'option', 'data-cmd': c.name, onclick: () => { ta.value = c.name + ' '; grow(); drawCmds(); ta.focus(); } }, h('b', {}, c.name), h('span', { class: 'muted' }, c.description)))); };
    ta.addEventListener('input', drawCmds);
    const modeChip = h('button', { type: 'button', class: 'code-pill', title: 'Permissions and model', hidden: true, onclick: () => settingsDialog() }); const hintEl = h('span', { class: 'code-hint' }, 'Enter to send · Shift+Enter for a new line');
    const composer = h('div', { class: 'composer code-composer' }, strip, ta, h('div', { class: 'code-tools' }, pics.button, ext ? '' : modeChip, hintEl, stopBtn, sendBtn));

    async function send(text) {
      text = (text ?? ta.value).trim(); if (!text && !files.length) return;
      if (files.some((f) => !f.path && !f.error)) { toast('Still uploading — one moment.'); return; }
      const ok = files.filter((f) => f.path); if (!text && !ok.length) { files = []; drawFiles(); return; } sendBtn.disabled = true;
      try {
        let full = text; for (const f of ok) full = `${full}${full ? '\n' : ''}@${f.path}`;
        const sent = await api(`${base}/send`, { method: 'POST', body: { text: full } }); if (sent?.queued) poll(); pendingCmd = full.startsWith('/') ? { cmd: full.split('\n')[0].trim(), at: Date.now() } : null; ta.value = ''; try { localStorage.removeItem(KEY_D); } catch { /* ignore */ } grow(); files = []; drawFiles(); cmdBox.hidden = true; stick = true; poll(); setTimeout(poll, 250); setTimeout(poll, 700);
      } catch (e) { toast(e.message, { error: true }); } finally { sendBtn.disabled = false; ta.focus({ preventScroll: true }); }
    }
    async function fetchUpload(im) { const bytes = Uint8Array.from(atob(im.data), (c) => c.charCodeAt(0)); return api(`/code/sessions/${sid}/upload?name=${encodeURIComponent(im.name)}`, { method: 'POST', raw: bytes }); }
    ta.addEventListener('keydown', (e) => { if (e.key === 'Tab' && !cmdBox.hidden) { e.preventDefault(); const m = matches(); if (m[0]) { ta.value = m[0].name + ' '; drawCmds(); } return; } if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); const m = matches(); if (m.length && !m.some((c) => c.name === ta.value.trim())) { ta.value = m[0].name + ' '; drawCmds(); return; } cmdBox.hidden = true; send(); } });
    const key = async (...keys) => { await guarded(() => api(`${base}/keys`, { method: 'POST', body: { keys } })); poll(); };
    // Keyboard: Enter answers whatever Claude is asking (the highlighted option / the dialog), "/" jumps to the message box.
    if (window.__codeKeys) document.removeEventListener('keydown', window.__codeKeys, true);
    window.__codeKeys = (e) => {
      if (!msgs.isConnected || e.isComposing || e.ctrlKey || e.metaKey || e.altKey || document.querySelector('md-dialog[open], md-menu[open]')) return;
      const t = e.composedPath()[0]; const field = t?.tagName && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable || /^MD-(OUTLINED|FILLED)-(TEXT-FIELD|SELECT)$/.test(t.tagName));
      if (e.key === 'Enter' && !e.shiftKey) {
        if (scr?.state !== 'permission' && scr?.state !== 'dialog') return;
        if (field && t !== ta) return; if (t === ta && ta.value.trim()) return;      // typing a message: Enter sends it as usual
        if (!field && t?.closest?.('button, a, md-text-button, md-filled-button, md-outlined-button, md-filled-tonal-button, md-icon-button, md-menu-item')) return;   // a focused button handles its own Enter
        e.preventDefault(); e.stopPropagation(); key('Enter');
      } else if (e.key === '/' && !field) {
        const target = view === 'term' ? termPane.querySelector('md-outlined-text-field') : ta; if (!target) return;
        e.preventDefault(); e.stopPropagation(); target.focus(); target.scrollIntoView?.({ block: 'nearest' });
      }
    };
    document.addEventListener('keydown', window.__codeKeys, true);

    // header
    const act = (label, ic, fn, cls = 'md-outlined-button') => h(cls, { onclick: fn, 'aria-label': label, title: label }, icon(ic), h('span', { class: 'lbl' }, label));   // (the label is hidden on phones: icon only)
    const headBtns = h('div', { class: 'code-head-btns' });
    const MODE_NAMES = { manual: 'Manual — ask for everything', acceptEdits: 'Accept edits automatically', auto: 'Auto — Claude judges risk', plan: 'Plan only — no changes', dontAsk: "Don't ask", bypassPermissions: 'Bypass permissions (no prompts)' };
    const MODE_SHORT = { manual: 'Ask first', acceptEdits: 'Accept edits', auto: 'Auto', plan: 'Plan', dontAsk: "Don't ask", bypassPermissions: 'Bypass' };
    const MODE_FROM_SCREEN = (m) => { m = String(m || ''); return /accept edits/.test(m) ? 'acceptEdits' : /plan/.test(m) ? 'plan' : /auto/.test(m) ? 'auto' : /manual/.test(m) ? 'manual' : /bypass/.test(m) ? 'bypassPermissions' : /ask/.test(m) ? 'dontAsk' : ''; };
    function settingsDialog() {
      const cur = MODE_FROM_SCREEN(scr?.mode) || s.permissionMode || 'manual';
      const mode = h('md-outlined-select', { label: 'Permissions' }, ...st.modes.filter((m) => m !== 'bypassPermissions' || st.allowBypass).map((m) => h('md-select-option', { value: m, selected: m === cur || undefined }, h('div', { slot: 'headline' }, MODE_NAMES[m] || m))));
      const known = [['', 'Keep current'], ['sonnet', 'Sonnet'], ['opus', 'Opus'], ['haiku', 'Haiku']];
      const model = h('md-outlined-select', { label: 'Model' }, ...known.map(([v, l]) => h('md-select-option', { value: v, selected: v === '' || undefined }, h('div', { slot: 'headline' }, l + (v === '' && s.model ? ` (${s.model})` : '')))));
      const { close } = dialog({ title: 'Session settings', content: h('div', { class: 'form' }, mode, model, h('div', { class: 'help' }, 'Applied to the running session right away, the same way you would in the terminal (Shift+Tab for permissions, /model for the model). Claude must be idle (not waiting for an answer).')),
        actions: [h('md-text-button', { onclick: () => close() }, 'Cancel'), h('md-filled-button', { onclick: async () => {
          if (mode.value && mode.value !== cur) { const r = await guarded(() => api(`/code/sessions/${sid}/mode`, { method: 'POST', body: { mode: mode.value } }), 'Permissions changed'); if (!r) return; s.permissionMode = mode.value; }
          if (model.value) { const r = await guarded(() => api(`/code/sessions/${sid}/model`, { method: 'POST', body: { model: model.value } }), 'Switching model…'); if (!r) return; s.model = model.value; }
          close(); poll(); } }, 'Apply')] });
    }
    const drawHead = () => { if (ext) { clear(headBtns).append(chip(running ? 'On this computer' : 'Ended')); return; } clear(headBtns).append(running ? act('Settings', 'tune', settingsDialog) : '', running ? act('Stop', 'stop', async () => { if (await confirmDialog('Stop this session?', 'The tmux session ends. Start it again later and the conversation resumes.', 'Stop')) { await guarded(() => api(`/code/sessions/${sid}/stop`, { method: 'POST' }), 'Stopped'); poll(); } }) : startBtn,
      h('md-icon-button', { id: 'sessMenu', 'aria-label': 'More' }, icon('more_horiz')));
      menu(headBtns.querySelector('#sessMenu'), [['Restart', async () => { await guarded(() => api(`/code/sessions/${sid}/restart`, { method: 'POST' }), 'Restarted'); poll(); }], ['Rename', () => renameDialog('Rename session', title, (n) => api('/code/sessions/' + sid, { method: 'PATCH', body: { title: n } }), () => { titleEl.textContent = title = ''; location.reload(); })],
        ['Delete session', async () => { if (await confirmDialog('Delete this session?', 'It is stopped and removed from the list. The conversation file stays on disk.', 'Delete')) { await guarded(() => api('/code/sessions/' + sid, { method: 'DELETE' }), 'Deleted'); go('p/' + p.id); } }]]); };
    // "Replies only": hides tool cards, thinking, slash commands and their output (remembered per session in this browser)
    let emptyReady = false;   // set once the chat's empty-state element exists
    const KEY_H = 'code-replies-only:' + sid; let only = lsGet(KEY_H) !== '0';   // replies only unless this session was switched to "All activity"
    const onlyBtn = h('button', { class: 'code-only', type: 'button', title: 'Show only Claude\'s replies and your messages — hide tool calls, thinking and commands', onclick: () => { only = !only; lsSet(KEY_H, only ? '1' : '0'); drawOnly(); } });
    const drawOnly = () => { onlyBtn.setAttribute('aria-pressed', String(only)); clear(onlyBtn).append(icon(only ? 'visibility_off' : 'visibility'), h('span', { class: 'lbl' }, only ? 'Replies only' : 'All activity')); onlyBtn.setAttribute('aria-label', only ? 'Replies only (tap to show all activity)' : 'All activity (tap for replies only)'); msgs.classList.toggle('replies-only', only); fillUp(); if (emptyReady) updateEmpty(); if (stick) msgs.scrollTop = msgs.scrollHeight; };
    const seg = h('div', { class: 'seg' }); const drawSeg = () => clear(seg).append(...[['chat', 'Conversation'], ['term', 'Terminal']].map(([v, l]) => h('button', { 'aria-pressed': String(view === v), 'data-view': v, onclick: () => { view = v; drawSeg(); layout(); if (v === 'term') pollTerm(); } }, l))); drawSeg();
    const workEl = h('div', { class: 'code-working', role: 'status', hidden: true }, h('span', { class: 'spark' }, '✻'), h('span', { class: 'wlabel' }, 'Working…'));
    const jump = h('button', { type: 'button', class: 'code-jump', hidden: true, 'aria-label': 'Jump to latest', title: 'Jump to latest', onclick: () => { stick = true; msgs.scrollTo({ top: msgs.scrollHeight, behavior: 'smooth' }); } }, icon('keyboard_arrow_down'));
    const chatPane = h('div', { class: 'code-chat' }, h('div', { class: 'code-msgs-wrap' }, msgs, jump), workEl, permBox);
    const termPane = h('div', { class: 'code-term' }, term, termKeys, h('div', { class: 'code-term-send' }, (() => { const f = h('md-outlined-text-field', { label: 'Type into the terminal', class: 'grow' }); const go2 = async (enter) => { const t = f.value; f.value = ''; await guarded(() => api(`${base}/keys`, { method: 'POST', body: { text: t, keys: enter ? ['Enter'] : undefined } })); pollTerm(); }; f.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go2(true); } }); return [f, h('md-filled-tonal-button', { onclick: () => go2(true) }, 'Send + Enter'), h('md-text-button', { onclick: () => go2(false) }, 'Type only')]; })()));
    for (const [l, k] of [['Enter', 'Enter'], ['Esc', 'Escape'], ['↑', 'Up'], ['↓', 'Down'], ['←', 'Left'], ['→', 'Right'], ['Tab', 'Tab'], ['⇧Tab', 'BTab'], ['Ctrl+C', 'C-c'], ['1', '1'], ['2', '2'], ['3', '3'], ['y', 'y'], ['n', 'n']]) termKeys.append(h('md-outlined-button', { 'data-key': k, onclick: () => key(k) }, l));
    const quick = h('div', { class: 'code-quick' }, ...[['Interrupt', 'stop', () => key('Escape')], ['Cycle mode', 'sync', () => key('BTab')], ['/ Commands', 'terminal', () => { ta.value = '/'; ta.focus(); drawCmds(); }]].map(([l, ic, fn]) => h('md-assist-chip', { label: l, onclick: fn })));
    const layout = () => { chatPane.hidden = view !== 'chat'; termPane.hidden = view !== 'term'; composer.hidden = view !== 'chat' || !running; quick.hidden = view !== 'chat' || !running; if (view !== 'chat' || !running) cmdBox.hidden = true; startNote.hidden = running; };
    const startNote = h('div', { class: 'card code-stopped' }, h('b', {}, 'This session is stopped.'), h('span', { class: 'muted' }, ' Start it to continue the conversation — everything said so far is kept.'));
    clear(el).append(h('div', { class: 'card high code-session-head' }, h('div', { class: 'code-ph' }, h('md-icon-button', { 'aria-label': 'Back to ' + p.name, onclick: () => go(ext ? '' : 'p/' + p.id) }, icon('arrow_back')), h('div', { style: 'flex:1 1 180px;min-width:0' }, titleEl, h('div', { class: 'muted s code-meta' }, p.name + ' · ' + (s.permissionMode || 'default permissions') + (s.model ? ' · ' + s.model : ''))), h('div', { class: 'code-head-right' }, stateEl, chipHost, seg, onlyBtn, headBtns))),
      chatPane, termPane, startNote, quick, cmdBox, composer, pics.input); drawHead(); layout(); drawOnly();

    // rendering the conversation
    const near = () => msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 80;
    msgs.addEventListener('scroll', () => { stick = near(); jump.hidden = stick; });
    const fileOf = (i) => String(i.file_path || i.path || i.notebook_path || '');
    const toolBody = (b) => { const i = b.input || {}; const n = b.name;
      if (n === 'Bash') return h('pre', { class: 'code-pre' }, i.command || '');
      if (n === 'Edit' || n === 'MultiEdit') { const eds = n === 'Edit' ? [i] : i.edits || []; return h('div', {}, eds.slice(0, 6).map((e) => h('pre', { class: 'code-pre diff' }, ...String(e.old_string ?? '').split('\n').slice(0, 40).map((l) => h('div', { class: 'del' }, '- ' + l)), ...String(e.new_string ?? '').split('\n').slice(0, 40).map((l) => h('div', { class: 'add' }, '+ ' + l))))); }
      if (n === 'Write') return h('pre', { class: 'code-pre' }, String(i.content ?? '').split('\n').slice(0, 60).join('\n'));
      if (n === 'TodoWrite') return h('ul', { class: 'code-todos' }, (i.todos || []).map((t) => h('li', { class: t.status }, icon(t.status === 'completed' ? 'check_box' : t.status === 'in_progress' ? 'timelapse' : 'check_box_outline_blank'), ' ' + (t.content || ''))));
      return h('pre', { class: 'code-pre' }, JSON.stringify(i, null, 2).slice(0, 2500)); };
    const toolSummary = (b) => { const i = b.input || {}; return b.name === 'Bash' ? String(i.description || i.command || '').split('\n')[0] : fileOf(i) || i.pattern || i.query || i.url || i.description || i.prompt?.slice?.(0, 80) || ''; };
    const copy = async (text, btn) => { try { await navigator.clipboard.writeText(text); } catch { const t = h('textarea', {}); t.value = text; document.body.append(t); t.select(); try { document.execCommand('copy'); } catch { /* ignore */ } t.remove(); } const old = btn.firstChild; btn.replaceChildren(icon('check')); setTimeout(() => btn.replaceChildren(old), 1200); };
    /** Copy buttons: one on every code block, one on the whole reply (appears on hover). */
    function decorate(el, text) {
      for (const pre of el.querySelectorAll('pre')) { const b = h('button', { type: 'button', class: 'code-copy', 'aria-label': 'Copy code', title: 'Copy code' }, icon('content_copy')); b.onclick = () => copy(pre.innerText.replace(/\n$/, ''), b); pre.classList.add('has-copy'); pre.append(b); }
      const all = h('button', { type: 'button', class: 'code-copy-msg', 'aria-label': 'Copy reply', title: 'Copy reply' }, icon('content_copy')); all.onclick = () => copy(text, all); el.append(all);
    }
    function addMsg(m, into = msgs) {
      if (m.t === 'title') { if (into !== msgs) return; title = m.title; titleEl.textContent = title; return; }
      if (m.t === 'mode') return;
      if (m.t === 'user') return void into.append(h('div', { class: 'bubble me code-user' + (m.command ? ' cmd' : '') }, m.command ? h('code', {}, m.text) : md(m.text)));
      if (m.t === 'note' && m.kind === 'compact') return void into.append(h('div', { class: 'code-compact', role: 'separator' }, h('span', { class: 'wave' }), h('span', { class: 'lbl' }, icon(/clear/i.test(m.text) ? 'cleaning_services' : 'compress'), m.text || 'Conversation compacted'), h('span', { class: 'wave' })));
      if (m.t === 'note') return void into.append(h('div', { class: 'code-note' }, m.text));
      if (m.t === 'assistant') for (const b of m.blocks) {
        if (b.type === 'text') { const el = h('div', { class: 'bubble bot code-bot' }, md(b.text)); decorate(el, b.text); into.append(el); }
        else if (b.type === 'thinking') into.append(h('details', { class: 'code-think' }, h('summary', {}, 'Thinking'), h('div', { class: 'muted' }, md(b.text))));
        else { const out = h('div', { class: 'code-out' }); const card = h('details', { class: 'code-tool pending', 'data-tool': b.name }, h('summary', {}, h('span', { class: 'code-dot' }), h('b', {}, b.name), h('span', { class: 'mono muted code-tsum' }, toolSummary(b).slice(0, 140)), icon('keyboard_arrow_down')), toolBody(b), out); tools.set(b.id, out); if (orphans.has(b.id)) { out.append(orphans.get(b.id)); orphans.delete(b.id); } if (b.name === 'TodoWrite') card.open = true; into.append(card); }
      }
      if (m.t === 'result') { const out = tools.get(m.toolUseId); const pre = h('pre', { class: 'code-pre' + (m.isError ? ' err' : '') }, m.text.length > 3000 ? m.text.slice(0, 3000) + '\n…' : m.text || '(no output)'); if (out) { out.append(pre); const d = out.closest('details'); d?.classList.remove('pending'); if (m.isError) d?.classList.add('error'); } else orphans.set(m.toolUseId, pre); }   // its tool call is further up: shown when that part is loaded
    }
    // messages still waiting for Claude to finish: dotted outline (like a scheduled iMessage) at the end of the chat until they go in
    const queueEl = h('div', { class: 'code-queue' }); let queueSig = '';
    function drawQueue(q) {
      const sig = q.join('\u0000'); if (sig === queueSig && queueEl.isConnected && msgs.lastElementChild === queueEl) return; queueSig = sig;
      clear(queueEl).append(...q.map((t) => h('div', { class: 'bubble me code-user queued', title: 'Waiting for Claude to finish — it goes in automatically' }, md(t), h('div', { class: 'queued-note' }, icon('schedule'), 'Waiting'))));
      msgs.append(queueEl); if (q.length && stick) msgs.scrollTop = msgs.scrollHeight;
    }
    /** An option that means "let me say it in words" (Type something, No and tell Claude what to do differently, Other…): a text box opens in the card; Send picks the option, types the words and presses Enter. */
    function typeAnswer(card, o) {
      const open = card.querySelector('.code-perm-type'); if (open) { open.querySelector('md-outlined-text-field')?.focus(); return; }
      const f = h('md-outlined-text-field', { label: o.label.replace(/\s*\((?:esc|shift\+tab)\)\s*$/i, '').replace(/[.…]+$/, ''), class: 'grow', maxlength: '500', 'data-primary': '' });
      const sendBtn = h('md-filled-button', {}, icon('send'), 'Send'); const row = h('div', { class: 'code-perm-type' }, f, h('div', { class: 'code-perm-btns' }, sendBtn, h('md-text-button', { onclick: () => row.remove() }, 'Close')));
      const send = async () => {
        const text = String(f.value || '').replace(/[\r\n]+/g, ' ').trim(); if (!text || sendBtn.disabled) return; sendBtn.disabled = true;
        try { if (!(await guarded(() => api(`${base}/keys`, { method: 'POST', body: { keys: [o.key] } })))) return; await new Promise((r) => setTimeout(r, 400));   // let Claude Code open its text row
          if (await guarded(() => api(`${base}/keys`, { method: 'POST', body: { text, keys: ['Enter'] } }))) row.remove(); } finally { sendBtn.disabled = false; poll(); }
      };
      sendBtn.addEventListener('click', send); f.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); send(); } });
      card.append(row); setTimeout(() => { row.scrollIntoView({ block: 'nearest' }); f.focus(); }, 60);
    }
    function drawLive(l) {
      const wasRunning = running; running = l.running; scr = l.screen; if (running && !wasRunning && view === 'chat') setTimeout(() => ta.focus({ preventScroll: true }), 150); const sc = l.screen?.state || 'stopped';
      clear(stateEl).append(stateChip(sc, running)); if (running !== wasRunning || !headBtns.childElementCount) drawHead(); layout();   // not on every poll: redrawing rebuilds the ⋯ menu and closes it
      infoEl.title = infoEl.textContent = [scr?.working && '✻ ' + scr.working, scr?.mode, l.lastActivity && 'last activity ' + ago(l.lastActivity)].filter(Boolean).join(' · ');
      // permission question / dialog
      // Rebuild the question card only when what it says changes. Rebuilding on every poll threw away anything the owner had selected to copy.
      const sig = scr?.state === 'permission' ? 'p' + JSON.stringify(scr.permission) : scr?.state === 'dialog' || scr?.state === 'unknown' && l.dialogText ? 'd' + (l.dialogText || scr.hint || '') : '';
      if (sig !== permSig) { permSig = sig; clear(permBox);
      if (scr?.state === 'permission') permBox.append(h('div', { class: 'card code-perm', role: 'alertdialog', 'aria-label': 'Claude is asking' }, h('b', {}, scr.permission.question), scr.permission.detail ? h('pre', { class: 'code-pre' }, scr.permission.detail) : '', h('div', { class: 'code-perm-btns' }, ...scr.permission.options.map((o) => h(o.selected ? 'md-filled-button' : 'md-outlined-button', { 'data-opt': o.key, onclick: (ev) => (FREE_TEXT.test(o.label) ? typeAnswer(ev.currentTarget.closest('.code-perm'), o) : key(o.key)) }, o.label.replace(/\s*\(shift\+tab\)\s*$/, ''))), h('md-text-button', { onclick: () => key('Escape') }, 'Cancel'))));
      else if (scr?.state === 'dialog' || scr?.state === 'unknown' && l.dialogText) permBox.append(h('div', { class: 'card code-dialog', role: 'dialog', 'aria-label': 'Claude Code' }, h('pre', { class: 'code-pre' }, (l.dialogText || scr.hint || '').split('\n').filter((x) => x.trim()).slice(-24).join('\n')), h('div', { class: 'code-perm-btns' }, ...[['↑', 'Up'], ['↓', 'Down'], ['←', 'Left'], ['→', 'Right'], ['Enter', 'Enter'], ['Tab', 'Tab'], ['Esc', 'Escape']].map(([lb, k]) => h('md-outlined-button', { 'data-key': k, onclick: () => key(k) }, lb))))); }
      composer.classList.toggle('busy', scr?.state === 'working'); stopBtn.hidden = scr?.state !== 'working'; hintEl.hidden = scr?.state === 'working';
      const working = running && scr?.state === 'working'; workEl.hidden = !working || view !== 'chat'; if (working) { workEl.querySelector('.wlabel').textContent = (scr.working || 'Working…').replace(/^✻\s*/, ''); if (stick) msgs.scrollTop = msgs.scrollHeight; }
      const mn = (MODE_FROM_SCREEN(scr?.mode) || s.permissionMode || ''); modeChip.hidden = !running || ext; clear(modeChip).append(icon('tune'), h('span', {}, (MODE_SHORT[mn] || 'Permissions') + (s.model ? ' · ' + s.model : '')));
    }
    // One poll at a time (two overlapping polls both used the same offset and drew every new message twice) and each message is drawn once.
    let polling = false, again = false; const seen = new Set(), orphans = new Map(); let oldest = 0, loadingOld = false;
    const topNote = h('button', { class: 'code-older', type: 'button', hidden: true, onclick: () => loadOlder() }, icon('keyboard_arrow_up'), 'Load earlier messages');
    const loadingEl = spinner('Loading conversation'); msgs.prepend(topNote); msgs.append(loadingEl);
    async function loadOlder() {
      if (loadingOld || oldest <= 0) return; loadingOld = true; topNote.disabled = true;
      try { const r = await api(`${base}/history?before=${oldest}&limit=30`); const frag = document.createDocumentFragment(); for (const m of r.msgs) { if (m.t !== 'title' && m.t !== 'mode') { if (seen.has(m.id)) continue; seen.add(m.id); } addMsg(m, frag); }
        const prevH = msgs.scrollHeight, prevT = msgs.scrollTop; topNote.after(frag); msgs.scrollTop = prevT + (msgs.scrollHeight - prevH); oldest = r.start; topNote.hidden = oldest <= 0; fillUp(); updateEmpty(); }
      catch (e) { toast(e.message, { error: true }); } finally { loadingOld = false; topNote.disabled = false; }
    }
    function fillUp() { setTimeout(() => { if (oldest > 0 && !loadingOld && msgs.scrollHeight <= msgs.clientHeight + 60) loadOlder(); }, 60); }   // short history (e.g. replies only): keep loading until the box is full or there is no more
    msgs.addEventListener('scroll', () => { if (msgs.scrollTop < 160 && oldest > 0 && !loadingOld) loadOlder(); });
    function poll() { if (polling) { again = true; return Promise.resolve(); } polling = true; return pollOnce().finally(() => { polling = false; if (again) { again = false; poll(); } }); }
    // Never leave the chat looking blank (it reads as "stuck"): say so when there is nothing to show — no messages yet, a stopped session, or "Replies only" hiding everything.
    const emptyEl = h('div', { class: 'code-empty', role: 'status', hidden: true }); msgs.append(emptyEl); emptyReady = true;
    function updateEmpty() {
      if (!started || oldest > 0 || loadingEl.isConnected) { emptyEl.hidden = true; return; }   // still loading, or earlier messages are being fetched
      const skip = new Set([topNote, loadingEl, queueEl, emptyEl]); const kids = [...msgs.children].filter((n) => !skip.has(n));
      if (kids.some((n) => n.getClientRects().length && !n.classList.contains('code-note'))) { emptyEl.hidden = true; return; }
      const hiddenSome = only && kids.some((n) => !n.getClientRects().length && !n.classList.contains('code-note'));
      emptyEl.textContent = hiddenSome ? 'No replies to show. Tool calls and commands are hidden: switch to “All activity” to see them.'
        : running ? 'No messages to display yet. Say something to Claude Code below.' : 'No messages to display. This session is stopped: start it to begin.';
      emptyEl.hidden = false; if (emptyEl !== msgs.lastElementChild) msgs.append(emptyEl);
    }
    let curFile = '';
    async function pollOnce() {
      if (document.hidden) return;
      try {
        const l = await api(started ? `${base}/live?after=${after}` : `${base}/live?tail=40`); const first = !started;
        if (started && (l.next < after || (l.fileKey && curFile && l.fileKey !== curFile))) { { const lastReal = [...msgs.children].filter((n) => n !== queueEl).pop(); if (lastReal && !lastReal.classList.contains('code-compact') && msgs.querySelector('.bubble')) addMsg({ t: 'note', id: 'clear-' + Date.now(), ts: '', text: 'Conversation cleared', kind: 'compact' }); } topNote.hidden = true; tools.clear(); seen.clear(); orphans.clear(); oldest = 0; started = false; after = 0; again = true; return; }   // the conversation file was replaced (e.g. /clear): start over
        curFile = l.fileKey || curFile; loadingEl.remove(); started = true; after = l.next || after; if (first) { oldest = l.start || 0; topNote.hidden = oldest <= 0; setTimeout(fillUp, 100); }
        let list = l.msgs.filter((m) => { if (m.t === 'title' || m.t === 'mode') return true; const k = m.id; if (seen.has(k)) return false; seen.add(k); return true; }); if (first && list.length > 300) { hidden = list.length - 300; list = list.slice(-300); msgs.append(h('div', { class: 'code-note' }, `${hidden} earlier messages are not shown here (they are in the terminal's scrollback and the conversation file).`)); }
        for (const m of list) addMsg(m); if (list.length && stick) msgs.scrollTop = msgs.scrollHeight;
        drawLive(l); drawQueue(l.queue || []); updateEmpty();
        if (pendingCmd && l.screen?.state === 'idle' && Date.now() - pendingCmd.at > 900) { const c = pendingCmd; pendingCmd = null; try { const o = await api(`${base}/output?cmd=${encodeURIComponent(c.cmd)}`); if (o.text && !list.some((m) => m.t === 'note')) { msgs.append(h('pre', { class: 'code-pre code-cmdout' }, o.text)); if (stick) msgs.scrollTop = msgs.scrollHeight; } } catch { /* ignore */ } }
      } catch (e) { infoEl.textContent = e.message; }
    }
    async function pollTerm() { if (view !== 'term' || document.hidden) return; try { const j = await api(`${base}/screen`); term.textContent = j.running ? noEmoji(j.text.replace(/\n{3,}/g, '\n\n')) : '(stopped)'; term.scrollTop = term.scrollHeight; } catch { /* retry */ } }
    async function usageInfo() { try { const u = await api(`${base}/usage`); if (u.messages) { chipHost.replaceChildren(chip(`context ${kfmt(u.context)}`), chip(`≈${usd(u.cost)}`)); chipHost.title = `${kfmt(u.input + u.output)} in/out`; } } catch { /* ignore */ } }
    
    await poll(); usageInfo(); setTimeout(() => { msgs.scrollTop = msgs.scrollHeight; }, 50);
    tm.push(setInterval(poll, 800), setInterval(pollTerm, 1200), setInterval(() => { if (!document.hidden) usageInfo(); }, 15000));
    if (running) setTimeout(() => ta.focus({ preventScroll: true }), 100);
  }
}
