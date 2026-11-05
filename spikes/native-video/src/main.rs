//! Spike: capture the primary monitor with Windows Graphics Capture and encode H.264 on the GPU
//! (encoder.rs). Sends it over WebRTC (str0m, webrtc.rs) to a mediasoup WebRtcTransport when given
//! the server's transport parameters; send.mjs does the signaling. Resolution and frame rate follow
//! the bandwidth estimate (ladder.rs). Prints frames, bitrate, encode latency, quality changes and
//! this process's CPU time.
//!
//!   native-video-spike [seconds=20] [fps=60] [max kbps=6000] [out.h264 or -] [ufrag pwd ip:port "sha-256 AB:.."]
//!
//! Test only: JAYC_SHAPE_KBPS=1500 simulates a narrow uplink during the middle third of the run.

mod encoder;
mod ladder;
mod webrtc;

use std::collections::HashMap;
use std::fs::File;
use std::io::Write;
use std::time::{Duration, Instant};

use windows::core::{factory, Interface, Result};
use windows::Graphics::Capture::{Direct3D11CaptureFramePool, GraphicsCaptureItem};
use windows::Graphics::DirectX::Direct3D11::IDirect3DDevice;
use windows::Graphics::DirectX::DirectXPixelFormat;
use windows::Win32::Foundation::{HMODULE, POINT};
use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_HARDWARE;
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::IDXGIDevice;
use windows::Win32::Graphics::Gdi::{MonitorFromPoint, MONITOR_DEFAULTTOPRIMARY};
use windows::Win32::Media::MediaFoundation::{MFStartup, MFSTARTUP_FULL, MF_VERSION};
use windows::Win32::System::Threading::{GetCurrentProcess, GetProcessTimes};
use windows::Win32::System::WinRT::Direct3D11::{CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess};
use windows::Win32::System::WinRT::Graphics::Capture::IGraphicsCaptureItemInterop;
use windows::Win32::System::WinRT::{RoInitialize, RO_INIT_MULTITHREADED};

use encoder::Encoder;
use ladder::{loss_limit, Ladder, TIERS};

/// The encoder spends this share of the bandwidth estimate (the rest: RTX, RTCP, headroom).
const BUDGET_SHARE: f64 = 0.85;
/// Forced keyframes at most this often: under congestion every PLI's keyframe makes it worse.
const KEYFRAME_GAP: Duration = Duration::from_secs(1);

fn cpu_time() -> Duration {
    let (mut c, mut e, mut k, mut u) = Default::default();
    unsafe { GetProcessTimes(GetCurrentProcess(), &mut c, &mut e, &mut k, &mut u).unwrap() };
    let ticks = |f: windows::Win32::Foundation::FILETIME| ((f.dwHighDateTime as u64) << 32) | f.dwLowDateTime as u64;
    Duration::from_nanos((ticks(k) + ticks(u)) * 100)
}

/// Output size for a ladder step: the step's height (never above the capture), same aspect, even.
fn step_size(capture: (u32, u32), height: u32) -> (u32, u32) {
    let h = height.min(capture.1);
    let w = (capture.0 as u64 * h as u64 / capture.1 as u64) as u32;
    (w & !1, h & !1)
}

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let seconds: u64 = args.get(1).and_then(|s| s.parse().ok()).unwrap_or(20);
    let max_fps: u32 = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(60);
    let max_kbps: u32 = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(6000);
    let mut out = args.get(4).filter(|p| *p != "-").map(|p| File::create(p).expect("output file"));
    let start_kbps = 1500;
    let mut net = match (args.get(5), args.get(6), args.get(7), args.get(8)) {
        (Some(ufrag), Some(pwd), Some(addr), Some(fingerprint)) => {
            let remote = webrtc::Remote { ufrag: ufrag.clone(), pwd: pwd.clone(), addr: addr.parse().expect("ip:port"), fingerprint: fingerprint.clone() };
            let (sender, local) = webrtc::Sender::new(&remote, start_kbps, max_kbps as u64).expect("webrtc");
            // One JSON line for send.mjs: what goes into connectTransport and produce.
            println!(r#"{{"fingerprint":"{}","ssrc":{},"rtxSsrc":{}}}"#, local.fingerprint, local.ssrc, local.rtx_ssrc);
            std::io::stdout().flush().unwrap();
            Some(sender)
        }
        _ => None,
    };
    let shape_kbps: Option<u64> = std::env::var("JAYC_SHAPE_KBPS").ok().and_then(|v| v.parse().ok());

    // Without a network there is no estimate: fixed at the top step and `max_kbps`.
    let mut budget = if net.is_some() { (start_kbps as f64 * BUDGET_SHARE) as u32 } else { max_kbps };
    let mut ladder = Ladder::new(budget);
    let mut estimate_budget = budget;
    let mut limit: Option<u32> = None;
    let target_for = |budget: u32, tier: usize| budget.min(TIERS[tier].max_kbps).min(max_kbps);

    unsafe {
        RoInitialize(RO_INIT_MULTITHREADED)?;
        MFStartup(MF_VERSION, MFSTARTUP_FULL)?;

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
        )?;
        let device: ID3D11Device = device.unwrap();
        let _ = device.cast::<ID3D11Multithread>()?.SetMultithreadProtected(true);

        // ---- Capture: primary monitor ----
        let monitor = MonitorFromPoint(POINT { x: 0, y: 0 }, MONITOR_DEFAULTTOPRIMARY);
        let interop = factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>()?;
        let item: GraphicsCaptureItem = interop.CreateForMonitor(monitor)?;
        let size = item.Size()?;
        let capture = (size.Width as u32, size.Height as u32);
        let winrt_device: IDirect3DDevice = CreateDirect3D11DeviceFromDXGIDevice(&device.cast::<IDXGIDevice>()?)?.cast()?;
        let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(&winrt_device, DirectXPixelFormat::B8G8R8A8UIntNormalized, 2, size)?;
        let session = pool.CreateCaptureSession(&item)?;
        let border = session.SetIsBorderRequired(false).is_ok(); // no yellow frame, where allowed

        let make = |tier: usize, kbps: u32| -> Result<Encoder> {
            let (w, h) = step_size(capture, TIERS[tier].height);
            Encoder::new(&device, capture, w, h, TIERS[tier].fps.min(max_fps), kbps)
        };
        let mut enc = make(ladder.tier, target_for(budget, ladder.tier))?;
        println!("encoder: {} | capture {}x{} | max {max_fps} fps, {max_kbps} kbps | borderless: {border}", enc.name, capture.0, capture.1);

        // ---- Loop ----
        session.StartCapture()?;
        let start = Instant::now();
        let cpu0 = cpu_time();
        let mut next_due = start;
        let (mut captured, mut encoded, mut keyframes, mut bytes) = (0u64, 0u64, 0u64, 0u64);
        let mut sent_at: HashMap<i64, Instant> = HashMap::new();
        let mut latencies = Vec::new();
        let mut latest = None;
        let mut last_forced: Option<Instant> = None;
        let mut events: Vec<String> = Vec::new();
        let log = |events: &mut Vec<String>, what: String| {
            let line = format!("{:.1}s {what}", start.elapsed().as_secs_f64());
            eprintln!("{line}");
            events.push(line);
        };
        log(&mut events, format!("start {}x{}@{} target {} kbps", enc.width, enc.height, enc.fps, target_for(budget, ladder.tier)));

        while start.elapsed() < Duration::from_secs(seconds) {
            // Newest captured frame (older ones are dropped, like a live does).
            while let Ok(frame) = pool.TryGetNextFrame() {
                captured += 1;
                latest = Some(frame);
            }
            for frame in enc.poll()? {
                if let Some(t) = sent_at.remove(&frame.time) {
                    latencies.push(t.elapsed());
                }
                keyframes += frame.keyframe as u64;
                bytes += frame.data.len() as u64;
                encoded += 1;
                if let Some(f) = out.as_mut() {
                    f.write_all(&frame.data).unwrap();
                }
                if let Some(n) = net.as_mut() {
                    n.send_frame(&frame.data, (frame.time * 9 / 1000) as u64).expect("send");
                }
            }
            // Feed the newest frame, at most the step's fps.
            let now = Instant::now();
            if enc.wants_input() && now >= next_due {
                if let Some(frame) = latest.take() {
                    let tex: ID3D11Texture2D = frame.Surface()?.cast::<IDirect3DDxgiInterfaceAccess>()?.GetInterface()?;
                    let time = (now - start).as_nanos() as i64 / 100;
                    enc.encode(&tex, time)?;
                    drop(frame); // back to the pool
                    sent_at.insert(time, now);
                    next_due = (next_due + Duration::from_secs_f64(1.0 / enc.fps as f64)).max(now);
                }
            }
            std::thread::sleep(Duration::from_millis(1));
            let Some(n) = net.as_mut() else { continue };
            let t = start.elapsed().as_secs_f64() / seconds as f64;
            n.shape_kbps = shape_kbps.filter(|_| (1.0 / 3.0..2.0 / 3.0).contains(&t));
            let signals = n.drive().expect("network");
            let now = Instant::now();
            if let Some(bps) = signals.estimate {
                estimate_budget = ((bps / 1000) as f64 * BUDGET_SHARE) as u32;
            }
            if let Some(loss) = signals.loss {
                let before = limit;
                limit = loss_limit(limit, target_for(budget, ladder.tier), estimate_budget, loss);
                if limit.is_some() != before.is_some() || (loss > 0.10 && limit != before) {
                    log(&mut events, format!("loss {:.0}% -> limit {limit:?}", loss * 100.0));
                }
            }
            let changed = signals.estimate.is_some() || signals.loss.is_some();
            budget = limit.map_or(estimate_budget, |l| l.min(estimate_budget));
            if let Some(tier) = ladder.update(budget, now) {
                // New size: a new encoder, whose first frame is a small keyframe at the new size.
                enc = make(tier, target_for(budget, tier))?;
                last_forced = Some(now);
                log(&mut events, format!("step {}x{}@{} target {} kbps (budget {budget})", enc.width, enc.height, enc.fps, target_for(budget, tier)));
            } else if changed {
                enc.set_bitrate(target_for(budget, ladder.tier));
            }
            if signals.keyframe && last_forced.is_none_or(|t| now - t >= KEYFRAME_GAP) {
                enc.force_keyframe();
                last_forced = Some(now);
            }
        }
        session.Close()?;
        let wall = start.elapsed().as_secs_f64();
        let cpu = (cpu_time() - cpu0).as_secs_f64();
        latencies.sort();
        let pct = |p: f64| latencies.get(((latencies.len() as f64 - 1.0) * p) as usize).map(|d| d.as_secs_f64() * 1000.0).unwrap_or(f64::NAN);
        println!(
            "captured {:.1}/s | encoded {:.1}/s ({keyframes} keyframes) | {:.0} kbps | encode latency p50 {:.1} ms p95 {:.1} ms | CPU {:.3} cores ({:.1}% of 12 threads)",
            captured as f64 / wall,
            encoded as f64 / wall,
            bytes as f64 * 8.0 / wall / 1000.0,
            pct(0.5),
            pct(0.95),
            cpu / wall,
            cpu / wall / 12.0 * 100.0
        );
        if let Some(n) = &net {
            println!(
                "webrtc: connected {} | {} frames sent | {} keyframe requests | shaper dropped {}",
                n.connected(),
                n.frames_sent,
                n.keyframe_requests,
                n.shaper_dropped()
            );
            println!("steps: {}", events.join(" | "));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::step_size;

    #[test]
    fn step_sizes_keep_the_aspect_and_never_upscale() {
        assert_eq!(step_size((1920, 1080), 720), (1280, 720));
        assert_eq!(step_size((1920, 1080), 1080), (1920, 1080));
        assert_eq!(step_size((2560, 1440), 540), (960, 540));
        assert_eq!(step_size((1366, 768), 1080), (1366, 768));
        assert_eq!(step_size((1366, 768), 360), (640, 360));
    }
}
