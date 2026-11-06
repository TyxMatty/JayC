//! Native audio capture for Jay-C (Windows):
//! - screen-share sound: per-process WASAPI loopback (Windows 10 2004+), see docs/spikes/06-transmissoes.md;
//! - the call microphone: plain WASAPI capture cleaned by WebRTC's audio processing (echo
//!   cancellation against what the app plays, noise suppression, gain). WebView2's own microphone
//!   triggers OEM "call mode" speaker processing that muffles other apps, see docs/spikes/09-som-abafado.md.
//!
//! Other platforms: `is_supported` returns false and capture commands fail with "unsupported".
//!
//! Audio reaches the webview as raw bytes over a `tauri::ipc::Channel`: interleaved f32
//! little-endian at 48 kHz (stereo for screen sound, mono for the mic), in 20 ms chunks
//! (960 frames). Errors after start arrive on the same channel as JSON `{ "error": "..." }`.

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, Manager, Runtime, State,
    ipc::{Channel, InvokeResponseBody},
    plugin::{Builder, TauriPlugin},
};

#[cfg(windows)]
mod apm;
#[cfg(windows)]
mod jay_a;
#[cfg(windows)]
pub mod link;
#[cfg(windows)]
mod selector;
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
    /// With `exclude_self`: also leave out apps running these executables (e.g. "Discord.exe",
    /// case-insensitive, ".exe" optional), themselves or as an ancestor process. Then each other
    /// app playing sound is captured as its own stream and mixed.
    #[serde(default)]
    pub exclude_exes: Vec<String>,
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

/// Options for the native call microphone.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MicOptions {
    /// Cancel the app's own playback from the mic (needed on speakers; can be off with headphones).
    #[serde(default = "default_true")]
    pub echo_cancellation: bool,
    /// Remove steady background noise (fans, hum). Off is better for music.
    #[serde(default = "default_true")]
    pub noise_suppression: bool,
    /// Level the voice automatically.
    #[serde(default = "default_true")]
    pub auto_gain_control: bool,
    /// Capture endpoint id from `list_mics`; none (or one no longer present) = the Windows default.
    #[serde(default)]
    pub device: Option<String>,
    /// Whose processing the call hears (docs/JAY-A.md).
    #[serde(default)]
    pub filter: MicFilter,
    /// Jay-A mode: the person's Jay-C mic settings, sent in HELLO as `import` (Jay-A adopts them
    /// the first time it connects).
    #[serde(default)]
    pub jay_a_import: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MicFilter {
    /// Jay-C's own: WebRTC's audio processing on the native capture.
    #[default]
    JayC,
    /// Jay-A's audio over the Jay Link while it flows, Jay-C's own (still running) otherwise.
    /// States arrive on the audio channel as JSON `{ "link": ... }` (see jay_a.rs).
    JayA,
}

/// A microphone the user can pick.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MicDevice {
    pub id: String,
    pub name: String,
    pub is_default: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MicInfo {
    pub sample_rate: u32,
    pub channels: u16,
    pub chunk_frames: usize,
    pub device: String,
    /// Whether the echo reference (the app's own playback) is being captured.
    pub echo_reference: bool,
}

#[cfg(windows)]
type RunningMic = win::Mic;
#[cfg(not(windows))]
type RunningMic = ();

#[derive(Default)]
struct MicState(Mutex<Option<RunningMic>>);

/// Sends interleaved f32 samples to the webview as little-endian bytes.
#[cfg(windows)]
fn send_samples(channel: &Channel<InvokeResponseBody>, samples: &[f32]) {
    let mut bytes = Vec::with_capacity(samples.len() * 4);
    for s in samples {
        bytes.extend_from_slice(&s.to_le_bytes());
    }
    let _ = channel.send(InvokeResponseBody::Raw(bytes));
}

#[cfg(windows)]
fn send_json(channel: &Channel<InvokeResponseBody>, value: serde_json::Value) {
    let _ = channel.send(InvokeResponseBody::Json(value.to_string()));
}

#[cfg(windows)]
fn send_error(channel: &Channel<InvokeResponseBody>, error: String) {
    log::warn!("system-audio: {error}");
    let _ = channel.send(InvokeResponseBody::Json(serde_json::json!({ "error": error }).to_string()));
}

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
async fn list_mics() -> Result<Vec<MicDevice>, String> {
    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(win::list_mics)
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
            move |samples: &[f32]| send_samples(&on_audio, samples),
            move |error: String| send_error(&errors, error),
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
fn start_mic<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, MicState>,
    options: MicOptions,
    on_audio: Channel<InvokeResponseBody>,
) -> Result<MicInfo, String> {
    let mut current = state.0.lock().map_err(|e| e.to_string())?;
    #[allow(unused_mut)]
    let mut previous = current.take();

    #[cfg(windows)]
    {
        // In Jay-A mode, a reopened microphone keeps the previous one's link (no reconnection, and
        // no second of reserve while it would flow again).
        let jay_a = (options.filter == MicFilter::JayA).then(|| match previous.as_mut().and_then(win::Mic::take_jay_a) {
            Some(link) => win::JayAStart::Keep(link),
            None => {
                let mut hello = serde_json::json!({ "app": "jay-c", "version": app.package_info().version.to_string(), "protocol": link::PROTOCOL });
                if let Some(import) = &options.jay_a_import {
                    hello["import"] = import.clone();
                }
                win::JayAStart::New(hello)
            }
        });
        drop(previous); // stops the old capture before the new one opens the microphone
        let (errors, states) = (on_audio.clone(), on_audio.clone());
        let (mic, info) = win::Mic::start(
            options,
            jay_a,
            move |samples: &[f32]| send_samples(&on_audio, samples),
            move |error: String| send_error(&errors, error),
            move |status| send_json(&states, status),
        )?;
        *current = Some(mic);
        Ok(info)
    }
    #[cfg(not(windows))]
    {
        let _ = (app, options, on_audio, previous);
        Err("unsupported".into())
    }
}

/// Whether Jay-A is installed for this user (`%LOCALAPPDATA%\Jay-A\jay-a.exe`).
#[tauri::command]
fn jay_a_installed() -> bool {
    #[cfg(windows)]
    {
        jay_a::installed_exe().is_some()
    }
    #[cfg(not(windows))]
    false
}

/// Opens Jay-A's releases page in the browser (a fixed address: the page can't choose another).
#[tauri::command]
fn jay_a_open_releases() -> Result<(), String> {
    #[cfg(windows)]
    {
        std::process::Command::new("explorer.exe").arg(jay_a::RELEASES).spawn().map(|_| ()).map_err(|e| e.to_string())
    }
    #[cfg(not(windows))]
    Err("unsupported".into())
}

/// Jay-A mode: asks Jay-A to show its window (Settings › Audio › "Open Jay-A").
#[tauri::command]
fn jay_a_show(state: State<'_, MicState>) -> Result<(), String> {
    #[cfg(windows)]
    if let Some(mic) = &*state.0.lock().map_err(|e| e.to_string())? {
        mic.show_jay_a();
    }
    #[cfg(not(windows))]
    let _ = state;
    Ok(())
}

/// Jay-A mode: tells Jay-A whether we're in a call and muted (shown in its window).
#[tauri::command]
fn mic_call_state(state: State<'_, MicState>, in_call: bool, muted: bool) -> Result<(), String> {
    #[cfg(windows)]
    if let Some(mic) = &*state.0.lock().map_err(|e| e.to_string())? {
        mic.call_state(in_call, muted);
    }
    #[cfg(not(windows))]
    let _ = (state, in_call, muted);
    Ok(())
}

#[tauri::command]
fn stop_mic(state: State<'_, MicState>) -> Result<(), String> {
    state.0.lock().map_err(|e| e.to_string())?.take();
    Ok(())
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
            list_mics,
            window_process,
            start_capture,
            stop_capture,
            start_mic,
            stop_mic,
            mic_call_state,
            jay_a_show,
            jay_a_installed,
            jay_a_open_releases
        ])
        .setup(|app, _api| {
            app.manage(CaptureState::default());
            app.manage(MicState::default());
            Ok(())
        })
        .build()
}
