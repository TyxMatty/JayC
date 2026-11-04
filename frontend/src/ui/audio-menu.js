// The right-click menu on a person or a stream: volume (0–200%) and mute, only for us.
// Keyboard: focus the tile and press the Menu key (or Shift+F10), which fires the same event.
import { h } from './dom.js';
import { MAX_VOLUME } from '../core/playback.js';

export function createAudioMenu() {
  const title = h('h2', { class: 'audio-menu-title', id: 'audio-menu-title' });
  const value = h('output', { for: 'audio-menu-volume', class: 'hint' });
  const slider = h('input', { type: 'range', id: 'audio-menu-volume', min: 0, max: MAX_VOLUME * 100, step: 5 });
  const mute = h('input', { type: 'checkbox', id: 'audio-menu-mute' });
  const muteText = h('span', {});
  const el = h(
    'div',
    { class: 'audio-menu', popover: 'auto', 'aria-labelledby': 'audio-menu-title' },
    title,
    h('div', { class: 'audio-menu-row' }, h('label', { for: 'audio-menu-volume' }, 'Volume'), value),
    slider,
    h('label', { class: 'audio-menu-check' }, mute, muteText),
  );

  /** @type {{ get: () => { volume: number, muted: boolean }, set: (patch: object) => void } | null} */
  let target = null;
  const render = () => {
    const { volume, muted } = target.get();
    slider.value = String(Math.round(volume * 100));
    value.textContent = `${Math.round(volume * 100)}%`;
    mute.checked = muted;
  };
  slider.addEventListener('input', () => {
    target?.set({ volume: Number(slider.value) / 100 });
    render();
  });
  mute.addEventListener('change', () => {
    target?.set({ muted: mute.checked });
    render();
  });

  return {
    element: el,
    /**
     * @param {MouseEvent} event the contextmenu event (its position, or the tile's when from the keyboard)
     * @param {{ title: string, muteLabel: string, get: () => { volume: number, muted: boolean }, set: (patch: object) => void }} options
     */
    open(event, options) {
      event.preventDefault();
      target = options;
      title.textContent = options.title;
      muteText.textContent = options.muteLabel;
      render();
      el.showPopover();
      // From the keyboard the event has no pointer position: anchor to the tile instead.
      const anchor = event.clientX || event.clientY ? { x: event.clientX, y: event.clientY } : event.currentTarget.getBoundingClientRect();
      const { width, height } = el.getBoundingClientRect();
      el.style.left = `${Math.max(8, Math.min(anchor.x, innerWidth - width - 8))}px`;
      el.style.top = `${Math.max(8, Math.min(anchor.y, innerHeight - height - 8))}px`;
      slider.focus();
    },
  };
}
