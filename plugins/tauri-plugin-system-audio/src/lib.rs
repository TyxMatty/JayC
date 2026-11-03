//! Per-process audio capture for screen sharing.
//!
//! Windows: WASAPI process loopback (Windows 10 2004+), see docs/spikes/06-transmissoes.md.
//! Other platforms: `is_supported` returns false and capture commands fail with "unsupported".
//!
//! Audio reaches the webview as raw bytes over a `tauri::ipc::Channel`: interleaved stereo
//! f32 little-endian at 48 kHz, in 20 ms chunks (960 frames = 7680 bytes). Errors after start
//! arrive on the same channel as JSON `{ "error": "..." }`.

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{
    Manager, Runtime, State,
    ipc::{Channel, InvokeResponseBody},
    plugin::{Builder, TauriPlugin},
};

#[cfg(windows)]
mod win;

pub const SAMPLE_RATE: u32 = 48_000;
pub const CHANNELS: u16 = 2;
/// 20 ms, matching Opus frames.
pub const CHUNK_FRAMES: usize = 960;

/// What to capture.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureTarget {
    /// Capture only these process trees (mixed together). Use root/main process ids.
    #[serde(default)]
    pub include: Vec<u32>,
    /// Capture everything except this app's own sound (i.e. not the call's voices), which on
    /// Windows means excluding the app's WebView2 browser process tree. Takes precedence over `include`.
    #[serde(default)]
    pub exclude_self: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureInfo {
    pub sample_rate: u32,
    pub channels: u16,
    pub chunk_frames: usize,
    /// Number of WASAPI streams being mixed.
    pub streams: usize,
}

/// A process that owns an audio session (grouped under its root process of the same executable).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioApp {
    pub pid: u32,
    pub exe: String,
    pub display_name: String,
    /// At least one of its sessions is playing right now.
    pub active: bool,
}

/// The process behind a window, e.g. one picked in getDisplayMedia ("window:<HWND>:0").
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowProcess {
    pub pid: u32,
    /// Topmost ancestor with the same executable: the tree to capture.
    pub root_pid: u32,
    pub exe: String,
    pub title: String,
}

/// The running capture, if any; dropping it stops the capture threads.
#[cfg(windows)]
type RunningCapture = win::Capture;
#[cfg(not(windows))]
type RunningCapture = ();

#[derive(Default)]
struct CaptureState(Mutex<Option<RunningCapture>>);

#[tauri::command]
fn is_supported() -> bool {
    cfg!(windows)
}

#[tauri::command]
async fn list_audio_apps() -> Result<Vec<AudioApp>, String> {
    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(win::list_audio_apps)
            .await
            .map_err(|e| e.to_string())?
    }
    #[cfg(not(windows))]
    Err("unsupported".into())
}

#[tauri::command]
fn window_process(hwnd: i64) -> Result<WindowProcess, String> {
    #[cfg(windows)]
    {
        win::window_process(hwnd)
    }
    #[cfg(not(windows))]
    {
        let _ = hwnd;
        Err("unsupported".into())
    }
}

#[tauri::command]
fn start_capture(
    state: State<'_, CaptureState>,
    target: CaptureTarget,
    on_audio: Channel<InvokeResponseBody>,
) -> Result<CaptureInfo, String> {
    let mut current = state.0.lock().map_err(|e| e.to_string())?;
    current.take(); // only one capture at a time: stop the previous one first

    #[cfg(windows)]
    {
        let errors = on_audio.clone();
        let (capture, info) = win::Capture::start(
            target,
            move |samples: &[f32]| {
                let mut bytes = Vec::with_capacity(samples.len() * 4);
                for s in samples {
                    bytes.extend_from_slice(&s.to_le_bytes());
                }
                let _ = on_audio.send(InvokeResponseBody::Raw(bytes));
            },
            move |error: String| {
                log::warn!("system-audio capture error: {error}");
                let json = serde_json::json!({ "error": error }).to_string();
                let _ = errors.send(InvokeResponseBody::Json(json));
            },
        )?;
        *current = Some(capture);
        Ok(info)
    }
    #[cfg(not(windows))]
    {
        let _ = (target, on_audio);
        Err("unsupported".into())
    }
}

#[tauri::command]
fn stop_capture(state: State<'_, CaptureState>) -> Result<(), String> {
    state.0.lock().map_err(|e| e.to_string())?.take();
    Ok(())
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("system-audio")
        .invoke_handler(tauri::generate_handler![
            is_supported,
            list_audio_apps,
            window_process,
            start_capture,
            stop_capture
        ])
        .setup(|app, _api| {
            app.manage(CaptureState::default());
            Ok(())
        })
        .build()
}
