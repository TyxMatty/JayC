//! Spike: capture the primary monitor with Windows Graphics Capture, convert BGRA -> NV12 on the
//! GPU (D3D11 video processor) and encode H.264 with the hardware Media Foundation encoder, all on
//! the GPU. Sends it over WebRTC (str0m) to a mediasoup WebRtcTransport when given the server's
//! transport parameters; send.mjs does the signaling. Prints frames, bitrate, encode latency,
//! bandwidth estimates and this process's CPU time.
//!
//!   native-video-spike [seconds=20] [fps=60] [max kbps=6000] [out.h264 or -] [ufrag pwd ip:port "sha-256 AB:.."]

mod webrtc;

use std::collections::HashMap;
use std::fs::File;
use std::io::Write;
use std::mem::ManuallyDrop;
use std::time::{Duration, Instant};

use windows::core::{factory, Interface, Result, GUID};
use windows::Graphics::Capture::{Direct3D11CaptureFramePool, GraphicsCaptureItem};
use windows::Graphics::DirectX::Direct3D11::IDirect3DDevice;
use windows::Graphics::DirectX::DirectXPixelFormat;
use windows::Win32::Foundation::{HMODULE, POINT};
use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_HARDWARE;
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_NV12, DXGI_RATIONAL, DXGI_SAMPLE_DESC};
use windows::Win32::Graphics::Dxgi::IDXGIDevice;
use windows::Win32::Graphics::Gdi::{MonitorFromPoint, MONITOR_DEFAULTTOPRIMARY};
use windows::Win32::Media::MediaFoundation::*;
use windows::Win32::System::Threading::{GetCurrentProcess, GetProcessTimes};
use windows::Win32::System::Variant::VARIANT;
use windows::Win32::System::WinRT::Direct3D11::{CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess};
use windows::Win32::System::WinRT::Graphics::Capture::IGraphicsCaptureItemInterop;
use windows::Win32::System::WinRT::{RoInitialize, RO_INIT_MULTITHREADED};

const RING: usize = 4; // NV12 textures the encoder may still be reading

fn cpu_time() -> Duration {
    let (mut c, mut e, mut k, mut u) = Default::default();
    unsafe { GetProcessTimes(GetCurrentProcess(), &mut c, &mut e, &mut k, &mut u).unwrap() };
    let ticks = |f: windows::Win32::Foundation::FILETIME| ((f.dwHighDateTime as u64) << 32) | f.dwLowDateTime as u64;
    Duration::from_nanos((ticks(k) + ticks(u)) * 100)
}

fn pack(hi: u32, lo: u32) -> u64 {
    ((hi as u64) << 32) | lo as u64
}

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let seconds: u64 = args.get(1).and_then(|s| s.parse().ok()).unwrap_or(20);
    let fps: u32 = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(60);
    let kbps: u32 = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(6000);
    let mut out = args.get(4).filter(|p| *p != "-").map(|p| File::create(p).expect("output file"));
    let start_kbps = 1500;
    let mut net = match (args.get(5), args.get(6), args.get(7), args.get(8)) {
        (Some(ufrag), Some(pwd), Some(addr), Some(fingerprint)) => {
            let remote = webrtc::Remote { ufrag: ufrag.clone(), pwd: pwd.clone(), addr: addr.parse().expect("ip:port"), fingerprint: fingerprint.clone() };
            let (sender, local) = webrtc::Sender::new(&remote, start_kbps, kbps as u64).expect("webrtc");
            // One JSON line for send.mjs: what goes into connectTransport and produce.
            println!(r#"{{"fingerprint":"{}","ssrc":{},"rtxSsrc":{}}}"#, local.fingerprint, local.ssrc, local.rtx_ssrc);
            std::io::stdout().flush().unwrap();
            Some(sender)
        }
        _ => None,
    };
    // The encoder follows the bandwidth estimate (85% of it, at most `kbps`).
    let mut target_kbps = if net.is_some() { start_kbps as u32 } else { kbps };
    let mut estimates: Vec<(f64, u64)> = Vec::new();
    let shape_kbps: Option<u64> = std::env::var("JAYC_SHAPE_KBPS").ok().and_then(|v| v.parse().ok());

    unsafe {
        RoInitialize(RO_INIT_MULTITHREADED)?;
        MFStartup(MF_VERSION, MFSTARTUP_FULL)?;

        // ---- D3D11 device shared by capture, conversion and encoder ----
        let mut device = None;
        let mut context = None;
        D3D11CreateDevice(
            None,
            D3D_DRIVER_TYPE_HARDWARE,
            HMODULE::default(),
            D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_VIDEO_SUPPORT,
            None,
            D3D11_SDK_VERSION,
            Some(&mut device),
            None,
            Some(&mut context),
        )?;
        let device: ID3D11Device = device.unwrap();
        let context: ID3D11DeviceContext = context.unwrap();
        let _ = device.cast::<ID3D11Multithread>()?.SetMultithreadProtected(true);

        // ---- Capture: primary monitor ----
        let monitor = MonitorFromPoint(POINT { x: 0, y: 0 }, MONITOR_DEFAULTTOPRIMARY);
        let interop = factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>()?;
        let item: GraphicsCaptureItem = interop.CreateForMonitor(monitor)?;
        let size = item.Size()?;
        let (w, h) = ((size.Width as u32) & !1, (size.Height as u32) & !1);
        let winrt_device: IDirect3DDevice = CreateDirect3D11DeviceFromDXGIDevice(&device.cast::<IDXGIDevice>()?)?.cast()?;
        let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(&winrt_device, DirectXPixelFormat::B8G8R8A8UIntNormalized, 2, size)?;
        let session = pool.CreateCaptureSession(&item)?;
        let border = session.SetIsBorderRequired(false).is_ok(); // no yellow frame, where allowed

        // ---- BGRA -> NV12 on the GPU ----
        let vdevice: ID3D11VideoDevice = device.cast()?;
        let vcontext: ID3D11VideoContext = context.cast()?;
        let rate = DXGI_RATIONAL { Numerator: fps, Denominator: 1 };
        let content = D3D11_VIDEO_PROCESSOR_CONTENT_DESC {
            InputFrameFormat: D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
            InputFrameRate: rate,
            InputWidth: size.Width as u32,
            InputHeight: size.Height as u32,
            OutputFrameRate: rate,
            OutputWidth: w,
            OutputHeight: h,
            Usage: D3D11_VIDEO_USAGE_OPTIMAL_SPEED,
        };
        let vp_enum = vdevice.CreateVideoProcessorEnumerator(&content)?;
        let processor = vdevice.CreateVideoProcessor(&vp_enum, 0)?;
        let nv12_desc = D3D11_TEXTURE2D_DESC {
            Width: w,
            Height: h,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_NV12,
            SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
            Usage: D3D11_USAGE_DEFAULT,
            BindFlags: (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_VIDEO_ENCODER.0) as u32,
            ..Default::default()
        };
        let mut ring = Vec::new();
        for _ in 0..RING {
            let mut tex = None;
            device.CreateTexture2D(&nv12_desc, None, Some(&mut tex))?;
            let tex = tex.unwrap();
            let view_desc = D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC {
                ViewDimension: D3D11_VPOV_DIMENSION_TEXTURE2D,
                ..Default::default()
            };
            let mut view = None;
            vdevice.CreateVideoProcessorOutputView(&tex, &vp_enum, &view_desc, Some(&mut view))?;
            ring.push((tex, view.unwrap()));
        }

        // ---- Hardware H.264 encoder (async MFT) ----
        let input_info = MFT_REGISTER_TYPE_INFO { guidMajorType: MFMediaType_Video, guidSubtype: MFVideoFormat_NV12 };
        let output_info = MFT_REGISTER_TYPE_INFO { guidMajorType: MFMediaType_Video, guidSubtype: MFVideoFormat_H264 };
        let mut activates: *mut Option<IMFActivate> = std::ptr::null_mut();
        let mut count = 0u32;
        MFTEnumEx(
            MFT_CATEGORY_VIDEO_ENCODER,
            MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SORTANDFILTER,
            Some(&input_info),
            Some(&output_info),
            &mut activates,
            &mut count,
        )?;
        assert!(count > 0, "no hardware H.264 encoder");
        let activate = (*activates).clone().unwrap();
        let mut name = windows::core::PWSTR::null();
        let mut len = 0;
        activate.GetAllocatedString(&MFT_FRIENDLY_NAME_Attribute, &mut name, &mut len)?;
        println!("encoder: {} | capture {}x{} -> {}x{} @{fps} | {kbps} kbps | borderless: {border}", name.display(), size.Width, size.Height, w, h);
        let encoder: IMFTransform = activate.ActivateObject()?;
        encoder.GetAttributes()?.SetUINT32(&MF_TRANSFORM_ASYNC_UNLOCK, 1)?;

        let mut token = 0u32;
        let mut manager = None;
        MFCreateDXGIDeviceManager(&mut token, &mut manager)?;
        let manager: IMFDXGIDeviceManager = manager.unwrap();
        manager.ResetDevice(&device, token)?;
        encoder.ProcessMessage(MFT_MESSAGE_SET_D3D_MANAGER, manager.as_raw() as usize)?;

        // Before the media types: some encoders only read these when the types are set.
        let codec = encoder.cast::<ICodecAPI>().ok();
        if let Some(codec) = &codec {
            let set = |guid: &GUID, v: VARIANT, what: &str| {
                if let Err(e) = codec.SetValue(guid, &v) {
                    println!("  (encoder ignored {what}: {e})");
                }
            };
            set(&CODECAPI_AVLowLatencyMode, VARIANT::from(true), "low latency");
            set(&CODECAPI_AVEncCommonRateControlMode, VARIANT::from(eAVEncCommonRateControlMode_CBR.0 as u32), "CBR");
            set(&CODECAPI_AVEncCommonMeanBitRate, VARIANT::from(target_kbps * 1000), "bitrate");
            set(&CODECAPI_AVEncMPVGOPSize, VARIANT::from(fps * 4), "GOP");
        }
        let out_type = MFCreateMediaType()?;
        out_type.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
        out_type.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_H264)?;
        out_type.SetUINT32(&MF_MT_AVG_BITRATE, target_kbps * 1000)?;
        out_type.SetUINT64(&MF_MT_FRAME_SIZE, pack(w, h))?;
        out_type.SetUINT64(&MF_MT_FRAME_RATE, pack(fps, 1))?;
        out_type.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)?;
        out_type.SetUINT32(&MF_MT_MPEG2_PROFILE, eAVEncH264VProfile_High.0 as u32)?;
        out_type.SetUINT32(&MF_MT_MAX_KEYFRAME_SPACING, fps * 4)?;
        encoder.SetOutputType(0, &out_type, 0)?;
        let in_type = MFCreateMediaType()?;
        in_type.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
        in_type.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_NV12)?;
        in_type.SetUINT64(&MF_MT_FRAME_SIZE, pack(w, h))?;
        in_type.SetUINT64(&MF_MT_FRAME_RATE, pack(fps, 1))?;
        in_type.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)?;
        encoder.SetInputType(0, &in_type, 0)?;

        let provides_samples = encoder.GetOutputStreamInfo(0)?.dwFlags & MFT_OUTPUT_STREAM_PROVIDES_SAMPLES.0 as u32 != 0;
        encoder.ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0)?;
        encoder.ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0)?;
        let events: IMFMediaEventGenerator = encoder.cast()?;

        // ---- Loop ----
        session.StartCapture()?;
        let start = Instant::now();
        let cpu0 = cpu_time();
        let interval = Duration::from_secs_f64(1.0 / fps as f64);
        let (mut need, mut next_slot, mut next_due) = (0u32, 0usize, start);
        let (mut captured, mut sent, mut encoded, mut keyframes, mut bytes) = (0u64, 0u64, 0u64, 0u64, 0u64);
        let mut sent_at: HashMap<i64, Instant> = HashMap::new();
        let mut latencies = Vec::new();
        let mut latest = None;

        while start.elapsed() < Duration::from_secs(seconds) {
            // Newest captured frame (older ones are dropped, like a live does).
            while let Ok(frame) = pool.TryGetNextFrame() {
                captured += 1;
                latest = Some(frame);
            }
            // Encoder events.
            loop {
                let event = match events.GetEvent(MF_EVENT_FLAG_NO_WAIT) {
                    Ok(e) => e,
                    Err(_) => break, // MF_E_NO_EVENTS_AVAILABLE
                };
                match event.GetType()? {
                    t if t == METransformNeedInput.0 as u32 => need += 1,
                    t if t == METransformHaveOutput.0 as u32 => {
                        let mut buf = [MFT_OUTPUT_DATA_BUFFER::default()];
                        if !provides_samples {
                            let info = encoder.GetOutputStreamInfo(0)?;
                            let s = MFCreateSample()?;
                            s.AddBuffer(&MFCreateMemoryBuffer(info.cbSize.max(1 << 20))?)?;
                            buf[0].pSample = ManuallyDrop::new(Some(s));
                        }
                        let mut status = 0;
                        encoder.ProcessOutput(0, &mut buf, &mut status)?;
                        let sample = ManuallyDrop::take(&mut buf[0].pSample).unwrap();
                        drop(ManuallyDrop::take(&mut buf[0].pEvents));
                        let time = sample.GetSampleTime()?;
                        if let Some(t) = sent_at.remove(&time) {
                            latencies.push(t.elapsed());
                        }
                        if sample.GetUINT32(&MFSampleExtension_CleanPoint).unwrap_or(0) != 0 {
                            keyframes += 1;
                        }
                        let media = sample.ConvertToContiguousBuffer()?;
                        let (mut ptr, mut len) = (std::ptr::null_mut(), 0u32);
                        media.Lock(&mut ptr, None, Some(&mut len))?;
                        if let Some(f) = out.as_mut() {
                            f.write_all(std::slice::from_raw_parts(ptr, len as usize)).unwrap();
                        }
                        if let Some(n) = net.as_mut() {
                            n.send_frame(std::slice::from_raw_parts(ptr, len as usize), (time * 9 / 1000) as u64).expect("send");
                        }
                        media.Unlock()?;
                        bytes += len as u64;
                        encoded += 1;
                    }
                    _ => {}
                }
            }
            // Feed the newest frame, at most `fps` per second.
            let now = Instant::now();
            if need > 0 && now >= next_due {
                if let Some(frame) = latest.take() {
                    let surface = frame.Surface()?;
                    let tex: ID3D11Texture2D = surface.cast::<IDirect3DDxgiInterfaceAccess>()?.GetInterface()?;
                    let (nv12, out_view) = &ring[next_slot];
                    next_slot = (next_slot + 1) % RING;
                    let in_desc = D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC {
                        FourCC: 0,
                        ViewDimension: D3D11_VPIV_DIMENSION_TEXTURE2D,
                        ..Default::default()
                    };
                    let mut in_view = None;
                    vdevice.CreateVideoProcessorInputView(&tex, &vp_enum, &in_desc, Some(&mut in_view))?;
                    let stream = D3D11_VIDEO_PROCESSOR_STREAM {
                        Enable: true.into(),
                        pInputSurface: ManuallyDrop::new(in_view),
                        ..Default::default()
                    };
                    let mut streams = [stream];
                    vcontext.VideoProcessorBlt(&processor, out_view, 0, &streams)?;
                    ManuallyDrop::drop(&mut streams[0].pInputSurface);
                    drop(frame); // back to the pool

                    let sample = MFCreateSample()?;
                    sample.AddBuffer(&MFCreateDXGISurfaceBuffer(&ID3D11Texture2D::IID, nv12, 0, false)?)?;
                    let time = (now - start).as_nanos() as i64 / 100;
                    sample.SetSampleTime(time)?;
                    sample.SetSampleDuration(10_000_000 / fps as i64)?;
                    encoder.ProcessInput(0, &sample, 0)?;
                    sent_at.insert(time, now);
                    need -= 1;
                    sent += 1;
                    next_due = (next_due + interval).max(now);
                }
            }
            std::thread::sleep(Duration::from_millis(1));
            if let Some(n) = net.as_mut() {
                // Test: JAYC_SHAPE_KBPS narrows the uplink during the middle third of the run.
                let t = start.elapsed().as_secs_f64() / seconds as f64;
                n.shape_kbps = shape_kbps.filter(|_| (1.0 / 3.0..2.0 / 3.0).contains(&t));
                {
                    let signals = n.drive().expect("network");
                    // A viewer started watching (PLI/FIR), or we just connected.
                    if signals.keyframe {
                        if let Some(c) = &codec {
                            let _ = c.SetValue(&CODECAPI_AVEncVideoForceKeyFrame, &VARIANT::from(1u32));
                        }
                    }
                    if let Some(bps) = signals.estimate {
                        estimates.push((start.elapsed().as_secs_f64(), bps / 1000));
                        let want = ((bps / 1000) as f64 * 0.85).min(kbps as f64) as u32;
                        if want.abs_diff(target_kbps) * 10 > target_kbps {
                            target_kbps = want;
                            eprintln!("{:.1}s encoder target {target_kbps} kbps", start.elapsed().as_secs_f64());
                            if let Some(c) = &codec {
                                let _ = c.SetValue(&CODECAPI_AVEncCommonMeanBitRate, &VARIANT::from(target_kbps * 1000));
                            }
                        }
                    }
                }
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
            let every_5s: Vec<String> = (0..=seconds / 3)
                .filter_map(|k| estimates.iter().rev().find(|(t, _)| *t <= (k * 3) as f64 + 0.5).map(|(t, e)| format!("{t:.0}s:{e}")))
                .collect();
            println!(
                "webrtc: connected {} | {} frames sent | {} keyframe requests | shaper dropped {} | estimate kbps {} | encoder target {target_kbps} kbps",
                n.connected(),
                n.frames_sent,
                n.keyframe_requests,
                n.shaper_dropped(),
                every_5s.join(" ")
            );
        }
        let _ = sent;
    }
    Ok(())
}
