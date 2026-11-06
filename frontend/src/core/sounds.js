// Short cues for what happens in a call, synthesized with WebAudio (no sound files): rising notes
// for "on" / someone arriving, falling for "off" / someone leaving. They play on the mixer's alert
// bus (core/playback.js), so they follow the output device and deafen doesn't silence them.

/** Each cue's notes (Hz), a step apart. */
const CUES = {
  'mic-on': [659.25, 880], // E5 A5
  'mic-off': [880, 659.25],
  deafen: [392, 293.66], // G4 D4: lower, the whole call goes quiet
  undeafen: [293.66, 392],
  join: [523.25, 659.25, 783.99], // C5 E5 G5
  leave: [783.99, 659.25, 523.25],
  stream: [523.25, 783.99, 1046.5], // C5 G5 C6: brighter, something to watch
  chat: [987.77], // B5, a single blip
};

/** Seconds between notes, and how long each rings. */
const STEP = 0.07;
const RING = 0.16;
/** Each cue is detuned up to this much (either way), so repeats don't sound mechanical. */
const DETUNE = 0.02;

/**
 * The notes of cue `name`: `[{ freq, at, dur }]` in Hz and seconds; [] for an unknown name.
 * @param {() => number} [random]
 */
export function cueNotes(name, random = Math.random) {
  const detune = 1 + (random() * 2 - 1) * DETUNE;
  return (CUES[name] ?? []).map((freq, i) => ({ freq: freq * detune, at: i * STEP, dur: RING }));
}

/** Plays cue `name` now into `destination`, an AudioNode of `context`. */
export function playCue(context, destination, name, random) {
  const start = context.currentTime + 0.01;
  for (const { freq, at, dur } of cueNotes(name, random)) {
    const osc = context.createOscillator();
    osc.frequency.value = freq;
    const envelope = context.createGain();
    envelope.gain.setValueAtTime(0, start + at);
    envelope.gain.linearRampToValueAtTime(1, start + at + 0.008); // an 8 ms attack: no click
    envelope.gain.exponentialRampToValueAtTime(0.001, start + at + dur);
    osc.connect(envelope).connect(destination);
    osc.start(start + at);
    osc.stop(start + at + dur + 0.02);
    osc.onended = () => envelope.disconnect(); // one-shots don't pile up
  }
}
