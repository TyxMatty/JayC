import { h } from './dom.js';
import { icons } from './icons.js';
import { canShareScreen } from '../core/media.js';
import { createSharePanel } from './share-panel.js';
import { pipSupported, pickPipTrack, createPip } from '../core/pip.js';
import { fitGrid } from '../core/grid-fit.js';
import { fullscreenElement, toggleFullscreen as toggleElementFullscreen, exitFullscreen } from '../core/fullscreen.js';
import { createControlBar } from './control-bar.js';
import { createAudioMenu } from './audio-menu.js';
import { createChatPanel } from './chat-panel.js';
import { createMixer } from '../core/playback.js';
import { createSpeakingDetector } from '../core/speaking.js';
import { profileBackground } from '../core/profile-color.js';
import { settings } from '../store/settings.js';
import { t } from '../core/i18n.js';

const CONNECTION_LABELS = {
  new: 'Connecting…',
  connecting: 'Connecting…',
  disconnected: 'Reconnecting…',
  failed: 'Connection failed',
};

const MEDIA_ERROR_LABELS = {
  NotAllowedError: 'permission denied',
  NotFoundError: 'no device found',
  NotReadableError: 'device is in use by another app',
  unsupported: 'not supported here',
};

function initials(name) {
  return (
    name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((word) => word[0]?.toUpperCase() ?? '')
      .join('') || '?'
  );
}

function hasLiveVideo(stream) {
  return stream.getVideoTracks().some((t) => t.readyState === 'live' && !t.muted && t.enabled);
}

/**
 * @param {{ name: string, stream: MediaStream, local: boolean, getMedia: () => ({ audio: boolean, video: boolean } | null), getAvatar: () => string | null, getColor?: () => object | null, onWatch?: () => void }} options
 *   getMedia: what this participant is sending (null = unknown yet); getAvatar: their profile picture;
 *   getColor: their profile color (the tile's background while the camera is off);
 *   onWatch: the "Watch stream" button on their tile while they share and we aren't watching.
 */
function createTile({ name, stream, local, getMedia, getAvatar, getColor = () => null, onWatch }) {
  // Always muted: remote sound plays through the mixer (core/playback.js).
  const video = h('video', { autoplay: true, playsinline: true, muted: true, srcObject: stream });
  const avatar = h('div', { class: 'tile-avatar', 'aria-hidden': 'true' }, initials(name));
  const nameText = h('span', {}, local ? t('{name} (you)', { name }) : name);
  const mutedIcon = h('span', { class: 'tile-muted', title: t('Microphone off'), html: icons.micOff, hidden: true });
  const label = h('div', { class: 'tile-label' }, mutedIcon, nameText);
  const overlay = h('div', { class: 'tile-overlay', hidden: true });
  const watchButton = h(
    'button',
    { type: 'button', class: 'tile-watch', hidden: true, onClick: () => onWatch?.() },
    h('span', { class: 'live-badge' }, t('LIVE')),
    t('Watch stream'),
  );
  const el = h('div', { class: local ? 'tile tile-local' : 'tile', tabindex: local ? false : 0 }, video, avatar, overlay, watchButton, label);

  const videoOn = () => (getMedia()?.video ?? true) && hasLiveVideo(stream);

  let shownName = name;
  let shownAvatar;
  /** The profile picture when there is one, else the initials, in a circle on their profile color. */
  const renderAvatar = () => {
    el.style.setProperty('--tile-bg', profileBackground(getColor(), shownName));
    const url = getAvatar();
    if (url === shownAvatar) return;
    shownAvatar = url;
    avatar.classList.toggle('has-picture', Boolean(url));
    avatar.replaceChildren(url ? h('img', { src: url, alt: '' }) : h('span', { class: 'tile-initials' }, initials(shownName)));
  };

  const tile = {
    el,
    refresh() {
      renderAvatar();
      el.dataset.video = videoOn() ? 'on' : 'off';
      mutedIcon.hidden = getMedia()?.audio !== false;
      // Re-attach so newly added tracks render everywhere (WebView2 and WebKit).
      if (video.srcObject !== stream || video.dataset.tracks !== String(stream.getTracks().length)) {
        video.srcObject = stream;
        video.dataset.tracks = String(stream.getTracks().length);
        video.play().catch(() => {});
      }
      // Track mute/unmute toggles the avatar placeholder.
      for (const track of stream.getVideoTracks()) {
        track.onmute = track.onunmute = track.onended = () => {
          el.dataset.video = videoOn() ? 'on' : 'off';
        };
      }
    },
    setName(next) {
      nameText.textContent = local ? t('{name} (you)', { name: next }) : next;
      shownName = next;
      shownAvatar = undefined; // re-render: the initials may have changed
      renderAvatar();
    },
    setOverlay(text) {
      overlay.textContent = text ?? '';
      overlay.hidden = !text;
    },
    /** Shows "Watch stream" while they share a stream we aren't watching. */
    setLive(unwatched) {
      watchButton.hidden = !unwatched;
      watchButton.setAttribute('aria-label', t("Watch {name}'s stream", { name: shownName }));
    },
  };
  tile.refresh();
  return tile;
}

/** A shared screen/window. Double-click (or its button) toggles full screen; `onPip` pops it out. */
function createScreenTile({ name, stream, local, onStop, onToggleMute, onFocus, onPip }) {
  const video = h('video', { autoplay: true, playsinline: true, muted: true, srcObject: stream });
  const muteButton = local ? null : h('button', { type: 'button', class: 'btn btn-secondary', onClick: () => onToggleMute?.() });
  const iconButton = (label, icon, onClick) =>
    h('button', { type: 'button', class: 'btn btn-secondary btn-icon', 'aria-label': label, title: label, html: icon, onClick });
  const toggleFullscreen = () => toggleElementFullscreen(el);
  const fullscreenButton = local ? null : iconButton(t('Full screen'), icons.maximize, () => toggleFullscreen());
  const pipButton = local || !onPip ? null : iconButton(t('Pop out video'), icons.pip, () => onPip());
  const icon = h('span', { class: 'tile-screen-icon', html: icons.monitor });
  const nameText = h('span', {}, local ? t('Your screen') : t("{name}'s screen", { name }));
  // A native share (core/native-live.js) has no local track to preview.
  const note = local
    ? h('div', { class: 'tile-screen-note', title: t('Sent straight from the GPU: no preview, to save CPU.') }, t('Live · no preview'))
    : null;
  const el = h(
    'div',
    {
      class: local ? 'tile tile-screen tile-screen-local' : 'tile tile-screen',
      title: local ? t('Click to show it bigger, or back in the corner') : t('Click to focus · double-click for fullscreen'),
    },
    video,
    note,
    h('div', { class: 'tile-label' }, icon, nameText),
    ...(local
      ? []
      : [
          h(
            'div',
            { class: 'tile-stream-actions' },
            muteButton,
            h('button', { type: 'button', class: 'btn btn-secondary', onClick: () => onStop?.() }, t('Stop watching')),
            pipButton,
            fullscreenButton,
          ),
        ]),
  );
  el.tabIndex = 0;
  // Focus this stream (a double-click's two clicks cancel out, then it goes fullscreen).
  el.addEventListener('click', (e) => !e.target.closest('button') && onFocus?.());
  el.addEventListener('keydown', (e) => {
    if (e.target === el && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      onFocus?.();
    }
  });
  if (!local) {
    el.addEventListener('dblclick', (e) => !e.target.closest('button') && toggleFullscreen());
    // Fires on this element when it enters or leaves full screen (Esc included).
    el.addEventListener('fullscreenchange', () => {
      const on = fullscreenElement() === el;
      fullscreenButton.innerHTML = on ? icons.minimize : icons.maximize;
      fullscreenButton.setAttribute('aria-label', on ? t('Exit full screen') : t('Full screen'));
      fullscreenButton.title = fullscreenButton.getAttribute('aria-label');
    });
  }
  return {
    el,
    toggleFullscreen,
    /** After the tile moved in the page (moving a <video> pauses it). */
    play() {
      video.play().catch(() => {});
    },
    /** The stream's sound is muted just for us. */
    setMuted(muted) {
      if (!muteButton) return;
      muteButton.textContent = muted ? t('Unmute stream') : t('Mute stream');
      muteButton.setAttribute('aria-pressed', String(muted));
    },
    refresh({ name: next, mode }) {
      icon.innerHTML = mode === 'window' ? icons.appWindow : icons.monitor;
      nameText.textContent = local
        ? t(mode === 'window' ? 'Your window' : 'Your screen')
        : t(mode === 'window' ? "{name}'s window" : "{name}'s screen", { name: next });
      if (note) note.hidden = stream.getVideoTracks().length > 0;
      if (video.srcObject !== stream || video.dataset.tracks !== String(stream.getTracks().length)) {
        video.srcObject = stream;
        video.dataset.tracks = String(stream.getTracks().length);
        video.play().catch(() => {});
      }
    },
  };
}

function controlButton({ label, onClick, variant = '' }) {
  return h('button', { type: 'button', class: `control-btn ${variant}`.trim(), 'aria-label': label, title: label, onClick });
}

/**
 * The in-call screen. Calls `onLeft()` once the call has ended.
 * @param {import('../core/call.js').Call} call
 */
export function createCallView(call, { displayName, onLeft, openSettings }) {
  // Shared screens (featured) and cameras (grid, or a strip while someone presents).
  const screens = h('div', { class: 'stage-screens' });
  const cameras = h('div', { class: 'stage-cameras' });
  const stage = h('div', { class: 'call-stage' }, screens, cameras);
  const banner = h('div', { class: 'call-banner', role: 'status', hidden: true });
  const toast = h('div', { class: 'call-toast', role: 'status', 'aria-live': 'polite', hidden: true });
  // Each voice and stream sound has its own volume and mute, just for us (right-click a tile).
  const mixer = createMixer();
  mixer.setSink(settings.get().outputDevice);
  const unsubscribeOutput = settings.subscribe((next, prev) => {
    if (next.outputDevice !== prev.outputDevice) mixer.setSink(next.outputDevice);
  });
  const audioMenu = createAudioMenu();
  const voiceKey = (participant) => `${participant.id}:voice`;
  const streamKey = (participant) => `${participant.id}:stream`;
  const tiles = new Map();
  const screenTiles = new Map();
  let localScreenTile = null;

  let toastTimer;
  const showToast = (text) => {
    toast.textContent = text;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast.hidden = true), 5000);
  };

  // ----- Room name to share (header button) -----
  const copyRoom = async () => {
    try {
      await navigator.clipboard.writeText(call.room);
      showToast(t('Room name copied.'));
    } catch {
      showToast(t('Room name: {room}', { room: call.room }));
    }
  };
  const copyButton = h('button', { type: 'button', class: 'icon-btn', 'aria-label': t('Copy room name'), title: t('Copy room name'), html: icons.copy, onClick: copyRoom });
  const waiting = h('div', { class: 'call-waiting' }, h('p', {}, t('Waiting for others to join. Share the room name from the top.')));

  // ----- Header: which room, how many people (like a channel header) -----
  const peopleCount = h('span', { class: 'call-header-count' });
  const header = h(
    'header',
    { class: 'call-header' },
    h('h2', { class: 'call-header-room', title: call.room }, h('span', { class: 'call-header-hash', 'aria-hidden': 'true' }, '#'), call.room),
    peopleCount,
    copyButton,
  );

  // ----- Picture-in-Picture: the featured remote video floats over other windows (desktop) -----
  // Created before the tiles: rendering the people already in the room updates it.
  const pip = pipSupported()
    ? createPip({
        togglemicrophone: () => micButton.click(),
        togglecamera: () => camButton.click(),
        hangup: () => call.leave(),
        onLeave: () => {
          pinnedPipTrack = null;
          renderPip();
        },
      })
    : null;
  /** A stream popped out from its own tile or menu: PiP stays on it (not on the featured video) while we watch it. */
  let pinnedPipTrack = null;
  const popOut = async (track) => {
    try {
      pinnedPipTrack = track;
      await pip.enter(track);
    } catch (error) {
      pinnedPipTrack = null;
      showToast(t("Couldn't pop out the video: {reason}", { reason: error?.message ?? error }));
    }
    renderPip();
  };
  const pipButton = pip ? controlButton({ label: t('Pop out video') }) : null;
  pipButton?.addEventListener('click', async () => {
    try {
      pinnedPipTrack = null;
      if (pip.open) await pip.exit();
      else await pip.enter(pickPipTrack(call.participants.values()));
    } catch (error) {
      showToast(t("Couldn't pop out the video: {reason}", { reason: error?.message ?? error }));
    }
    renderPip();
  });

  /** Keeps the PiP window on the featured video, and the button in sync. */
  function renderPip() {
    if (!pip) return;
    // A remote track starts muted and unmutes when frames arrive, with no participant event: listen
    // to the tracks too (the same function is only added once per track).
    for (const p of call.participants.values()) {
      for (const t of [...p.stream.getVideoTracks(), ...p.screenStream.getVideoTracks()]) {
        for (const type of ['mute', 'unmute', 'ended']) t.addEventListener(type, renderPip);
      }
    }
    const pinnedWatched = [...call.participants.values()].some((p) => p.watching && p.screenStream.getVideoTracks().includes(pinnedPipTrack));
    if (pinnedPipTrack && !(pinnedWatched && pinnedPipTrack.readyState === 'live')) pinnedPipTrack = null;
    const track = pinnedPipTrack ?? pickPipTrack(call.participants.values());
    if (pip.followsFeatured) {
      pip.show(track); // Android: the app may float on its own at any moment (leaving the app)
    } else if (pip.open) {
      if (track) pip.show(track);
      else pip.exit().catch(() => {}); // nothing left to show
    }
    const open = pip.open && Boolean(track);
    pipButton.innerHTML = icons.pip;
    pipButton.disabled = !open && !track;
    pipButton.setAttribute('aria-pressed', String(open));
    pipButton.setAttribute('aria-label', open ? t('Close pop-out video') : t('Pop out video'));
    pipButton.title = track || open ? pipButton.getAttribute('aria-label') : t('Pop out video (no one has video on)');
    pipButton.classList.toggle('active', open);
  }

  // ----- Tiles -----
  const localTile = createTile({
    name: displayName,
    stream: call.localStream,
    local: true,
    getMedia: () => ({ audio: call.micOn, video: call.cameraOn }),
    getAvatar: () => call.avatar,
    getColor: () => call.color,
  });
  cameras.append(localTile.el);

  /** The stream shown big: a participant id, 'local' (our own), or null (all streams share the stage). */
  let focusedScreen = null;
  const toggleFocus = (id) => {
    const apply = () => {
      focusedScreen = focusedScreen === id ? null : id;
      layout();
    };
    // Tiles glide to their new places (each screen tile has its own view-transition-name).
    if (document.startViewTransition && document.documentElement.dataset.motion === 'full') document.startViewTransition(apply);
    else apply();
  };

  /** Alone or 3+ people: the column count (and width) that makes the biggest tiles in the stage's actual size. */
  const fitCameras = () => {
    if (!['solo', 'grid'].includes(stage.dataset.layout)) return void cameras.style.removeProperty('grid-template-columns');
    const gap = parseFloat(getComputedStyle(cameras).rowGap) || 0;
    const { columns, tileWidth } = fitGrid(cameras.children.length, cameras.clientWidth, cameras.clientHeight, gap);
    cameras.style.gridTemplateColumns = `repeat(${columns}, ${Math.max(0, tileWidth)}px)`;
  };
  new ResizeObserver(() => fitCameras()).observe(cameras);

  const layout = () => {
    const remotes = tiles.size;
    if (focusedScreen === 'local' ? !localScreenTile : focusedScreen && !screenTiles.has(focusedScreen)) focusedScreen = null;
    // Our own preview floats in a corner, or joins the streams on the stage when focused.
    if (localScreenTile) {
      const onStage = focusedScreen === 'local';
      const parent = onStage ? screens : stage;
      if (localScreenTile.el.parentNode !== parent) {
        parent.append(localScreenTile.el);
        localScreenTile.play();
      }
      localScreenTile.el.classList.toggle('tile-screen-local', !onStage);
      localScreenTile.el.classList.toggle('is-focused', onStage);
    }
    for (const [id, tile] of screenTiles) tile.el.classList.toggle('is-focused', id === focusedScreen);
    // Several streams and one focused: it takes the stage, the others make a column beside it.
    const streams = screens.children.length;
    if (focusedScreen && streams > 1) {
      screens.dataset.focus = '';
      screens.style.setProperty('--others', String(streams - 1));
    } else {
      delete screens.dataset.focus;
    }
    stage.dataset.layout = streams > 0 ? 'presenting' : remotes === 0 ? 'solo' : remotes === 1 ? 'duo' : 'grid';
    fitCameras();
    peopleCount.textContent = remotes === 0 ? t('Just you') : t('{count} people', { count: remotes + 1 });
    waiting.hidden = remotes > 0;
  };

  const sharing = new Set();
  const renderScreen = (participant) => {
    // Announce a new share once; it starts unwatched (no sound, not featured) until "Watch stream".
    if (participant.media.screen && !sharing.has(participant.id)) {
      sharing.add(participant.id);
      showToast(t('{name} started a stream.', { name: participant.name }));
    } else if (!participant.media.screen) {
      sharing.delete(participant.id);
    }
    let tile = screenTiles.get(participant.id);
    mixer.play(streamKey(participant), (participant.watching && participant.screenStream.getAudioTracks()[0]) || null);
    if (!participant.media.screen || !participant.watching) {
      if (tile) {
        if (fullscreenElement() === tile.el) exitFullscreen(); // Android's pinned full screen outlives the element
        tile.el.remove();
        screenTiles.delete(participant.id);
        layout();
      }
      return;
    }
    if (!tile) {
      tile = createScreenTile({
        name: participant.name,
        stream: participant.screenStream,
        local: false,
        onFocus: () => toggleFocus(participant.id),
        onStop: () => call.watchStream(participant.id, false),
        onToggleMute: () => tile.setMuted(mixer.set(streamKey(participant), { muted: !mixer.get(streamKey(participant)).muted }).muted),
        onPip: pip ? () => popOut(participant.screenStream.getVideoTracks()[0]) : null,
      });
      tile.el.addEventListener('contextmenu', (e) => {
        const full = fullscreenElement() === tile.el;
        audioMenu.open(e, {
          title: t("{name}'s stream", { name: participant.name }),
          muteLabel: t('Mute stream'),
          get: () => mixer.get(streamKey(participant)),
          set: (patch) => tile.setMuted(mixer.set(streamKey(participant), patch).muted),
          actions: [
            { label: full ? t('Exit full screen') : t('Full screen'), icon: full ? icons.minimize : icons.maximize, onClick: () => tile.toggleFullscreen() },
            ...(pip ? [{ label: t('Pop out video'), icon: icons.pip, onClick: () => popOut(participant.screenStream.getVideoTracks()[0]) }] : []),
          ],
        });
      });
      tile.setMuted(mixer.get(streamKey(participant)).muted);
      tile.el.style.viewTransitionName = `screen-${participant.id}`;
      screenTiles.set(participant.id, tile);
      screens.append(tile.el);
      layout();
    }
    tile.refresh({ name: participant.name, mode: participant.screenMode });
  };

  const renderParticipant = (participant, { announce }) => {
    let tile = tiles.get(participant.id);
    if (!tile) {
      tile = createTile({
        name: participant.name,
        stream: participant.stream,
        local: false,
        getMedia: () => participant.media,
        getAvatar: () => participant.avatar,
        getColor: () => participant.color,
        onWatch: () => call.watchStream(participant.id, true),
      });
      tile.el.addEventListener('contextmenu', (e) =>
        audioMenu.open(e, {
          title: participant.name,
          muteLabel: t('Mute {name} for me', { name: participant.name }),
          get: () => mixer.get(voiceKey(participant)),
          set: (patch) => mixer.set(voiceKey(participant), patch),
        }),
      );
      tiles.set(participant.id, tile);
      cameras.insertBefore(tile.el, localTile.el);
      if (announce) showToast(t('{name} joined.', { name: participant.name }));
      layout();
    }
    tile.setName(participant.name);
    const connection = CONNECTION_LABELS[participant.connectionState];
    tile.setOverlay(connection && t(connection));
    tile.refresh();
    tile.setLive(participant.media.screen && !participant.watching);
    mixer.play(voiceKey(participant), participant.stream.getAudioTracks()[0] ?? null);
    renderScreen(participant);
    renderPip();
  };

  /** Small preview of what we're sharing, floating in a corner. */
  const renderLocalScreen = () => {
    if (!call.screenStream) {
      if (localScreenTile) {
        localScreenTile.el.remove();
        localScreenTile = null;
        layout();
      }
      return;
    }
    if (!localScreenTile || localScreenTile.stream !== call.screenStream) {
      localScreenTile?.el.remove();
      localScreenTile = {
        ...createScreenTile({ name: displayName, stream: call.screenStream, local: true, onFocus: () => toggleFocus('local') }),
        stream: call.screenStream,
      };
      localScreenTile.el.style.viewTransitionName = 'screen-local';
      stage.append(localScreenTile.el);
      layout();
    }
    localScreenTile.refresh({ mode: call.screenShare?.mode });
  };

  call.addEventListener('participant-added', (e) => renderParticipant(e.detail.participant, { announce: true }));
  call.addEventListener('participant-updated', (e) => renderParticipant(e.detail.participant, { announce: false }));
  call.addEventListener('participant-removed', (e) => {
    const { participant } = e.detail;
    sharing.delete(participant.id);
    speaking.forget(participant.id);
    mixer.stop(voiceKey(participant));
    mixer.stop(streamKey(participant));
    const screenTile = screenTiles.get(participant.id);
    if (screenTile && fullscreenElement() === screenTile.el) exitFullscreen();
    screenTile?.el.remove();
    screenTiles.delete(participant.id);
    renderPip();
    const tile = tiles.get(participant.id);
    if (!tile) return layout();
    tile.el.remove();
    tiles.delete(participant.id);
    showToast(t('{name} left.', { name: participant.name }));
    layout();
  });
  // People already in the room when we joined (their events fired before this view existed).
  for (const participant of call.participants.values()) renderParticipant(participant, { announce: false });

  call.addEventListener('notice', (e) => showToast(e.detail.message));

  call.addEventListener('signaling-state', (e) => {
    const { state } = e.detail;
    banner.hidden = !(state === 'reconnecting' || state === 'connecting');
    banner.textContent = t('Lost connection to the server — reconnecting…');
  });

  // ----- Controls -----
  const micButton = controlButton({ label: t('Mute microphone') });
  const camButton = controlButton({ label: t('Turn camera off') });
  const leaveButton = controlButton({ label: t('Leave call'), variant: 'danger', onClick: () => call.leave() });
  leaveButton.innerHTML = icons.phoneOff;

  const chat = createChatPanel({
    send: (text) => call.sendChat(text, displayName),
    onIncoming: ({ name, text }) => showToast(`${name || t('Guest')}: ${text.length > 80 ? `${text.slice(0, 80)}…` : text}`),
  });
  // Each message with the sender's picture and profile color, as on their tile.
  call.addEventListener('chat', (e) => {
    const { id, name, mine } = e.detail;
    const sender = mine ? null : call.participants.get(id);
    const shownName = mine ? displayName : (sender?.name ?? name);
    chat.add({
      ...e.detail,
      name: mine ? displayName : name,
      avatar: mine ? call.avatar : (sender?.avatar ?? null),
      background: profileBackground(mine ? call.color : sender?.color, shownName),
    });
  });

  // Screen sharing (desktop only: mobile WebViews have no getDisplayMedia).
  const sharePanel = canShareScreen() ? createSharePanel(call, { onError: showToast }) : null;
  const shareButton = sharePanel
    ? h('button', { type: 'button', class: 'control-btn', popovertarget: 'share-panel', html: icons.screenShare })
    : null;

  const renderControls = () => {
    micButton.innerHTML = call.micOn ? icons.mic : icons.micOff;
    micButton.setAttribute('aria-pressed', String(!call.micOn));
    micButton.setAttribute('aria-label', call.micOn ? t('Mute microphone') : t('Unmute microphone'));
    micButton.title = micButton.getAttribute('aria-label');
    micButton.classList.toggle('off', !call.micOn);

    camButton.innerHTML = call.cameraOn ? icons.video : icons.videoOff;
    camButton.setAttribute('aria-pressed', String(!call.cameraOn));
    camButton.setAttribute('aria-label', call.cameraOn ? t('Turn camera off') : t('Turn camera on'));
    camButton.title = camButton.getAttribute('aria-label');
    camButton.classList.toggle('off', !call.cameraOn);

    if (shareButton) {
      const label = call.sharing ? t('Screen share settings') : t('Share your screen');
      shareButton.setAttribute('aria-label', label);
      shareButton.title = label;
      shareButton.classList.toggle('active', call.sharing);
    }

    localTile.refresh();
    renderLocalScreen();
    pip?.setState({ micOn: call.micOn, cameraOn: call.cameraOn });
  };

  const guarded = (button, action, what) => async () => {
    button.disabled = true;
    try {
      await action();
    } catch (error) {
      const reason = MEDIA_ERROR_LABELS[error?.name] ? t(MEDIA_ERROR_LABELS[error.name]) : (error?.message ?? t('unknown error'));
      showToast(t(what === 'camera' ? "Couldn't access the camera: {reason}." : "Couldn't access the microphone: {reason}.", { reason }));
    } finally {
      button.disabled = false;
    }
  };
  micButton.addEventListener('click', guarded(micButton, () => call.toggleMic(), 'microphone'));
  // Right-click the mic: its devices, volume and sensitivity (Settings › Audio devices).
  micButton.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    openSettings?.('audio');
  });
  camButton.addEventListener('click', guarded(camButton, () => call.toggleCamera(), 'camera'));
  call.addEventListener('local-updated', renderControls);

  // Sharing the entire screen: keep this window out of the capture, or it films its own preview
  // (a mirror that, measured, sent ~2.5x the data while focused). Windows: WDA_EXCLUDEFROMCAPTURE.
  let hiddenFromCapture = false;
  const hideFromCapture = (on) => {
    if (on === hiddenFromCapture || !('__TAURI_INTERNALS__' in window)) return;
    hiddenFromCapture = on;
    if (on) showToast(t('While you share your entire screen, the Jay-C window is hidden from screen captures, including your screenshots and recordings.'));
    import('@tauri-apps/api/window')
      .then(({ getCurrentWindow }) => getCurrentWindow().setContentProtected(on))
      .catch(() => {});
  };
  call.addEventListener('local-updated', () => hideFromCapture(call.screenShare?.mode === 'screen'));
  call.addEventListener('ended', () => hideFromCapture(false));

  // ----- Who's speaking: a green ring on their tile -----
  // Our own level comes from our mic track, measured without playing it (we'd hear ourselves).
  const speaking = createSpeakingDetector();
  const speakingTimer = setInterval(() => {
    const now = performance.now();
    for (const [id, tile] of tiles) {
      const participant = call.participants.get(id);
      const on = Boolean(participant?.media.audio) && speaking.update(id, mixer.levelDb(voiceKey(participant)), now);
      tile.el.classList.toggle('speaking', on);
    }
    mixer.play('me:mic', call.local.audio, { listenOnly: true });
    localTile.el.classList.toggle('speaking', call.micOn && speaking.update('me', mixer.levelDb('me:mic'), now));
  }, 100);

  const section = h('section', { class: 'call', 'aria-label': t('Call in room {room}', { room: call.room }) });
  const controlBar = createControlBar({
    section,
    buttons: { mic: micButton, camera: camButton, share: shareButton, chat: chat.button, pip: pipButton, leave: leaveButton },
  });

  call.addEventListener('ended', () => {
    clearTimeout(toastTimer);
    clearInterval(speakingTimer);
    unsubscribeOutput();
    mixer.close();
    pip?.exit().catch(() => {});
    pip?.destroy?.();
    exitFullscreen();
    controlBar.destroy();
    onLeft();
  });

  // Notify the server when the window closes mid-call.
  const onPageHide = () => call.leave();
  window.addEventListener('pagehide', onPageHide);
  call.addEventListener('ended', () => window.removeEventListener('pagehide', onPageHide));

  renderControls();
  renderPip();
  layout();

  const problems = Object.entries(call.mediaErrors).map(
    ([kind, name]) => `${kind === 'audio' ? t('Microphone') : t('Camera')}: ${MEDIA_ERROR_LABELS[name] ? t(MEDIA_ERROR_LABELS[name]) : name}`,
  );
  if (problems.length) showToast(t('{problems}. You can still see and hear others.', { problems: problems.join(' · ') }));

  // The bar can sit on any edge (section[data-bar]), so the rest of the call is one column of its own.
  section.append(h('div', { class: 'call-main' }, header, banner, stage, waiting, toast, chat.element), controlBar.element, audioMenu.element, ...(sharePanel ? [sharePanel] : []));
  return section;
}
