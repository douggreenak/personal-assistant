import { noEmoji, icon } from './ui.js';
// Small, safe Markdown → DOM renderer. It never uses innerHTML: everything is built from text nodes and elements,
// links are limited to http(s)/mailto, and external images are shown as links (nothing is fetched from a third party).
const el = (tag, props, ...kids) => { const e = document.createElement(tag); if (props) for (const [k, v] of Object.entries(props)) e.setAttribute(k, v); e.append(...kids.flat().map((k) => (typeof k === 'string' ? noEmoji(k) : k))); return e; };
const safeUrl = (u) => { try { const x = new URL(u, 'https://x.invalid'); return /^(https?:|mailto:)$/.test(x.protocol) && x.hostname !== 'x.invalid' || x.protocol === 'mailto:' ? u : null; } catch { return null; } };
const link = (text, url) => { const u = safeUrl(url); return u ? el('a', { href: u, target: '_blank', rel: 'noopener noreferrer nofollow' }, text) : document.createTextNode(text); };

// Inline: `code`, **bold**, *italic* or _italic_, ~~strike~~, [text](url), ![alt](url) (shown as a link), bare URLs.
export function inline(src) {
  const out = []; let i = 0, buf = '';
  const flush = () => { if (buf) { out.push(document.createTextNode(buf)); buf = ''; } };
  const rules = [
    [/^`([^`\n]+)`/, (m) => el('code', null, m[1])],
    [/^\*\*([^\n]+?)\*\*(?!\*)/, (m) => el('strong', null, inline(m[1]))],
    [/^__([^\n]+?)__(?!_)/, (m) => el('strong', null, inline(m[1]))],
    [/^~~([^\n]+?)~~/, (m) => el('del', null, inline(m[1]))],
    [/^\*(?![\s*])([^\n*]+?)\*(?!\*)/, (m) => el('em', null, inline(m[1]))],
    [/^_(?![\s_])([^\n_]+?)_(?![\w_])/, (m) => el('em', null, inline(m[1]))],
    [/^!?\[([^\]\n]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/, (m, whole) => link(whole.startsWith('!') ? (m[1] || m[2]) : inlineText(m[1]), m[2])],
    [/^https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]/, (m) => link(m[0], m[0])],
  ];
  while (i < src.length) {
    const rest = src.slice(i); const c = rest[0];
    if (c === '\\' && /[\\`*_{}[\]()#+\-.!~|>]/.test(rest[1] ?? '')) { buf += rest[1]; i += 2; continue; }
    let hit = false;
    if ('`*_~[!h'.includes(c) && (c !== '_' || i === 0 || /\W/.test(src[i - 1]))) {
      for (const [re, fn] of rules) { const m = re.exec(rest); if (m) { flush(); out.push(fn(m, m[0])); i += m[0].length; hit = true; break; } }
    }
    if (!hit) { buf += c; i++; }
  }
  flush(); return out;
}
const inlineText = (s) => s;
const withBreaks = (lines) => lines.flatMap((l, n) => (n ? [el('br'), ...inline(l)] : inline(l)));

/** Renders Markdown text to a <div class="md">. */
export function md(text) {
  const root = el('div', { class: 'md' }); const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n'); let i = 0;
  const isTableSep = (l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l ?? '') && (l ?? '').includes('-');
  const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  const startsBlock = (l) => /^\s*(```|#{1,6}\s|>|[-*+]\s|\d+[.)]\s|(-{3,}|\*{3,}|_{3,})\s*$)/.test(l);
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) { i++; continue; }
    let m;
    if ((m = /^\s*```\s*([\w+-]*)\s*$/.exec(l))) {
      const code = []; i++; while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) code.push(lines[i++]); i++;
      root.append(el('pre', null, el('code', m[1] ? { 'data-lang': m[1] } : null, code.join('\n')))); continue;
    }
    if ((m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(l))) { root.append(el('h' + Math.min(6, m[1].length + 2), null, inline(m[2]))); i++; continue; }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(l)) { root.append(el('hr')); i++; continue; }
    if (/^\s*>/.test(l)) { const q = []; while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, '')); const b = md(q.join('\n')); b.className = ''; root.append(el('blockquote', null, ...b.childNodes)); continue; }
    if (l.includes('|') && isTableSep(lines[i + 1])) {
      const head = cells(l); i += 2; const rows = []; while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]));
      root.append(el('div', { class: 'md-table' }, el('table', null, el('thead', null, el('tr', null, head.map((c) => el('th', null, inline(c))))), el('tbody', null, rows.map((r) => el('tr', null, head.map((_, n) => el('td', null, inline(r[n] ?? '')))))))));
      continue;
    }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(l)) {
      const ordered = /^\s*\d+[.)]/.test(l); const list = el(ordered ? 'ol' : 'ul');
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
        const first = lines[i++].replace(/^\s*([-*+]|\d+[.)])\s+/, ''); const more = [];
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) more.push(lines[i++].trim());
        const task = /^\[( |x|X)\]\s+(.*)$/.exec(first);
        list.append(el('li', null, ...(task ? [el('span', { class: 'md-check', 'aria-hidden': 'true' }, icon(task[1] === ' ' ? 'check_box_outline_blank' : 'check_box'), ' ')] : []), ...withBreaks([task ? task[2] : first, ...more])));
      }
      root.append(list); continue;
    }
    const para = []; while (i < lines.length && lines[i].trim() && !(para.length && startsBlock(lines[i]))) para.push(lines[i++]);
    root.append(el('p', null, ...withBreaks(para)));
  }
  return root;
}
