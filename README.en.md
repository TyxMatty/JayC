# Jay-C

[Português](README.md) · **English**

A lightweight, open-source app for calls and screen sharing on desktop and mobile, with a self-hosted signaling server that runs in Docker.

## Download

The Windows installer is in the **[releases](https://github.com/TyxMatty/JayC/releases/latest)**: download `Jay-C_<version>_x64-setup.exe` from the latest one. It updates an earlier version in place and keeps your settings. Every version is listed under [releases](https://github.com/TyxMatty/JayC/releases).

## Code

| Folder | Contents |
|---|---|
| [`signaling-server/`](signaling-server/) | Signaling server (Node.js + `ws`) and media SFU (mediasoup), with Docker files |
| [`frontend/`](frontend/) | Tauri v2 + vanilla JS app (Vite) |
| [`plugins/tauri-plugin-system-audio/`](plugins/tauri-plugin-system-audio/) | Per-process audio capture for streams (Windows) |
| `plugins/tauri-plugin-pip/` | Picture-in-picture plugin for Android/iOS *(work in progress)* |
| [`docs/ARQUITETURA.md`](docs/ARQUITETURA.md) | Architecture, technical decisions and milestones (in Portuguese) |
| [`docs/CONTINUAR.md`](docs/CONTINUAR.md) | Setting up a new PC, current state and next steps (in Portuguese) |
| [`scripts/`](scripts/) | Development tools: the app with debugging on, running JS in the real app, a test tone |

## Running the app

```bash
npm install
npm run dev
```

This opens the Jay-C window (Tauri) with hot reload. To open only the interface in a browser, without Tauri, use `npm run web`. The first Rust build takes a few minutes.

On Windows the build also needs **Python with Meson and Ninja** (`py -m pip install --user meson ninja`, with Python's Scripts folder on the PATH). They build WebRTC's audio processing, used by the microphone. The first build downloads abseil-cpp and takes a few minutes more.

## Running the server locally

```bash
npm install
npm run server
```

The server uses port **3000/tcp** for signaling (`ws://`) and **40000** (UDP and TCP) for media. Open both in the firewall. The health check is at `http://localhost:3000/health`.

## Running the server with Docker

Inside the repository, this builds the image from source:

```bash
docker compose -f signaling-server/docker-compose.yml up -d --build
```

End users only need `docker-compose.yml` in an empty folder and `docker compose up -d`. The image is pulled from the registry, which will be published in the release milestone.

## Tests

```bash
npm test
```
