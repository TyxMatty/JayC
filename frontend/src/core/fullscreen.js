// Full screen for one element (a stream). Desktop: the Fullscreen API, and Tauri turns the window
// full screen with it. Android: the WebView can't (wry cancels element full screen), so the element
// is pinned over the page with CSS (.is-fullscreen) and the app hides the system bars and turns
// landscape (tauri-plugin-pip set_immersive). Android's back button leaves it, like a video app.
// The element gets a `fullscreenchange` event either way.
import { invoke } from '@tauri-apps/api/core';
import { isAndroidApp } from './activity-pip.js';

let pinned = null;

/** The element in full screen, or null. */
export const fullscreenElement = () => pinned ?? document.fullscreenElement ?? null;

function pin(el) {
  const previous = pinned;
  pinned = el;
  previous?.classList.remove('is-fullscreen');
  el?.classList.add('is-fullscreen');
  invoke('plugin:pip|set_immersive', { enabled: Boolean(el) }).catch((error) => console.warn('[fullscreen]', error));
  for (const target of new Set([previous, el])) target?.dispatchEvent(new Event('fullscreenchange'));
}

/** Leaves full screen (no-op when nothing is). */
export function exitFullscreen() {
  if (!isAndroidApp()) {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    return;
  }
  if (!pinned) return;
  // Undo the history entry added on entering; its popstate (below) unpins.
  if (history.state?.jaycFullscreen) history.back();
  else pin(null);
}

/** Must run from a click on desktop (the Fullscreen API needs user activation). */
export function toggleFullscreen(el) {
  if (fullscreenElement()) return exitFullscreen();
  if (!isAndroidApp()) return void el.requestFullscreen?.().catch(() => {});
  // A history entry, so the back button closes the full screen instead of the app.
  history.pushState({ jaycFullscreen: true }, '');
  pin(el);
}

if (isAndroidApp()) addEventListener('popstate', () => pinned && pin(null));
