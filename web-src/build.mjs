// Builds the web UI into ../src/web/assets (committed, so the server needs no build step or runtime dependencies).
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync, readdirSync } from 'node:fs';

const ICONS = ['computer', 'compress', 'support_agent', 'open_in_new', 'code', 'stop', 'bar_chart', 'arrow_back', 'attach_file', 'image', 'home', 'checklist', 'chat', 'inbox', 'task_alt', 'extension', 'monitor_heart', 'settings', 'add', 'close', 'check', 'schedule', 'delete', 'edit',
  'send', 'refresh', 'search', 'history', 'warning', 'error', 'restart_alt', 'logout', 'key', 'upload', 'dark_mode', 'light_mode', 'palette', 'bolt', 'notifications',
  'confirmation_number', 'alarm', 'more_horiz', 'menu', 'keyboard_arrow_down', 'sync', 'play_arrow', 'block', 'link', 'cloud_done', 'cloud_off', 'mail', 'folder',
  'snooze', 'done_all', 'undo', 'mic', 'bug_report', 'terminal', 'tune', 'lock_reset', 'contrast', 'arrow_forward', 'chevron_right', 'info', 'help', 'person', 'flag', 'event',
  'checklist_rtl', 'inventory_2', 'dns', 'speed', 'memory', 'database', 'smart_toy', 'public', 'verified', 'new_releases', 'auto_fix_high', 'keyboard', 'download', 'content_copy', 'system_update_alt', 'laptop_mac', 'sort', 'wifi_off', 'palette', 'dark_mode', 'light_mode', 'arrow_forward'];
const dir = 'node_modules/@material-symbols/svg-400/rounded/';
const icons = {};
for (const n of ICONS) {
  for (const [k, f] of [['', `${n}.svg`], ['-fill', `${n}-fill.svg`]]) {
    try { const svg = readFileSync(dir + f, 'utf8'); icons[n + k] = /<path d="([^"]+)"/.exec(svg)?.[1] ?? /<svg[^>]*>([\s\S]*)<\/svg>/.exec(svg)?.[1]; } catch { if (!k) console.warn('missing icon', n); }
  }
}
writeFileSync('src/icons.generated.js', `export default ${JSON.stringify(icons)};\n`);

const out = '../src/web/assets';
rmSync(out, { recursive: true, force: true }); mkdirSync(out + '/fonts', { recursive: true });
copyFileSync('node_modules/@fontsource-variable/roboto-flex/files/roboto-flex-latin-full-normal.woff2', out + '/fonts/roboto-flex.woff2');
await build({ entryPoints: { app: 'src/main.js' }, bundle: true, minify: true, format: 'esm', target: 'es2022', outdir: out, legalComments: 'none' });
for (const f of readdirSync('public')) copyFileSync('public/' + f, out + '/' + f);   // PWA: manifest, service worker, phone icons
copyFileSync('src/styles.css', out + '/styles.css'); copyFileSync('icon.svg', out + '/icon.svg');
console.log('built', out);
