// Apps left out of the entire-screen share's sound (Settings › Streaming), by executable name.
// The Rust side matches case-insensitively, with ".exe" optional, also on ancestor processes.

/** Quick picks shown even when the app isn't playing sound right now. */
export const SUGGESTED_APPS = [
  { exe: 'Discord.exe', displayName: 'Discord' },
  { exe: 'ms-teams.exe', displayName: 'Teams' },
  { exe: 'Zoom.exe', displayName: 'Zoom' },
];

/** "Discord.exe", " discord " and "DISCORD.EXE" are the same app. */
export const exeKey = (name) => name.trim().toLowerCase().replace(/\.exe$/, '');

export const isExcluded = (list, name) => list.some((exe) => exeKey(exe) === exeKey(name));

/** Returns `list` with `name` added (trimmed, ".exe" appended), or `list` itself if it's empty or already there. */
export function addExcludedApp(list, name) {
  const trimmed = name.trim();
  if (!exeKey(trimmed) || isExcluded(list, trimmed)) return list;
  return [...list, /\.exe$/i.test(trimmed) ? trimmed : `${trimmed}.exe`];
}

export const removeExcludedApp = (list, name) => list.filter((exe) => exeKey(exe) !== exeKey(name));
