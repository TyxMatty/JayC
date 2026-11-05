//! What can be shared, for the app's own picker (ui/source-picker.js): monitors and app windows,
//! each with a JPEG thumbnail grabbed with Windows Graphics Capture (one frame) — the same capture
//! the live uses, so GPU-drawn windows (games, browsers) show up too.

use serde::{Deserialize, Serialize};
use windows::Graphics::Capture::{Direct3D11CaptureFramePool, GraphicsCaptureItem};
use windows::Graphics::DirectX::DirectXPixelFormat;
use windows::Win32::Foundation::{HWND, LPARAM, RECT, TRUE};
use windows::core::BOOL;
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
use windows::Win32::Graphics::Dxgi::Common::DXGI_SAMPLE_DESC;
use windows::Win32::Graphics::Gdi::{EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITORINFO};
use windows::Win32::Graphics::Imaging::*;
use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER, STREAM_SEEK_SET};
use windows::Win32::System::Threading::{GetCurrentProcessId, OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION};
use windows::Win32::UI::Shell::SHCreateMemStream;
use windows::Win32::UI::WindowsAndMessaging::*;
use windows::Win32::System::WinRT::Direct3D11::IDirect3DDxgiInterfaceAccess;
use windows::Win32::System::WinRT::Graphics::Capture::IGraphicsCaptureItemInterop;
use windows::core::{factory, Interface, PWSTR};

use super::err;

/// Windows smaller than this (either side) aren't offered, nor encoded: a minimized window reports
/// just its title bar (146x28), which the GPU encoder refuses.
pub const MIN_SIDE: u32 = 64;

/// A monitor (`id` = HMONITOR) or a top-level window (`id` = HWND).
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SourceId {
    pub kind: Kind,
    pub id: i64,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    Monitor,
    Window,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    #[serde(flatten)]
    pub source: SourceId,
    /// Window title; empty for monitors (the page names them "Screen 1", ...).
    pub title: String,
    /// The window's program (file name without .exe).
    pub app: String,
    pub width: u32,
    pub height: u32,
    pub primary: bool,
    /// A Jay-C window: shared without sound (its sound is the call's voices).
    pub own: bool,
}

pub fn capture_item(source: SourceId) -> Result<GraphicsCaptureItem, String> {
    let interop = factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>().map_err(err("capture"))?;
    unsafe {
        match source.kind {
            Kind::Monitor => interop.CreateForMonitor(HMONITOR(source.id as _)),
            Kind::Window => {
                if !IsWindow(Some(HWND(source.id as _))).as_bool() {
                    return Err("the window was closed".into());
                }
                interop.CreateForWindow(HWND(source.id as _))
            }
        }
    }
    .map_err(err("capture"))
}

/// Monitors first (primary first), then windows in Z order (the most recently used first).
pub fn list() -> Vec<Source> {
    let mut out = monitors();
    out.sort_by_key(|s| !s.primary);
    out.extend(windows());
    out
}

fn monitors() -> Vec<Source> {
    unsafe extern "system" fn each(monitor: HMONITOR, _: HDC, _: *mut RECT, data: LPARAM) -> BOOL {
        let out = &mut *(data.0 as *mut Vec<Source>);
        let mut info = MONITORINFO { cbSize: size_of::<MONITORINFO>() as u32, ..Default::default() };
        if GetMonitorInfoW(monitor, &mut info).as_bool() {
            let r = info.rcMonitor;
            out.push(Source {
                source: SourceId { kind: Kind::Monitor, id: monitor.0 as i64 },
                title: String::new(),
                app: String::new(),
                width: (r.right - r.left) as u32,
                height: (r.bottom - r.top) as u32,
                primary: info.dwFlags & MONITORINFOF_PRIMARY != 0,
                own: false,
            });
        }
        TRUE
    }
    let mut out: Vec<Source> = Vec::new();
    unsafe {
        let _ = EnumDisplayMonitors(None, None, Some(each), LPARAM(&mut out as *mut _ as isize));
    }
    out
}

/// Windows a person would call "an app": visible, titled, not minimized, not hidden by the shell
/// (cloaked: other virtual desktops, suspended UWP apps), not tool windows, not Jay-C itself.
fn windows() -> Vec<Source> {
    unsafe extern "system" fn each(hwnd: HWND, data: LPARAM) -> BOOL {
        let out = &mut *(data.0 as *mut Vec<Source>);
        if let Some(source) = describe(hwnd) {
            out.push(source);
        }
        TRUE
    }
    let mut out: Vec<Source> = Vec::new();
    unsafe {
        let _ = EnumWindows(Some(each), LPARAM(&mut out as *mut _ as isize));
    }
    out
}

unsafe fn describe(hwnd: HWND) -> Option<Source> {
    if !IsWindowVisible(hwnd).as_bool() || IsIconic(hwnd).as_bool() {
        return None;
    }
    if GetWindow(hwnd, GW_OWNER).is_ok_and(|o| !o.is_invalid()) {
        return None;
    }
    let ex = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
    if ex & WS_EX_TOOLWINDOW.0 != 0 {
        return None;
    }
    let mut cloaked = 0u32;
    if DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, &mut cloaked as *mut _ as _, 4).is_ok() && cloaked != 0 {
        return None;
    }
    let mut pid = 0;
    GetWindowThreadProcessId(hwnd, Some(&mut pid));
    let mut title = [0u16; 256];
    let n = GetWindowTextW(hwnd, &mut title);
    if n == 0 {
        return None;
    }
    let mut rect = RECT::default();
    let _ = GetClientRect(hwnd, &mut rect);
    let (width, height) = ((rect.right - rect.left) as u32, (rect.bottom - rect.top) as u32);
    if width < MIN_SIDE || height < MIN_SIDE {
        return None;
    }
    let title = String::from_utf16_lossy(&title[..n as usize]);
    if title == "Program Manager" {
        return None; // the desktop itself
    }
    Some(Source {
        source: SourceId { kind: Kind::Window, id: hwnd.0 as i64 },
        title,
        app: process_name(pid).unwrap_or_default(),
        width,
        height,
        primary: false,
        own: pid == GetCurrentProcessId(),
    })
}

unsafe fn process_name(pid: u32) -> Option<String> {
    let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
    let mut buf = [0u16; 512];
    let mut len = buf.len() as u32;
    let ok = QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len).is_ok();
    let _ = windows::Win32::Foundation::CloseHandle(process);
    if !ok {
        return None;
    }
    let path = String::from_utf16_lossy(&buf[..len as usize]);
    let file = path.rsplit('\\').next()?;
    Some(file.strip_suffix(".exe").or(file.strip_suffix(".EXE")).unwrap_or(file).to_string())
}

/// One frame of `source`, as a JPEG at most `max_width` wide.
pub unsafe fn thumbnail(source: SourceId, max_width: u32) -> Result<Vec<u8>, String> {
    let (device, winrt_device) = super::create_device()?;
    let item = capture_item(source)?;
    let size = item.Size().map_err(err("capture"))?;
    let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(&winrt_device, DirectXPixelFormat::B8G8R8A8UIntNormalized, 1, size)
        .map_err(err("capture"))?;
    let session = pool.CreateCaptureSession(&item).map_err(err("capture"))?;
    let _ = session.SetIsBorderRequired(false);
    let _ = session.SetIsCursorCaptureEnabled(false);
    session.StartCapture().map_err(err("capture"))?;
    // The first frame comes right after starting, even for a still window.
    let mut frame = None;
    for _ in 0..200 {
        if let Ok(f) = pool.TryGetNextFrame() {
            frame = Some(f);
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    let frame = frame.ok_or("no frame from the capture")?;
    let tex: ID3D11Texture2D = frame
        .Surface()
        .and_then(|s| s.cast::<IDirect3DDxgiInterfaceAccess>())
        .and_then(|a| a.GetInterface())
        .map_err(err("capture"))?;
    let mut desc = D3D11_TEXTURE2D_DESC::default();
    tex.GetDesc(&mut desc);
    let staging_desc = D3D11_TEXTURE2D_DESC {
        Usage: D3D11_USAGE_STAGING,
        BindFlags: 0,
        CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
        MiscFlags: 0,
        MipLevels: 1,
        ArraySize: 1,
        SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
        ..desc
    };
    let mut staging = None;
    device.CreateTexture2D(&staging_desc, None, Some(&mut staging)).map_err(err("thumbnail"))?;
    let staging = staging.unwrap();
    let context = device.GetImmediateContext().map_err(err("thumbnail"))?;
    context.CopyResource(&staging, &tex);
    drop(frame);
    let _ = session.Close();
    let _ = pool.Close();
    let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
    context.Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped)).map_err(err("thumbnail"))?;
    let pixels = std::slice::from_raw_parts(mapped.pData as *const u8, (mapped.RowPitch * desc.Height) as usize).to_vec();
    context.Unmap(&staging, 0);
    jpeg(&pixels, desc.Width, desc.Height, mapped.RowPitch, max_width)
}

/// A capture frame (BGRA texture) -> JPEG about `max_width` wide, for the live's previews. The GPU
/// halves it with mipmaps down to under twice that width; WIC scales the rest and encodes.
pub unsafe fn frame_jpeg(device: &ID3D11Device, tex: &ID3D11Texture2D, max_width: u32) -> Result<Vec<u8>, String> {
    let mut desc = D3D11_TEXTURE2D_DESC::default();
    tex.GetDesc(&mut desc);
    let mut level = 0;
    while level < 12 && desc.Width >> (level + 1) >= max_width {
        level += 1;
    }
    let mips_desc = D3D11_TEXTURE2D_DESC {
        Width: desc.Width,
        Height: desc.Height,
        MipLevels: level + 1,
        ArraySize: 1,
        Format: desc.Format,
        SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
        Usage: D3D11_USAGE_DEFAULT,
        BindFlags: (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_SHADER_RESOURCE.0) as u32,
        CPUAccessFlags: 0,
        MiscFlags: D3D11_RESOURCE_MISC_GENERATE_MIPS.0 as u32,
    };
    let mut mips = None;
    device.CreateTexture2D(&mips_desc, None, Some(&mut mips)).map_err(err("preview"))?;
    let mips = mips.unwrap();
    let mut view = None;
    device.CreateShaderResourceView(&mips, None, Some(&mut view)).map_err(err("preview"))?;
    let context = device.GetImmediateContext().map_err(err("preview"))?;
    context.CopySubresourceRegion(&mips, 0, 0, 0, 0, tex, 0, None);
    context.GenerateMips(&view.unwrap());

    let (width, height) = ((desc.Width >> level).max(1), (desc.Height >> level).max(1));
    let staging_desc = D3D11_TEXTURE2D_DESC {
        Width: width,
        Height: height,
        MipLevels: 1,
        Usage: D3D11_USAGE_STAGING,
        BindFlags: 0,
        CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
        MiscFlags: 0,
        ..mips_desc
    };
    let mut staging = None;
    device.CreateTexture2D(&staging_desc, None, Some(&mut staging)).map_err(err("preview"))?;
    let staging = staging.unwrap();
    context.CopySubresourceRegion(&staging, 0, 0, 0, 0, &mips, level, None);
    let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
    context.Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped)).map_err(err("preview"))?;
    let pixels = std::slice::from_raw_parts(mapped.pData as *const u8, (mapped.RowPitch * height) as usize).to_vec();
    context.Unmap(&staging, 0);
    jpeg(&pixels, width, height, mapped.RowPitch, max_width)
}

/// BGRA pixels -> scaled JPEG, with WIC (Windows' own codecs).
unsafe fn jpeg(bgra: &[u8], width: u32, height: u32, stride: u32, max_width: u32) -> Result<Vec<u8>, String> {
    let wic: IWICImagingFactory = CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER).map_err(err("thumbnail"))?;
    let bitmap = wic
        .CreateBitmapFromMemory(width, height, &GUID_WICPixelFormat32bppBGRA, stride, bgra)
        .map_err(err("thumbnail"))?;
    let tw = width.min(max_width);
    let th = ((height as u64 * tw as u64) / width as u64).max(1) as u32;
    let scaler = wic.CreateBitmapScaler().map_err(err("thumbnail"))?;
    scaler.Initialize(&bitmap, tw, th, WICBitmapInterpolationModeFant).map_err(err("thumbnail"))?;
    let bgr = wic.CreateFormatConverter().map_err(err("thumbnail"))?;
    bgr.Initialize(&scaler, &GUID_WICPixelFormat24bppBGR, WICBitmapDitherTypeNone, None, 0.0, WICBitmapPaletteTypeCustom)
        .map_err(err("thumbnail"))?;

    let stream = SHCreateMemStream(None).ok_or("thumbnail: no memory stream")?;
    let encoder = wic.CreateEncoder(&GUID_ContainerFormatJpeg, std::ptr::null()).map_err(err("thumbnail"))?;
    encoder.Initialize(&stream, WICBitmapEncoderNoCache).map_err(err("thumbnail"))?;
    let mut frame = None;
    encoder.CreateNewFrame(&mut frame, std::ptr::null_mut()).map_err(err("thumbnail"))?;
    let frame = frame.unwrap();
    frame.Initialize(None).map_err(err("thumbnail"))?;
    frame.SetSize(tw, th).map_err(err("thumbnail"))?;
    let mut format = GUID_WICPixelFormat24bppBGR;
    frame.SetPixelFormat(&mut format).map_err(err("thumbnail"))?;
    frame.WriteSource(&bgr, std::ptr::null()).map_err(err("thumbnail"))?;
    frame.Commit().map_err(err("thumbnail"))?;
    encoder.Commit().map_err(err("thumbnail"))?;

    let mut end = 0u64;
    stream.Seek(0, windows::Win32::System::Com::STREAM_SEEK_END, Some(&mut end)).map_err(err("thumbnail"))?;
    stream.Seek(0, STREAM_SEEK_SET, None).map_err(err("thumbnail"))?;
    let mut out = vec![0u8; end as usize];
    let mut read = 0u32;
    stream.Read(out.as_mut_ptr() as _, end as u32, Some(&mut read)).ok().map_err(err("thumbnail"))?;
    out.truncate(read as usize);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Run by hand: `cargo test -- --ignored sources` (captures the real screen, keeps nothing).
    #[test]
    #[ignore = "captures the real screen"]
    fn lists_monitors_first_and_makes_jpeg_thumbnails() {
        let all = list();
        let monitors: Vec<_> = all.iter().filter(|s| s.source.kind == Kind::Monitor).collect();
        assert!(!monitors.is_empty());
        assert!(monitors[0].primary, "primary monitor first");
        assert_eq!(all[..monitors.len()].iter().filter(|s| s.source.kind == Kind::Monitor).count(), monitors.len());
        for s in &all {
            println!("{:?} {} | {} | {}x{}", s.source.kind, s.title, s.app, s.width, s.height);
        }
        unsafe {
            windows::Win32::System::WinRT::RoInitialize(windows::Win32::System::WinRT::RO_INIT_MULTITHREADED).unwrap();
            let started = std::time::Instant::now();
            let jpeg = thumbnail(monitors[0].source, 384).unwrap();
            println!("monitor thumbnail: {} bytes in {:?}", jpeg.len(), started.elapsed());
            assert_eq!(&jpeg[..2], &[0xFF, 0xD8], "JPEG start marker");
            for s in all.iter().filter(|s| s.source.kind == Kind::Window) {
                let started = std::time::Instant::now();
                match thumbnail(s.source, 384) {
                    Ok(j) => println!("window {:?}: {} bytes in {:?}", s.app, j.len(), started.elapsed()),
                    Err(e) => println!("window {:?}: {e}", s.app),
                }
            }
        }
    }
}
