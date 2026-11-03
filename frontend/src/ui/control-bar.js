import { h } from './dom.js';
import { icons } from './icons.js';
import { settings } from '../store/settings.js';
import { POSITIONS, normalizeOrder, normalizePosition, dropIndex, nearestEdge } from '../core/call-bar.js';

/** Pointer travel (px) that turns a press into a drag; less is a normal click. */
const DRAG_THRESHOLD = 6;

/**
 * The call's control bar. Drag a button to reorder; drag the grip to an edge of the call to move
 * the bar there, or click the grip (keyboard too) to move it to the next edge. Saved in
 * settings.callBar, which Settings › Call controls edits as well.
 * @param {{ section: HTMLElement, buttons: Record<string, HTMLElement | null> }} options
 *   section: the call's root (gets data-bar = the edge); buttons: by key of CONTROLS (null = absent).
 */
export function createControlBar({ section, buttons }) {
  const grip = h('button', {
    type: 'button',
    class: 'bar-grip',
    html: icons.grip,
    'aria-label': 'Move the controls to the next edge',
    title: 'Drag to an edge of the window to move the controls',
  });
  const bar = h('div', { class: 'call-controls', role: 'toolbar', 'aria-label': 'Call controls' }, grip);
  for (const [key, button] of Object.entries(buttons)) if (button) button.dataset.control = key;

  const save = (patch) => settings.update({ callBar: { ...settings.get().callBar, ...patch } });
  const vertical = () => section.dataset.bar === 'left' || section.dataset.bar === 'right';

  const render = () => {
    const { position, order } = settings.get().callBar;
    section.dataset.bar = normalizePosition(position);
    bar.setAttribute('aria-orientation', vertical() ? 'vertical' : 'horizontal');
    for (const key of normalizeOrder(order)) if (buttons[key]) bar.append(buttons[key]);
  };

  grip.addEventListener('click', () => {
    const next = POSITIONS[(POSITIONS.indexOf(section.dataset.bar) + 1) % POSITIONS.length];
    save({ position: next });
  });

  // ----- Drag (mouse, pen or touch) -----
  let drag = null;
  let suppressClick = false;
  bar.addEventListener('pointerdown', (e) => {
    const target = e.button === 0 && e.target.closest('.bar-grip, [data-control]');
    if (!target) return;
    drag = { target, x: e.clientX, y: e.clientY, id: e.pointerId, moved: false };
    // On the window: a quick drag leaves the bar before the threshold (and the capture) kicks in.
    // Not captured right away, or a plain click would go to the bar instead of the button.
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  });
  const move = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    if (!drag.moved) {
      if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < DRAG_THRESHOLD) return;
      drag.moved = true;
      // Captured by the bar, not the button: moving the button in the DOM would drop the capture.
      bar.setPointerCapture(e.pointerId);
      drag.target.classList.add('dragging');
    }
    if (drag.target === grip) {
      section.dataset.drop = nearestEdge(section.getBoundingClientRect(), e.clientX, e.clientY);
      return;
    }
    const others = [...bar.querySelectorAll('[data-control]')].filter((b) => b !== drag.target);
    const centers = others.map((b) => {
      const r = b.getBoundingClientRect();
      return vertical() ? r.top + r.height / 2 : r.left + r.width / 2;
    });
    const before = others[dropIndex(centers, vertical() ? e.clientY : e.clientX)];
    if (before && drag.target.nextElementSibling !== before) bar.insertBefore(drag.target, before);
    else if (!before && bar.lastElementChild !== drag.target) bar.append(drag.target);
  };
  function end(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const { target, moved } = drag;
    drag = null;
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', end);
    window.removeEventListener('pointercancel', end);
    if (!moved) return;
    target.classList.remove('dragging');
    // The click that follows a drag isn't a press. Reset after this task in case no click comes.
    suppressClick = true;
    setTimeout(() => (suppressClick = false));
    const edge = section.dataset.drop;
    delete section.dataset.drop;
    if (e.type === 'pointercancel') return render(); // put things back
    if (target === grip) save({ position: edge });
    else save({ order: [...bar.querySelectorAll('[data-control]')].map((b) => b.dataset.control) });
  }
  bar.addEventListener(
    'click',
    (e) => {
      if (!suppressClick) return;
      suppressClick = false;
      e.preventDefault(); // also keeps the share button's popover closed
      e.stopImmediatePropagation();
    },
    true,
  );

  render();
  const unsubscribe = settings.subscribe((next, prev) => next.callBar !== prev.callBar && render());
  return { element: bar, destroy: unsubscribe };
}
