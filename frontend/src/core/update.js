// Updates of Jay-C itself, the Jay-H way (src-tauri/src/update.rs): the latest GitHub release, its
// installer checked against GitHub's SHA-256, then run while Jay-C closes. Here: is there a newer
// version, and asking for it. Windows app only (the commands are Windows ones).

import { isAndroidApp } from './activity-pip.js';

async function invoke(command, args) {
  return (await import('@tauri-apps/api/core')).invoke(command, args);
}

/** Only in the Windows app (not Android, not a browser tab on the dev server). */
export const updatesSupported = () => '__TAURI_INTERNALS__' in globalThis && !isAndroidApp();

/** "v0.4.0" → [0, 4, 0]. A pre-release or build suffix ("-beta", "+1") is ignored. */
const parts = (version) =>
  String(version)
    .replace(/^v/i, '')
    .split(/[-+]/)[0]
    .split('.')
    .map((n) => Number.parseInt(n, 10) || 0);

/** Negative if a < b, 0 if equal, positive if a > b. Missing parts count as 0 ("1.2" = "1.2.0"). */
export function compareVersions(a, b) {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const diff = (x[i] ?? 0) - (y[i] ?? 0);
    if (diff) return diff;
  }
  return 0;
}

/**
 * The release worth offering: newer than `current` and with an installer that can be checked.
 * @param {{ version: string, url: string, installable: boolean } | null} latest
 * @param {string} current
 */
export const newerRelease = (latest, current) => (latest?.installable && compareVersions(latest.version, current) > 0 ? latest : null);

let check = null;

/**
 * Asks GitHub once per run (the lobby and Settings › Help share the answer); `again` asks anew.
 * @returns {Promise<{ update: { version: string, url: string } | null, error?: string }>}
 */
export function checkForUpdate({ again = false } = {}) {
  if (!check || again) {
    check = invoke('update_latest')
      .then((latest) => ({ update: newerRelease(latest, __APP_VERSION__) }))
      .catch((error) => ({ update: null, error: String(error) }));
  }
  return check;
}

/** Downloads and checks the new installer, opens it and closes Jay-C. Rejects with the reason. */
export const installUpdate = () => invoke('update_install');
