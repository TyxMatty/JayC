// Settings › Audio: which microphone and speakers to use, the mic volume and its sensitivity
// (a gate: only send the voice above a level), with a live meter: the call's mic, or a test mic
// opened here (out of a call) so the level can be set before joining.
// Microphone choice, volume and sensitivity need the native mic (Windows); speakers need
// AudioContext.setSinkId. Each part hides itself where it can't work.
// Also the microphone filter: Jay-C's own, or Jay-A's with Jay-C's as the reserve (docs/JAY-A.md).
import { h } from './dom.js';
import { settings } from '../store/settings.js';
import * as systemAudio from 'tauri-plugin-system-audio-api';
import { MAX_MIC_GAIN } from '../core/mic-shape.js';
import { startNativeMic, jayAShow } from '../core/native-mic.js';
import { t } from '../core/i18n.js';

const GATE_MIN = -70;
const GATE_MAX = -10;
const DEFAULT_GATE = -45;
const meterPercent = (db) => `${Math.max(0, Math.min(100, ((db - GATE_MIN) / -GATE_MIN) * 100))}%`;

const FILTERS = [
  ['jay-c', 'Jay-C', 'Jay-C cleans the microphone itself, with the settings below.'],
  ['jay-a', 'Jay-A', "Jay-A's filters, effects and soundboard. If Jay-A stops, Jay-C's filter takes over at once."],
];

/** What the Jay-A link is doing, for people (null: no microphone open in Jay-A mode). */
const jayAStatusLabel = (status) =>
  !status
    ? t('Jay-A connects when the microphone opens (in a call or a test).')
    : status.link === 'jay-a'
      ? t('Jay-A is on ({version}).', { version: status.version ?? '?' })
      : status.link === 'fallback'
        ? t("Jay-A isn't responding: using Jay-C's filter.")
        : status.link === 'incompatible'
          ? t('Update Jay-A: it speaks another version of the link.')
          : t('Looking for Jay-A…');

/** @param {{ getCall: () => any }} options */
export function createAudioSettings({ getCall }) {
  const current = settings.get();

  // ----- Microphone filter (native mic only) -----
  const filterLabels = FILTERS.map(([, label]) => h('span', {}, label));
  const filterGroup = h(
    'div',
    { class: 'segmented', role: 'radiogroup', 'aria-labelledby': 'mic-filter-label' },
    FILTERS.map(([value], i) =>
      h('label', {}, h('input', { type: 'radio', name: 'mic-filter', value, checked: current.micFilter === value, onChange: () => settings.update({ micFilter: value }) }), filterLabels[i]),
    ),
  );
  /** Whether Jay-A is installed (checked when Settings opens); null = not known yet. */
  let jayAInstalled = null;
  const jayAMissing = h(
    'div',
    { class: 'audio-menu-row', hidden: true },
    h('p', { class: 'hint' }, t("Jay-A isn't installed on this PC.")),
    h('button', { type: 'button', class: 'btn btn-secondary', onClick: () => systemAudio.jayAOpenReleases().catch(() => {}) }, t('Get Jay-A')),
  );
  const filterHint = h('p', { class: 'hint' });
  const jayAStatusText = h('p', { class: 'hint', 'aria-live': 'polite' });
  const jayAOpen = h('button', { type: 'button', class: 'btn btn-secondary', onClick: () => jayAShow() }, t('Open Jay-A'));
  const jayAPart = h(
    'div',
    { class: 'field' },
    jayAMissing,
    h('div', { class: 'audio-menu-row' }, jayAStatusText, jayAOpen),
    h('p', { class: 'hint' }, t("With Jay-A, the settings below apply only while Jay-A isn't responding. Jay-A's own are in Jay-A.")),
  );
  const filterPart = h(
    'fieldset',
    { hidden: true },
    h('h3', { id: 'mic-filter-label' }, t('Microphone filter')),
    h('div', { class: 'field' }, filterGroup, filterHint),
    jayAPart,
  );

  // ----- Microphone (native) -----
  const micSelect = h('select', {
    class: 'input',
    id: 'settings-mic-device',
    onChange: (e) => settings.update({ micDevice: e.target.value || null }),
  });
  const gainValue = h('output', { for: 'settings-mic-gain', class: 'hint' });
  const gainInput = h('input', {
    type: 'range',
    id: 'settings-mic-gain',
    min: 0,
    max: MAX_MIC_GAIN * 100,
    step: 5,
    value: String(Math.round(current.micGain * 100)),
    onInput: (e) => settings.update({ micGain: Number(e.target.value) / 100 }),
  });
  const gateSwitch = h('input', {
    type: 'checkbox',
    role: 'switch',
    checked: current.micGate != null,
    onChange: (e) => settings.update({ micGate: e.target.checked ? DEFAULT_GATE : null }),
  });
  const gateValue = h('output', { for: 'settings-mic-gate', class: 'hint' });
  const gateInput = h('input', {
    type: 'range',
    id: 'settings-mic-gate',
    min: GATE_MIN,
    max: GATE_MAX,
    step: 1,
    onInput: (e) => settings.update({ micGate: Number(e.target.value) }),
  });
  const meterFill = h('div', { class: 'mic-meter-fill' });
  const meterMark = h('div', { class: 'mic-meter-mark' });
  const meter = h('div', { class: 'mic-meter', 'aria-hidden': 'true' }, meterFill, meterMark);
  const meterStatus = h('span', { class: 'hint mic-meter-status', 'aria-live': 'off' });
  const testButton = h('button', { type: 'button', class: 'btn btn-secondary', onClick: () => (test ? stopTest() : startTest()) }, t('Test microphone'));
  const meterHint = h('p', { class: 'hint' });
  const micPart = h(
    'div',
    { hidden: true },
    h('div', { class: 'field' }, h('label', { for: 'settings-mic-device' }, t('Microphone')), micSelect),
    h('div', { class: 'field' }, h('div', { class: 'audio-menu-row' }, h('label', { for: 'settings-mic-gain' }, t('Microphone volume')), gainValue), gainInput),
    h(
      'label',
      { class: 'toggle-row' },
      gateSwitch,
      h(
        'span',
        { class: 'toggle-text' },
        h('span', { class: 'toggle-title' }, t('Only send when I speak')),
        h('span', { class: 'hint' }, t('Sounds quieter than the sensitivity level (breathing, typing, the room) are not sent.')),
      ),
    ),
    h('div', { class: 'field gate-field' }, h('div', { class: 'audio-menu-row' }, h('label', { for: 'settings-mic-gate' }, t('Sensitivity level')), gateValue),
      gateInput,
      meter,
      h('div', { class: 'audio-menu-row' }, meterStatus, testButton),
      meterHint,
    ),
  );

  // ----- Speakers -----
  const outputSelect = h('select', {
    class: 'input',
    id: 'settings-output-device',
    onChange: (e) => settings.update({ outputDevice: e.target.value }),
  });
  // Speaker names stay hidden until the WebView has mic permission once (granted silently in the
  // app and remembered). This opens the WebView mic for a moment, so only on request.
  const revealButton = h('button', { type: 'button', class: 'btn btn-secondary' }, t('Show speakers'));
  revealButton.addEventListener('click', async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      for (const track of stream.getTracks()) track.stop();
    } catch {
      // Denied: the list stays at "Default".
    }
    refreshOutputs();
  });
  const outputPart = h(
    'div',
    { class: 'field', hidden: true },
    h('label', { for: 'settings-output-device' }, t('Speakers')),
    h('div', { class: 'input-row' }, outputSelect, revealButton),
  );

  const render = () => {
    const s = settings.get();
    for (const input of filterGroup.querySelectorAll('input')) input.checked = input.value === s.micFilter;
    filterHint.textContent = t(FILTERS.find(([value]) => value === s.micFilter)?.[2] ?? FILTERS[0][2]);
    jayAPart.hidden = s.micFilter !== 'jay-a';
    jayAMissing.hidden = jayAInstalled !== false;
    filterLabels[1].textContent = jayAInstalled === false ? t('Jay-A (not installed)') : 'Jay-A';
    gainValue.textContent = `${Math.round(s.micGain * 100)}%`;
    gateSwitch.checked = s.micGate != null;
    gateInput.disabled = s.micGate == null;
    gateInput.value = String(s.micGate ?? DEFAULT_GATE);
    gateValue.textContent = s.micGate == null ? t('Off') : `${s.micGate} dB`;
    meterMark.hidden = s.micGate == null;
    meterMark.style.left = meterPercent(s.micGate ?? DEFAULT_GATE);
  };
  settings.subscribe(render);

  // ----- Test mic (out of a call): the same device, processing, volume and sensitivity as a call -----
  /** @type {Awaited<ReturnType<typeof startNativeMic>> | null} */
  let test = null;
  let testLevel = -Infinity;
  let testOpen = false;
  let testError = '';
  let testStatus = null;
  const testShape = { gain: current.micGain, gateDb: current.micGate };
  /** Opens the test mic. `previous` (a running test) is closed once the new one replaced it. */
  async function startTest(previous = null) {
    const s = settings.get();
    const claim = { stop() {}, close() {} }; // held while it opens: a second click doesn't open two
    test = claim;
    testError = '';
    testStatus = null;
    try {
      // Replaces any running capture on the Rust side, so the previous one is closed, not stopped.
      const mic = await startNativeMic({
        ...s.micProcessing,
        device: s.micDevice,
        filter: s.micFilter,
        shape: testShape,
        onLevel: (db, open) => ((testLevel = db), (testOpen = open)),
        onStatus: (status) => (testStatus = status),
      });
      previous?.close();
      if (test === claim) test = mic;
      else if (test === null) mic.stop(); // stopped (or Settings closed) while it opened
      else mic.close(); // another test replaced it
    } catch (error) {
      previous?.close();
      if (test !== claim) return;
      test = null;
      testError = String(error.message ?? error);
    }
  }
  function stopTest() {
    test?.stop();
    test = null;
    testLevel = -Infinity;
    testOpen = false;
    testStatus = null;
  }
  settings.subscribe((next, prev) => {
    Object.assign(testShape, { gain: next.micGain, gateDb: next.micGate });
    // Another device, processing or filter: reopen the test mic with it.
    if (test && (next.micDevice !== prev.micDevice || next.micProcessing !== prev.micProcessing || next.micFilter !== prev.micFilter)) startTest(test);
  });

  const option = (value, label, selected) => h('option', { value, selected }, label);

  async function refreshMics() {
    const mics = await systemAudio.listMics().catch(() => null);
    if (!mics) return;
    const chosen = settings.get().micDevice;
    const fallback = mics.find((m) => m.isDefault);
    micSelect.replaceChildren(
      option('', fallback ? t('Windows default ({name})', { name: fallback.name }) : t('Windows default'), !chosen),
      ...mics.map((m) => option(m.id, m.name, m.id === chosen)),
      // The saved one is unplugged: keep it visible so it isn't silently replaced.
      ...(chosen && !mics.some((m) => m.id === chosen) ? [option(chosen, t('Saved microphone (not connected)'), true)] : []),
    );
  }

  async function refreshOutputs() {
    const devices = await navigator.mediaDevices?.enumerateDevices().catch(() => []);
    const outputs = (devices ?? []).filter((d) => d.kind === 'audiooutput' && d.deviceId && d.deviceId !== 'default' && d.label);
    const chosen = settings.get().outputDevice;
    revealButton.hidden = outputs.length > 0;
    outputSelect.replaceChildren(
      option('', t('System default'), !chosen),
      ...outputs.map((d) => option(d.deviceId, d.label, d.deviceId === chosen)),
      ...(chosen && !outputs.some((d) => d.deviceId === chosen) ? [option(chosen, t('Saved speakers (not connected)'), true)] : []),
    );
  }

  // The meter follows the call's native mic (even muted: it still captures, nothing is sent), else
  // the test mic, while Settings is open. Green = loud enough to be sent.
  let frame = 0;
  let shownAt = 0;
  let peak = -Infinity;
  let sentLately = false;
  const tick = (now) => {
    const call = getCall();
    if (call && test) stopTest();
    const live = call ? Boolean(call.local.audio) : Boolean(test?.track);
    const level = call ? (call.local.audio ? call.micLevel : -Infinity) : testLevel;
    // The gate's real state: it stays open a moment after the voice drops, so word ends go too.
    const sent = live && Number.isFinite(level) && (call ? call.micGateOpen : testOpen);
    meterFill.style.width = meterPercent(level);
    meter.classList.toggle('is-sent', sent);
    // The number is the loudest of the last 250 ms (single frames jump around), so it can be read.
    peak = Math.max(peak, level);
    sentLately ||= sent;
    if (now - shownAt > 250) {
      shownAt = now;
      meterStatus.textContent = !live
        ? ''
        : `${t('Now: {db} dB', { db: Number.isFinite(peak) ? Math.round(peak) : '−∞' })} · ${sentLately ? t('sent') : t('not sent')}`;
      peak = -Infinity;
      sentLately = false;
    }
    if (!jayAPart.hidden) {
      const status = call ? call.jayAStatus : testStatus;
      const label = jayAStatusLabel(status);
      if (jayAStatusText.textContent !== label) jayAStatusText.textContent = label;
      jayAOpen.disabled = !status?.version; // only while connected
    }
    testButton.hidden = Boolean(call);
    testButton.textContent = test ? t('Stop test') : t('Test microphone');
    testButton.setAttribute('aria-pressed', String(Boolean(test)));
    meterHint.textContent = testError
      ? t('The microphone did not open: {reason}', { reason: testError })
      : live
        ? t('Stay quiet and watch the bar, then talk. Put the sensitivity between the two: green is sent, gray is not.')
        : t('Test your microphone to see its level here.');
    frame = requestAnimationFrame(tick);
  };

  const ready = systemAudio.isSupported().then((native) => {
    micPart.hidden = !native;
    filterPart.hidden = !native;
  });
  outputPart.hidden = typeof AudioContext === 'undefined' || !('setSinkId' in AudioContext.prototype);

  render();
  return {
    element: h('fieldset', {}, h('h3', {}, t('Audio devices')), micPart, outputPart),
    /** The microphone filter (Jay-C or Jay-A), shown before the devices. */
    filterElement: filterPart,
    /** Settings opened: reload the device lists and start the meter. */
    open() {
      systemAudio.jayAInstalled().then((installed) => {
        jayAInstalled = installed;
        render();
      });
      ready.then(() => !micPart.hidden && refreshMics());
      if (!outputPart.hidden) refreshOutputs();
      cancelAnimationFrame(frame);
      if (!micPart.hidden) frame = requestAnimationFrame(tick);
    },
    close() {
      cancelAnimationFrame(frame);
      stopTest();
    },
  };
}
