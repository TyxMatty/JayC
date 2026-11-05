//! Release builds turn off WebView2's browser shortcuts (F5/Ctrl+R reload, which would drop the
//! call, Ctrl+P print, Ctrl+F find, Ctrl+Shift+I…), so the app doesn't behave like a browser tab.
//! Copy, paste and the other editing keys keep working. Dev builds keep them for debugging.

use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
use windows::core::Interface;

pub fn disable_browser_keys(window: &tauri::WebviewWindow) {
    let result = window.with_webview(|webview| unsafe {
        let settings = webview.controller().CoreWebView2().and_then(|core| core.Settings());
        if let Err(e) = settings
            .and_then(|s| s.cast::<ICoreWebView2Settings3>())
            .and_then(|s| s.SetAreBrowserAcceleratorKeysEnabled(false))
        {
            log::warn!("app chrome: {e}");
        }
    });
    if let Err(e) = result {
        log::warn!("app chrome: {e}");
    }
}
