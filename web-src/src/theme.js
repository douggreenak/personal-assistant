import { Hct, SchemeVibrant, MaterialDynamicColors, argbFromHex, hexFromArgb } from '@material/material-color-utilities';

export const PRESETS = [['Violet', '#6750A4'], ['Coral', '#D9534F'], ['Orchid', '#C2478F'], ['Tangerine', '#E8761A'], ['Lime', '#7A9A00'], ['Teal', '#00897B'], ['Ocean', '#1E6FD9'], ['Slate', '#5B6B7A']];
const ROLES = ['primary', 'onPrimary', 'primaryContainer', 'onPrimaryContainer', 'secondary', 'onSecondary', 'secondaryContainer', 'onSecondaryContainer',
  'tertiary', 'onTertiary', 'tertiaryContainer', 'onTertiaryContainer', 'error', 'onError', 'errorContainer', 'onErrorContainer', 'background', 'onBackground',
  'surface', 'onSurface', 'surfaceVariant', 'onSurfaceVariant', 'outline', 'outlineVariant', 'shadow', 'scrim', 'inverseSurface', 'inverseOnSurface', 'inversePrimary',
  'surfaceDim', 'surfaceBright', 'surfaceContainerLowest', 'surfaceContainerLow', 'surfaceContainer', 'surfaceContainerHigh', 'surfaceContainerHighest', 'surfaceTint',
  'primaryFixed', 'primaryFixedDim', 'secondaryFixed', 'tertiaryFixed'];
const kebab = (s) => s.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());

export const prefs = {
  get seed() { return localStorage.getItem('ui_seed') || '#C2478F'; },
  get mode() { return localStorage.getItem('ui_mode') || 'auto'; },
  set(k, v) { localStorage.setItem('ui_' + k, v); applyTheme(); },
};
const mq = matchMedia('(prefers-color-scheme: dark)');
export const isDark = () => (prefs.mode === 'auto' ? mq.matches : prefs.mode === 'dark');

export function applyTheme() {
  const dark = isDark();
  const scheme = new SchemeVibrant(Hct.fromInt(argbFromHex(prefs.seed)), dark, 0);
  const root = document.documentElement;
  for (const r of ROLES) { const dc = MaterialDynamicColors[r]; if (dc) root.style.setProperty('--md-sys-color-' + kebab(r), hexFromArgb(dc.getArgb(scheme))); }
  root.dataset.theme = dark ? 'dark' : 'light'; root.style.colorScheme = dark ? 'dark' : 'light';
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', getComputedStyle(root).getPropertyValue('--md-sys-color-surface'));
}
mq.addEventListener('change', () => prefs.mode === 'auto' && applyTheme());
