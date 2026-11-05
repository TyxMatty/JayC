//! The taskbar icon (Windows `ICON_BIG`), drawn by the page in the current style
//! (frontend/src/ui/window-icon.js). Tauri's `setIcon` only sets the title bar's small icon, so
//! without this the taskbar keeps the .exe's icon. Same conversion as tao's `set_taskbar_icon`.

use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
use windows::Win32::UI::WindowsAndMessaging::{CreateIcon, DestroyIcon, SendMessageW, HICON, ICON_BIG, WM_SETICON};

/// `rgba`: `size` x `size` pixels, 4 bytes each (straight alpha), as from a canvas.
#[tauri::command]
pub fn set_taskbar_icon(window: tauri::WebviewWindow, rgba: Vec<u8>, size: u32) -> Result<(), String> {
    let pixels = (size * size) as usize;
    if size == 0 || size > 256 || rgba.len() != pixels * 4 {
        return Err(format!("expected {size}x{size} RGBA pixels, got {} bytes", rgba.len()));
    }
    // CreateIcon takes BGRA color bits and an AND mask (here one byte per pixel: the inverted alpha).
    let mut bgra = rgba;
    let mut and_mask = Vec::with_capacity(pixels);
    for px in bgra.chunks_exact_mut(4) {
        and_mask.push(px[3].wrapping_sub(u8::MAX));
        px.swap(0, 2);
    }
    let hwnd = HWND(window.hwnd().map_err(|e| e.to_string())?.0);
    unsafe {
        let icon = CreateIcon(None, size as i32, size as i32, 1, 32, and_mask.as_ptr(), bgra.as_ptr()).map_err(|e| e.to_string())?;
        // The previous big icon is one this command made (nothing else sets ICON_BIG): free it.
        let old = SendMessageW(hwnd, WM_SETICON, Some(WPARAM(ICON_BIG as usize)), Some(LPARAM(icon.0 as isize)));
        if old.0 != 0 {
            let _ = DestroyIcon(HICON(old.0 as _));
        }
    }
    Ok(())
}
