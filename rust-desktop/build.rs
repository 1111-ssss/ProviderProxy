fn main() {
    if std::env::var_os("CARGO_FEATURE_DESKTOP").is_some() {
        let attributes = tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&[
                "check_for_update",
                "install_update",
                "restart_app",
                "autostart_enabled",
                "set_autostart",
                "autostart_tray_enabled",
                "create_app_shortcut",
            ]),
        );
        tauri_build::try_build(attributes).expect("failed to run tauri-build");
    }
}
