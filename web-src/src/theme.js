import { Hct, SchemeTonalSpot, MaterialDynamicColors, argbFromHex, hexFromArgb } from '@material/material-color-utilities';

export const PRESETS = [['Blue', '#1E6FD9'], ['Teal', '#00897B'], ['Green', '#2E7D32'], ['Lime', '#7A9A00'], ['Orange', '#E8761A'], ['Slate', '#5B6B7A']];
const ROLES = ['primary', 'onPrimary', 'primaryContainer', 'onPrimaryContainer', 'secondary', 'onSecondary', 'secondaryContainer', 'onSecondaryContainer',
  'tertiary', 'onTertiary', 'tertiaryContainer', 'onTertiaryContainer', 'error', 'onError', 'errorContainer', 'onErrorContainer', 'background', 'onBackground',
  'surface', 'onSurface', 'surfaceVariant', 'onSurfaceVariant', 'outline', 'outlineVariant', 'shadow', 'scrim', 'inverseSurface', 'inverseOnSurface', 'inversePrimary',
  'surfaceDim', 'surfaceBright', 'surfaceContainerLowest', 'surfaceContainerLow', 'surfaceContainer', 'surfaceContainerHigh', 'surfaceContainerHighest', 'surfaceTint',
  'primaryFixed', 'primaryFixedDim', 'secondaryFixed', 'tertiaryFixed'];
const kebab = (s) => s.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());

/** Pink and purple are not offered anywhere: a seed colour in that range is refused (and a saved one is ignored). */
export const isBannedHue = (hex) => { try { const h = Hct.fromInt(argbFromHex(hex)); return h.chroma > 12 && (h.hue >= 278 || h.hue <= 12);  /* HCT hues: violet and purple 278–330, pink 330–360, hot pink and magenta 0–12 */ } catch { return false; } };
export const prefs = {
  get seed() { const v = localStorage.getItem('ui_seed'); return v && !isBannedHue(v) ? v : '#1E6FD9'; },
  get mode() { return localStorage.getItem('ui_mode') || 'auto'; },
  set(k, v) { localStorage.setItem('ui_' + k, v); applyTheme(); },
};
const mq = matchMedia('(prefers-color-scheme: dark)');
export const isDark = () => (prefs.mode === 'auto' ? mq.matches : prefs.mode === 'dark');

export function applyTheme() {
  const dark = isDark();
  const scheme = new SchemeTonalSpot(Hct.fromInt(argbFromHex(prefs.seed)), dark, 0);
  const root = document.documentElement;
  for (const r of ROLES) { const dc = MaterialDynamicColors[r]; if (dc) root.style.setProperty('--md-sys-color-' + kebab(r), hexFromArgb(dc.getArgb(scheme))); }
  // TonalSpot's tertiary hue lands on pink/purple for many seeds, so the tertiary roles come from a fixed amber palette instead.
  const amber = new SchemeTonalSpot(Hct.fromInt(argbFromHex('#B26A00')), dark, 0);
  for (const [role, from] of [['tertiary', 'primary'], ['onTertiary', 'onPrimary'], ['tertiaryContainer', 'primaryContainer'], ['onTertiaryContainer', 'onPrimaryContainer']]) {
    root.style.setProperty('--md-sys-color-' + kebab(role), hexFromArgb(MaterialDynamicColors[from].getArgb(amber)));
  }
  root.dataset.theme = dark ? 'dark' : 'light'; root.style.colorScheme = dark ? 'dark' : 'light';
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', getComputedStyle(root).getPropertyValue('--md-sys-color-surface'));
}
mq.addEventListener('change', () => prefs.mode === 'auto' && applyTheme());
