// Profile picture: whatever image the user picks becomes a small square data URL that fits the
// server's limit (MAX_AVATAR_LENGTH in signaling-server/src/server.js).

export const AVATAR_SIZE = 128;
export const MAX_AVATAR_LENGTH = 32_000;

/** The centered square of a width × height image. */
export function centerSquare(width, height) {
  const size = Math.min(width, height);
  return { sx: (width - size) / 2, sy: (height - size) / 2, size };
}

/**
 * Crops `file` to its centered square and scales it to AVATAR_SIZE px.
 * @param {Blob} file an image (rejects when it can't be decoded)
 * @returns {Promise<string>} a data:image/webp (or jpeg) URL
 */
export async function makeAvatar(file) {
  const bitmap = await createImageBitmap(file);
  const { sx, sy, size } = centerSquare(bitmap.width, bitmap.height);
  const canvas = Object.assign(document.createElement('canvas'), { width: AVATAR_SIZE, height: AVATAR_SIZE });
  const context = canvas.getContext('2d');
  context.imageSmoothingQuality = 'high';
  context.drawImage(bitmap, sx, sy, size, size, 0, 0, AVATAR_SIZE, AVATAR_SIZE);
  bitmap.close();

  for (const quality of [0.85, 0.7, 0.5, 0.3]) {
    const url = canvas.toDataURL('image/webp', quality);
    if (url.startsWith('data:image/webp') && url.length <= MAX_AVATAR_LENGTH) return url;
  }
  // WebKit (macOS/iOS) can't encode WebP and returns PNG instead: use JPEG there.
  const jpeg = canvas.toDataURL('image/jpeg', 0.8);
  if (jpeg.length <= MAX_AVATAR_LENGTH) return jpeg;
  throw new Error("couldn't make the picture small enough");
}
