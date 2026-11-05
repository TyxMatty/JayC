#[cfg(windows)]
mod app_chrome;
#[cfg(windows)]
mod media_permissions;
#[cfg(windows)]
mod taskbar_icon;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_system_audio::init())
        .plugin(tauri_plugin_pip::init())
        .invoke_handler(tauri::generate_handler![
            #[cfg(windows)]
            taskbar_icon::set_taskbar_icon
        ])
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
