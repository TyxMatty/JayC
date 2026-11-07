# Continuing Jay-C on another PC

[Português](CONTINUAR.md) · **English**

> Translation of [CONTINUAR.md](CONTINUAR.md). The Portuguese file is the reference and is updated first, so this one may lag behind it.

Updated on 2026-11-03, in the commit after `d8f7f8b`.

## 0. On a PC that already has the project (e.g. the laptop)

```powershell
git pull
npm install         # if the server tests fail with "mediasoup-worker ENOENT": npm rebuild mediasoup
npm test
```

Then **restart `npm run server`**. The protocol changed (profile picture), and an old server rejects changing the picture during a call. Then `npm run dev`. The first build after the pull recompiles the `system-audio` plugin, but not the WebRTC APM, which is already built in `target`.

## 1. Install the tools (Windows)

In PowerShell. Each `winget` may ask for administrator approval (UAC).

```powershell
winget install -e --id Git.Git
winget install -e --id OpenJS.NodeJS.LTS
winget install -e --id Microsoft.VisualStudio.2022.BuildTools --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
winget install -e --id Rustlang.Rustup
winget install -e --id Python.Python.3.13 --scope user   # or 3.14, which also works
```

Then, **in a new terminal**, to pick up the updated PATH:

```powershell
py -m pip install --user meson ninja
```

Finally, put Python's Scripts folder on the user PATH. It follows the version (`Python313`, `Python314`...) and `pip` shows it in the "not on PATH" warning. Python 3.14 also works.

```powershell
$scripts = py -c "import sysconfig;print(sysconfig.get_path('scripts','nt_user'))"
[Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path','User') + ";$scripts", 'User')
```

Optional:

| Tool | What for | How |
|---|---|---|
| Docker Desktop | running the server in a container (`docker compose`) | `winget install -e --id Docker.DockerDesktop` |
| Android Studio + SDK/NDK | Android only | see [ARQUITETURA.en.md](ARQUITETURA.en.md), section 9, or the command line only (below) |

WebView2 already comes with Windows 11.

If the PC has MSYS2 on the PATH, that's fine: the audio build ignores its `pkg-config`.

## 2. Get the code

Clone **outside OneDrive**. The Rust build produces several GB and OneDrive would try to sync them.

```powershell
git clone https://github.com/TyxMatty/Jay-C.git C:\dev\JayC
cd C:\dev\JayC
npm install
```

npm 12 blocks install scripts. The `allowScripts` in `package.json` allows mediasoup's. If the server tests fail with `mediasoup-worker ENOENT`, run `npm rebuild mediasoup`.

- **If you clone inside OneDrive anyway:** create `.cargo\config.toml` at the repository root, which is local and doesn't go to git, with:
  ```toml
  [build]
  target-dir = "C:/Users/<you>/.cargo-target/jay-c"
  ```
- **The OneDrive copy:** the other PC's `Documentos\JayC` folder also shows up there, synced. Work only in the clone and use git (`push`/`pull`) to move changes between PCs. Editing both copies causes conflicts.

## 3. Run

```powershell
npm run server     # terminal 1: signaling (:3000) + SFU (media :40000 UDP/TCP)
npm run dev        # terminal 2: opens the app (the 1st build compiles the WebRTC APM; takes a few minutes)
npm test           # tests
```

- **Firewall:** Windows may ask about Node.js. Allow it, because that's the media port.
- **First app setup:** in Settings › Server, use `localhost:3000`, or the IP of the PC running the server.
- **A second participant for testing:** open `http://localhost:5173` in Chrome.
- **A terminal opened before installing something** doesn't see the new PATH (e.g. `cargo` not found). Open a new terminal, or use `scripts\dev-debug.ps1`.
- **Run the commands in the project folder**, not in the user folder (`npm error ENOENT ... package.json`).
- **CI on GitHub** (`.github/workflows/ci.yml`, runs on every push to `main` and every pull request):
  - on Ubuntu, `npm ci` and `npm test`;
  - on Windows, `cargo test --lib` for the `system-audio` plugin and `cargo test` for the app. Before that, it installs Meson and Ninja for the APM and runs `vite build`, because the app embeds `frontend/dist`.
  - Rust tests that need a screen, Discord or live sound are `#[ignore]` and don't run there.
  - It also builds the server's Docker image (`signaling-server/Dockerfile`, context at the root) and checks that it starts and answers on `/health`. The image isn't published: its name on GHCR is an open decision.
  - The "CI" badge at the top of the READMEs shows the result of the last run on `main`.
- **Installer on GitHub** (`.github/workflows/installer.yml`): on a `v*` tag or by hand from the Actions tab ("Installer › Run workflow"), it runs `npm run build` on a clean Windows machine. The `Jay-C_<version>_x64-setup.exe` is kept as the run's artifact and, on a tag, goes into a **draft release** (if the tag's release is already published, it isn't touched).
- **A new version, step by step:**
  1. bump the version in the same places as the "Versão 0.4.1" commit and record the changes in this document;
  2. commit, push, and `git tag vX.Y.Z` + `git push origin vX.Y.Z`;
  3. wait for the Installer workflow (~8–11 min): it creates the draft with the installer;
  4. test the installer on a test PC, write the notes in the draft and publish it.

  Only the published release reaches Jay-C's auto-update (from 0.4.2 on) and Jay-H. The SHA-256 they check is the one GitHub computes for the release's installer.

## 4. Claude Code on the new PC

Open the clone's folder in Claude, in the desktop app (Code tab) or the CLI. `CLAUDE.md` is loaded automatically and holds the working rules and the build and audio pitfalls. **Since 05/11/2026 it is not in git** (it's in `.gitignore`): copy it from this PC to the root of the clone. Claude's "memory" notes stay on this PC; what matters from them is in CLAUDE.md. To pick up again, say something like: *"Read CLAUDE.md and docs/CONTINUAR.md and move on to milestone 14 (release)."*

## 5. Current state

**Milestones 0 to 13 done, plus 14.A (Windows installer)** (details in [ARQUITETURA.en.md](ARQUITETURA.en.md), section 10).

| Milestone | What it delivers |
|---|---|
| Server | signaling + mediasoup SFU in Docker, rooms of up to 16, a single media port, automatic announced IP |
| Calls | camera with 3-layer simulcast, solo / 1:1 / grid layouts, reconnection |
| Screen or window streaming | live quality panel (resolution, fps, text/motion) and a presenting layout for viewers |
| Stream sound (Windows) | native per-process capture. Window = only that app; entire screen = everything except Jay-C and the apps excluded in Settings › Streaming (applied live, apps re-evaluated every 2 s). Stereo Opus at 128 kbps. |
| Setup guide | "Server setup guide" modal (lobby and Settings › Server) with two tabs: **Connecting** (just connecting: address, room, what to do if it doesn't connect) and **Hosting** (the 5 steps, ports, firewall, VPN and the upload bandwidth math; our own Markdown and 5 images) |
| PiP (desktop) | the featured video (shared screen or camera) floats over the other windows, switches by itself and has mic, camera and hang-up buttons |
| Native microphone (Windows) | WASAPI + WebRTC's AudioProcessing (echo/noise/gain) so other apps aren't muffled, with options in Settings › Microphone applied live |
| Android | debug APK with camera and microphone; joins the call and, when leaving the app, becomes a mini-window (PiP) with the featured video. Tested on the emulator. |
| Customization | Settings › Appearance: style (Calm, Neon or Soft, each in light and dark), button color and a gradient background (translucent top bar). Inter font bundled. A call bar that can be dragged to any edge, in any order (also by keyboard in Settings › Call controls). A profile picture that shows when the camera is off, with zoom and crop when picking it. |

Customization details in ARQUITETURA, section 10, "Customization". **Plugins were left for after the release**: plugins without isolation on the client are ruled out, because they would reach Tauri's IPC (audio, screen and microphone capture).

**Jay-A integration** (the Jay line's audio app, in another repository): the plan is in `docs/JAY-A.md` (Portuguese). Milestones I1 to I4 are done: the pipe client, the selector, the fake Jay-A, the probe, the Jay-A mode of the native microphone, the interface (Settings › Audio › Microphone filter, notices, Open Jay-A, "not installed") and starting the installed Jay-A automatically. The app switches to Jay-C's own filter without a gap when Jay-A goes down. The next milestone is I5, the test with the real Jay-A. It waits for Jay-A's step 3 (the Jay Link server).

**Next: the external test feedback** (list below, under "First external test"), starting with a new test with the friends using the diagnostics. Then 14.B (signed release APK). The parts of milestone 14 are in ARQUITETURA, section 10, "Release".

iOS (milestone 15, code only) was left for after launch.

**"Welcome!" tour (04/11/2026):** W1 and W2 done: 7 cards with an animated illustration each, transitions between cards and a fixed height; it opens the first time and reopens from Settings › Help. Plan and details in ARQUITETURA, section 10, "Welcome! tour".

**Live audio tests** (they play sound on the speakers), in `plugins/tauri-plugin-system-audio`:
`cargo test --lib -- --ignored --nocapture --test-threads 1 exclusion_live` and `cargo test --release --lib -- --ignored --nocapture cpu_many_streams`.

**Installer 0.2.3 (04/11/2026):** 0.2.2 plus the Welcome tour with the animated illustrations (W2). It's the version to send to the friends. The server hasn't changed since 0.2.1.

**Installer 0.2.4 (05/11/2026):** new look (Inter, Calm/Neon/Soft styles, call, lobby, chat with pictures, Settings in cards), mic meter outside the call, full screen and PiP for streams, picture editor and full screen on Android (not tested on a device). The installer got the Soft look: side and header images (`scripts/installer-art.mjs`) and a warm background. A temporary icon with the Jay-C mark on the Soft gradient (`frontend/src-tauri/app-icon.svg`), in the app, the installer and Android, until Jay-C had its own (milestone 14.D).

**Installer 0.2.5 (05/11/2026):** 0.2.4 with the avatar initial inside the circle on large cards.

**Installer 0.2.6 (05/11/2026):** 0.2.5 with the window and taskbar icon in the chosen style and color.

**The Jay-C icon (05/11/2026, milestone 14.D):** the wolf drawn by the user replaces the temporary mark.
- **Where:** in the `.exe`, the installer (icon and images), Android, the window, the taskbar and the mark in the top bar and the lobby.
- **Why not the original line art:** it vanishes at 16–32 px. So the icon is the "filled head": thickened lines and a dark inside.
- **Colors:**
  - `.exe`, installer and Android: Soft orange over the head in `#16131B`.
  - Window and taskbar: the style's dark colors (the user's drawings).
  - Inside the app: the theme's colors.
- **How to regenerate:** `scripts/wolf-icon.ps1` and then `tauri icon` (see CLAUDE.md, "Ícone").
- Shipped in installer 0.3.1.

**Installer 0.4.1 (06/11/2026):** 0.4.0 with what's below, built by the installer workflow on GitHub (tag `v0.4.1`). The server didn't change inside: a 0.4.0 server works the same. Only the Docker image changed its base.

**Between 0.4.0 and 0.4.1 (06/11/2026):**
- **Jay-A integration** (milestones I1–I4 in `docs/JAY-A.md`):
  - Settings › Audio › **Microphone filter**: Jay-C (default) or Jay-A;
  - with Jay-A, Jay-C's filter runs alongside as the fallback and takes over without a gap if Jay-A goes down;
  - in-call notices only for drops longer than 2 s;
  - **Open Jay-A**, and "not installed" with **Get Jay-A**;
  - the installed Jay-A is started once per call.
  - It only takes effect with a Jay-A that has the Jay Link server.
- **Microphone and stream audio:** the worklet no longer cuts dry after the page stalls. The burst of chunks becomes a cushion and is trimmed with a crossfade (`docs/spikes/11-continuidade-do-mic.md`).
- **GitHub:** the home page README is in English (Portuguese in `README.pt-BR.md`); links use the new name, `TyxMatty/Jay-C`, including the in-app server guide; the CI and the installer workflow were added.
- **Server Docker image:** the base moved from `node:24-bookworm-slim` to `node:24-trixie-slim`. On a host with kernel 7, mediasoup's prebuilt worker needs glibc 2.38, and bookworm has 2.36: the image didn't build.

**Installer 0.4.0 (06/11/2026):** 0.3.9 with what's below. The server didn't change.

**Between 0.3.9 and 0.4.0 (06/11/2026):**
- **Small cards (under a stream):** the picture or initial sits in the middle of the card (it rode up before, because its area left out the name's 30 px), and the name has its own `z-index` to stay on top where the two meet. Measured at three window sizes: a 49 px circle at the exact center of 160×90 cards; where they meet, the top element is the name. The README's call image was retaken.

**Installer 0.3.9 (06/11/2026):** 0.3.8 with what's below. The server changed only inside (the bandwidth report); the protocol is the same, and a 0.3.8 server works the same.

**Between 0.3.8 and 0.3.9 (06/11/2026):**
- **Version in the app:** "Jay-C <version>" in the lobby's bottom-left corner (hidden on windows narrower than 900 px, where it covered the card) and in an "About" section in Settings › Help. The number comes from the frontend's `package.json` (Vite `define`), so it follows each release.
- **README with images** (PT and EN): a call with a stream up front, four points about the app and the lobby in the three styles (`docs/images/`). Captures of the dev app's window only (`PrintWindow`, without Windows' invisible border), with a test profile and made-up participants.
- **Security review** (authorization, secrets, uploads): no data leak and no secret in the code or the 123 commits of history. New test: ids from another person or another room are refused and nothing crosses rooms (verified by mutation). The tour's example address, which was the real IP of the user's server on Radmin, is now `192.168.0.10:3000`; the IP is still in old commits.
- **Code review (0.3.6 → 0.3.8), items fixed, each checked by mutation** (breaking the rule on purpose turns a test red):
  - `reportViewerBandwidth`: queries each viewer's bandwidth once per round, all at once, and doesn't stack rounds if the media process stalls; unit test with a fake router (`signaling-server/test/sfu-room.test.js`), since mediasoup only estimates with a connected viewer;
  - deafen: the test now goes through `setTargetAtTime`, the app's path (the test-only `else` is gone);
  - alert sounds: the rule (on in Settings; while deafened, only our own actions') became `cueAllowed` in `core/sounds.js`, with a test;
  - taskbar: `descendants` only counts a child process that started after its parent (Windows reuses ids, and a process whose parent died long ago can name an id of ours); a test with data and another with a real child process.

**Installer 0.3.8 (06/11/2026):** 0.3.7 with what's below. The server changed (`viewer-bandwidth` and the 6 Mbps starting estimate); with an old server the live works as before, without the cap.

**Between 0.3.7 and 0.3.8 (06/11/2026):**
- **Native live freezing for viewers above 720p** (report: "extremely frequent freezes", video and anime, both sides, server on the user's PC). The native live has a single layer, and the sender only saw its own leg to the server: with the server on the same PC the estimate was ~12 Mbps and the live went out at 1080p60, ~7 Mbps, to everyone. Measured with a 1920×1080 high-motion window, the dev app sending, a headless Chrome watching and a 4 Mbps UDP bottleneck (200 ms queue) on the viewer only: **0 frames/s for 30 s** (~600 packets lost/s, non-stop keyframe requests) while the sender kept 7.7 Mbps. Now:
  - every 2 s the server sends the sharer the smallest bandwidth among its viewers (`viewer-bandwidth`, from mediasoup's `availableOutgoingBitrate`), and Rust caps the live at 70% of it (`native_live_viewer_kbps`), stepping down the ladder (1080p60 → 720p30…);
  - each viewer's estimate starts at 6 Mbps (was 1 Mbps): with the cap, 1 Mbps would hold a still screen at 540p, since it doesn't grow without traffic;
  - each step down doubles the wait before climbing again (3 s → 6 → 12, up to 30 s): at 85% and 3 s the live climbed back to 1080p60 and its keyframe flooded the link (2 to 7 s without picture).
  - Measured, 4 Mbps: steady picture at 8 s, then 55 s at 720p30 with no loss and no freezes (gaps < 0.2 s). Fast link: 1080p60 at 55 frames/s and ~7 Mbps for 60 s, no loss, as before.
  - **Limits:** a viewer on a slow link still stutters for the first ~8 s (the live goes out at 1080p60 until the server notices); the slowest viewer pulls the live down for everyone; and the bottleneck was simulated, not measured on a real internet link.
- **Also measured, no change:** the late-audio renewal (0.3.7) doesn't freeze the video (4 forced renewals every 15 s: no gap above 200 ms, same video delay). Capture and encoder hold 1080p60 high motion on this PC (56–58 frames/s).

**Installer 0.3.7 (05/11/2026):** 0.3.6 with what's below. The server changed (`closeConsumer`); an old server still works.

**Between 0.3.6 and 0.3.7 (05/11/2026):**
- **Deafen:** a headphones button next to the mic. It silences everything received (the mixer got a bus for voices and streams, set to zero with a ~15 ms ramp) and turns the mic off; undeafening brings the mic back as it was; turning the mic on while deafened undeafens (as in Discord). Saved bar orders get the button next to the mic (`normalizeOrder` puts a new button next to its neighbor). Measured in the dev app with a capture of its own WebView2 only: deafened -120 dB, undeafened -13 dB (a bot's 440 Hz tone), back to -120. Others don't see the headphones, only the mic off.
- **PiP in its own window (Windows):** WebView2's PiP showed the page's origin ("tauri.localhost") and only the Media Session buttons. Now the page's `window.open('')` becomes a Jay-C window (`src-tauri/src/pip_window.rs`): always on top, no title bar, 480×270 in the bottom-right corner, resizable (min 200×112), draggable from anywhere outside the buttons (`pip_drag`). The page fills the window (same process, so the same `MediaStream` plays there) with the video and the microphone, camera, leave and close buttons, shown on hover. Only `about:blank` opens; any other URL is refused. For that the main window is created in `setup` (with `on_new_window`), and `tauri.windows.conf.json` turns off the automatic creation on Windows only. WebView2 sometimes replaces the window's page after it was filled (a white window, seen by the user): the page checks every 300 ms and fills it again. Measured in the dev app: 480×270 window on top, in the Jay-C taskbar group, 1280×720 video playing, buttons working, and the refill after forcing a page replace. The page's `window.close()` only closed the page and left the native window white with no buttons (the PiP's X and the end of a stream, seen by the user): the window is closed from Rust (`pip_close`), also when the main window closes (or the app kept running) or the page reloads. Measured: after the X and after the stream ends, only the `main` window exists; closing Jay-C with the PiP open ends the process. **Not tested:** dragging and resizing with the mouse.
- **PiP on the same taskbar stack as Jay-C:** with the window's own ID (0.3.5), the PiP window (WebView2's, a child process) showed as another app ("Microsoft Edge WebView2"). When the PiP opens, the app gives its child processes' windows the same ID and icon (`group_child_windows`). Measured: the dev app's PiP joined the Jay-C group; the installed app's (0.3.6, without the change) stayed separate.

- **Alert sounds** (`core/sounds.js`): synthesized with WebAudio, no files, on the mixer's alert bus (straight to the chosen speakers, outside the voices bus, ~-16 dBFS per cue). Rising = on/arrived, falling = off/left: mic, deafen (lower), someone joined, left, started a stream, a message with the chat closed (a blip), and our own arrival in the room. ±2% pitch variation. While deafened, only our own actions' cues play. Settings › Audio › "Play alert sounds" (on). Measured in the dev app by logging every note played: each event played its sequence, and the bot's chat while the app was deafened played nothing.

- **Audio that stayed behind after a freeze** (`core/catch-up.js`): measured with a streamed clock window and the server's media process frozen for 3 s, video drops its old frames and is back at once, but audio kept 2.5 s and drained only 0.2 s per second (~17 s out of sync; much longer after a longer freeze). Now the app checks each received audio's buffer every 1 s (`getStats`) and, above 500 ms in two checks in a row, opens a new consumer (new `closeConsumer` request on the server; an old server gets `pauseConsumer`). Measured: back to 30 ms ~3 s after the freeze. It also caught a 1.4 s delay right when starting to watch. Fine audio/video sync of a stream isn't solved: grouping the tracks by `streamId` in mediasoup-client was tested on a native stream (clock window with a click every second) and changed nothing (video ~46 ms, audio 147–198 ms behind, before and after), so it was reverted. The native stream sends video and audio on different transports.

**Installer 0.3.6 (05/11/2026):** only the Discord image names fix: Calm and Neon use `discord-wolf-calm` and `discord-wolf-neon`, as they were saved in the application (0.3.5 looked for names that don't exist and showed those styles without an image). The server hasn't changed.

**Installer 0.3.5 (05/11/2026):** 0.3.4 with what's below. The server hasn't changed.

**Between 0.3.4 and 0.3.5 (05/11/2026):**
- **Your own stream on your tile**, at its real quality and frame rate: Rust hands the H.264 frames to the page and WebCodecs decodes them on the GPU. ~0.2 core more while the tile shows; paused while the app is minimized. See docs/spikes/10-live-nativa.md (in Portuguese).
- **A minimized shared window** no longer ends the stream (the last frame keeps going out).
- **Sharing again after a stream that ended by itself** (window closed) no longer falls back to the system picker.
- **Discord:** the thick wolves in every style (`discord-wolf-calm`, `discord-wolf-neon`, `jayc_orange_thick`).
- **Taskbar icon of the installed app:** it stayed the `.exe`'s orange in every style, because Windows ties `jay-c.exe` to its Start menu shortcut and uses the shortcut's icon.
  - The window now has its own AppUserModelID (`io.github.tyxmatty.jayc.window`) and "relaunch" properties with a `.ico` of the style, written to `%LOCALAPPDATA%\io.github.tyxmatty.jayc\taskbar-*.ico` (`src-tauri/src/taskbar_icon.rs`).
  - Measured with a temporary shortcut pointing at the dev app (the same tie as the installed one): purple in Calm, cyan after switching to Neon, purple again, always named "Jay-C".
  - The installer now asks Windows to refresh its icon cache at the end (`SHChangeNotify`), against the old icon in the right-click menu. Not tested: it only runs in an installer build, and installers aren't run on this PC.
  - An app pinned to the taskbar shows the icon from when it was pinned (Windows uses the pinned shortcut's).

**Installer 0.3.4 (05/11/2026):** 0.3.3 with what's below and Discord Rich Presence: during a call, the Discord profile shows Jay-C (people, time, streams without names, the style's wolf), with the options in Settings › Profile › Discord. Plan and measurements in ARQUITETURA.en.md, section 10, "Discord Rich Presence". The server changed (the `screen-preview` message); an old server still works, without the previews.

**Between 0.3.3 and 0.3.4 (05/11/2026):**
- **No text selection:** dragging with the left button no longer selects labels, buttons and images (`user-select: none` on `body`). Text fields, chat messages and the setup guide stay selectable. Measured with a real drag (CDP): nothing selected; with selection forced back on, the same drag picks up the lobby's text.
- **Jay-C in the stream:**
  - The native stream no longer hides the Jay-C window (affinity 0 during an entire-screen stream).
  - The picker lists Jay-C's own window (`own`), streamed without sound: its sound is the call's and would go back to everyone.
  - Only a stream through the system picker, which has a local preview, still hides Jay-C (mirror effect).
- **Stream preview:**
  - Whoever streams sends a picture (a 320 px JPEG, ~10 KB) every 6 s, with the new `screen-preview` message. "Watch stream" becomes a card with the picture.
  - Your own stream's tile, which said "Live · no preview", shows the picture, refreshed every 2 s.
  - On the native stream the picture comes from the stream's last frame, scaled down on the GPU (mipmaps): ~10 ms and ~15 ms of CPU in the dev build, against 230 ms and 166 ms with a new capture (the picker's thumbnail).
  - Old server: the app doesn't send the pictures (`joined` doesn't list `features`).

**Installer 0.3.3 (05/11/2026):** 0.3.2 with the code review fixes (native stream on a still screen, network drops, transport closed on stop, stopping while it starts, encoder errors; joining a room without a ghost call) and the mic that comes back by itself when reconnected. See "Fixes after the code review", below.

The server changed: the new `closeTransport` request. An old server still works with the new app.

**Installer 0.3.2 (05/11/2026):** 0.3.1 with:
- a bigger wolf in the icons (cropped to the drawing: 98% of the square in the window and the taskbar, 94% in the `.exe`);
- the left side of the lobby as tall as the card, with the big wolf in the original thin line growing to fill it;
- Animations with only On (default) and Off, no longer following Windows.

The server hasn't changed.

**Installer 0.3.1 (05/11/2026):** 0.3.0 with the Jay-C icon (the wolf) in the `.exe`, the installer, the window, the taskbar and the app's mark. The server hasn't changed.

**Installer 0.3.0 (05/11/2026):**
- **Native stream on Windows:** capture, H.264 on the graphics card and our own WebRTC, at ~0.3 of a core instead of ~1.5, with resolution and frame rate that adapt to the bandwidth. It comes with our own picker of screens and windows, with thumbnails, and no preview of your own stream.
- **App without browser menu or shortcuts.**
- **Calm in violet:** `#AA8BFF` in dark.
- **Server:** unchanged; the native stream uses the same `createTransport`/`produce` and port 40000.
- **Not tested yet:** the native stream with a viewer on another PC, and Intel/AMD graphics cards. If the native path fails to start, the stream uses Chromium's picker.

**Installer 0.2.2 (04/11/2026):** app language (Settings › Appearance › Language: System, English or Português (Brasil); the default follows Windows) with everything in informal PT-BR, including the server guide and the Welcome tour. Texts in English in the code, passed through `t()` (`core/i18n.js`), with the translations in `src/locales/pt-BR.js`; a test checks that every `t('…')` has a translation. The guide has the **Copy** pill on each command. The installer asks for the language on start (English / Português) and uses `frontend/src-tauri/windows/PortugueseBR.nsh` for Tauri's texts.

**Settings lost during the installer test (04/11/2026):** the `%LOCALAPPDATA%\io.github.tyxmatty.jayc` folder (the WebView2 profile of the dev app and of the installed one) was recreated empty at 11:50, during the 0.2.1 test, and the user's settings were restored by hand. Repeating the sequence with a marker file (install 0.2.0 silently, 0.2.1 over it with the UI, uninstall silently), nothing was deleted: the cause wasn't found. Before testing installers, copy that folder.

**Installer 0.2.1 (04/11/2026):** 0.2.0 plus the entire screen stream without the mirror effect, H.264 High on the graphics card (with VP8 as a fallback), the chat limit and the guide with `npm run server`. The server is also at 0.2.1: the host has to restart it (new H.264 profile and chat limit). This is the version the friends should install. **Whoever already has an older version just runs the installer:** it updates in place, without the "Uninstall before installing" page (our own NSIS template, see CLAUDE.md). Measured: 0.2.0 installed → 0.2.1 installer with the UI: welcome, installing, finished; the registry went to 0.2.1 and the executable was replaced. The same version or a downgrade still ask.

**Installer 0.2.0 (04/11/2026):** brings the external test feedback (items 1–8) and the design review (A–E). For the next test, the friends install 0.2.0, the host restarts the server (the protocol changed: `pauseConsumer`, `chat`, `color`), and whoever can't hear sends the text from Settings › Help › Copy call diagnostics.

**Windows installer:** `npm run build` produces `<target>\release\bundle\nsis\Jay-C_<version>_x64-setup.exe`. It takes ~7–9 min, because of LTO.

**First external test:** on 03/11/2026, installer 0.1.0 was sent to the user's friends. The server is hosted by the user, and they connect through the user's IP (VPN or LAN), with ports 3000 and 40000 open. Without code signing, SmartScreen asks for "More info → Run anyway". Friends on Radmin VPN: the host is the user's Radmin IP (`26.x.x.x`).

**External test feedback (04/11/2026), in the agreed order:**
1. **Bug: whoever joins a room with people already in it doesn't hear the others, but is heard.** It happened to anyone who joined later. The person saw the others' video (the network gets through), and leaving and rejoining fixed it for them. **Not reproduced on this PC**, with the sound measured at the speakers (`output_meter`) in 5 scenarios: dev, release with a real click and a clean profile, first join after opening the app, a bot with a camera, and a bot leaving and coming back. It didn't reproduce through the Radmin IP either. For the next test, **Settings › Troubleshooting › Copy call diagnostics** was created: it measures for 2 s, for each person, packets/s, kbps and `playedEnergy`, plus the player's state. Whoever can't hear copies the text and sends it. Packets arriving with `playedEnergy` 0 = the sound arrives but doesn't play; no packets = network or server.
2. The stream stutters with the app in focus and is smooth on Alt+Tab. **Measured on this PC** (real entire screen, with the picker chosen through the `--auto-select-desktop-capture-source="Tela inteira"` flag):
   - **Mirror effect confirmed:** with Jay-C in focus, it filmed its own preview. The stream sent 450–600 kbps, against 180–200 with another window in focus. With the window out of the capture, it sent 20–25% less with Jay-C in focus, and the capture FPS stayed the same. ✅ Fixed: during an entire screen stream, Jay-C disappears from the capture (`setContentProtected`, `WDA_EXCLUDEFROMCAPTURE`). Side effect: during that time, screenshots and recordings (Win+Shift+S, OBS) don't show Jay-C's window either, and a notice says so when the stream starts.
   - **Encoder:** the stream used software VP8 (libvpx, 7–20 ms per frame at 720p). ✅ It now uses H.264 High, which WebView2 hands to the graphics card. Only when the WebView can send High (`RTCRtpSender.getCapabilities`) and the server has the profile; if `produce` fails anyway, the stream restarts with the default codec (VP8). Measured: with High hidden from the WebView, the stream came out in libvpx. Constrained baseline stayed on OpenH264 in software. Checked: a bot decodes through the server (720p, 35 fps). Total CPU **didn't drop** on this PC (~0.8 of a core in both cases), because the capture weighs more than the encoding; the difference should show on weaker CPUs, but that wasn't measured.
   - **Your own stream's preview**, when visible, cost ~0.1–0.4 of a core (a noisy measurement).
   - **Viewers:** no difference between the app in focus and out of it (43–55 fps, no freezes).
   - **Likely explanation of "smooth on Alt+Tab":** with the game full screen in front, Windows marks Jay-C as occluded, and the WebView stops drawing (preview, mirror), leaving more of the machine for the game and the encoding. **Needs the server restarted** (new H.264 profile) and a new test with the friends.
3. Windows shortcuts (the Windows key, Win+Shift+S) stop working during the stream. They say other streaming apps also cause this, except Discord. **Not reproduced on this PC:** with a real entire screen stream, the Windows key (synthetic, via `keybd_event`) opened Start and Win+Shift+S opened the snipping tool, with Jay-C in focus or not (3 rounds). The app doesn't use global shortcuts, keyboard hooks or `keyboard.lock`. Next step: ask the friends whether the game was in exclusive full screen and whether it happens without Jay-C (they said other apps cause the same).
4. ✅ Defaults: the camera starts off; other people's streams start muted and unfocused, and each person chooses to watch (like Discord). Done: the streamer's card shows **LIVE · Watch stream**. Until the click, the stream's screen and sound stay paused on the server (0 kbps, measured), with no presenting layout and out of the PiP. **Stop watching** pauses it again. A new stream starts unwatched.
5. Audio, in the right-click menu.
   - ✅ **5A:** volume per person and per stream (0–200%) and mute just for yourself, by right-clicking the card (or the Menu key with the card focused), plus a **Mute stream** button on the watched stream. Remote sound goes through WebAudio (`core/playback.js`), with one gain per voice and per stream; the `<video>` elements stay muted. Measured at the speakers: 100% = −13.5 dB, 200% = −7.5 dB, muted = silence. The levels only last for the call.
   - ✅ **5B:** Settings › Audio devices (also by right-clicking the microphone button):
     - **Microphone:** native list (WASAPI, `list_mics` in the plugin). A microphone that disappeared goes back to the Windows default.
     - **Microphone volume** (0–300%) and **"Only send when I speak"** (a gate with a dB threshold, 300 ms hold and a ramp), with a meter during the call. They live in `core/mic-shape.js`, applied live.
     - **Speakers:** `AudioContext.setSinkId` on the mixer. The names only show after a WebView2 microphone permission, granted without a prompt and remembered. The "Show speakers" button opens the WebView's mic for ~0.1 s, once.
     - **Measured in the app:** gate at −10 dB → nothing sent; live microphone switch (ME6S → Iriun → default); output on "Saída Digital" → the default speaker goes silent, and comes back to −13.5 dB.
     - **Not proven in the app:** the gain. The ambient noise varied too much, and only the unit test measures the effect (+6.02 dB at 2×).
     - **Windows only:** microphone, volume and sensitivity (the Android/macOS mic is still `getUserMedia`).
6. ✅ Focusing one stream among several, or your own: clicking a stream (or Enter with it keyboard-focused) makes it big, and the others go to a column beside it. Clicking again splits the space evenly. Your stream's preview, in the corner, goes to the stage with one click and back with another. Checked in the app with 2 bots streaming and your own stream: sizes and videos playing after each switch.
7. ✅ Call chat: a **Chat** button in the bar (with an unread counter) opens a side panel. New messages with the panel closed also show in a notice. The server only relays (`chat`, 1–500 characters, no control characters, at most 2 per second with a burst of 10 per person) and stores nothing: whoever joins later doesn't see the history. Checked in the app with a bot: the counter, the notice, a reply typed on the keyboard reaching the bot, HTML shown as text, Esc closing the panel. A rejected message (too many, or an old server without chat) shows a notice instead of looking sent.
8. ✅ Featured buttons: mic, camera and stream at 64 px (the others are 52), a "bounce" on hover and click on every bar button (off with the system's "reduce motion", which is on on this PC), and a green border (#16a34a) on the card of whoever is speaking, including yours (`core/speaking.js`: −50 dBFS, 400 ms hold; the level comes from the mixer's analyzers). Measured in the app: the border follows a tone that turns on and off every 1 s; hover goes to 1.11 and settles at 1.10, and a click to 0.90. Your own border wasn't seen lighting up, because nobody spoke into the microphone during the test.

**Design review (04/11/2026), inspired by Discord:**
- ✅ A. Profile color: Settings › General › Profile color (Auto from the name, Solid or Gradient, with a preview). It reaches the others in `join` and `profile`, and the server only accepts `#rrggbb` and an integer angle. Cards without a camera use the background color, with the avatar in a circle. Whoever didn't choose gets a stable gradient from their name (`core/profile-color.js`). Checked in the app with 2 bots, in the dark and light themes: each card with its color, and a change reached both live.
- ✅ B. Settings with side tabs: Profile, Appearance (theme, colors, call buttons), Audio, Streaming (only where sound capture exists), Server and Help (diagnostics). In a narrow window, the tabs become a row at the top. The tabs come from the `ui/tabs.js` helper (ARIA pattern: one Tab stop, arrows, Home/End), which the setup guide also uses. Right-clicking the mic opens the Audio tab directly. Checked in the app: keyboard, the mic shortcut, the guide, 480 px with no horizontal scroll, light and dark themes.
- ✅ C. Lobby with a profile card and recent rooms. At the top of the card, the profile as the others see you (a strip in your color, avatar and name), with the "Edit profile" button, which opens the Profile tab. Below the Room field, the last 5 rooms (`core/recent-rooms.js`): one click joins. The "room-full" message no longer says "4 people max" (the default is 16 and it's configurable). Checked in the app: joining through the room button, the room moving to the top of the list, 360 px, light and dark themes.
- ✅ D. Call header: "# room", "Just you" or "N people" and the copy button, in a pill with its own background (readable over any gradient, in both themes). The "Waiting for others" card no longer repeats the room name. Checked in the app: "Just you" → "2 people" with a bot, the copy showing the notice, the name cut with "…" and a tooltip at 360 px, light theme.
- ✅ E. Animations (only with the system's motion allowed, at the time): dialogs and popovers fade in and out (`@starting-style` + `allow-discrete`); the chat slides; notices rise; new cards "pop"; the Settings tab appears smoothly; switching the focused stream uses View Transitions. They use `translate`/`scale`/`opacity`, without touching positioning `transform`s. Measured in the app with animations allowed (dialog 0.05 → 1; chat 0.28 → 1; menu 0.43 → 1; new card with `tile-in`; focus with 15 view-transition animations) and with "reduce motion" (everything instant). **Settings › Appearance › Animations** was System / On / Off at the time; since 0.3.2 it's only On (default) and Off. `core/motion.js` resolves the choice and `ui/theme.js` sets `<html data-motion="full|reduced">`, which the CSS uses instead of the media query.

They suggested rewriting without the WebView ("our own engine, Discord style"). Recommendation given: no. Discord is also Chromium (Electron), and what it does differently is capture and encode in native code. If items 2 and 3 point at the WebView, the way out is a native video capture milestone (WGC/DXGI + hardware H.264).

**Native stream, spike (05/11/2026):** see [spikes/10-live-nativa.md](spikes/10-live-nativa.md) (in Portuguese).
- **What it is:** capture (Windows Graphics Capture) and hardware H.264 (Media Foundation) in Rust, sent over WebRTC (str0m) to the same `WebRtcTransport` and the same port 40000 as the app. The server doesn't change.
- **Measured:**
  - CPU: the old stream used ~1.3 of a core on video alone, and the native one ~0.05.
  - Viewers receive 1080p with no loss.
  - On a simulated narrow network, resolution and frame rate step down (1080p60 → 720p30 → 540p30 → 360p15) within seconds, with 0–53 packets lost (it used to be ~500), and come back by themselves.
  - What viewers see during the drop wasn't measured reliably: a viewer on the same PC disturbs the capture. A two-PC test is missing.
- ✅ **In the app:**
  - With "Entire screen" on a single monitor, the stream was native: no picker and no preview ("Live · no preview"). If it fails, it falls back to the old path.
  - Measured: the app's process tree uses 0.68–0.72 of a core while streaming, against 1.88 for the old stream.
  - Viewers receive 1080p with sound and no loss. The frame rate in the app wasn't measured reliably (the user was using the PC).
- ✅ **Our own picker** (Windows):
  - "Choose and share…" opens the list of screens and windows with thumbnails, and the stream goes out natively from whatever is chosen, on any monitor or window.
  - With a window, the stream follows resizing and ends if the window closes.
  - Measured: with a window that really changes, 56–59 frames/s on the sending side.
  - **Correction:** the earlier frame rates were measured with the animation window hidden (see spike 10).

**Fixes after the code review (05/11/2026):**
- **Native stream:**
  - Sends a picture even on a still screen (the last frame every 1 s, and right away for whoever starts watching).
  - Survives network drops of up to 20 s and restarts by itself when the server comes back.
  - Closes its own transport on the server when it stops (`closeTransport`: **restart the server** to get it; an old server still works).
  - Really stops if you leave the call while it's starting.
- **Joining a room:** if the call screen fails to open, the call is ended, instead of staying connected behind the lobby's error.
- **A mic that disconnects and comes back:** the app checks the mics every 3 s and reopens on its own, without touching a setting.
  - If the chosen one is gone, it uses the Windows default and switches back to the chosen one when it reappears.
  - Measured with the real ME6S: it dropped (`0x88890004`), the app moved to the new default (Voicemeeter) with the "Microphone back" notice, and went back to the ME6S 1 s after it reappeared.
  - **Note:** Windows renamed the ME6S when it reconnected ("8- ME6S" → "3- ME6S"). If the mic was chosen in Settings and its id changes on another USB port, the app stays on the default until it's chosen again.

**No browser look (05/11/2026):** in release, right-clicking outside text fields no longer opens WebView2's menu (Back, Reload, Print, Inspect), and the browser shortcuts are off (`SetAreBrowserAcceleratorKeysEnabled(false)`, in `src-tauri/src/app_chrome.rs`): F5/Ctrl+R don't reload the page (which dropped the call), and Ctrl+P/Ctrl+F don't open print or find. Text fields keep the copy/paste menu. Dev keeps everything, for debugging.

**Android in dev** (emulator or a phone with USB debugging):
- **Windows Developer Mode on:** Tauri creates symlinks to the `.so` in `jniLibs`.
- `scripts\android-dev.ps1` reloads PATH, `JAVA_HOME`, `ANDROID_HOME` and `NDK_HOME` and runs `tauri android dev`. The app loads Vite through the PC's IP on port 5173.
- **Server on the emulator:** use `10.0.2.2:3000`, which is the PC as seen from inside the emulator. On a phone, use the PC's IP on the network.
- **Permissions:** the app asks for camera and microphone on the first call. In automated tests, grant them beforehand with `adb shell pm grant io.github.tyxmatty.jayc.debug android.permission.CAMERA` (and `RECORD_AUDIO`).
- **SDK without Android Studio** (done on the current PC, without UAC): Microsoft's JDK 21 (zip) in `%LOCALAPPDATA%\Programs\MicrosoftJDK`, command-line tools in `%LOCALAPPDATA%\Android\Sdk\cmdline-tools\latest`, and `JAVA_HOME`/`ANDROID_HOME`/`NDK_HOME` in the user variables. The new `sdkmanager` is a shortcut of the "Android CLI": from Bash, the packages go with a slash (`platforms/android-37.0`, `ndk/30.0.16248370`), because `;` breaks in the `.bat`. Installed: platform-tools, emulator, platforms 37.0, build-tools 37.0.0, NDK 30.0.16248370 and the `android-36/google_apis/x86_64` image.
- **Emulator on this PC:** doesn't run. Virtualization is off in the BIOS/UEFI (`VirtualizationFirmwareEnabled = False`) and the Windows Hypervisor Platform is missing.
- **Without Developer Mode**, `tauri android build` compiles the Rust and stops at the `.so` symlink. To check only a plugin's Kotlin: `gradlew :tauri-plugin-pip:compileDebugKotlin` in `frontend/src-tauri/gen/android`.

**Not verified yet:**
- The installer on another PC, the real screen picker in the installed app and friends connecting over the internet/VPN (waiting for the external test feedback).
- Android on a real phone, and PiP on Android 8–11 (entry through the user-leave hint).
- **Stream full screen on Android** (hidden bars, landscape, back exits): the Kotlin compiles and the page part was tested by simulating Android on the PC, but it didn't run on a device.
- A 16-person room with real media (tested with 6 tabs, and with 16 only at the protocol level).
- VPN IP (ZeroTier/Radmin).
- Sound in window mode with the real picker (the path was validated in parts).
- Mic, camera and hang-up buttons in the PiP window: the Media Session actions were accepted, but the buttons only show with the mouse over them and weren't clicked.
- Exclusions with the real Discord and someone listening on the other end. They were measured with tones and with the track sent to WebRTC, using a fake canvas instead of the picker.
- Echo cancellation with real speakers, because the test laptop's microphone doesn't pick up its own speakers.
- Customization:
  - dragging the bar by touch (Android only);
  - the side bar with 2+ people in the call;
  - a profile picture with a real photo from disk (tested with generated images);
  - the picture's JPEG fallback on WebKit (macOS/iOS).
- The guide link in the lobby, which only shows without a configured server.
- A possible glitch in the entire screen sound (single stream): two measurements gave 46–47.5 thousand frames/s instead of 48 thousand, and it didn't happen again. See ARQUITETURA, "CPU".

**Open decisions:**
- The image name on GHCR (`ghcr.io/tyxmatty/jay-c-signaling`).
- The Docker image size (379 MB).
- The frontend bundle (~58 KB gzip, mostly mediasoup-client).
- The guide (Hosting tab) offers two ways. **Option A, Node.js** (`npm install -w signaling-server` + `npm run server`), works today: in a clean clone, the install took 11 s and downloaded the prebuilt `mediasoup-worker.exe`. It asks for the GitHub ZIP in a short folder, because the repository's longest path has 152 characters and a clone in a deep folder failed with "Filename too long". The ZIP only downloads with the repository **public** (it's private today). **Option B, Docker**, relies on the `docker-compose.yml` on the releases page and the image on GHCR, which only exist in milestone 14.
