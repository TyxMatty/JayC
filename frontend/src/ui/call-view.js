import { h } from './dom.js';
import { icons } from './icons.js';

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
 * @param {{ name: string, stream: MediaStream, local: boolean, getMedia: () => ({ audio: boolean, video: boolean } | null) }} options
 *   getMedia: what this participant is sending (null = unknown yet).
 */
function createTile({ name, stream, local, getMedia }) {
  const video = h('video', { autoplay: true, playsinline: true, muted: local, srcObject: stream });
  const avatar = h('div', { class: 'tile-avatar', 'aria-hidden': 'true' }, initials(name));
  const nameText = h('span', {}, local ? `${name} (you)` : name);
  const mutedIcon = h('span', { class: 'tile-muted', title: 'Microphone off', html: icons.micOff, hidden: true });
  const label = h('div', { class: 'tile-label' }, mutedIcon, nameText);
  const overlay = h('div', { class: 'tile-overlay', hidden: true });
  const el = h('div', { class: local ? 'tile tile-local' : 'tile' }, video, avatar, overlay, label);

  const videoOn = () => (getMedia()?.video ?? true) && hasLiveVideo(stream);

  const tile = {
    el,
    refresh() {
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
      avatar.textContent = initials(next);
    },
    setOverlay(text) {
      overlay.textContent = text ?? '';
      overlay.hidden = !text;
    },
  };
  tile.refresh();
  return tile;
}

function controlButton({ label, onClick, variant = '' }) {
  return h('button', { type: 'button', class: `control-btn ${variant}`.trim(), 'aria-label': label, title: label, onClick });
}

/**
 * The in-call screen. Calls `onLeft()` once the call has ended.
 * @param {import('../core/call.js').Call} call
 */
export function createCallView(call, { displayName, onLeft }) {
  const stage = h('div', { class: 'call-stage' });
  const banner = h('div', { class: 'call-banner', role: 'status', hidden: true });
  const toast = h('div', { class: 'call-toast', role: 'status', 'aria-live': 'polite', hidden: true });
  const tiles = new Map();

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

  // ----- Tiles -----
  const localTile = createTile({
    name: displayName,
    stream: call.localStream,
    local: true,
    getMedia: () => ({ audio: call.micOn, video: call.cameraOn }),
  });
  stage.append(localTile.el);

  const layout = () => {
    const remotes = tiles.size;
    stage.dataset.layout = remotes === 0 ? 'solo' : remotes === 1 ? 'duo' : 'grid';
    waiting.hidden = remotes > 0;
  };

  const renderParticipant = (participant, { announce }) => {
    let tile = tiles.get(participant.id);
    if (!tile) {
      tile = createTile({
        name: participant.name,
        stream: participant.stream,
        local: false,
        getMedia: () => participant.media,
      });
      tiles.set(participant.id, tile);
      stage.insertBefore(tile.el, localTile.el);
      if (announce) showToast(`${participant.name} joined.`);
      layout();
    }
    tile.setName(participant.name);
    tile.setOverlay(CONNECTION_LABELS[participant.connectionState]);
    tile.refresh();
  };

  call.addEventListener('participant-added', (e) => renderParticipant(e.detail.participant, { announce: true }));
  call.addEventListener('participant-updated', (e) => renderParticipant(e.detail.participant, { announce: false }));
  call.addEventListener('participant-removed', (e) => {
    const { participant } = e.detail;
    const tile = tiles.get(participant.id);
    if (!tile) return;
    tile.el.remove();
    tiles.delete(participant.id);
    showToast(`${participant.name} left.`);
    layout();
  });
  // People already in the room when we joined (their events fired before this view existed).
  for (const participant of call.participants.values()) renderParticipant(participant, { announce: false });

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

    localTile.refresh();
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
  camButton.addEventListener('click', guarded(camButton, () => call.toggleCamera(), 'camera'));
  call.addEventListener('local-updated', renderControls);

  call.addEventListener('ended', () => {
    clearTimeout(toastTimer);
    onLeft();
  });

  // Notify the server when the window closes mid-call.
  const onPageHide = () => call.leave();
  window.addEventListener('pagehide', onPageHide);
  call.addEventListener('ended', () => window.removeEventListener('pagehide', onPageHide));

  renderControls();
  layout();

  const problems = Object.entries(call.mediaErrors).map(
    ([kind, name]) => `${kind === 'audio' ? 'Microphone' : 'Camera'}: ${MEDIA_ERROR_LABELS[name] ?? name}`,
  );
  if (problems.length) showToast(`${problems.join(' · ')}. You can still see and hear others.`);

  return h(
    'section',
    { class: 'call', 'aria-label': `Call in room ${call.room}` },
    banner,
    stage,
    waiting,
    toast,
    h('div', { class: 'call-controls' }, micButton, camButton, leaveButton),
  );
}
