// Profile picture: whatever image the user picks (zoomed and moved in ui/avatar-editor.js) becomes
// a small square data URL that fits the server's limit (MAX_AVATAR_LENGTH in signaling-server/src/server.js).

export const AVATAR_SIZE = 128;
export const MAX_AVATAR_LENGTH = 32_000;

export const MAX_AVATAR_ZOOM = 4;

/**
 * The square of a width × height image to keep. Zoom 1 = the short side fills it; the square is
 * centered on (cx, cy) in image pixels (default: the middle), moved back inside the image if needed.
 * @param {{ zoom?: number, cx?: number, cy?: number }} [view]
 */
export function cropSquare(width, height, { zoom = 1, cx = width / 2, cy = height / 2 } = {}) {
  const size = Math.min(width, height) / Math.min(MAX_AVATAR_ZOOM, Math.max(1, zoom));
  const start = (center, length) => Math.min(length - size, Math.max(0, center - size / 2));
  return { sx: start(cx, width), sy: start(cy, height), size };
}

/**
 * Crops an image to the square `view` picks (default: the centered one) and scales it to AVATAR_SIZE px.
 * @param {Blob | ImageBitmap} source a file (rejects when it can't be decoded) or a decoded image
 * @param {{ zoom?: number, cx?: number, cy?: number }} [view]
 * @returns {Promise<string>} a data:image/webp (or jpeg) URL
 */
export async function makeAvatar(source, view) {
  const bitmap = source instanceof Blob ? await createImageBitmap(source) : source;
  const { sx, sy, size } = cropSquare(bitmap.width, bitmap.height, view);
  const canvas = Object.assign(document.createElement('canvas'), { width: AVATAR_SIZE, height: AVATAR_SIZE });
  const context = canvas.getContext('2d');
  context.imageSmoothingQuality = 'high';
  context.drawImage(bitmap, sx, sy, size, size, 0, 0, AVATAR_SIZE, AVATAR_SIZE);
  if (bitmap !== source) bitmap.close();

  for (const quality of [0.85, 0.7, 0.5, 0.3]) {
    const url = canvas.toDataURL('image/webp', quality);
    if (url.startsWith('data:image/webp') && url.length <= MAX_AVATAR_LENGTH) return url;
  }
  // WebKit (macOS/iOS) can't encode WebP and returns PNG instead: use JPEG there.
  const jpeg = canvas.toDataURL('image/jpeg', 0.8);
  if (jpeg.length <= MAX_AVATAR_LENGTH) return jpeg;
  throw new Error("couldn't make the picture small enough");
}
