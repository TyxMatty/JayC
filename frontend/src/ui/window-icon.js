// The window's icon (title bar and taskbar) drawn like the header's brand mark: the style's corners,
// the button color and its text color. It follows Settings › Appearance; the .exe's own icon (on
// disk, in the Start menu, when pinned) is the file one, src-tauri/app-icon.svg.
import { isAndroidApp } from '../core/activity-pip.js';

const SIZE = 64;
/** The header mark is 30 px with --radius-sm corners: keep the same proportion. */
const MARK_PX = 30;

/** The brand mark (ui/icons.js `logo`): three rounded bars on a rounded square. */
export function drawMark(g, size, { fill, bars, radius }) {
  g.clearRect(0, 0, size, size);
  g.fillStyle = fill;
  g.beginPath();
  g.roundRect(0, 0, size, size, radius);
  g.fill();
  g.strokeStyle = bars;
  g.lineCap = 'round';
  g.lineWidth = size * 0.11;
  const s = size / 24; // the icon's 24-unit viewBox
  for (const [x, y1, y2] of [[8, 9, 15], [12, 6, 18], [16, 9, 15]]) {
    g.beginPath();
    g.moveTo(x * s, y1 * s);
    g.lineTo(x * s, y2 * s);
    g.stroke();
  }
}

let pending = null;

/** Redraws the window icon from the current tokens (desktop app only; a no-op elsewhere). */
export function updateWindowIcon() {
  if (!('__TAURI_INTERNALS__' in window) || isAndroidApp() || pending) return;
  // After the style/theme attributes and inline colors have been applied, once per frame.
  pending = requestAnimationFrame(async () => {
    pending = null;
    const cs = getComputedStyle(document.documentElement);
    const canvas = Object.assign(document.createElement('canvas'), { width: SIZE, height: SIZE });
    const g = canvas.getContext('2d');
    drawMark(g, SIZE, {
      fill: cs.getPropertyValue('--accent').trim(),
      bars: cs.getPropertyValue('--accent-contrast').trim(),
      radius: Math.min(SIZE / 2, (parseFloat(cs.getPropertyValue('--radius-sm')) * SIZE) / MARK_PX),
    });
    try {
      const [{ Image }, { getCurrentWindow }] = await Promise.all([import('@tauri-apps/api/image'), import('@tauri-apps/api/window')]);
      const pixels = g.getImageData(0, 0, SIZE, SIZE).data;
      // The buffer, not the Uint8ClampedArray: Tauri only treats Uint8Array/ArrayBuffer as bytes.
      await getCurrentWindow().setIcon(await Image.new(pixels.buffer, SIZE, SIZE)); // title bar
      // The taskbar's big icon: Tauri's setIcon doesn't set it (src-tauri/src/taskbar_icon.rs).
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('set_taskbar_icon', { rgba: Array.from(pixels), size: SIZE });
    } catch (error) {
      console.warn('[window-icon]', error);
    }
  });
}
