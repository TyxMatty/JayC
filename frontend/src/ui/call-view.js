import { h } from './dom.js';
import { icons } from './icons.js';
import { canShareScreen } from '../core/media.js';
import { createSharePanel } from './share-panel.js';
import { pipSupported, pickPipTrack, createPip } from '../core/pip.js';
import { createControlBar } from './control-bar.js';
import { createAudioMenu } from './audio-menu.js';
import { createMixer } from '../core/playback.js';
import { settings } from '../store/settings.js';

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
 * @param {{ name: string, stream: MediaStream, local: boolean, getMedia: () => ({ audio: boolean, video: boolean } | null), getAvatar: () => string | null, onWatch?: () => void }} options
 *   getMedia: what this participant is sending (null = unknown yet); getAvatar: their profile picture;
 *   onWatch: the "Watch stream" button on their tile while they share and we aren't watching.
 */
function createTile({ name, stream, local, getMedia, getAvatar, onWatch }) {
  // Always muted: remote sound plays through the mixer (core/playback.js).
  const video = h('video', { autoplay: true, playsinline: true, muted: true, srcObject: stream });
  const avatar = h('div', { class: 'tile-avatar', 'aria-hidden': 'true' }, initials(name));
  const nameText = h('span', {}, local ? `${name} (you)` : name);
  const mutedIcon = h('span', { class: 'tile-muted', title: 'Microphone off', html: icons.micOff, hidden: true });
  const label = h('div', { class: 'tile-label' }, mutedIcon, nameText);
  const overlay = h('div', { class: 'tile-overlay', hidden: true });
  const watchButton = h(
    'button',
    { type: 'button', class: 'tile-watch', hidden: true, onClick: () => onWatch?.() },
    h('span', { class: 'live-badge' }, 'LIVE'),
    'Watch stream',
  );
  const el = h('div', { class: local ? 'tile tile-local' : 'tile', tabindex: local ? false : 0 }, video, avatar, overlay, watchButton, label);

  const videoOn = () => (getMedia()?.video ?? true) && hasLiveVideo(stream);

  let shownName = name;
  let shownAvatar;
  /** The profile picture when there is one, else the initials. */
  const renderAvatar = () => {
    const url = getAvatar();
    if (url === shownAvatar) return;
    shownAvatar = url;
    avatar.classList.toggle('has-picture', Boolean(url));
    avatar.replaceChildren(url ? h('img', { src: url, alt: '' }) : initials(shownName));
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
      nameText.textContent = local ? `${next} (you)` : next;
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
      watchButton.setAttribute('aria-label', `Watch ${shownName}'s stream`);
    },
  };
  tile.refresh();
  return tile;
}

/** A shared screen/window. Double-click toggles fullscreen. Audio (later) plays from the same element. */
function createScreenTile({ name, stream, local, onStop, onToggleMute }) {
  const video = h('video', { autoplay: true, playsinline: true, muted: true, srcObject: stream });
  const muteButton = local ? null : h('button', { type: 'button', class: 'btn btn-secondary', onClick: () => onToggleMute?.() });
  const icon = h('span', { class: 'tile-screen-icon', html: icons.monitor });
  const nameText = h('span', {}, local ? 'Your screen' : `${name}'s screen`);
  const el = h(
    'div',
    { class: local ? 'tile tile-screen tile-screen-local' : 'tile tile-screen', title: local ? '' : 'Double-click for fullscreen' },
    video,
    h('div', { class: 'tile-label' }, icon, nameText),
    ...(local
      ? []
      : [h('div', { class: 'tile-stream-actions' }, muteButton, h('button', { type: 'button', class: 'btn btn-secondary', onClick: () => onStop?.() }, 'Stop watching'))]),
  );
  if (!local) el.tabIndex = 0;
  if (!local) {
    el.addEventListener('dblclick', () => {
      if (document.fullscreenElement) document.exitFullscreen();
      else el.requestFullscreen?.().catch(() => {});
    });
  }
  return {
    el,
    /** The stream's sound is muted just for us. */
    setMuted(muted) {
      if (!muteButton) return;
      muteButton.textContent = muted ? 'Unmute stream' : 'Mute stream';
      muteButton.setAttribute('aria-pressed', String(muted));
    },
    refresh({ name: next, mode }) {
      icon.innerHTML = mode === 'window' ? icons.appWindow : icons.monitor;
      nameText.textContent = local ? `Your ${mode === 'window' ? 'window' : 'screen'}` : `${next}'s ${mode === 'window' ? 'window' : 'screen'}`;
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

  // ----- Waiting card (shown while alone) -----
  const copyButton = h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Copy room name', title: 'Copy room name', html: icons.copy });
  copyButton.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(call.room);
      showToast('Room name copied.');
    } catch {
      showToast(`Room name: ${call.room}`);
    }
  });
  const waiting = h(
    'div',
    { class: 'call-waiting' },
    h('p', {}, 'Waiting for others to join'),
    h('div', { class: 'room-chip' }, h('code', {}, call.room), copyButton),
  );

  // ----- Picture-in-Picture: the featured remote video floats over other windows (desktop) -----
  // Created before the tiles: rendering the people already in the room updates it.
  const pip = pipSupported()
    ? createPip({
        togglemicrophone: () => micButton.click(),
        togglecamera: () => camButton.click(),
        hangup: () => call.leave(),
        onLeave: () => renderPip(),
      })
    : null;
  const pipButton = pip ? controlButton({ label: 'Pop out video' }) : null;
  pipButton?.addEventListener('click', async () => {
    try {
      if (pip.open) await pip.exit();
      else await pip.enter(pickPipTrack(call.participants.values()));
    } catch (error) {
      showToast(`Couldn't pop out the video: ${error?.message ?? error}`);
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
    const track = pickPipTrack(call.participants.values());
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
    pipButton.setAttribute('aria-label', open ? 'Close pop-out video' : 'Pop out video');
    pipButton.title = track || open ? pipButton.getAttribute('aria-label') : 'Pop out video (no one has video on)';
    pipButton.classList.toggle('active', open);
  }

  // ----- Tiles -----
  const localTile = createTile({
    name: displayName,
    stream: call.localStream,
    local: true,
    getMedia: () => ({ audio: call.micOn, video: call.cameraOn }),
    getAvatar: () => call.avatar,
  });
  cameras.append(localTile.el);

  const layout = () => {
    const remotes = tiles.size;
    stage.dataset.layout =
      screenTiles.size > 0 ? 'presenting' : remotes === 0 ? 'solo' : remotes === 1 ? 'duo' : 'grid';
    waiting.hidden = remotes > 0;
  };

  const sharing = new Set();
  const renderScreen = (participant) => {
    // Announce a new share once; it starts unwatched (no sound, not featured) until "Watch stream".
    if (participant.media.screen && !sharing.has(participant.id)) {
      sharing.add(participant.id);
      showToast(`${participant.name} started a stream.`);
    } else if (!participant.media.screen) {
      sharing.delete(participant.id);
    }
    let tile = screenTiles.get(participant.id);
    mixer.play(streamKey(participant), (participant.watching && participant.screenStream.getAudioTracks()[0]) || null);
    if (!participant.media.screen || !participant.watching) {
      if (tile) {
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
        onStop: () => call.watchStream(participant.id, false),
        onToggleMute: () => tile.setMuted(mixer.set(streamKey(participant), { muted: !mixer.get(streamKey(participant)).muted }).muted),
      });
      tile.el.addEventListener('contextmenu', (e) =>
        audioMenu.open(e, {
          title: `${participant.name}'s stream`,
          muteLabel: 'Mute stream',
          get: () => mixer.get(streamKey(participant)),
          set: (patch) => tile.setMuted(mixer.set(streamKey(participant), patch).muted),
        }),
      );
      tile.setMuted(mixer.get(streamKey(participant)).muted);
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
        onWatch: () => call.watchStream(participant.id, true),
      });
      tile.el.addEventListener('contextmenu', (e) =>
        audioMenu.open(e, {
          title: participant.name,
          muteLabel: `Mute ${participant.name} for me`,
          get: () => mixer.get(voiceKey(participant)),
          set: (patch) => mixer.set(voiceKey(participant), patch),
        }),
      );
      tiles.set(participant.id, tile);
      cameras.insertBefore(tile.el, localTile.el);
      if (announce) showToast(`${participant.name} joined.`);
      layout();
    }
    tile.setName(participant.name);
    tile.setOverlay(CONNECTION_LABELS[participant.connectionState]);
    tile.refresh();
    tile.setLive(participant.media.screen && !participant.watching);
    mixer.play(voiceKey(participant), participant.stream.getAudioTracks()[0] ?? null);
    renderScreen(participant);
    renderPip();
  };

  /** Small preview of what we're sharing, floating in a corner. */
  const renderLocalScreen = () => {
    if (!call.screenStream) {
      localScreenTile?.el.remove();
      localScreenTile = null;
      return;
    }
    if (!localScreenTile || localScreenTile.stream !== call.screenStream) {
      localScreenTile?.el.remove();
      localScreenTile = { ...createScreenTile({ name: displayName, stream: call.screenStream, local: true }), stream: call.screenStream };
      stage.append(localScreenTile.el);
    }
    localScreenTile.refresh({ mode: call.screenShare?.mode });
  };

  call.addEventListener('participant-added', (e) => renderParticipant(e.detail.participant, { announce: true }));
  call.addEventListener('participant-updated', (e) => renderParticipant(e.detail.participant, { announce: false }));
  call.addEventListener('participant-removed', (e) => {
    const { participant } = e.detail;
    sharing.delete(participant.id);
    mixer.stop(voiceKey(participant));
    mixer.stop(streamKey(participant));
    screenTiles.get(participant.id)?.el.remove();
    screenTiles.delete(participant.id);
    renderPip();
    const tile = tiles.get(participant.id);
    if (!tile) return layout();
    tile.el.remove();
    tiles.delete(participant.id);
    showToast(`${participant.name} left.`);
    layout();
  });
  // People already in the room when we joined (their events fired before this view existed).
  for (const participant of call.participants.values()) renderParticipant(participant, { announce: false });

  call.addEventListener('notice', (e) => showToast(e.detail.message));

  call.addEventListener('signaling-state', (e) => {
    const { state } = e.detail;
    banner.hidden = !(state === 'reconnecting' || state === 'connecting');
    banner.textContent = 'Lost connection to the server — reconnecting…';
  });

  // ----- Controls -----
  const micButton = controlButton({ label: 'Mute microphone' });
  const camButton = controlButton({ label: 'Turn camera off' });
  const leaveButton = controlButton({ label: 'Leave call', variant: 'danger', onClick: () => call.leave() });
  leaveButton.innerHTML = icons.phoneOff;

  // Screen sharing (desktop only: mobile WebViews have no getDisplayMedia).
  const sharePanel = canShareScreen() ? createSharePanel(call, { onError: showToast }) : null;
  const shareButton = sharePanel
    ? h('button', { type: 'button', class: 'control-btn', popovertarget: 'share-panel', html: icons.screenShare })
    : null;

  const renderControls = () => {
    micButton.innerHTML = call.micOn ? icons.mic : icons.micOff;
    micButton.setAttribute('aria-pressed', String(!call.micOn));
    micButton.setAttribute('aria-label', call.micOn ? 'Mute microphone' : 'Unmute microphone');
    micButton.title = micButton.getAttribute('aria-label');
    micButton.classList.toggle('off', !call.micOn);

    camButton.innerHTML = call.cameraOn ? icons.video : icons.videoOff;
    camButton.setAttribute('aria-pressed', String(!call.cameraOn));
    camButton.setAttribute('aria-label', call.cameraOn ? 'Turn camera off' : 'Turn camera on');
    camButton.title = camButton.getAttribute('aria-label');
    camButton.classList.toggle('off', !call.cameraOn);

    if (shareButton) {
      const label = call.sharing ? 'Screen share settings' : 'Share your screen';
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
      showToast(`Couldn't access the ${what}: ${MEDIA_ERROR_LABELS[error?.name] ?? error?.message ?? 'unknown error'}.`);
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

  const section = h('section', { class: 'call', 'aria-label': `Call in room ${call.room}` });
  const controlBar = createControlBar({
    section,
    buttons: { mic: micButton, camera: camButton, share: shareButton, pip: pipButton, leave: leaveButton },
  });

  call.addEventListener('ended', () => {
    clearTimeout(toastTimer);
    unsubscribeOutput();
    mixer.close();
    pip?.exit().catch(() => {});
    pip?.destroy?.();
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
    ([kind, name]) => `${kind === 'audio' ? 'Microphone' : 'Camera'}: ${MEDIA_ERROR_LABELS[name] ?? name}`,
  );
  if (problems.length) showToast(`${problems.join(' · ')}. You can still see and hear others.`);

  // The bar can sit on any edge (section[data-bar]), so the rest of the call is one column of its own.
  section.append(h('div', { class: 'call-main' }, banner, stage, waiting, toast), controlBar.element, audioMenu.element, ...(sharePanel ? [sharePanel] : []));
  return section;
}
