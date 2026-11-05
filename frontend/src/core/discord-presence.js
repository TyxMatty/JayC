// Discord Rich Presence (Windows app): during a call, the user's Discord profile shows Jay-C.
// This side decides what the status says; src-tauri/src/discord.rs talks to Discord (and spaces
// the updates). Choices: docs/ARQUITETURA.md, "Discord Rich Presence".
import * as systemAudio from 'tauri-plugin-system-audio-api';
import { t } from './i18n.js';
import { resolveStyle } from './style.js';

/** The wolf in each style's color: images of the "Jay-C" app on the Discord Developer Portal. */
const WOLF_IMAGES = { calm: 'jayc_purple', neon: 'jayc_neon', soft: 'jayc_orange_thick' };

/** shortcut: the server's default room limit; a server with another MAX_PEERS_PER_ROOM shows a wrong max. */
const ROOM_SIZE = 16;

/**
 * The Discord activity for a call's state.
 * @param {{ people: number, sharing: boolean, watching: boolean, room: string, showRoom: boolean, since: number, style?: string }} state
 *   `since`: when we joined (ms since the epoch); `style`: the app's (Calmo, Neon, Suave), for the wolf's color.
 */
export function presenceActivity({ people, sharing, watching, room, showRoom, since, style }) {
  const live = sharing || watching;
  return {
    details: showRoom ? t('In room #{room}', { room }) : t('In a call'),
    state: t(sharing ? 'Streaming their screen' : watching ? 'Watching a stream' : 'Talking'),
    timestamps: { start: since },
    assets: {
      large_image: WOLF_IMAGES[resolveStyle(style)],
      large_text: 'Jay-C',
      ...(live ? { small_image: 'live', small_text: t('Live') } : {}),
    },
    // Discord shows it after the state: "Talking (3 of 16)".
    party: { size: [people, Math.max(people, ROOM_SIZE)] },
  };
}

const setPresence = (activity) =>
  import('@tauri-apps/api/core').then(({ invoke }) => invoke('discord_presence', { activity })).catch(() => {});

/**
 * Keeps the Discord status in step with `call` until it ends or `stop()` (either clears it).
 * `refresh()`: after an option changed (Settings).
 * @param {import('./call.js').Call} call
 * @param {{ room: string, since?: number, getOptions?: () => { showRoom?: boolean, style?: string } }} options
 *   `since`: when we joined (ms), kept when the status is turned off and on again.
 * @returns {{ refresh: () => void, stop: () => void }}
 */
export function startDiscordPresence(call, { room, since = Date.now(), getOptions = () => ({}) }) {
  let stopped = false;
  let sent = '';
  let timer = null;
  // Bursts (a full room joining, leave() removing everyone before 'ended') become one update.
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(update, 250);
  };
  const update = async () => {
    if (!(await systemAudio.isSupported()) || stopped) return;
    const participants = [...call.participants.values()];
    const { showRoom = false, style } = getOptions();
    const activity = presenceActivity({
      people: participants.length + 1,
      sharing: call.sharing,
      watching: participants.some((p) => p.media.screen && p.watching),
      room,
      showRoom,
      since,
      style,
    });
    const json = JSON.stringify(activity);
    if (json === sent) return; // participant-updated also fires for mute, previews...
    sent = json;
    setPresence(activity);
  };
  const events = ['participant-added', 'participant-removed', 'participant-updated', 'local-updated'];
  for (const type of events) call.addEventListener(type, schedule);
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    for (const type of events) call.removeEventListener(type, schedule);
    call.removeEventListener('ended', stop);
    if (sent) setPresence(null);
  };
  call.addEventListener('ended', stop);
  update();
  return { refresh: schedule, stop };
}
