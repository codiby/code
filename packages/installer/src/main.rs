//! Starts the installer as a Windows window when built with Cargo
//! (`./build.sh`, `cargo xwin build`). `nsh package` builds its own runner
//! from `nsh.json` and skips this file.

#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

#[cfg(target_os = "windows")]
fn main() -> std::process::ExitCode {
    use nsh_platform_windows as platform;

    env_logger::init();
    let root = platform::Root::of::<codiby_installer::App>()
        // The UI text in every language (`t!`), from `locales/`.
        .translations_json(codiby_installer::TRANSLATIONS)
        // Fixed, centered, no system frame: the app draws its title bar.
        .main_window_json(codiby_installer::WINDOW);
    platform::run_app(
        platform::AppSource::Rust(root),
        platform::AppOptions {
            title: "Codiby Code".to_owned(),
            app_id: "com.codiby.installer".to_owned(),
            size: (560, 520),
            ..Default::default()
        },
    )
}

#[cfg(not(target_os = "windows"))]
fn main() {
    eprintln!(
        "This binary is for Windows. Elsewhere, preview the screens with \
         `CODIBY_INSTALLER_SIM=ok nsh run`."
    );
}
