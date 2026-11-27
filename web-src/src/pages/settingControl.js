import { h, icon } from '../ui.js';

/** One editable setting (switch, secret or text field). `touch(key, value)` is called on every change. Shared by Settings and the Connect page. */
export function settingControl(d, touch) {
  const hint = d.help ? h('div', { class: 'help' }, d.help) : null;
  if (d.type === 'bool') { const sw = h('md-switch', { selected: d.value === '1' || d.value === 'true' }); sw.addEventListener('change', () => touch(d.key, sw.selected ? '1' : '0')); return h('div', {}, h('div', { class: 'field-row' }, h('div', {}, h('div', { class: 't' }, d.label), hint), sw)); }
  if (d.type === 'secret') {
    const f = h('md-outlined-text-field', { label: d.label, type: 'password', placeholder: d.isSet ? '•••••••• (set — type to replace)' : 'not set', autocomplete: 'off' });
    f.addEventListener('input', () => touch(d.key, f.value));
    return h('div', {}, h('div', { style: 'display:flex;gap:8px;align-items:center' }, f, d.isSet && h('md-icon-button', { title: 'Clear', 'aria-label': 'Clear ' + d.label, onclick: () => { touch(d.key, '__clear__'); f.placeholder = 'will be cleared'; } }, icon('delete'))), hint);
  }
  const f = h('md-outlined-text-field', { label: d.label, value: d.value, placeholder: d.placeholder || '', type: d.type === 'number' ? 'number' : 'text', 'supporting-text': d.overridden ? 'Changed here (overrides .env)' : (!d.value && d.placeholder ? `Not set — default: ${d.placeholder}` : '') });
  f.addEventListener('input', () => touch(d.key, f.value)); return h('div', {}, f, hint);
}
