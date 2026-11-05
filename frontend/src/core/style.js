// The app's look (Settings › Appearance › Style): <html data-style> picks a set of tokens in
// styles/theme.css. public/theme-init.js repeats resolveStyle() to set it before first paint.

export const STYLES = ['calm', 'neon', 'soft'];

/** A saved preference, or 'calm' when missing or unknown. */
export const resolveStyle = (preference) => (STYLES.includes(preference) ? preference : 'calm');
