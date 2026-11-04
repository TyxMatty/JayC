//! Camera and microphone for the app's own page, without WebView2's "wants to use your camera"
//! prompt. An installed app asking that about `tauri.localhost` is confusing; the camera only turns
//! on when the user joins a call, and Windows' own privacy settings still apply.

use webview2_com::{
    Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_PERMISSION_KIND, COREWEBVIEW2_PERMISSION_KIND_CAMERA,
        COREWEBVIEW2_PERMISSION_KIND_MICROPHONE, COREWEBVIEW2_PERMISSION_STATE_ALLOW,
        ICoreWebView2, ICoreWebView2PermissionRequestedEventArgs,
    },
    PermissionRequestedEventHandler,
};
use windows::core::PWSTR;

/// The bundled frontend in release builds, and the Vite dev server in dev builds.
fn is_app_page(uri: &str) -> bool {
    uri.starts_with("http://tauri.localhost/")
        || (cfg!(debug_assertions) && uri.starts_with("http://localhost:5173/"))
}

pub fn allow_for_app(window: &tauri::WebviewWindow) {
    let result = window.with_webview(|webview| unsafe {
        let core = match webview.controller().CoreWebView2() {
            Ok(core) => core,
            Err(e) => return log::warn!("media permissions: no CoreWebView2: {e}"),
        };
        let handler = PermissionRequestedEventHandler::create(Box::new(
            |_: Option<ICoreWebView2>, args: Option<ICoreWebView2PermissionRequestedEventArgs>| {
                let Some(args) = args else { return Ok(()) };
                let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
                args.PermissionKind(&mut kind)?;
                if kind != COREWEBVIEW2_PERMISSION_KIND_CAMERA
                    && kind != COREWEBVIEW2_PERMISSION_KIND_MICROPHONE
                {
                    return Ok(()); // anything else keeps WebView2's default behavior
                }
                let mut uri = PWSTR::null();
                args.Uri(&mut uri)?;
                if is_app_page(&webview2_com::take_pwstr(uri)) {
                    args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW)?;
                }
                Ok(())
            },
        ));
        let mut token = Default::default();
        if let Err(e) = core.add_PermissionRequested(&handler, &mut token) {
            log::warn!("media permissions: add_PermissionRequested failed: {e}");
        }
    });
    if let Err(e) = result {
        log::warn!("media permissions: {e}");
    }
}
