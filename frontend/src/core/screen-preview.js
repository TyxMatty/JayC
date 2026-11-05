// Stills of our screen share: the room gets one every few seconds, for the tiles of those not
// watching it (the "Watch stream" card).
import { livePreview } from './native-live.js';

const MAX_WIDTH = 320;
const MAX_HEIGHT = 240;

/**
 * A small JPEG data URL (~10-30 KB) of what we're sharing right now.
 * @param {{ native?: boolean, track?: MediaStreamTrack }} what
 *   `native`: the running native share's last frame; `track`: the system picker's capture.
 */
export async function capturePreview({ native, track }) {
  const bitmap = native ? await createImageBitmap(await livePreview()) : await new ImageCapture(track).grabFrame();
  const scale = Math.min(1, MAX_WIDTH / bitmap.width, MAX_HEIGHT / bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas.toDataURL('image/jpeg', 0.7);
}
