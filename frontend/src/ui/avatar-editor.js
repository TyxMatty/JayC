// Zoom and crop for a new profile picture, before it's saved. Drag (or the arrow keys) moves it,
// the slider, the mouse wheel or a two-finger pinch zooms; the circle is what others see.
import { h } from './dom.js';
import { t } from '../core/i18n.js';
import { cropSquare, makeAvatar, MAX_AVATAR_ZOOM } from '../core/avatar.js';

/** The preview's size in CSS pixels. */
const VIEW = 240;
const KEY_STEP = 8;

export function createAvatarEditor() {
  const canvas = h('canvas', { class: 'avatar-editor-canvas' });
  const stage = h(
    'div',
    { class: 'avatar-editor-stage', role: 'group', 'aria-label': t('Picture position: drag it or use the arrow keys') },
    canvas,
  );
  stage.tabIndex = 0;
  const zoomInput = h('input', { type: 'range', id: 'avatar-editor-zoom', min: 1, max: MAX_AVATAR_ZOOM, step: 0.01 });
  const cancelButton = h('button', { type: 'button', class: 'btn btn-secondary' }, t('Cancel'));
  const saveButton = h('button', { type: 'button', class: 'btn' }, t('Save'));
  const dialog = h(
    'dialog',
    { class: 'modal avatar-editor', 'aria-labelledby': 'avatar-editor-title' },
    h('header', { class: 'modal-header' }, h('h2', { id: 'avatar-editor-title' }, t('Adjust picture'))),
    h(
      'div',
      { class: 'modal-body' },
      stage,
      h('div', { class: 'field avatar-editor-zoom' }, h('label', { for: 'avatar-editor-zoom' }, t('Zoom')), zoomInput),
      h('p', { class: 'hint' }, t('The circle is what others see.')),
    ),
    h('footer', { class: 'modal-footer' }, cancelButton, saveButton),
  );

  /** @type {ImageBitmap | null} */
  let bitmap = null;
  /** Zoom and the crop's center, in image pixels. */
  let view = { zoom: 1, cx: 0, cy: 0 };
  /** @type {(url: string | null) => void} */
  let resolve = () => {};
  /** @type {(error: unknown) => void} */
  let reject = () => {};

  function draw() {
    const crop = cropSquare(bitmap.width, bitmap.height, view);
    // Keep the clamped center, so dragging past an edge doesn't build up hidden travel.
    view = { zoom: Math.min(MAX_AVATAR_ZOOM, Math.max(1, view.zoom)), cx: crop.sx + crop.size / 2, cy: crop.sy + crop.size / 2 };
    const pixels = Math.round(VIEW * (devicePixelRatio || 1));
    if (canvas.width !== pixels) canvas.width = canvas.height = pixels;
    const context = canvas.getContext('2d');
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, crop.sx, crop.sy, crop.size, crop.size, 0, 0, pixels, pixels);
    zoomInput.value = String(view.zoom);
  }

  /** Moves the picture by (dx, dy) CSS pixels on screen. */
  function pan(dx, dy) {
    const imagePerPixel = cropSquare(bitmap.width, bitmap.height, view).size / VIEW;
    view = { ...view, cx: view.cx - dx * imagePerPixel, cy: view.cy - dy * imagePerPixel };
    draw();
  }
  const zoomTo = (zoom) => {
    view = { ...view, zoom };
    draw();
  };

  // Pointers: one drags, two pinch.
  const pointers = new Map();
  const spread = () => {
    const [a, b] = [...pointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };
  stage.addEventListener('pointerdown', (e) => {
    stage.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  });
  stage.addEventListener('pointermove', (e) => {
    const last = pointers.get(e.pointerId);
    if (!last || !bitmap) return;
    const before = pointers.size === 2 ? spread() : 0;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) pan(e.clientX - last.x, e.clientY - last.y);
    else if (pointers.size === 2 && before > 0) zoomTo(view.zoom * (spread() / before));
  });
  for (const type of ['pointerup', 'pointercancel']) stage.addEventListener(type, (e) => pointers.delete(e.pointerId));
  stage.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      if (bitmap) zoomTo(view.zoom * Math.exp(-e.deltaY * 0.0015));
    },
    { passive: false },
  );
  stage.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? KEY_STEP * 4 : KEY_STEP;
    const moves = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    if (moves[e.key]) pan(...moves[e.key]);
    else if (e.key === '+' || e.key === '=') zoomTo(view.zoom + 0.1);
    else if (e.key === '-') zoomTo(view.zoom - 0.1);
    else return;
    e.preventDefault();
  });
  zoomInput.addEventListener('input', () => zoomTo(Number(zoomInput.value)));

  const finish = (url) => {
    dialog.close();
    bitmap?.close();
    bitmap = null;
    pointers.clear();
    resolve(url);
  };
  cancelButton.addEventListener('click', () => finish(null));
  // Esc: the dialog's own cancel (handled here, not in `close`, which can arrive a frame late).
  dialog.addEventListener('cancel', (e) => {
    e.preventDefault();
    finish(null);
  });
  saveButton.addEventListener('click', async () => {
    saveButton.disabled = true;
    try {
      const url = await makeAvatar(bitmap, view);
      finish(url);
    } catch (error) {
      finish(null);
      reject(error);
    } finally {
      saveButton.disabled = false;
    }
  });

  return {
    element: dialog,
    /**
     * Shows `file` for adjusting. Resolves with the picture's data URL, or null if cancelled;
     * rejects when the file isn't an image (before anything opens).
     * @param {Blob} file
     */
    async open(file) {
      bitmap = await createImageBitmap(file);
      view = { zoom: 1, cx: bitmap.width / 2, cy: bitmap.height / 2 };
      draw();
      dialog.showModal();
      stage.focus();
      return new Promise((res, rej) => {
        resolve = res;
        reject = rej;
      });
    },
  };
}
