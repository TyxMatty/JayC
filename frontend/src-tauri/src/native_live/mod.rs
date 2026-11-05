//! Native screen share (Windows): a monitor or window captured with Windows Graphics Capture,
//! encoded to H.264 on the GPU (encoder.rs) and sent over WebRTC (str0m, webrtc.rs) to the call's
//! SFU, on the same media port as the app. Resolution and frame rate follow the bandwidth
//! (ladder.rs). The page does the signaling (core/native-live.js). Measurements and limits:
//! docs/spikes/10-live-nativa.md.

// Almost every line here is a COM/D3D/Media Foundation call: `unsafe fn` bodies stay one unsafe block.
#![allow(unsafe_op_in_unsafe_fn)]

mod encoder;
mod ladder;
mod sources;
mod webrtc;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use windows::core::Interface;
use windows::Graphics::Capture::Direct3D11CaptureFramePool;
use windows::Graphics::DirectX::Direct3D11::IDirect3DDevice;
use windows::Graphics::DirectX::DirectXPixelFormat;
use windows::Win32::Foundation::HMODULE;
use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_HARDWARE;
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::IDXGIDevice;
use windows::Win32::Media::MediaFoundation::{MFShutdown, MFStartup, MFSTARTUP_FULL, MF_VERSION};
use windows::Win32::System::WinRT::Direct3D11::{CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess};
use windows::Win32::System::WinRT::{RoInitialize, RO_INIT_MULTITHREADED};

use encoder::Encoder;
use ladder::{loss_limit, Ladder, TIERS};
use sources::{Kind, SourceId};

/// The encoder spends this share of the bandwidth estimate (the rest: RTX, RTCP, headroom).
const BUDGET_SHARE: f64 = 0.85;
/// Forced keyframes at most this often: under congestion every PLI's keyframe makes it worse.
const KEYFRAME_GAP: Duration = Duration::from_secs(1);
const START_KBPS: u32 = 1500;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// The capture only delivers frames when the picture changes: on a still screen the last frame is
/// sent again this often, so a viewer who starts watching gets a picture (and its keyframe).
const REFRESH_EVERY: Duration = Duration::from_secs(1);
/// ICE "disconnected" can come back by itself (a VPN hiccup); only this long without the server
/// ends the live. Meanwhile a signaling reconnect may restart it on a new transport.
const DISCONNECT_GRACE: Duration = Duration::from_secs(20);
/// Capture buffers: one stays held as the frame to resend while the screen is still.
const POOL_BUFFERS: i32 = 3;

/// The quality picked in Settings › Streaming: the top of the ladder.
#[derive(Deserialize, Clone, Copy, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Quality {
    /// None = the monitor's own height.
    pub max_height: Option<u32>,
    pub max_fps: u32,
    pub max_kbps: u32,
}

/// The server's `createTransport` answer, trimmed to what the sender needs.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteArgs {
    ufrag: String,
    pwd: String,
    ip: String,
    port: u16,
    /// "sha-256 AB:CD:..."
    fingerprint: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalParams {
    fingerprint: String,
    ssrc: u32,
    rtx_ssrc: u32,
}

#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum LiveEvent {
    Connected,
    Step { width: u32, height: u32, fps: u32 },
    /// Every 2 s: what the capture delivered and what went out (call.screenStats()).
    Stats { captured_fps: f64, encoded_fps: f64, kbps: u32, estimate_kbps: u32, width: u32, height: u32, fps: u32 },
    /// The share ended on its own (`error`), or after `native_live_stop` (no error).
    Ended { error: Option<String> },
}

struct Running {
    stop: Arc<AtomicBool>,
    quality: Arc<Mutex<Quality>>,
    thread: JoinHandle<()>,
}

static RUNNING: Mutex<Option<Running>> = Mutex::new(None);

fn stop_running() {
    let running = RUNNING.lock().unwrap().take();
    if let Some(r) = running {
        r.stop.store(true, Ordering::Relaxed);
        let _ = r.thread.join();
    }
}

/// Stops the live whose stop flag is `stop`, if it's still the registered one.
fn stop_if_current(stop: &Arc<AtomicBool>) {
    let mut running = RUNNING.lock().unwrap();
    if running.as_ref().is_some_and(|r| Arc::ptr_eq(&r.stop, stop)) {
        let r = running.take().unwrap();
        drop(running);
        r.stop.store(true, Ordering::Relaxed);
        let _ = r.thread.join();
    }
}

/// Starts capturing and connecting; resolves once capture and encoder work (so the page can fall
/// back to getDisplayMedia otherwise), with what goes into `connectTransport` and `produce`.
#[tauri::command]
pub async fn native_live_start(source: SourceId, remote: RemoteArgs, quality: Quality, on_event: Channel<LiveEvent>) -> Result<LocalParams, String> {
    stop_running();
    let stop = Arc::new(AtomicBool::new(false));
    let shared = Arc::new(Mutex::new(quality));
    let (ready_tx, ready_rx) = mpsc::channel();
    let thread = std::thread::Builder::new()
        .name("native-live".into())
        .spawn({
            let (stop, shared) = (stop.clone(), shared.clone());
            move || {
                let result = unsafe { run(source, remote, shared, stop, &ready_tx, &on_event) };
                if let Err(error) = &result {
                    log::warn!("native live: {error}");
                    let _ = ready_tx.send(Err(error.clone())); // ignored if already started
                }
                let _ = on_event.send(LiveEvent::Ended { error: result.err() });
            }
        })
        .map_err(|e| e.to_string())?;
    // Registered before it's ready, so a stop (or another start) during startup reaches it.
    *RUNNING.lock().unwrap() = Some(Running { stop: stop.clone(), quality: shared, thread });
    let ready = ready_rx.recv_timeout(Duration::from_secs(10)).map_err(|_| "the native capture did not start".to_string());
    match ready {
        Ok(Ok(_)) if stop.load(Ordering::Relaxed) => Err("the share was stopped".into()),
        Ok(Ok(local)) => Ok(local),
        Ok(Err(error)) | Err(error) => {
            stop_if_current(&stop);
            Err(error)
        }
    }
}

#[tauri::command]
pub async fn native_live_stop() {
    stop_running();
}

/// Monitors and windows for the picker (no thumbnails: those come one by one, see below).
#[tauri::command]
pub async fn native_live_sources() -> Result<Vec<sources::Source>, String> {
    tauri::async_runtime::spawn_blocking(sources::list).await.map_err(|e| e.to_string())
}

/// One source's thumbnail, as JPEG bytes (an ArrayBuffer on the page).
#[tauri::command]
pub async fn native_live_thumbnail(source: SourceId) -> Result<tauri::ipc::Response, String> {
    tauri::async_runtime::spawn_blocking(move || unsafe {
        RoInitialize(RO_INIT_MULTITHREADED).map_err(err("WinRT"))?;
        sources::thumbnail(source, 384)
    })
    .await
    .map_err(|e| e.to_string())?
    .map(tauri::ipc::Response::new)
}

/// Settings changed during the share: the new top of the ladder applies right away.
#[tauri::command]
pub fn native_live_set_quality(quality: Quality) {
    if let Some(r) = RUNNING.lock().unwrap().as_ref() {
        *r.quality.lock().unwrap() = quality;
    }
}

/// Output size for a height: same aspect as the capture, never above it, even.
fn step_size(capture: (u32, u32), height: u32) -> (u32, u32) {
    let h = height.min(capture.1);
    let w = (capture.0 as u64 * h as u64 / capture.1 as u64) as u32;
    (w & !1, h & !1)
}

/// Size, fps and bitrate cap of a ladder step under the picked quality (the top step is the pick).
fn step(tier: usize, q: &Quality, capture: (u32, u32)) -> (u32, u32, u32, u32) {
    let top = q.max_height.unwrap_or(capture.1);
    let height = if tier == 0 { top } else { TIERS[tier].height.min(top) };
    let fps = if tier == 0 { q.max_fps } else { TIERS[tier].fps.min(q.max_fps) };
    let (w, h) = step_size(capture, height);
    (w, h, fps.max(1), TIERS[tier].max_kbps.min(q.max_kbps))
}

/// Error text for a failed Windows call, naming the part that failed.
fn err(what: &'static str) -> impl Fn(windows::core::Error) -> String {
    move |e| format!("{what}: {e}")
}

/// A hardware D3D11 device usable from several threads, and its WinRT twin for the capture.
unsafe fn create_device() -> Result<(ID3D11Device, IDirect3DDevice), String> {
    let mut device = None;
    D3D11CreateDevice(
        None,
        D3D_DRIVER_TYPE_HARDWARE,
        HMODULE::default(),
        D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_VIDEO_SUPPORT,
        None,
        D3D11_SDK_VERSION,
        Some(&mut device),
        None,
        None,
    )
    .map_err(err("Direct3D"))?;
    let device: ID3D11Device = device.unwrap();
    let _ = device.cast::<ID3D11Multithread>().map_err(err("Direct3D"))?.SetMultithreadProtected(true);
    let winrt: IDirect3DDevice = CreateDirect3D11DeviceFromDXGIDevice(&device.cast::<IDXGIDevice>().map_err(err("Direct3D"))?)
        .and_then(|d| d.cast())
        .map_err(err("Direct3D"))?;
    Ok((device, winrt))
}

unsafe fn run(
    source: SourceId,
    remote: RemoteArgs,
    shared: Arc<Mutex<Quality>>,
    stop: Arc<AtomicBool>,
    ready: &mpsc::Sender<Result<LocalParams, String>>,
    events: &Channel<LiveEvent>,
) -> Result<(), String> {
    RoInitialize(RO_INIT_MULTITHREADED).map_err(err("WinRT"))?;
    MFStartup(MF_VERSION, MFSTARTUP_FULL).map_err(err("Media Foundation"))?;
    let result = (|| {
        let (device, winrt_device) = create_device()?;
        let item = sources::capture_item(source)?;
        let mut size = item.Size().map_err(err("capture"))?;
        let mut capture = (size.Width as u32, size.Height as u32);
        let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(&winrt_device, DirectXPixelFormat::B8G8R8A8UIntNormalized, POOL_BUFFERS, size)
            .map_err(err("capture"))?;
        let session = pool.CreateCaptureSession(&item).map_err(err("capture"))?;
        let _ = session.SetIsBorderRequired(false); // no yellow frame, where Windows allows it

        let mut quality = *shared.lock().unwrap();
        let mut budget = (START_KBPS as f64 * BUDGET_SHARE) as u32;
        let mut ladder = Ladder::new(budget);
        let make = |tier: usize, q: &Quality, budget: u32, capture: (u32, u32)| {
            let (w, h, fps, cap) = step(tier, q, capture);
            log::info!("native live: encoder {}x{} -> {w}x{h}@{fps}, {} kbps", capture.0, capture.1, budget.min(cap));
            let enc = Encoder::new(&device, capture, w, h, fps, budget.min(cap)).map_err(err("H.264 encoder"))?;
            let _ = events.send(LiveEvent::Step { width: w, height: h, fps });
            Ok::<_, String>(enc)
        };
        let mut enc = make(ladder.tier, &quality, budget, capture)?;
        log::info!("native live: {} {}x{} -> {}x{}@{}", enc.name, capture.0, capture.1, enc.width, enc.height, enc.fps);

        let addr = format!("{}:{}", remote.ip, remote.port).parse().map_err(|e| format!("server address: {e}"))?;
        let remote = webrtc::Remote { ufrag: remote.ufrag, pwd: remote.pwd, addr, fingerprint: remote.fingerprint };
        let (mut net, local) = webrtc::Sender::new(&remote, START_KBPS as u64, quality.max_kbps as u64).map_err(|e| format!("WebRTC: {e}"))?;
        let _ = ready.send(Ok(LocalParams { fingerprint: local.fingerprint, ssrc: local.ssrc, rtx_ssrc: local.rtx_ssrc }));

        session.StartCapture().map_err(err("capture"))?;
        let start = Instant::now();
        let mut next_due = start;
        let mut latest = None;
        // The last frame encoded, kept to resend while the screen is still.
        let mut last_frame: Option<windows::Graphics::Capture::Direct3D11CaptureFrame> = None;
        let mut last_encode = start;
        // Encode `last_frame` on the next chance (a forced keyframe or a new encoder needs a frame).
        let mut refresh_now = false;
        let mut keyframe_pending = false;
        let mut disconnected_since: Option<Instant> = None;
        let mut last_forced: Option<Instant> = None;
        let mut ever_connected = false;
        let mut estimate_budget = budget;
        let mut limit: Option<u32> = None;
        let target = |budget: u32, tier: usize, q: &Quality, capture: (u32, u32)| budget.min(step(tier, q, capture).3);
        let mut window_checked = start;
        let (mut captured, mut encoded, mut bytes, mut stats_at) = (0u32, 0u32, 0u64, start);

        while !stop.load(Ordering::Relaxed) {
            let mut resized = false;
            while let Ok(frame) = pool.TryGetNextFrame() {
                let content = frame.ContentSize().map_err(err("capture"))?;
                if (content.Width, content.Height) != (size.Width, size.Height) && content.Width > 0 && content.Height > 0 {
                    // The window changed size: new buffers and a new encoder at the new size.
                    drop(frame);
                    (latest, last_frame) = (None, None); // old-size frames, back to the old pool
                    size = content;
                    capture = (size.Width as u32, size.Height as u32);
                    pool.Recreate(&winrt_device, DirectXPixelFormat::B8G8R8A8UIntNormalized, POOL_BUFFERS, size).map_err(err("capture"))?;
                    resized = true;
                    break;
                }
                captured += 1;
                latest = Some(frame); // older ones are dropped, like a live does
            }
            if resized {
                enc = make(ladder.tier, &quality, budget, capture)?;
                (last_forced, keyframe_pending) = (Some(Instant::now()), false);
            }
            for frame in enc.poll().map_err(err("H.264 encoder"))? {
                encoded += 1;
                bytes += frame.data.len() as u64;
                net.send_frame(&frame.data, (frame.time * 9 / 1000) as u64).map_err(|e| format!("WebRTC: {e}"))?;
            }
            let now = Instant::now();
            if enc.wants_input() && now >= next_due {
                let fresh = latest.take();
                let got_fresh = fresh.is_some();
                let resend = !got_fresh && (refresh_now || now - last_encode >= REFRESH_EVERY);
                if let Some(frame) = fresh {
                    last_frame = Some(frame); // the one it replaces goes back to the pool
                }
                if let Some(frame) = last_frame.as_ref().filter(|_| got_fresh || resend) {
                    let tex: ID3D11Texture2D = frame
                        .Surface()
                        .and_then(|s| s.cast::<IDirect3DDxgiInterfaceAccess>())
                        .and_then(|a| a.GetInterface())
                        .map_err(err("capture"))?;
                    enc.encode(&tex, (now - start).as_nanos() as i64 / 100).map_err(err("H.264 encoder"))?;
                    (last_encode, refresh_now) = (now, false);
                    next_due = (next_due + Duration::from_secs_f64(1.0 / enc.fps as f64)).max(now);
                }
            }
            std::thread::sleep(Duration::from_millis(1));

            let signals = net.drive().map_err(|e| format!("WebRTC: {e}"))?;
            let now = Instant::now();
            let span = (now - stats_at).as_secs_f64();
            if span >= 2.0 {
                let _ = events.send(LiveEvent::Stats {
                    captured_fps: captured as f64 / span,
                    encoded_fps: encoded as f64 / span,
                    kbps: (bytes as f64 * 8.0 / span / 1000.0) as u32,
                    estimate_kbps: (estimate_budget as f64 / BUDGET_SHARE) as u32,
                    width: enc.width,
                    height: enc.height,
                    fps: enc.fps,
                });
                (captured, encoded, bytes, stats_at) = (0, 0, 0, now);
            }
            if signals.connected {
                ever_connected = true;
                let _ = events.send(LiveEvent::Connected);
            }
            if signals.disconnected {
                disconnected_since.get_or_insert(now);
            }
            if signals.reconnected {
                disconnected_since = None;
            }
            if disconnected_since.is_some_and(|t| now - t > DISCONNECT_GRACE) {
                return Err("lost the connection to the server".into());
            }
            if source.kind == Kind::Window && now - window_checked > Duration::from_millis(500) {
                window_checked = now;
                if !windows::Win32::UI::WindowsAndMessaging::IsWindow(Some(windows::Win32::Foundation::HWND(source.id as _))).as_bool() {
                    return Err("the window was closed".into());
                }
            }
            if !ever_connected && now - start > CONNECT_TIMEOUT {
                return Err("could not reach the server's media port".into());
            }
            let picked = *shared.lock().unwrap();
            let quality_changed = picked != quality;
            if quality_changed {
                quality = picked;
                net.set_max_kbps(quality.max_kbps as u64);
            }
            if let Some(bps) = signals.estimate {
                estimate_budget = ((bps / 1000) as f64 * BUDGET_SHARE) as u32;
            }
            if let Some(loss) = signals.loss {
                limit = loss_limit(limit, target(budget, ladder.tier, &quality, capture), estimate_budget, loss);
            }
            budget = limit.map_or(estimate_budget, |l| l.min(estimate_budget));
            if let Some(tier) = ladder.update(budget, now).or(quality_changed.then_some(ladder.tier)) {
                // New size or fps: a new encoder, whose first frame is a keyframe at the new size.
                enc = make(tier, &quality, budget, capture)?;
                (last_forced, keyframe_pending, refresh_now) = (Some(now), false, true);
            } else if signals.estimate.is_some() || signals.loss.is_some() {
                enc.set_bitrate(target(budget, ladder.tier, &quality, capture));
            }
            // A keyframe asked for too soon after the last one waits its turn instead of being dropped.
            keyframe_pending |= signals.keyframe;
            if keyframe_pending && last_forced.is_none_or(|t| now - t >= KEYFRAME_GAP) {
                enc.force_keyframe();
                (last_forced, keyframe_pending, refresh_now) = (Some(now), false, true);
            }
        }
        let _ = session.Close();
        let _ = pool.Close();
        Ok(())
    })();
    let _ = MFShutdown();
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn step_sizes_keep_the_aspect_and_never_upscale() {
        assert_eq!(step_size((1920, 1080), 720), (1280, 720));
        assert_eq!(step_size((2560, 1440), 540), (960, 540));
        assert_eq!(step_size((1366, 768), 1080), (1366, 768));
    }

    #[test]
    fn the_top_step_is_the_picked_quality_and_lower_steps_never_exceed_it() {
        let q = |h: Option<u32>, fps: u32| Quality { max_height: h, max_fps: fps, max_kbps: 5000 };
        let capture = (2560, 1440);
        assert_eq!(step(0, &q(None, 60), capture), (2560, 1440, 60, 5000)); // "Source"
        assert_eq!(step(0, &q(Some(1080), 30), capture), (1920, 1080, 30, 5000));
        assert_eq!(step(1, &q(Some(1080), 60), capture), (1280, 720, 30, 2500));
        assert_eq!(step(1, &q(Some(480), 15), capture), (852, 480, 15, 2500)); // never above the pick
        assert_eq!(step(3, &q(Some(1080), 60), capture), (640, 360, 15, 600));
    }
}
