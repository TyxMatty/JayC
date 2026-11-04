// Settings › Audio: which microphone and speakers to use, the mic volume and its sensitivity
// (a gate: only send the voice above a level), with a live meter during a call.
// Microphone choice, volume and sensitivity need the native mic (Windows); speakers need
// AudioContext.setSinkId. Each part hides itself where it can't work.
import { h } from './dom.js';
import { settings } from '../store/settings.js';
import * as systemAudio from 'tauri-plugin-system-audio-api';
import { MAX_MIC_GAIN } from '../core/mic-shape.js';
import { t } from '../core/i18n.js';

const GATE_MIN = -70;
const GATE_MAX = -10;
const DEFAULT_GATE = -45;
const meterPercent = (db) => `${Math.max(0, Math.min(100, ((db - GATE_MIN) / -GATE_MIN) * 100))}%`;

/** @param {{ getCall: () => any }} options */
export function createAudioSettings({ getCall }) {
  const current = settings.get();

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
    h('div', { class: 'field gate-field' }, h('div', { class: 'audio-menu-row' }, h('label', { for: 'settings-mic-gate' }, t('Sensitivity level')), gateValue), gateInput, meter, meterHint),
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
    gainValue.textContent = `${Math.round(s.micGain * 100)}%`;
    gateSwitch.checked = s.micGate != null;
    gateInput.disabled = s.micGate == null;
    gateInput.value = String(s.micGate ?? DEFAULT_GATE);
    gateValue.textContent = s.micGate == null ? t('Off') : `${s.micGate} dB`;
    meterMark.hidden = s.micGate == null;
    meterMark.style.left = meterPercent(s.micGate ?? DEFAULT_GATE);
  };
  settings.subscribe(render);

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

  // The meter follows the call's native mic while Settings is open.
  let frame = 0;
  const tick = () => {
    const call = getCall();
    const level = call?.micOn ? call.micLevel : -Infinity;
    meterFill.style.width = meterPercent(level);
    meterHint.textContent = call
      ? t('The bar is your microphone now. Set the level just above the noise when you are quiet.')
      : t('Join a call to see your microphone level here.');
    frame = requestAnimationFrame(tick);
  };

  const ready = systemAudio.isSupported().then((native) => {
    micPart.hidden = !native;
  });
  outputPart.hidden = typeof AudioContext === 'undefined' || !('setSinkId' in AudioContext.prototype);

  render();
  return {
    element: h('fieldset', {}, h('h3', {}, t('Audio devices')), micPart, outputPart),
    /** Settings opened: reload the device lists and start the meter. */
    open() {
      ready.then(() => !micPart.hidden && refreshMics());
      if (!outputPart.hidden) refreshOutputs();
      cancelAnimationFrame(frame);
      if (!micPart.hidden) frame = requestAnimationFrame(tick);
    },
    close() {
      cancelAnimationFrame(frame);
    },
  };
}
