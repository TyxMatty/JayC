// Camera/microphone and screen capture, plus screen-share quality presets.

export const CAMERA_CONSTRAINTS = {
  width: { ideal: 1280 },
  height: { ideal: 720 },
  frameRate: { ideal: 30 },
};

export const MIC_CONSTRAINTS = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

export async function getMicTrack() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: MIC_CONSTRAINTS });
  return stream.getAudioTracks()[0];
}

export async function getCameraTrack() {
  const stream = await navigator.mediaDevices.getUserMedia({ video: CAMERA_CONSTRAINTS });
  return stream.getVideoTracks()[0];
}

/**
 * Opens microphone and camera, degrading gracefully: a missing or denied device just leaves
 * that track null (the call still works, receive-only for that kind).
 * @returns {Promise<{ audio: MediaStreamTrack | null, video: MediaStreamTrack | null, errors: Record<string, string> }>}
 */
export async function openLocalMedia() {
  if (!navigator.mediaDevices?.getUserMedia) {
    return { audio: null, video: null, errors: { audio: 'unsupported', video: 'unsupported' } };
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: MIC_CONSTRAINTS, video: CAMERA_CONSTRAINTS });
    return { audio: stream.getAudioTracks()[0] ?? null, video: stream.getVideoTracks()[0] ?? null, errors: {} };
  } catch {
    // One device failed (or the user denied one): try each separately.
    const [audio, video] = await Promise.allSettled([getMicTrack(), getCameraTrack()]);
    return {
      audio: audio.status === 'fulfilled' ? audio.value : null,
      video: video.status === 'fulfilled' ? video.value : null,
      errors: {
        ...(audio.status === 'rejected' ? { audio: audio.reason?.name ?? 'Error' } : {}),
        ...(video.status === 'rejected' ? { video: video.reason?.name ?? 'Error' } : {}),
      },
    };
  }
}

// ---------- Screen sharing ----------

/** Output heights offered in the quality controls (null = the source's own size). */
export const STREAM_RESOLUTIONS = [
  { id: '360', label: '360p', height: 360 },
  { id: '480', label: '480p', height: 480 },
  { id: '720', label: '720p', height: 720 },
  { id: '1080', label: '1080p', height: 1080 },
  { id: '1440', label: '1440p', height: 1440 },
  { id: 'source', label: 'Source', height: null },
];

export const STREAM_FRAME_RATES = [5, 15, 24, 30, 60];

/** `optimizeFor` maps to track.contentHint: crisp text vs. smooth movement when bandwidth is short. */
export const DEFAULT_STREAM_QUALITY = Object.freeze({ resolution: '1080', fps: 30, optimizeFor: 'detail' });

export const canShareScreen = () => Boolean(navigator.mediaDevices?.getDisplayMedia);

export function targetHeight(resolutionId) {
  return STREAM_RESOLUTIONS.find((r) => r.id === resolutionId)?.height ?? null;
}

/**
 * Bitrate cap for a screen share: ~0.08 bits per pixel per frame, with frames above 30 fps
 * counting half (screen content compresses well between frames). 1080p30 ≈ 5 Mbps, 1080p60 ≈ 7.5 Mbps.
 */
export function streamBitrate(width, height, fps) {
  const effectiveFps = fps <= 30 ? fps : 30 + (fps - 30) / 2;
  const bitrate = width * height * 0.08 * effectiveFps;
  return Math.round(Math.min(12_000_000, Math.max(200_000, bitrate)));
}

/**
 * Opens the system picker. `mode` is a hint ('screen' -> monitors first, 'window' -> windows first);
 * check `describeCapture()` for what the user actually picked.
 * Audio is captured natively (Rust) in a later milestone, so getDisplayMedia's is not requested.
 */
export async function getScreenTrack(mode, quality) {
  if (!canShareScreen()) {
    throw Object.assign(new Error('Screen sharing is not supported here'), { name: 'NotSupportedError' });
  }
  const height = targetHeight(quality.resolution);
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: {
      displaySurface: mode === 'window' ? 'window' : 'monitor',
      frameRate: { ideal: quality.fps, max: quality.fps },
      ...(height ? { height: { max: height } } : {}),
    },
    audio: false,
    selfBrowserSurface: 'exclude',
    surfaceSwitching: 'exclude',
    monitorTypeSurfaces: 'include',
  });
  return stream.getVideoTracks()[0];
}

/**
 * What a display track captures. On Windows, Chromium labels window captures "window:<HWND>:0",
 * which the native audio capture uses to find the window's process.
 */
export function describeCapture(track) {
  const match = /^(window|screen):(-?\d+):/.exec(track.label);
  const surface = track.getSettings().displaySurface ?? (match?.[1] === 'window' ? 'window' : 'monitor');
  return {
    mode: surface === 'window' ? 'window' : 'screen',
    windowHandle: match?.[1] === 'window' ? Number(match[2]) : null,
  };
}
