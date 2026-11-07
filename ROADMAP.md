# Jay-C roadmap

Jay-C is a lightweight, open-source app for calls and screen sharing on desktop and mobile, with a self-hosted server that runs in Docker.

Every milestone ends with something testable. The full plan, with the "done when" checks, is in [`docs/ARQUITETURA.en.md`](docs/ARQUITETURA.en.md), section 10. The current state and the feedback from testers are in [`docs/CONTINUAR.en.md`](docs/CONTINUAR.en.md), section 5.

## Done

- [x] **Server:** signaling (Node.js + `ws`) and a mediasoup SFU in Docker, rooms of up to 16 people, a single media port.
- [x] **Calls:** camera with 3-layer simulcast, solo, 1:1 and grid layouts, chat and reconnection.
- [x] **Screen and window streaming:** up to 1080p60 with live quality controls and H.264 on the graphics card.
- [x] **Stream sound (Windows):** native per-process audio capture in a Rust plugin, in stereo, with apps excluded from the capture.
- [x] **Native microphone (Windows):** WASAPI + WebRTC AudioProcessing, so other apps aren't muffled.
- [x] **Picture-in-picture** on desktop and Android.
- [x] **Android:** debug APK that joins calls and goes into PiP.
- [x] **Windows installer** (NSIS, per user, no admin rights), released on GitHub.
- [x] **CI:** JS tests on Ubuntu, Rust on Windows, the server's Docker image, and the installer built on version tags.
- [x] **Look and feel:** three styles (Calm, Neon, Soft) in light and dark, custom colors, a movable call bar, the welcome tour and the wolf icon.
- [x] **Audio controls:** volume per person and per stream, device selection, microphone volume and "only send when I speak".
- [x] **Discord Rich Presence.**
- [x] **Jay-A integration, client side (I1 to I4):** the named-pipe client, the filter selector, Jay-C's own filter kept running as a hot standby, and starting Jay-A when a call begins.

## Next

- [ ] **Tester feedback:** a late joiner sometimes doesn't hear the people already in the room; the stream stutters with the app in focus; Windows shortcuts during a stream. Details and measurements in `docs/CONTINUAR.en.md`.
- [ ] **Signed release APK** for ARM 64 and 32-bit (14.B).
- [ ] **Release pipeline:** add the APK and the server image on GHCR to the tag workflow, and draft the GitHub Release with `docker-compose.yml` (14.C).
- [ ] **Publishing**, and testing the setup guide from scratch on a clean machine (14.E).
- [ ] **Jay-A integration with the real app:** latency and jitter measured, closing Jay-A mid-call doesn't cut the voice (I5); the soundboard button in the call bar (I6); a release that works with and without Jay-A installed (I7).
- [ ] **iOS:** Swift PiP plugin, after launch (milestone 15).
- [ ] **Plugins:** after the release, and only isolated from the app's audio, screen and microphone access.
