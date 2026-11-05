import { settings } from '../store/settings.js';
import { appearanceVars } from '../core/appearance.js';
import { resolveMotion } from '../core/motion.js';
import { resolveStyle } from '../core/style.js';
import { normalizeShape } from '../core/call-bar.js';

const darkQuery = matchMedia('(prefers-color-scheme: dark)');
const reducedMotionQuery = matchMedia('(prefers-reduced-motion: reduce)');

/** <html data-motion="full|reduced"> from Settings › Appearance › Animations and the OS. */
function applyMotion() {
  document.documentElement.dataset.motion = resolveMotion(settings.get().motion, reducedMotionQuery.matches);
}

/** <html data-style> from Settings › Appearance › Style (styles/theme.css). */
function applyStyle() {
  const { style, callBar } = settings.get();
  document.documentElement.dataset.style = resolveStyle(style);
  document.documentElement.dataset.callShape = normalizeShape(callBar?.shape);
}
const isTauri = '__TAURI_INTERNALS__' in window;

/** Same logic as public/theme-init.js. */
export function resolveTheme(preference) {
  return preference === 'dark' || (preference === 'system' && darkQuery.matches) ? 'dark' : 'light';
}

function apply() {
  const theme = resolveTheme(settings.get().theme);
  const root = document.documentElement;
  if (root.dataset.theme === theme) return;
  root.dataset.theme = theme;

  // Keep the native title bar in sync (Windows/macOS).
  if (isTauri) {
    import('@tauri-apps/api/window')
      .then(({ getCurrentWindow }) => getCurrentWindow().setTheme(theme))
      .catch(() => {});
  }
}

/** Button color and background gradient from Settings › Appearance (inline, so both themes use them). */
function applyAppearance() {
  const root = document.documentElement;
  const vars = appearanceVars(settings.get().appearance);
  for (const [name, value] of Object.entries(vars)) {
    if (value) root.style.setProperty(name, value);
    else root.style.removeProperty(name);
  }
  // Lets the CSS let the gradient show through the top bar (public/theme-init.js sets it too).
  if (vars['--app-background']) root.dataset.background = 'gradient';
  else delete root.dataset.background;
}

export function initTheme() {
  document.documentElement.dataset.theme = ''; // force the first apply() to sync the title bar
  apply();
  applyAppearance();
  applyMotion();
  applyStyle();
  settings.subscribe((next, prev) => {
    if (next.theme !== prev.theme) apply();
    if (next.appearance !== prev.appearance) applyAppearance();
    if (next.motion !== prev.motion) applyMotion();
    if (next.style !== prev.style || next.callBar !== prev.callBar) applyStyle();
  });
  darkQuery.addEventListener('change', apply);
  reducedMotionQuery.addEventListener('change', applyMotion);
}

/** Header quick toggle: flips between explicit light and dark. */
export function toggleTheme() {
  const current = document.documentElement.dataset.theme;
  settings.update({ theme: current === 'dark' ? 'light' : 'dark' });
}

export function currentTheme() {
  return document.documentElement.dataset.theme;
}
