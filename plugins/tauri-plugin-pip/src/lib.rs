//! Picture-in-Picture for Jay-C on mobile.
//!
//! On Android the whole activity becomes the floating window (WebView's `<video>` PiP isn't
//! available), so the plugin only drives the activity: auto-enter when the user leaves the app
//! during a call, enter on demand, and report PiP mode changes as the `pipModeChanged` event.
//! It also has `set_immersive`, the native half of a stream's full screen (the WebView can't do
//! element full screen): hide the system bars and turn the screen to landscape.
//! The commands live in Kotlin (android/src/main/java/.../PipPlugin.kt). Desktop uses the
//! WebView's own video PiP instead (frontend/src/core/pip.js), so the plugin does nothing there.

use tauri::{
    Runtime,
    plugin::{Builder, TauriPlugin},
};

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("pip")
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            _api.register_android_plugin("io.github.tyxmatty.jayc.pip", "PipPlugin")?;
            Ok(())
        })
        .build()
}
