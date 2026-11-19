//! Codiby Code's installer for Windows: installs the app and makes Windows or
//! a WSL distro its base host. `nsh.json`'s `"root"` names [`App`].

mod screens;
mod store;
pub mod system;
mod ui;

use nsh_core::prelude::*;

/// The UI text in every language (`locales/`), for builds without `nsh`
/// (`build.rs` writes it).
pub const TRANSLATIONS: &str = include_str!(concat!(env!("OUT_DIR"), "/translations.json"));

/// The main window's options (`nsh.json`'s `"window"`), for builds without
/// `nsh`.
pub const WINDOW: &str = include_str!(concat!(env!("OUT_DIR"), "/window.json"));

/// The app's UI set (`nsh.json` `"rust"`).
#[native_module("codiby-installer/native")]
fn native(registry: &mut Registry) {
    registry.register::<App>();
}

/// The window: its own title bar, the current screen centered, the stage
/// dots under it, all inside a 1px border (the window has no system frame).
#[component]
pub fn App() -> impl IntoElement {
    store::start_detect();
    view()
        .flex_1()
        .bg(rgb(ui::BACKGROUND))
        .border_1()
        .border_color(rgb(ui::BORDER))
        .child(ui::title_bar())
        .child(
            view()
                .flex_1()
                .items_center()
                .justify_center()
                .px(px(56.0))
                .pb_2()
                .child(dynamic(|| screens::show(store::screen()))),
        )
        .child(view().pb_5().child(ui::dots(
            || screens::stage(store::screen()),
            screens::STAGES,
        )))
}
