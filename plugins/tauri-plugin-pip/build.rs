// Commands are implemented in Kotlin (android/) and invoked from JS as `plugin:pip|<name>`
// (snake_case here, camelCase in Kotlin). The listener commands back `addPluginListener`.
const COMMANDS: &[&str] = &["is_supported", "set_auto_enter", "enter", "register_listener", "remove_listener"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).android_path("android").build();
}
