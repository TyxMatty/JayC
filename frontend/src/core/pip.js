// Picture-in-Picture. Windows app: our own always-on-top window (src-tauri/src/pip_window.rs turns
// window.open into it), filled from here with the video and the call's buttons. WebView2's video
// PiP (the fallback) showed the page's origin, "tauri.localhost"; Document PiP can't open its
// window there ("no window"), see docs/ARQUITETURA.md section 7.
// On Android the whole app floats instead (activity-pip.js); createPip() picks the right one.
import { isAndroidApp, createActivityPip } from './activity-pip.js';
import { t } from './i18n.js';

export const pipSupported = () => globalThis.document?.pictureInPictureEnabled === true || isAndroidApp();

const showing = (track) => track?.readyState === 'live' && !track.muted && track.enabled;

/**
 * The video worth floating: a shared screen we watch first, else a camera that is on.
 * @param {Iterable<{ media: { screen?: boolean, video?: boolean }, watching?: boolean, stream: MediaStream, screenStream?: MediaStream }>} participants
 * @returns {MediaStreamTrack | null}
 */
export function pickPipTrack(participants) {
  const list = [...participants];
  for (const p of list) {
    const track = p.media.screen && p.watching !== false && p.screenStream?.getVideoTracks().find(showing);
    if (track) return track;
  }
  for (const p of list) {
    const track = p.media.video !== false && p.stream.getVideoTracks().find(showing);
    if (track) return track;
  }
  return null;
}

const ACTIONS = ['togglemicrophone', 'togglecamera', 'hangup'];

/**
 * Windows: the PiP window is WebView2's, and the taskbar showed it as another app (the main window
 * has its own app ID, src-tauri/src/taskbar_icon.rs). Gives it the same ID, a few times in case it
 * isn't up yet when requestPictureInPicture resolves.
 */
function groupWithApp() {
  if (!('__TAURI_INTERNALS__' in window) || isAndroidApp()) return;
  for (const delay of [0, 300, 1000]) {
    setTimeout(() => window.__TAURI_INTERNALS__.invoke('group_child_windows').catch(() => {}), delay);
  }
}

/**
 * A PiP window that shows one video track at a time. The track can change while it's open (e.g.
 * someone starts sharing) without a new click, because the same detached <video> stays in PiP.
 * @param {{ togglemicrophone: () => void, togglecamera: () => void, hangup: () => void, onLeave?: () => void }} handlers
 *   onLeave: the window closed (also from its own close button).
 */
export function createPip(handlers) {
  if (isAndroidApp()) return createActivityPip(handlers);
  if ('__TAURI_INTERNALS__' in window && handlers.icons) return createWindowPip(handlers);
  return createVideoPip(handlers);
}

const PIP_STYLE = `
  html, body { margin: 0; height: 100%; background: #000; overflow: hidden; user-select: none; cursor: default; }
  video { width: 100%; height: 100%; object-fit: contain; display: block; }
  .bar { position: fixed; left: 50%; bottom: 10px; transform: translateX(-50%); display: flex; gap: 8px; opacity: 0; transition: opacity 0.15s; }
  .corner { position: fixed; top: 8px; right: 8px; opacity: 0; transition: opacity 0.15s; }
  body:hover .bar, body:hover .corner { opacity: 1; }
  button { width: 36px; height: 36px; padding: 0; border: 0; border-radius: 50%; display: grid; place-items: center;
    background: rgb(0 0 0 / 0.6); color: #fff; cursor: pointer; }
  button:hover { background: rgb(0 0 0 / 0.85); }
  button.off, button.danger { background: #e11d48; }
  button svg { width: 18px; height: 18px; }
`;

/**
 * Windows app: our own PiP window. Same API as createVideoPip. It's a window.open popup, so it
 * shares this page's process: the MediaStream plays there as is, and its buttons call back here.
 */
function createWindowPip(handlers) {
  const { icons } = handlers;
  let popup = null;
  let video = null;
  let buttons = null;
  let state = { micOn: true, cameraOn: false };
  let closedWatch = null;
  /** The track on show, to put back if the window's page is replaced. */
  let current = null;
  const fallback = createVideoPip(handlers);
  let usingFallback = false;
  // window.close() only closes the page: the native window stays, white (pip_window.rs).
  const closeWindow = () => window.__TAURI_INTERNALS__.invoke('pip_close').catch(() => popup?.close());
  // A reload of the app (or leaving it) would orphan the window.
  window.addEventListener('pagehide', () => popup && closeWindow());
  const render = () => {
    if (!buttons) return;
    const set = (button, html, label, off) => {
      button.innerHTML = html;
      button.title = label;
      button.setAttribute('aria-label', label);
      button.classList.toggle('off', off);
    };
    set(buttons.mic, state.micOn ? icons.mic : icons.micOff, t(state.micOn ? 'Mute microphone' : 'Unmute microphone'), !state.micOn);
    set(buttons.camera, state.cameraOn ? icons.video : icons.videoOff, t(state.cameraOn ? 'Turn camera off' : 'Turn camera on'), !state.cameraOn);
  };
  const build = () => {
    const doc = popup.document;
    doc.title = 'Jay-C';
    const style = doc.createElement('style');
    style.textContent = PIP_STYLE;
    doc.head.append(style);
    video = Object.assign(doc.createElement('video'), { muted: true, autoplay: true, playsInline: true });
    const button = (html, label, onClick, cls = '') => {
      const b = doc.createElement('button');
      b.type = 'button';
      b.className = cls;
      b.innerHTML = html;
      b.title = label;
      b.setAttribute('aria-label', label);
      b.addEventListener('click', onClick);
      return b;
    };
    buttons = {
      mic: button('', '', () => handlers.togglemicrophone()),
      camera: button('', '', () => handlers.togglecamera()),
      hangup: button(icons.phoneOff, t('Leave call'), () => handlers.hangup(), 'danger'),
      close: button(icons.close, t('Close'), closeWindow),
    };
    const bar = doc.createElement('div');
    bar.className = 'bar';
    bar.append(buttons.mic, buttons.camera, buttons.hangup);
    const corner = doc.createElement('div');
    corner.className = 'corner';
    corner.append(buttons.close);
    doc.body.append(video, bar, corner);
    // No title bar: pressing anywhere but a button moves the window.
    doc.addEventListener('mousedown', (e) => {
      if (e.button === 0 && !e.target.closest('button')) window.__TAURI_INTERNALS__.invoke('pip_drag').catch(() => {});
    });
    render();
  };
  return {
    get open() {
      return usingFallback ? fallback.open : Boolean(popup && !popup.closed);
    },
    show(track) {
      if (usingFallback) return fallback.show(track);
      current = track;
      if (video && video.srcObject?.getVideoTracks()[0] !== track) video.srcObject = new MediaStream([track]);
    },
    async enter(track) {
      if (!this.open) {
        const width = 480;
        const height = 270;
        const left = screen.availLeft + screen.availWidth - width - 24;
        const top = screen.availTop + screen.availHeight - height - 24;
        popup = window.open('', '', `popup,width=${width},height=${height},left=${left},top=${top}`);
        if (!popup) {
          usingFallback = true; // no window: WebView2's video PiP
          return fallback.enter(track);
        }
        usingFallback = false;
        build();
        closedWatch = setInterval(() => {
          if (popup && !popup.closed) {
            // WebView2 may finish loading the window's about:blank after we filled it, which
            // replaces the page (seen: a white window): fill it again.
            if (!popup.document.querySelector('video')) {
              build();
              if (current) video.srcObject = new MediaStream([current]);
              video.play().catch(() => {});
            }
            return;
          }
          clearInterval(closedWatch);
          popup = video = buttons = null;
          handlers.onLeave?.();
        }, 300);
      }
      this.show(track);
      await video.play().catch(() => {});
      groupWithApp();
    },
    async exit() {
      if (usingFallback) return fallback.exit();
      if (popup && !popup.closed) closeWindow();
    },
    setState(next) {
      state = next;
      render();
      fallback.setState(next);
    },
  };
}

function createVideoPip(handlers) {
  const video =Object.assign(document.createElement('video'), { muted: true, autoplay: true, playsInline: true });
  const setHandlers = (on) => {
    for (const action of ACTIONS) {
      try {
        navigator.mediaSession.setActionHandler(action, on ? handlers[action] : null);
      } catch {
        // Action not supported by this WebView: the window just lacks that button.
      }
    }
  };
  video.addEventListener('leavepictureinpicture', () => {
    setHandlers(false);
    handlers.onLeave?.();
  });

  return {
    get open() {
      return document.pictureInPictureElement === video;
    },
    /** Shows `track` (audio plays from the call tiles, so this video stays muted). */
    show(track) {
      if (video.srcObject?.getVideoTracks()[0] !== track) video.srcObject = new MediaStream([track]);
    },
    /** Must run from a click (PiP needs user activation). */
    async enter(track) {
      this.show(track);
      await video.play();
      setHandlers(true);
      await video.requestPictureInPicture();
      groupWithApp();
    },
    async exit() {
      if (this.open) await document.exitPictureInPicture();
    },
    /** Mic / camera state for the PiP window's buttons. */
    setState({ micOn, cameraOn }) {
      try {
        navigator.mediaSession.setMicrophoneActive(micOn);
        navigator.mediaSession.setCameraActive(cameraOn);
      } catch {
        // Not supported: the buttons still work, they just don't show the state.
      }
    },
  };
}
