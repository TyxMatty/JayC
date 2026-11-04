// Picture-in-Picture on Android: the WebView has no <video> PiP, so the whole activity shrinks into
// the floating window (tauri-plugin-pip). While it's floating, the page shows only the featured
// video, full size (html[data-activity-pip] in app.css). Same interface as createPip() in pip.js.
import { invoke, addPluginListener } from '@tauri-apps/api/core';

export const isAndroidApp = () => '__TAURI_INTERNALS__' in globalThis && /Android/i.test(navigator.userAgent);

/**
 * @param {{ onLeave?: () => void }} handlers  onLeave: the floating window went back to full screen.
 */
export function createActivityPip({ onLeave } = {}) {
  let active = false;
  let size = { width: 16, height: 9 };
  const video = Object.assign(document.createElement('video'), {
    muted: true, // the call's audio keeps playing from the (hidden) tiles
    autoplay: true,
    playsInline: true,
    className: 'activity-pip-video',
  });
  document.body.append(video);

  // Leaving the app (Home, recents) during a call floats it; the window takes the video's shape.
  const autoEnter = (enabled) =>
    invoke('plugin:pip|set_auto_enter', { enabled, ...size }).catch((error) => console.warn('[pip]', error));
  video.addEventListener('resize', () => {
    if (!video.videoWidth || !video.videoHeight) return;
    size = { width: video.videoWidth, height: video.videoHeight };
    autoEnter(true);
  });
  autoEnter(true);

  const listener = addPluginListener('pip', 'pipModeChanged', ({ active: now }) => {
    active = now;
    document.documentElement.toggleAttribute('data-activity-pip', now);
    if (now) video.play().catch(() => {});
    else onLeave?.();
  });

  return {
    /** The floating window can appear on its own (auto-enter), so keep the video current. */
    followsFeatured: true,
    get open() {
      return active;
    },
    show(track) {
      const current = video.srcObject?.getVideoTracks()[0] ?? null;
      if (current === (track ?? null)) return;
      video.srcObject = track ? new MediaStream([track]) : null;
      if (track) video.play().catch(() => {});
    },
    async enter(track) {
      this.show(track);
      await invoke('plugin:pip|enter', size);
    },
    /** Android has no "leave PiP" call: the user expands or closes the floating window. */
    async exit() {},
    setState() {},
    destroy() {
      autoEnter(false);
      listener.then((l) => l.unregister()).catch(() => {});
      video.remove();
      document.documentElement.removeAttribute('data-activity-pip');
    },
  };
}
