import { Device } from 'mediasoup-client';
import { SignalingClient } from './signaling.js';
import {
  openLocalMedia,
  getMicTrack,
  getCameraTrack,
  getScreenTrack,
  describeCapture,
  streamBitrate,
  targetHeight,
  DEFAULT_STREAM_QUALITY,
  DEFAULT_MIC_PROCESSING,
  screenCodec,
} from './media.js';
import { startScreenAudio } from './screen-audio.js';
import { nativeMicSupported, startNativeMic, listMics, micNeedsRestart, micCallState } from './native-mic.js';
import { startNativeLive, stopNativeLive } from './native-live.js';
import { capturePreview } from './screen-preview.js';
import { bufferDelayMs, catchUp } from './catch-up.js';
import { t } from './i18n.js';

/** Screen-share sound: stereo Opus at music quality, no DTX (silence detection would clip quiet passages). */
const SCREEN_AUDIO_CODEC_OPTIONS = { opusStereo: true, opusFec: true, opusDtx: false, opusMaxAverageBitrate: 128_000 };

/** Camera simulcast: the SFU forwards one of these layers to each viewer. */
const CAMERA_ENCODINGS = [
  { scaleResolutionDownBy: 4, maxBitrate: 150_000 },
  { scaleResolutionDownBy: 2, maxBitrate: 500_000 },
  { scaleResolutionDownBy: 1, maxBitrate: 1_500_000 },
];

/**
 * Which camera layer to receive, by how many cameras are on screen (bigger tiles -> higher layer).
 * While someone presents, cameras shrink to a strip, so the lowest layer is enough.
 */
function cameraLayerFor(cameraCount, presenting) {
  if (presenting) return 0;
  if (cameraCount <= 2) return 2;
  if (cameraCount <= 6) return 1;
  return 0;
}

/**
 * A call in one room, with media routed through the server's SFU (mediasoup): we upload each
 * track once over a "send" transport and receive everyone else's over a "recv" transport.
 *
 * Events (CustomEvent):
 *   participant-added   { participant }
 *   participant-removed { participant }
 *   participant-updated { participant }   tracks, mute state or connection changed
 *   local-updated       {}                local tracks changed (mute, camera on/off, screen share)
 *   signaling-state     { state }
 *   notice              { message }       something worth telling the user (e.g. no screen sound)
 *   ended               {}
 *
 * participant = {
 *   id, name, connectionState,
 *   stream: MediaStream,        mic + camera
 *   screenStream: MediaStream,  their screen share, if any
 *   media: { audio, video, screen },
 *   screenMode: 'screen' | 'window' | null,
 *   preview: string | null,     a still of their screen share (data URL), refreshed every few seconds
 * }
 */
const isStream = (source) => source === 'screen' || source === 'screen-audio';
/** A still of our share goes to the room this often (~10-30 KB each, to everyone). */
const PREVIEW_EVERY_MS = 6000;

export class Call extends EventTarget {
  local = { audio: null, video: null, screen: null };
  /** For the local preview tile (mic + camera). */
  localStream = new MediaStream();
  /** Our own screen share preview, while sharing. */
  screenStream = null;
  /**
   * { mode: 'screen' | 'window', windowHandle: number | null, audio: string | null, native: boolean }
   * while sharing. `native`: captured and encoded in Rust (core/native-live.js), so there is no
   * local track and `screenStream` is empty (no preview).
   */
  screenShare = null;
  screenQuality = { ...DEFAULT_STREAM_QUALITY };
  /** { echoCancellation, noiseSuppression, autoGainControl } applied to the mic. */
  micProcessing = { ...DEFAULT_MIC_PROCESSING };
  /** Native mic only: the endpoint to open (null = default), and volume/sensitivity applied live. */
  micDeviceId = null;
  micShape = { gain: 1, gateDb: null };
  /** Latest native mic level in dBFS (for a meter), -Infinity when silent or not native. */
  micLevel = -Infinity;
  /** Native mic: whether the sensitivity gate is letting the voice through (for the meter). */
  micGateOpen = false;
  /** Native mic: whose processing the call hears, 'jay-c' or 'jay-a' (docs/JAY-A.md). */
  micFilter = 'jay-c';
  /** With 'jay-a': `{ link: 'searching' | 'jay-a' | 'fallback' | 'incompatible', version, reason }`,
   * also sent as a 'jay-a-status' event; null otherwise. */
  jayAStatus = null;
  /** Our profile picture (data URL) or null; others see it while our camera is off. */
  avatar = null;
  /** Our profile color ({ from, to?, angle? }) or null = picked from the name (core/profile-color.js). */
  color = null;
  /** Executables left out of an entire-screen share's sound (see setExcludedApps). */
  excludedApps = [];
  /** The latest still of our screen share (data URL) while sharing, else null. */
  screenPreview = null;
  /** @type {Map<string, object>} */
  participants = new Map();
  mediaErrors = {};
  room = null;

  #signaling = null;
  #device = null;
  #iceServers = [];
  #send = null;
  #recv = null;
  /** Resolves with the recv transport of the current setup (consumes wait for it). */
  #recvReady = null;
  /** @type {Record<'mic' | 'camera' | 'screen' | 'screen-audio', import('mediasoup-client').types.Producer | null>} */
  #producers = { mic: null, camera: null, screen: null, 'screen-audio': null };
  /** Native screen share (video) while sharing: { id, stats(), setQuality(), close() }; also #producers.screen. */
  #nativeLive = null;
  /** What the native share captures ({ kind, id } from the app's picker), for restarts. */
  #nativeSource = null;
  /** A native share is starting (Rust side up, not yet published). */
  #nativeStarting = false;
  /** The signaling connection: 'connecting' | 'open' | 'reconnecting' | 'closed'. */
  #signalingState = 'connecting';
  #previewTimer = null;
  /** Every second: received audio that fell far behind gets a fresh consumer (core/catch-up.js). */
  #audioWatch = null;
  /** producerId -> { high, renewedAt, consumerId, stats } */
  #audioBehind = new Map();
  /** Native screen-share sound while sharing: { track, stop(), close(), description }. */
  #screenAudio = null;
  /** Native call microphone (Windows), when used instead of getUserMedia: { track, stop() }. */
  #nativeMic = null;
  /** The latest screen-sound restart (see setExcludedApps). */
  #screenAudioRestart = Promise.resolve();
  #micMuted = false;
  /** Bumped on every (re)setup so late async results from an old setup are discarded. */
  #generation = 0;
  /** Peers whose stream we chose to watch (kept across reconnects). Others' streams start unwatched. */
  #watched = new Set();
  /** When we last sent a chat message (to tell an old server's rejection apart). */
  #lastChatAt = -Infinity;
  /** Native mic restarts run one after another (two at once could leave a replaced, silent track). */
  #micRestart = Promise.resolve();
  /** The native mic's capture ended with an error (e.g. unplugged); the watch below reopens it. */
  #micFailed = false;
  /** Every few seconds: reopen the native mic when it failed or another one should be used. */
  #micWatch = null;
  #ended = false;

  /** Deafened: nothing received plays (ui/call-view.js tells the mixer) and the mic is off. */
  deafened = false;
  /** Whether the mic was on when we deafened: undeafening turns it back on. */
  #micBeforeDeafen = false;

  /** Left (or ended): nothing more happens in this call. */
  get ended() {
    return this.#ended;
  }

  get micOn() {
    return Boolean(this.local.audio) && !this.#micMuted;
  }

  get cameraOn() {
    return Boolean(this.local.video);
  }

  /** The microphone in use: the native device's name, else the track label. */
  get micDevice() {
    return this.#nativeMic?.device ?? this.local.audio?.label ?? null;
  }

  /** Opens local media, joins the room and starts sending/receiving through the SFU. */
  async join({ url, room, name, avatar = null, color = null, micProcessing = DEFAULT_MIC_PROCESSING, micDeviceId = null, micShape = null, micFilter = 'jay-c' }) {
    this.room = room;
    this.avatar = avatar;
    this.color = color;
    this.micProcessing = { ...micProcessing };
    this.micDeviceId = micDeviceId;
    this.micFilter = micFilter;
    if (micShape) Object.assign(this.micShape, micShape);
    const native = await nativeMicSupported();
    // The camera starts off: it opens on the first toggleCamera().
    const media = await openLocalMedia({ audio: !native, video: false, micProcessing: this.micProcessing });
    this.local.audio = media.audio;
    this.local.video = media.video;
    this.mediaErrors = media.errors;
    if (native) {
      try {
        this.local.audio = await this.#openNativeMic();
      } catch (error) {
        this.mediaErrors.audio = error?.name ?? 'Error';
      }
    }
    this.#syncLocalStream();

    const signaling = new SignalingClient(url);
    this.#signaling = signaling;
    signaling.addEventListener('state', (e) => {
      this.#signalingState = e.detail.state;
      this.#emit('signaling-state', e.detail);
    });
    signaling.addEventListener('peer-joined', (e) => this.#addParticipant(e.detail));
    signaling.addEventListener('peer-left', (e) => this.#removeParticipant(e.detail.id));
    signaling.addEventListener('peer-updated', (e) => {
      const participant = this.participants.get(e.detail.id);
      if (!participant) return;
      participant.avatar = e.detail.avatar ?? null;
      participant.color = e.detail.color ?? null;
      this.#emit('participant-updated', { participant });
    });
    signaling.addEventListener('screen-preview', (e) => {
      const participant = this.participants.get(e.detail.id);
      if (!participant) return;
      participant.preview = e.detail.image ?? null;
      this.#emit('participant-updated', { participant });
    });
    signaling.addEventListener('new-producer', (e) => this.#consume(e.detail));
    signaling.addEventListener('chat', (e) => this.#emit('chat', { id: e.detail.id, name: e.detail.name, text: e.detail.text, mine: false }));
    signaling.addEventListener('server-error', (e) => {
      // A server older than chat answers a bare 'bad-message' (no ref) to it.
      const { code, ref } = e.detail;
      if (ref !== 'chat' && !(ref === undefined && code === 'bad-message' && performance.now() - this.#lastChatAt < 3000)) return;
      const message = t(code === 'rate-limited' ? 'Too many messages: the last one was not sent.' : 'The server did not accept your message (it may need updating).');
      this.#emit('notice', { message });
    });
    signaling.addEventListener('producer-closed', (e) => this.#onProducerClosed(e.detail));
    signaling.addEventListener('producer-state', (e) => this.#onProducerState(e.detail));
    // Our native live has one layer: keep it within what the people watching can receive.
    signaling.addEventListener('viewer-bandwidth', (e) => e.detail.producerId === this.#nativeLive?.id && this.#nativeLive.setViewerKbps(e.detail.kbps));
    signaling.addEventListener('rejoined', (e) => this.#setup(e.detail).catch((err) => console.warn('[call] rejoin failed', err)));

    let joined;
    try {
      joined = await signaling.join(room, name, avatar, color);
      await this.#setup(joined);
    } catch (error) {
      signaling.close();
      this.#stopLocal();
      throw error;
    }
  }

  /** Deafen or undeafen (like Discord: the mic goes off with it, and comes back if it was on). */
  async toggleDeafen() {
    if (!this.deafened) {
      this.#micBeforeDeafen = this.micOn;
      this.deafened = true;
      if (this.micOn) return this.toggleMic();
    } else {
      this.deafened = false;
      if (this.#micBeforeDeafen && !this.micOn) return this.toggleMic();
    }
    this.#emit('local-updated', {});
  }

  async toggleMic() {
    // Turning the mic on while deafened undeafens too (you can't talk without hearing).
    if (this.deafened && !this.micOn) this.deafened = false;
    if (!this.local.audio) {
      // No mic yet (denied or missing at join): try again now.
      this.local.audio = (await nativeMicSupported())
        ? await this.#openNativeMic()
        : await getMicTrack(this.micProcessing);
      this.#micMuted = false;
      if (this.#producers.mic) {
        await this.#producers.mic.replaceTrack({ track: this.local.audio });
        await this.#setProducerPaused('mic', false);
      } else {
        await this.#produce('mic', this.local.audio);
      }
    } else {
      this.#micMuted = !this.#micMuted;
      await this.#setProducerPaused('mic', this.#micMuted);
    }
    if (this.#nativeMic) micCallState({ inCall: true, muted: this.#micMuted });
    this.#syncLocalStream();
  }

  /**
   * Changes echo cancellation / noise suppression / auto gain during the call. The native mic is
   * restarted with the new options and swapped in with replaceTrack (no renegotiation); a browser
   * mic gets the new constraints.
   */
  /** Changes our profile picture and/or color during the call (null removes it). */
  setProfile({ avatar = this.avatar, color = this.color }) {
    this.avatar = avatar;
    this.color = color;
    this.#signaling?.setProfile({ avatar, color });
    this.#emit('local-updated', {});
  }

  async setMicProcessing(processing) {
    this.micProcessing = { ...this.micProcessing, ...processing };
    if (!this.local.audio) return;

    if (this.#nativeMic) {
      await this.#restartNativeMic();
    } else {
      await this.local.audio.applyConstraints({ ...this.micProcessing }).catch((error) => {
        console.warn('[call] mic constraints not applied', error);
      });
    }
  }

  /** Sends a chat message to the room; false when offline (reconnecting). Ours is echoed as a 'chat' event. */
  sendChat(text, name) {
    if (!this.#signaling?.sendChat(text)) return false;
    this.#lastChatAt = performance.now();
    this.#emit('chat', { id: this.#signaling.id, name, text, mine: true });
    return true;
  }

  /** Native mic: switches to another microphone (null = the Windows default). */
  async setMicDevice(id) {
    this.micDeviceId = id;
    if (this.#nativeMic && this.local.audio) await this.#restartNativeMic();
  }

  /** Native mic: 'jay-c' or 'jay-a' (docs/JAY-A.md). Reopens the mic, swapped in with replaceTrack. */
  async setMicFilter(filter) {
    this.micFilter = filter;
    if (this.#nativeMic && this.local.audio) await this.#restartNativeMic();
  }

  /** Native mic: volume (gain) and sensitivity (gateDb, null = off), applied from the next chunk. */
  setMicShape(patch) {
    Object.assign(this.micShape, patch);
  }

  #restartNativeMic() {
    const run = this.#micRestart.then(() => this.#doRestartNativeMic());
    this.#micRestart = run.catch(() => {});
    return run;
  }

  async #doRestartNativeMic() {
    const old = this.#nativeMic;
    const track = await this.#openNativeMic(); // replaces the Rust-side capture
    old?.close();
    track.enabled = this.local.audio.enabled; // keep the mute state
    this.local.audio = track;
    await this.#producers.mic?.replaceTrack({ track });
    this.#syncLocalStream();
  }

  async toggleCamera() {
    if (this.local.video) {
      // Stop the track so the camera light turns off.
      await this.#setProducerPaused('camera', true);
      await this.#producers.camera?.replaceTrack({ track: null });
      this.local.video.stop();
      this.local.video = null;
    } else {
      this.local.video = await getCameraTrack();
      if (this.#producers.camera) {
        await this.#producers.camera.replaceTrack({ track: this.local.video });
        await this.#setProducerPaused('camera', false);
      } else {
        await this.#produce('camera', this.local.video);
      }
    }
    this.#syncLocalStream();
  }

  get sharing() {
    // A native share waiting for the server to come back still counts (the rejoin restarts it).
    return Boolean(this.local.screen || this.#nativeLive || this.screenShare?.native);
  }

  /**
   * Starts sharing. With `source` (picked in the app's own picker, Windows) the share is native:
   * captured and encoded in Rust, ~20x less CPU. Otherwise, or if that fails, the system picker
   * opens; resolves false if the user cancelled it.
   * @param {{ mode: 'screen' | 'window', quality: typeof DEFAULT_STREAM_QUALITY,
   *   source?: { kind: 'monitor' | 'window', id: number, own?: boolean } }} options
   */
  async startScreenShare({ mode, quality, source }) {
    if (source && this.#signaling) {
      if (this.sharing) await this.stopScreenShare();
      if (await this.#startNativeLive(quality, source)) {
        const window = source.kind === 'window';
        this.screenQuality = { ...quality };
        // windowHandle: the window's sound is captured from its process (core/screen-audio.js).
        this.screenShare = { mode: window ? 'window' : 'screen', windowHandle: window ? source.id : null, audio: null, native: true };
        this.screenStream = new MediaStream();
        // A Jay-C window's sound is the call itself: sending it would echo everyone's voices back.
        if (!source.own) await this.#startScreenAudio();
        this.#startPreviews();
        this.#emit('local-updated', {});
        return true;
      }
    }
    if (this.#ended) return false; // left the call while the native share was starting
    let track;
    try {
      track = await getScreenTrack(mode, quality);
    } catch (error) {
      if (error?.name === 'NotAllowedError' || error?.name === 'AbortError') return false; // picker dismissed
      throw error;
    }
    if (this.local.screen) await this.stopScreenShare();

    this.screenQuality = { ...quality };
    this.screenShare = { ...describeCapture(track), audio: null };
    this.local.screen = track;
    this.screenStream = new MediaStream([track]);
    // "Stop sharing" from the system UI, or the shared window closed.
    track.addEventListener('ended', () => this.local.screen === track && this.stopScreenShare());

    await this.#applyCaptureQuality();
    if (this.#send) await this.#produceScreen();
    await this.#startScreenAudio();
    this.#startPreviews();
    this.#emit('local-updated', {});
    return true;
  }

  /** Stills of the share for the room, every PREVIEW_EVERY_MS, while it runs (core/screen-preview.js). */
  #startPreviews() {
    clearInterval(this.#previewTimer);
    let busy = false;
    const tick = async () => {
      const share = this.screenShare;
      if (!share || busy) return;
      busy = true;
      let image;
      try {
        image = await capturePreview(share.native ? { native: true } : { track: this.local.screen });
      } catch {
        return; // e.g. the shared window is closing; the next tick tries again
      } finally {
        busy = false;
      }
      if (this.screenShare !== share) return;
      this.screenPreview = image;
      this.#signaling?.sendScreenPreview(image);
    };
    this.#previewTimer = setInterval(tick, PREVIEW_EVERY_MS);
    tick();
  }

  #stopPreviews() {
    clearInterval(this.#previewTimer);
    this.#previewTimer = null;
    if (this.screenPreview) this.#signaling?.sendScreenPreview(null);
    this.screenPreview = null;
  }

  async stopScreenShare() {
    this.#stopPreviews();
    this.#nativeLive = null; // its close() runs below, as the screen producer's
    this.#screenAudio?.stop();
    this.#screenAudio = null;
    for (const source of ['screen', 'screen-audio']) {
      const producer = this.#producers[source];
      this.#producers[source] = null;
      if (producer) {
        producer.close();
        await this.#signaling?.request('closeProducer', { producerId: producer.id }).catch(() => {});
      }
    }
    this.local.screen?.stop();
    this.local.screen = null;
    this.screenStream = null;
    this.screenShare = null;
    this.#emit('local-updated', {});
  }

  /** Sound for the share (Windows: native per-process capture). Failing here keeps the video going. */
  async #startScreenAudio() {
    const share = this.screenShare;
    try {
      this.#screenAudio = await startScreenAudio(this.#screenAudioOptions());
    } catch (error) {
      this.#emit('notice', { message: t('Sharing without sound: {reason}', { reason: error?.message ?? error }) });
      return;
    }
    if (!this.#screenAudio) return; // not supported on this platform
    share.audio = this.#screenAudio.description;
    if (this.#send) await this.#produceScreenAudio();
  }

  #screenAudioOptions() {
    return {
      mode: this.screenShare.mode,
      windowHandle: this.screenShare.windowHandle,
      excludedApps: this.excludedApps,
      onError: (message) => this.#emit('notice', { message: t('Screen sound stopped: {reason}', { reason: message }) }),
    };
  }

  /**
   * Changes the apps left out of an entire-screen share's sound. During such a share the native
   * capture is restarted and the new track swapped in with replaceTrack (no renegotiation).
   */
  setExcludedApps(apps) {
    this.excludedApps = [...apps];
    // One restart at a time: overlapping ones would stop each other's Rust-side capture.
    const restart = this.#screenAudioRestart.catch(() => {}).then(() => this.#restartScreenAudio());
    this.#screenAudioRestart = restart;
    return restart;
  }

  async #restartScreenAudio() {
    if (this.screenShare?.mode !== 'screen' || !this.#screenAudio) return;
    const old = this.#screenAudio;
    const next = await startScreenAudio(this.#screenAudioOptions()); // replaces the Rust-side capture
    if (this.#screenAudio !== old) return next.stop(); // the share stopped meanwhile
    old.close();
    this.#screenAudio = next;
    this.screenShare.audio = next.description;
    await this.#producers['screen-audio']?.replaceTrack({ track: next.track });
    this.#emit('local-updated', {});
  }

  async #produceScreenAudio() {
    this.#producers['screen-audio'] = await this.#send.produce({
      track: this.#screenAudio.track,
      stopTracks: false,
      codecOptions: SCREEN_AUDIO_CODEC_OPTIONS,
      appData: { source: 'screen-audio', mode: this.screenShare.mode },
    });
  }

  /** Changes resolution / fps / content hint of the running share, without renegotiating. */
  async setScreenQuality(quality) {
    this.screenQuality = { ...this.screenQuality, ...quality };
    if (this.#nativeLive) return this.#nativeLive.setQuality(this.screenQuality);
    if (!this.local.screen) return;
    await this.#applyCaptureQuality();
    await this.#producers.screen?.setRtpEncodingParameters(this.#screenEncoding());
  }

  /** Outbound stats of the screen producer (resolution, fps, bitrate actually sent). */
  async screenStats() {
    // Sent from Rust: its own counters (captured/encoded fps, kbps, bandwidth estimate, current step).
    if (this.#nativeLive) return this.#nativeLive.stats();
    const stats = await this.#producers.screen?.getStats();
    return stats ? [...stats.values()].find((s) => s.type === 'outbound-rtp') ?? null : null;
  }

  leave() {
    if (this.#ended) return;
    this.#ended = true;
    this.#generation++;
    this.#signaling?.close();
    this.#closeTransports();
    for (const id of [...this.participants.keys()]) this.#removeParticipant(id);
    this.#stopLocal();
    this.#emit('ended', {});
  }

  /** Stats of what we upload, e.g. to confirm each track is sent once regardless of room size. */
  async sendStats() {
    return this.#send ? this.#send.getStats() : null;
  }

  // ---------- Setup (first join and every reconnect) ----------

  async #setup(joined) {
    const generation = ++this.#generation;
    this.#closeTransports();
    for (const id of [...this.participants.keys()]) this.#removeParticipant(id);
    this.#iceServers = joined.iceServers ?? [];

    if (!this.#device) {
      this.#device = new Device();
      await this.#device.load({ routerRtpCapabilities: joined.routerRtpCapabilities });
    }

    // Participants first, so producers announced while we build transports aren't lost.
    for (const p of joined.peers) this.#addParticipant(p);

    this.#recvReady = this.#createTransport('recv', generation);
    const sendReady = this.#createTransport('send', generation);

    for (const p of joined.peers) {
      for (const producer of p.producers ?? []) {
        this.#consume({ peerId: p.id, producerId: producer.id, kind: producer.kind, source: producer.source });
      }
    }

    this.#send = await sendReady;
    this.#recv = await this.#recvReady;
    if (generation !== this.#generation) return;

    if (this.local.audio) await this.#produce('mic', this.local.audio);
    if (this.local.video) await this.#produce('camera', this.local.video);
    if (this.local.screen) await this.#produceScreen();
    if (this.screenShare?.native) await this.#restartNativeLive();
    if (this.#screenAudio) await this.#produceScreenAudio();
  }

  /** Publishes the native share; false if it can't run here (the caller falls back to the picker). */
  async #startNativeLive(quality, source) {
    this.#nativeSource = source;
    this.#nativeStarting = true;
    let live;
    try {
      live = await startNativeLive({
        source,
        request: (type, data) => this.#signaling.request(type, data),
        quality,
        onEnded: (reason) => {
          if (this.#nativeLive !== live) return;
          this.#nativeLive = null;
          this.#producers.screen = null;
          // The server went away: the rejoin (#setup) starts the share again on a new transport.
          if (this.#signalingState !== 'open') return;
          // Its transport (and producer) on the server, or the next share is refused (duplicate-source).
          live.close();
          this.#emit('notice', { message: t('Screen share stopped: {reason}', { reason: t(reason) }) });
          this.stopScreenShare();
        },
      });
    } catch (error) {
      if (!this.#ended) console.warn('[call] native screen share unavailable, using the system picker', error);
      return false;
    } finally {
      this.#nativeStarting = false;
    }
    if (this.#ended) {
      live.close(); // left the call while it was starting
      return false;
    }
    this.#nativeLive = live;
    this.#producers.screen = live;
    return true;
  }

  /** After a reconnect the server forgot our transports: publish the native share again. */
  async #restartNativeLive() {
    await this.#nativeLive?.close();
    // Once more a second later: seen once, the encoder failed to reopen while Windows was swapping
    // an audio device at the same moment (docs/spikes/10-live-nativa.md).
    for (const delay of [0, 1000]) {
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      if (this.#ended || !this.screenShare?.native) return;
      if (await this.#startNativeLive(this.screenQuality, this.#nativeSource)) return;
    }
    this.#emit('notice', { message: t('Screen share stopped: {reason}', { reason: t("couldn't restart it after reconnecting") }) });
    await this.stopScreenShare();
  }

  async #createTransport(direction, generation) {
    const params = await this.#signaling.request('createTransport', { direction });
    const options = { ...params, iceServers: this.#iceServers };
    const transport =
      direction === 'send' ? this.#device.createSendTransport(options) : this.#device.createRecvTransport(options);

    transport.on('connect', ({ dtlsParameters }, ok, fail) => {
      this.#signaling.request('connectTransport', { transportId: transport.id, dtlsParameters }).then(ok, fail);
    });

    if (direction === 'send') {
      transport.on('produce', ({ kind, rtpParameters, appData }, ok, fail) => {
        this.#signaling
          .request('produce', {
            transportId: transport.id,
            kind,
            rtpParameters,
            source: appData.source,
            mode: appData.mode,
            paused: appData.paused,
          })
          .then(ok, fail);
      });
    }

    transport.on('connectionstatechange', (state) => {
      if (generation !== this.#generation) return;
      if (state === 'failed') this.#restartIce(transport);
      if (direction === 'recv') {
        for (const participant of this.participants.values()) this.#updateParticipant(participant);
      }
    });
    return transport;
  }

  async #restartIce(transport) {
    try {
      const { iceParameters } = await this.#signaling.request('restartIce', { transportId: transport.id });
      await transport.restartIce({ iceParameters });
    } catch (error) {
      console.warn('[call] ICE restart failed', error);
    }
  }

  #closeTransports() {
    // Closing transports closes their producers/consumers; our local tracks survive (stopTracks: false).
    this.#send?.close();
    this.#recv?.close();
    this.#send = this.#recv = this.#recvReady = null;
    this.#producers = { mic: null, camera: null, screen: null, 'screen-audio': null };
  }

  // ---------- Sending ----------

  async #produce(source, track) {
    const options = {
      track,
      stopTracks: false,
      appData: { source, paused: source === 'mic' && this.#micMuted },
    };
    if (source === 'camera') {
      options.encodings = CAMERA_ENCODINGS;
      options.codecOptions = { videoGoogleStartBitrate: 1000 };
    } else if (source === 'mic') {
      options.codecOptions = { opusDtx: true, opusFec: true };
    }
    const producer = await this.#send.produce(options);
    if (options.appData.paused) producer.pause();
    this.#producers[source] = producer;
    return producer;
  }

  async #produceScreen() {
    const codec = screenCodec(this.#device.rtpCapabilities);
    try {
      this.#producers.screen = await this.#produceScreenWith(codec);
    } catch (error) {
      if (!codec) throw error;
      console.warn('[call] H.264 High share failed, using the default codec', error);
      this.#producers.screen = await this.#produceScreenWith(undefined);
    }
  }

  #produceScreenWith(codec) {
    return this.#send.produce({
      track: this.local.screen,
      stopTracks: false,
      encodings: [this.#screenEncoding()],
      codec,
      codecOptions: { videoGoogleStartBitrate: 1000 },
      appData: { source: 'screen', mode: this.screenShare.mode },
    });
  }

  /**
   * Resizes the capture itself where the browser allows it (cheaper than encoding a bigger frame),
   * and sets the content hint. Encoder-side scaling in #screenEncoding() covers the rest.
   */
  async #applyCaptureQuality() {
    const track = this.local.screen;
    const { fps, resolution, optimizeFor } = this.screenQuality;
    track.contentHint = optimizeFor === 'motion' ? 'motion' : 'detail';
    const height = targetHeight(resolution);
    try {
      // Replaces the previous constraints, so "Source" lifts an earlier height cap.
      await track.applyConstraints({ frameRate: { max: fps }, ...(height ? { height: { max: height } } : {}) });
    } catch (error) {
      console.warn('[call] applyConstraints on the screen track failed; scaling in the encoder instead', error);
    }
  }

  #screenEncoding() {
    const { fps, resolution } = this.screenQuality;
    const settings = this.local.screen.getSettings();
    const height = targetHeight(resolution);
    // If the capture is still bigger than asked (applyConstraints unsupported), let the encoder scale it.
    const scale = height && settings.height > height * 1.05 ? settings.height / height : 1;
    const width = (settings.width ?? 1920) / scale;
    const outHeight = (settings.height ?? 1080) / scale;
    return { maxBitrate: streamBitrate(width, outHeight, fps), maxFramerate: fps, scaleResolutionDownBy: scale };
  }

  async #setProducerPaused(source, paused) {
    const producer = this.#producers[source];
    if (!producer || producer.paused === paused) return;
    if (paused) producer.pause();
    else producer.resume();
    await this.#signaling
      .request(paused ? 'pauseProducer' : 'resumeProducer', { producerId: producer.id })
      .catch((error) => console.warn('[call] pause/resume failed', error));
  }

  // ---------- Receiving ----------

  #addParticipant({ id, name, avatar, color, preview }) {
    if (this.participants.has(id)) return this.participants.get(id);
    const participant = {
      id,
      name: name ?? t('Guest'),
      /** Profile picture (data URL, validated by the server) or null. */
      avatar: avatar ?? null,
      /** Profile color { from, to?, angle? } (validated by the server) or null. */
      color: color ?? null,
      /** A still of their screen share (data URL, validated by the server) or null. */
      preview: preview ?? null,
      stream: new MediaStream(),
      screenStream: new MediaStream(),
      media: { audio: false, video: false, screen: false },
      screenMode: null,
      /** Receiving their screen share (opt-in, like a muted, collapsed live until then). */
      watching: this.#watched.has(id),
      connectionState: 'connected',
      /** producerId -> { consumer, source, mode, paused, layer } */
      consumers: new Map(),
      pending: new Set(),
    };
    this.participants.set(id, participant);
    this.#emit('participant-added', { participant });
    return participant;
  }

  #removeParticipant(id) {
    const participant = this.participants.get(id);
    if (!participant) return;
    this.participants.delete(id);
    for (const { consumer } of participant.consumers.values()) consumer.close();
    for (const stream of [participant.stream, participant.screenStream]) {
      for (const track of stream.getTracks()) stream.removeTrack(track);
    }
    this.#emit('participant-removed', { participant });
    this.#applyLayerPolicy();
  }

  async #consume({ peerId, producerId, source }) {
    const participant = this.participants.get(peerId);
    if (!participant || participant.consumers.has(producerId) || participant.pending.has(producerId)) return;

    const generation = this.#generation;
    participant.pending.add(producerId);
    try {
      const recv = await this.#recvReady;
      const params = await this.#signaling.request('consume', { producerId, rtpCapabilities: this.#device.rtpCapabilities });
      if (generation !== this.#generation || !this.participants.has(peerId)) return;

      const consumer = await recv.consume({
        id: params.id,
        producerId,
        kind: params.kind,
        rtpParameters: params.rtpParameters,
        appData: { source: params.source },
      });
      const entry = { consumer, source: params.source, mode: params.mode ?? null, paused: params.producerPaused, layer: null };
      participant.consumers.set(producerId, entry);
      this.#streamFor(participant, entry.source).addTrack(consumer.track);
      // A stream stays paused on the server (no bandwidth) until we watch it.
      if (!isStream(entry.source) || participant.watching) {
        await this.#signaling.request('resumeConsumer', { consumerId: consumer.id });
      }
      this.#updateParticipant(participant);
      if (params.source === 'camera' || params.source === 'screen') this.#applyLayerPolicy();
      if (params.kind === 'audio') this.#audioWatch ??= setInterval(() => this.#checkAudioDelay().catch(() => {}), 1000);
    } catch (error) {
      // The producer may have closed in the meantime.
      if (error?.code !== 'unknown-producer') console.warn('[call] consume failed', error);
    } finally {
      participant.pending.delete(producerId);
    }
  }

  async #checkAudioDelay() {
    const now = Date.now();
    for (const participant of this.participants.values()) {
      for (const [producerId, entry] of participant.consumers) {
        if (entry.consumer.kind !== 'audio' || entry.consumer.closed) continue;
        const stats = [...(await entry.consumer.getStats()).values()].find((s) => s.type === 'inbound-rtp');
        if (!stats) continue;
        const last = this.#audioBehind.get(producerId) ?? { high: 0, renewedAt: 0 };
        const same = last.consumerId === entry.consumer.id && last.stats;
        const delay = same ? bufferDelayMs(last.stats, stats) : null;
        const { state, renew } = catchUp(last, delay, now);
        this.#audioBehind.set(producerId, { ...state, consumerId: entry.consumer.id, stats });
        if (renew) {
          console.info(`[call] ${entry.source} audio ${Math.round(delay)} ms behind: starting it again at live`);
          this.#renewConsumer(participant, producerId).catch((error) => console.warn('[call] renew consumer', error));
        }
      }
    }
  }

  /** A fresh consumer for an audio whose receive buffer fell far behind: it plays from live again. */
  async #renewConsumer(participant, producerId) {
    const entry = participant.consumers.get(producerId);
    if (!entry || this.#ended) return;
    participant.consumers.delete(producerId);
    this.#streamFor(participant, entry.source).removeTrack(entry.consumer.track);
    entry.consumer.close();
    const consumerId = entry.consumer.id;
    // An old server has no closeConsumer: pausing it at least stops the sending.
    const request = this.#signaling.features.includes('close-consumer') ? 'closeConsumer' : 'pauseConsumer';
    this.#signaling.request(request, { consumerId }).catch(() => {});
    await this.#consume({ peerId: participant.id, producerId, source: entry.source });
  }

  #onProducerClosed({ peerId, producerId }) {
    const participant = this.participants.get(peerId);
    const entry = participant?.consumers.get(producerId);
    if (!entry) return;
    participant.consumers.delete(producerId);
    this.#streamFor(participant, entry.source).removeTrack(entry.consumer.track);
    entry.consumer.close();
    // A new share later starts unwatched again.
    if (entry.source === 'screen') {
      participant.watching = false;
      this.#watched.delete(participant.id);
    }
    this.#updateParticipant(participant);
    if (entry.source === 'camera' || entry.source === 'screen') this.#applyLayerPolicy();
  }

  /** Starts or stops receiving `peerId`'s screen share and its sound. */
  async watchStream(peerId, watching) {
    const participant = this.participants.get(peerId);
    if (watching) this.#watched.add(peerId);
    else this.#watched.delete(peerId);
    if (!participant || participant.watching === watching) return;
    participant.watching = watching;
    this.#updateParticipant(participant);
    this.#applyLayerPolicy();
    const type = watching ? 'resumeConsumer' : 'pauseConsumer';
    await Promise.all(
      [...participant.consumers.values()]
        .filter((entry) => isStream(entry.source))
        .map((entry) => this.#signaling.request(type, { consumerId: entry.consumer.id }).catch((error) => console.warn(`[call] ${type} failed`, error))),
    );
  }

  #streamFor(participant, source) {
    return isStream(source) ? participant.screenStream : participant.stream;
  }

  #onProducerState({ peerId, producerId, paused }) {
    const participant = this.participants.get(peerId);
    const entry = participant?.consumers.get(producerId);
    if (!entry) return;
    entry.paused = paused;
    this.#updateParticipant(participant);
  }

  #updateParticipant(participant) {
    const live = (source) => [...participant.consumers.values()].some((c) => c.source === source && !c.paused);
    participant.media = { audio: live('mic'), video: live('camera'), screen: live('screen') };
    participant.screenMode = [...participant.consumers.values()].find((c) => c.source === 'screen')?.mode ?? null;
    const recvState = this.#recv?.connectionState ?? 'new';
    participant.connectionState = participant.consumers.size === 0 ? 'connected' : recvState;
    this.#emit('participant-updated', { participant });
  }

  /** Ask the SFU for a camera layer that fits the tile size. */
  #applyLayerPolicy() {
    const cameras = [];
    let presenting = false;
    for (const participant of this.participants.values()) {
      for (const entry of participant.consumers.values()) {
        if (entry.source === 'camera') cameras.push(entry);
        if (entry.source === 'screen' && participant.watching) presenting = true;
      }
    }
    const layer = cameraLayerFor(cameras.length, presenting);
    for (const entry of cameras) {
      if (entry.layer === layer) continue;
      entry.layer = layer;
      this.#signaling
        .request('setPreferredLayers', { consumerId: entry.consumer.id, spatialLayer: layer })
        .catch(() => (entry.layer = null));
    }
  }

  // ---------- Local media ----------

  #syncLocalStream() {
    for (const track of this.localStream.getTracks()) {
      if (track !== this.local.audio && track !== this.local.video) this.localStream.removeTrack(track);
    }
    for (const track of [this.local.audio, this.local.video]) {
      if (track && !this.localStream.getTracks().includes(track)) this.localStream.addTrack(track);
    }
    this.#emit('local-updated', {});
  }

  async #openNativeMic() {
    const mic = await startNativeMic({
      ...this.micProcessing,
      device: this.micDeviceId,
      filter: this.micFilter,
      // Jay-A adopts these the first time it connects (docs/JAY-A.md).
      jayAImport: { micDevice: this.micDeviceId, micGain: this.micShape.gain, micGate: this.micShape.gateDb, micProcessing: this.micProcessing },
      onStatus: (status) => {
        this.jayAStatus = status;
        this.#emit('jay-a-status', status);
      },
      shape: this.micShape,
      onLevel: (db, open) => {
        this.micLevel = db;
        this.micGateOpen = open;
      },
      onError: (message) => {
        if (this.#nativeMic !== mic) return; // an old capture, already replaced
        this.#micFailed = true;
        this.#emit('notice', { message: t('Microphone stopped: {reason}', { reason: message }) });
      },
    });
    this.#nativeMic = mic;
    if (this.micFilter !== 'jay-a' && this.jayAStatus) {
      this.jayAStatus = null;
      this.#emit('jay-a-status', null);
    }
    micCallState({ inCall: true, muted: this.#micMuted });
    this.#watchNativeMic();
    return mic.track;
  }

  #watchNativeMic() {
    this.#micWatch ??= setInterval(async () => {
      if (!this.#nativeMic || this.#ended) return;
      const mics = await listMics().catch(() => []);
      if (!micNeedsRestart({ failed: this.#micFailed, preferredId: this.micDeviceId, current: this.#nativeMic.device, mics })) return;
      const wasFailed = this.#micFailed;
      try {
        await this.#restartNativeMic();
        this.#micFailed = false;
        if (wasFailed) this.#emit('notice', { message: t('Microphone back: {name}', { name: this.#nativeMic.device }) });
      } catch {
        // Still nothing to open: try again on the next check.
      }
    }, 3000);
  }

  #stopLocal() {
    clearInterval(this.#micWatch);
    this.#micWatch = null;
    clearInterval(this.#previewTimer);
    this.#previewTimer = null;
    clearInterval(this.#audioWatch);
    this.#audioWatch = null;
    this.#nativeLive?.close();
    this.#nativeLive = null;
    if (this.#nativeStarting) stopNativeLive().catch(() => {});
    this.#nativeMic?.stop();
    this.#nativeMic = null;
    this.#screenAudio?.stop();
    this.#screenAudio = null;
    for (const track of [this.local.audio, this.local.video, this.local.screen]) track?.stop();
    this.local.audio = this.local.video = this.local.screen = null;
    this.screenStream = this.screenShare = null;
    for (const track of this.localStream.getTracks()) this.localStream.removeTrack(track);
  }

  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}
