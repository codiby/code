//! The wizard's flows, as a user takes them, on a simulated machine
//! (`CODIBY_INSTALLER_SIM`). The variable is process-wide, so the flows run
//! one at a time.

use std::{
    path::Path,
    sync::{Mutex, MutexGuard},
    time::Duration,
};

use nsh_core::platform::{Languages, Locale};
use nsh_engine::{EngineConfig, Root};
use nsh_testing::Headless;

static MACHINE: Mutex<()> = Mutex::new(());

struct App {
    app: Headless,
    _machine: MutexGuard<'static, ()>,
}

impl std::ops::Deref for App {
    type Target = Headless;
    fn deref(&self) -> &Headless {
        &self.app
    }
}
impl std::ops::DerefMut for App {
    fn deref_mut(&mut self) -> &mut Headless {
        &mut self.app
    }
}

/// Opens the installer on a `machine` (`ok`, `nodistro`, `nowsl`, `novirt`,
/// `fail`), in `locale`.
fn open(machine: &str, locale: &str) -> App {
    let guard = MACHINE.lock().unwrap_or_else(|e| e.into_inner());
    // SAFETY: MACHINE keeps every other flow out while this one runs.
    unsafe {
        std::env::set_var("CODIBY_INSTALLER_SIM", machine);
        std::env::set_var("CODIBY_INSTALLER_SIM_MS", "30");
    }
    let translations = nsh_i18n::read_translations(Path::new(env!("CARGO_MANIFEST_DIR"))).unwrap();
    let root = Root::of::<codiby_installer::App>()
        .translations_json(&nsh_i18n::translations_json(&translations));
    let mut config = EngineConfig::new(root);
    config.pinned.locale = Locale::parse(locale);
    config.pinned.languages = Languages::parse([locale]);
    App {
        app: Headless::start(config).unwrap(),
        _machine: guard,
    }
}

/// Presses `selector` once it is enabled (the first screen waits for the
/// machine to be looked at).
fn press(app: &mut Headless, selector: &str) {
    app.wait_until(&format!("{selector} enabled"), Duration::from_secs(5), |s| {
        s.enabled(selector) == Ok(true)
    })
    .unwrap();
    app.press(selector).unwrap();
}

#[test]
fn wsl_base_on_an_existing_distro() {
    let mut app = open("ok", "en-US");
    app.wait_for("Install Codiby Code").unwrap();
    press(&mut app, "role:button[Get started]");
    app.wait_for("Where does Codiby run?").unwrap();
    press(&mut app, "Linux tools. SSH hosts work.");
    press(&mut app, "role:button[Continue]");
    app.wait_for("Which distro?").unwrap();
    assert!(app.screen().shows("Ubuntu"));
    press(&mut app, "role:button[Continue]");
    app.wait_for("All set").unwrap();
    assert!(app.screen().shows("Start the WSL server"));
    press(&mut app, "role:button[Install]");
    app.wait_for("Codiby Code is ready").unwrap();
    assert!(app.screen().shows("WSL base on Ubuntu."));
}

#[test]
fn without_wsl_it_installs_it_and_asks_to_restart() {
    let mut app = open("nowsl", "es");
    app.wait_for("Instalar Codiby Code").unwrap();
    press(&mut app, "role:button[Empezar]");
    app.wait_for("se instala WSL").unwrap();
    press(&mut app, "Herramientas de Linux. Los hosts SSH funcionan.");
    app.wait_for("Se instala WSL. Windows pide permiso de administrador y hay que reiniciar una vez.")
        .unwrap();
    press(&mut app, "role:button[Continuar]");
    app.wait_for("WSL no está instalado").unwrap();
    press(&mut app, "role:button[Instalar WSL]");
    app.wait_for("Usuario de Linux").unwrap();
    assert!(!app.screen().enabled("role:button[Continuar]").unwrap());
    app.type_text("id:user", "2dev").unwrap();
    app.wait_for("Usa minúsculas, números, guion o guion bajo, empezando con una letra.")
        .unwrap();
    app.clear("id:user").unwrap();
    app.type_text("id:user", "jovaz").unwrap();
    app.type_text("id:password", "secreta").unwrap();
    app.type_text("id:repeat", "otra").unwrap();
    app.wait_for("Las contraseñas no coinciden.").unwrap();
    assert!(!app.screen().enabled("role:button[Continuar]").unwrap());
    app.clear("id:repeat").unwrap();
    app.type_text("id:repeat", "secreta").unwrap();
    app.wait_for_gone("Las contraseñas no coinciden.", Duration::from_secs(2))
        .unwrap();
    press(&mut app, "role:button[Continuar]");
    app.wait_for("Todo listo").unwrap();
    assert!(app.screen().shows("Instalar WSL · reinicio"));
    assert!(app.screen().shows("Ubuntu 24.04 LTS (nueva)"));
    press(&mut app, "role:button[Instalar]");
    app.wait_for("Hay que reiniciar Windows").unwrap();
}

#[test]
fn without_virtualization_only_windows_is_offered() {
    let mut app = open("novirt", "en-US");
    press(&mut app, "role:button[Get started]");
    app.wait_for("unavailable").unwrap();
    assert!(app.screen().shows(
        "WSL isn't available because virtualization is turned off. You can turn it on later and run the installer again."
    ));
    press(&mut app, "role:button[Continue]");
    app.wait_for("All set").unwrap();
    assert!(app.screen().shows("Windows"));
}

#[test]
fn the_windows_base_adds_the_distro_as_a_host() {
    let mut app = open("ok", "en-US");
    press(&mut app, "role:button[Get started]");
    press(&mut app, "role:button[Continue]");
    app.wait_for("Add WSL as a host").unwrap();
    press(&mut app, "role:button[Continue]");
    app.wait_for("All set").unwrap();
    assert!(app.screen().shows("Ubuntu"));
    press(&mut app, "role:button[Install]");
    app.wait_for("Windows base. Ubuntu was added as a host.").unwrap();
}

#[test]
fn a_failure_shows_the_log_and_can_be_retried() {
    let mut app = open("fail", "en-US");
    press(&mut app, "role:button[Get started]");
    press(&mut app, "role:button[Continue]");
    press(&mut app, "role:button[Continue]");
    press(&mut app, "role:button[Install]");
    app.wait_for("Something failed").unwrap();
    assert_eq!(app.screen().matches("role:button[Retry]"), Ok(true));
    assert!(app.screen().shows("Hide details"));
}

#[test]
fn the_language_switches_at_run_time() {
    let mut app = open("ok", "es");
    app.wait_for("Instalar Codiby Code").unwrap();
    press(&mut app, "role:button[English]");
    app.wait_for("Install Codiby Code").unwrap();
    press(&mut app, "role:button[Español]");
    app.wait_for("Instalar Codiby Code").unwrap();
}
