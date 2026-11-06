import { DEFAULT_STREAM_QUALITY, DEFAULT_MIC_PROCESSING } from '../core/media.js';
import { DEFAULT_APPEARANCE } from '../core/appearance.js';
import { DEFAULT_CALL_BAR } from '../core/call-bar.js';

// User preferences persisted in localStorage. public/theme-init.js reads the same key.
const STORAGE_KEY = 'jayc.settings';

export const DEFAULT_SETTINGS = Object.freeze({
  displayName: '',
  /** Profile picture as a small data URL (core/avatar.js), or null. */
  avatar: null,
  /** Profile color others see behind us: { from, to?, angle? }, or null = picked from the name. */
  profileColor: null,
  serverAddress: '',
  /** 'system' | 'light' | 'dark' */
  theme: 'system',
  lastRoom: '',
  /** Rooms joined lately, newest first (core/recent-rooms.js), for one-click rejoining. */
  recentRooms: [],
  /** Last screen-share choices: 'screen' | 'window', and { resolution, fps, optimizeFor }. */
  shareMode: 'screen',
  streamQuality: DEFAULT_STREAM_QUALITY,
  /** { echoCancellation, noiseSuppression, autoGainControl } for the call microphone. */
  micProcessing: DEFAULT_MIC_PROCESSING,
  /** { accent: '#rrggbb' | '', gradient: { from, to, angle } | null }: '' / null = the theme's. */
  appearance: DEFAULT_APPEARANCE,
  /** Call controls: { position: 'bottom' | 'right' | 'top' | 'left', order: control keys }. */
  callBar: DEFAULT_CALL_BAR,
  /** Interface language: 'system' (the OS language), 'en' or 'pt-BR' (core/i18n.js). */
  language: 'system',
  /** The look: 'calm', 'neon' or 'soft' (core/style.js, styles/theme.css). */
  style: 'calm',
  /** Animations: 'on' or 'off' (core/motion.js). */
  motion: 'on',
  /** Executables left out of the entire-screen share's sound, e.g. ['Discord.exe']. */
  excludedApps: [],
  /** Native mic (Windows) endpoint id, or null = the Windows default. */
  micDevice: null,
  /** Mic volume (1 = 100%, up to core/mic-shape.js MAX_MIC_GAIN) and sensitivity: the gate
   * threshold in dBFS, or null = always send. Native mic only. */
  micGain: 1,
  micGate: null,
  /** Speakers for the call's sound: a deviceId from enumerateDevices, or '' = the default. */
  outputDevice: '',
  /** The "Welcome!" tour (core/welcome.js) already opened by itself once; Settings › Help reopens it. */
  welcomeSeen: false,
  /** Discord status during calls (Windows, core/discord-presence.js), and whether it names the room. */
  discordPresence: true,
  discordShowRoom: false,
  /** Short sounds for mute, deafen, joins, leaves, streams and chat (core/sounds.js). */
  alertSounds: true,
});

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    return {
      ...DEFAULT_SETTINGS,
      ...saved,
      streamQuality: { ...DEFAULT_STREAM_QUALITY, ...saved.streamQuality },
      micProcessing: { ...DEFAULT_MIC_PROCESSING, ...saved.micProcessing },
      appearance: { ...DEFAULT_APPEARANCE, ...saved.appearance },
      callBar: { ...DEFAULT_CALL_BAR, ...saved.callBar },
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

let state = load();
const listeners = new Set();

export const settings = {
  get() {
    return state;
  },

  update(patch) {
    const prev = state;
    state = { ...state, ...patch };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // Storage unavailable (private mode / quota): keep working in memory.
    }
    for (const listener of listeners) listener(state, prev);
  },

  /** Calls `listener(next, prev)` on every update. Returns an unsubscribe function. */
  subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
