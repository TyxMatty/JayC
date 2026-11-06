// Picture-in-Picture on the desktop: WebView2's video PiP, an always-on-top window, with the call's
// mic / camera / hang-up buttons through the Media Session API. Document PiP exists in WebView2 but
// can't open its window ("no window"), see docs/ARQUITETURA.md section 7.
// On Android the whole app floats instead (activity-pip.js); createPip() picks the right one.
import { isAndroidApp, createActivityPip } from './activity-pip.js';

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
