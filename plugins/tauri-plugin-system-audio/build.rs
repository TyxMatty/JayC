const COMMANDS: &[&str] = &["is_supported", "list_audio_apps", "window_process", "start_capture", "stop_capture"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).build();
}
