#[cfg(windows)]
mod app_chrome;
#[cfg(windows)]
mod discord;
#[cfg(windows)]
mod media_permissions;
#[cfg(windows)]
mod native_live;
#[cfg(windows)]
mod pip_window;
#[cfg(windows)]
mod taskbar_icon;
#[cfg(windows)]
mod update;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_system_audio::init())
        .plugin(tauri_plugin_pip::init())
        .invoke_handler(tauri::generate_handler![
            #[cfg(windows)]
            taskbar_icon::set_taskbar_icon,
            #[cfg(windows)]
            taskbar_icon::group_child_windows,
            #[cfg(windows)]
            native_live::native_live_start,
            #[cfg(windows)]
            native_live::native_live_stop,
            #[cfg(windows)]
            native_live::native_live_set_quality,
            #[cfg(windows)]
            native_live::native_live_viewer_kbps,
            #[cfg(windows)]
            native_live::native_live_audio_lead,
            #[cfg(windows)]
            native_live::native_live_sources,
            #[cfg(windows)]
            native_live::native_live_thumbnail,
            #[cfg(windows)]
            native_live::native_live_preview,
            #[cfg(windows)]
            native_live::native_live_watch,
            #[cfg(windows)]
            native_live::native_live_unwatch,
            #[cfg(windows)]
            discord::discord_presence,
            #[cfg(windows)]
            pip_window::pip_drag,
            #[cfg(windows)]
            pip_window::pip_close,
            #[cfg(windows)]
            update::update_latest,
            #[cfg(windows)]
            update::update_install
        ])
        .on_window_event(|window, event| {
            #[cfg(windows)]
            if window.label() == "main" && matches!(event, tauri::WindowEvent::Destroyed) {
                use tauri::Manager;
                pip_window::pip_close(window.app_handle().clone());
            }
        })
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            #[cfg(windows)]
            {
                use tauri::Manager;
                // Windows: tauri.windows.conf.json leaves the main window to us, to catch window.open
                // for our own PiP window (pip_window.rs).
                if app.get_webview_window("main").is_none() {
                    let config = app.config().app.windows.iter().find(|w| w.label == "main").cloned().expect("main window in the config");
                    let handle = app.handle().clone();
                    tauri::WebviewWindowBuilder::from_config(app.handle(), &config)?
                        .on_new_window(move |url, features| pip_window::open(&handle, url, features))
                        .build()?;
                }
                if let Some(window) = app.get_webview_window("main") {
                    media_permissions::allow_for_app(&window);
                    if !cfg!(debug_assertions) {
                        app_chrome::disable_browser_keys(&window);
                    }
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Jay-C");
}
