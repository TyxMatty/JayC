// Writes a 20 s stereo test tone (left 440 Hz, right 880 Hz, 48 kHz 16-bit WAV), used to test
// screen-share audio and muffling. Play it in its own process, e.g.:
//   node scripts/make-tone.mjs tone.wav
//   powershell -c "(New-Object Media.SoundPlayer 'tone.wav').PlayLooping(); Start-Sleep 60"
import { writeFileSync } from 'node:fs';

const [, , out = 'tone.wav'] = process.argv;
const rate = 48000;
const seconds = 20;
const channels = 2;
const frames = rate * seconds;
const data = Buffer.alloc(frames * channels * 2);
for (let i = 0; i < frames; i++) {
  const t = i / rate;
  data.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * t) * 0.3 * 32767), i * 4);
  data.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 880 * t) * 0.3 * 32767), i * 4 + 2);
}
const header = Buffer.alloc(44);
header.write('RIFF', 0);
header.writeUInt32LE(36 + data.length, 4);
header.write('WAVE', 8);
header.write('fmt ', 12);
header.writeUInt32LE(16, 16);
header.writeUInt16LE(1, 20);
header.writeUInt16LE(channels, 22);
header.writeUInt32LE(rate, 24);
header.writeUInt32LE(rate * channels * 2, 28);
header.writeUInt16LE(channels * 2, 32);
header.writeUInt16LE(16, 34);
header.write('data', 36);
header.writeUInt32LE(data.length, 40);
writeFileSync(out, Buffer.concat([header, data]));
console.log('wrote', out);
