// Whether the interface animates: Settings › Appearance › Animations ('system' follows the OS's
// "reduce motion"; 'on' and 'off' override it for Jay-C only). ui/theme.js puts the result on
// <html data-motion="full|reduced">, which the CSS animations key off.

export const MOTION_PREFERENCES = ['system', 'on', 'off'];

/** @returns {'full' | 'reduced'} */
export function resolveMotion(preference, systemReduced) {
  if (preference === 'on') return 'full';
  if (preference === 'off') return 'reduced';
  return systemReduced ? 'reduced' : 'full';
}
