// The app's look (Settings › Appearance › Style): <html data-style> picks a set of tokens in
// styles/theme.css. public/theme-init.js repeats resolveStyle() to set it before first paint.

export const STYLES = ['calm', 'neon', 'soft'];

/**
 * The Jay-C wolf icon's colors per style: the style's dark-theme accent (the lines) and accent
 * contrast (the head). Same values as styles/theme.css (test/theme-contrast.test.js checks).
 */
export const ICON_COLORS = {
  calm: { lines: '#aa8bff', fill: '#0f0d16' },
  neon: { lines: '#22d3ee', fill: '#06060a' },
  soft: { lines: '#ff9068', fill: '#16131b' },
};

/** A saved preference, or 'calm' when missing or unknown. */
export const resolveStyle = (preference) => (STYLES.includes(preference) ? preference : 'calm');
