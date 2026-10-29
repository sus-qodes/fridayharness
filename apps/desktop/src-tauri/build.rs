// The app's own commands (lib.rs). Naming them here gives each an ACL permission
// (`allow-<command>`), so only the windows of capabilities/default.json may call them.
const COMMANDS: &[&str] = &[
    "friday_request",
    "confirm_and_send",
    "stream_open",
    "stream_close",
    "project_info",
    "daemon_status",
    "stop_daemon",
    "restart_daemon",
    "notch_rect",
    "notch_keyboard",
    "show_studio",
    "set_tray_state",
    "notify",
    "get_shortcuts",
    "set_shortcut",
    "open_in_editor",
    "open_in_browser",
    "store_key",
    "allow_spending",
    "get_autostart",
    "set_autostart",
];

fn main() {
    // The Friday checkout this app is built from (apps/desktop/src-tauri -> the repository root):
    // the second place, after FRIDAY_HOME, where the app looks for Friday's CLI.
    let manifest = std::path::PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    if let Some(home) = manifest.ancestors().nth(3) {
        println!("cargo:rustc-env=FRIDAY_BUILD_HOME={}", home.display());
    }
    let windows = std::env::var("CARGO_CFG_TARGET_OS").is_ok_and(|os| os == "windows");
    let mut attributes =
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(COMMANDS));
    if windows {
        // The application manifest is linked below into every artifact, tests included, so
        // tauri-build must not add a second one to the binary.
        attributes = attributes.windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
    }
    tauri_build::try_build(attributes).expect("tauri-build failed");
    if windows {
        app_manifest();
    }
}

/// Links `windows/app.manifest` (Common Controls 6, the manifest tauri-build would add) into the
/// binary *and* the test binaries. The native dialogs import `TaskDialogIndirect`, which only
/// Common Controls 6 exports: tauri-build links its manifest into binaries only, so the unit-test
/// binary stops before `main` with STATUS_ENTRYPOINT_NOT_FOUND (0xc0000139).
fn app_manifest() {
    let out = std::path::PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR"));
    let source = std::path::Path::new("windows").join("app.manifest");
    let manifest = out.join("app.manifest");
    std::fs::copy(&source, &manifest).expect("copy windows/app.manifest");
    let rc = out.join("app-manifest.rc");
    // RT_MANIFEST (24), CREATEPROCESS_MANIFEST_RESOURCE_ID (1); forward slashes: `\` escapes.
    let path = manifest.display().to_string().replace('\\', "/");
    std::fs::write(&rc, format!("1 24 \"{path}\"\n")).expect("write app-manifest.rc");
    embed_resource::compile_for_everything(&rc, embed_resource::NONE)
        .manifest_required()
        .expect("the application manifest could not be compiled (is windres on PATH?)");
    println!("cargo:rerun-if-changed=windows/app.manifest");
}
