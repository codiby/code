//! One function per screen of the wizard. Every text comes from `t!`.

use nsh_core::{
    element::{AnyElement, desktop::quit},
    i18n::set_locale,
    platform::Locale,
    prelude::*,
    t,
};

use crate::{
    store::{self, InstallMode, Run, Screen},
    system::{Base, NewDistro, Step},
    ui::{self, Mark},
};

/// The screen for `screen`.
pub fn show(screen: Screen) -> AnyElement {
    match screen {
        Screen::Welcome => welcome(),
        Screen::Base => base(),
        Screen::Hosts => hosts(),
        Screen::InstallWsl => install_wsl(),
        Screen::User => user(),
        Screen::Distro => distro(),
        Screen::NoVirt => novirt(),
        Screen::Summary => summary(),
        Screen::Progress => progress(),
        Screen::Reboot => reboot(),
        Screen::Done => done(),
    }
}

/// The stage `screen` belongs to, for the dots.
pub fn stage(screen: Screen) -> usize {
    match screen {
        Screen::Welcome => 0,
        Screen::Base => 1,
        Screen::Hosts | Screen::InstallWsl | Screen::User | Screen::Distro | Screen::NoVirt => 2,
        Screen::Summary => 3,
        Screen::Progress | Screen::Reboot | Screen::Done => 4,
    }
}

pub const STAGES: usize = 5;

fn none() -> Option<(String, bool)> {
    None
}

/// Switches between Spanish and English; `common.language` names the other.
fn toggle_language() {
    let to = if t!("common.language") == "English" { "en" } else { "es" };
    set_locale(Locale::parse(to));
}

fn version_line() -> String {
    let env = store::env();
    match env.latest {
        Some(release) => t!(
            "common.version",
            version = release.version,
            size = (release.size + 500_000) / 1_000_000
        ),
        None => t!("common.version_unknown"),
    }
}

// --- Welcome -----------------------------------------------------------------

fn welcome() -> AnyElement {
    ui::screen(vec![
        view().mb_5().child(ui::logo(68.0)).into_element(),
        ui::title(|| {
            if store::env().app_version.is_some() {
                t!("welcome.update_title")
            } else {
                t!("welcome.title")
            }
        }),
        ui::sub(version_line),
        ui::actions(vec![ui::primary_if(
            store::detected,
            || t!("welcome.start"),
            || store::go(Screen::Base),
        )]),
        view()
            .mt_5()
            .child(ui::link(Some(ui::GLOBE), || t!("common.language"), toggle_language))
            .into_element(),
    ])
    .into_element()
}

// --- Base --------------------------------------------------------------------

fn base() -> AnyElement {
    let wsl_pill = || {
        if !store::virtualization() {
            Some((t!("base.pill_unavailable"), true))
        } else if !store::has_wsl() {
            Some((t!("base.pill_install_wsl"), true))
        } else if !store::has_distro() {
            Some((t!("base.pill_install_distro"), true))
        } else {
            None
        }
    };
    let note = || {
        if !store::virtualization() {
            Some(t!("base.note_novirt"))
        } else if store::base() == Base::Wsl && !store::has_wsl() {
            Some(t!("base.note_install_wsl"))
        } else {
            None
        }
    };
    ui::screen(vec![
        ui::title(|| t!("base.title")),
        ui::sub(|| t!("base.sub")),
        ui::options(vec![
            ui::option(
                Mark::Radio,
                ui::MONITOR,
                || store::base() == Base::Windows,
                || true,
                || t!("base.windows"),
                || t!("base.windows_sub"),
                none,
                || store::set_base(Base::Windows),
            ),
            ui::option(
                Mark::Radio,
                ui::TERMINAL,
                || store::base() == Base::Wsl,
                store::virtualization,
                || t!("base.wsl"),
                || t!("base.wsl_sub"),
                wsl_pill,
                || store::set_base(Base::Wsl),
            ),
        ]),
        when(
            move || note().is_some(),
            move || ui::note(true, move || note().unwrap_or_default()),
        )
        .into_element(),
        ui::actions(vec![
            ui::ghost(|| t!("common.back"), || store::go(Screen::Welcome)),
            ui::primary(|| t!("common.continue"), store::after_base),
        ]),
    ])
    .into_element()
}

// --- Hosts (Windows base) ----------------------------------------------------

fn hosts() -> AnyElement {
    let env = store::env();
    let mut rows: Vec<AnyElement> = env
        .usable_distros()
        .into_iter()
        .map(|distro| {
            let name = distro.name.clone();
            let toggled = name.clone();
            let label = name.clone();
            let running = distro.running;
            ui::option(
                Mark::Check,
                ui::SERVER,
                move || store::hosts().contains(&name),
                || true,
                move || label.clone(),
                move || if running { t!("distro.running") } else { t!("distro.stopped") },
                none,
                move || store::toggle_host(toggled.clone()),
            )
        })
        .collect();
    if rows.is_empty() {
        rows.push(ui::option(
            Mark::Check,
            ui::PLUS,
            store::host_new,
            || true,
            || t!("hosts.install_new", distro = t!(store::new_distro().label_key())),
            || {
                if store::has_wsl() {
                    t!("hosts.install_new_sub_wsl")
                } else {
                    t!("hosts.install_new_sub_nowsl")
                }
            },
            none,
            || store::set_host_new(!store::host_new()),
        ));
    }
    rows.push(ui::option(
        Mark::Check,
        ui::BAN,
        || store::hosts().is_empty() && !store::host_new(),
        || true,
        || t!("hosts.none"),
        || t!("hosts.none_sub"),
        none,
        store::clear_hosts,
    ));
    ui::screen(vec![
        ui::title(|| t!("hosts.title")),
        ui::sub(|| t!("hosts.sub")),
        ui::options(rows),
        ui::actions(vec![
            ui::ghost(|| t!("common.back"), || store::go(Screen::Base)),
            ui::primary(|| t!("common.continue"), store::after_hosts),
        ]),
    ])
    .into_element()
}

// --- Install WSL or a distro -------------------------------------------------

fn new_distro_option(distro: NewDistro, detail: &'static str) -> AnyElement {
    ui::option(
        Mark::Radio,
        ui::SERVER,
        move || store::new_distro() == distro,
        || true,
        move || t!(distro.label_key()),
        move || t!(detail),
        none,
        move || store::set_new_distro(distro),
    )
}

fn install_wsl() -> AnyElement {
    let keys = || match store::mode() {
        InstallMode::New => ("install_wsl.title_new", "install_wsl.sub_new", "install_wsl.button_new"),
        InstallMode::Distro => (
            "install_wsl.title_distro",
            "install_wsl.sub_distro",
            "install_wsl.button_distro",
        ),
        InstallMode::Add => ("install_wsl.title_add", "install_wsl.sub_add", "install_wsl.button_distro"),
    };
    ui::screen(vec![
        ui::icon(ui::ALERT, ui::WARNING),
        ui::title(move || t!(keys().0)),
        ui::sub(move || t!(keys().1)),
        ui::options(vec![
            new_distro_option(NewDistro::Ubuntu, "distro.ubuntu_sub"),
            new_distro_option(NewDistro::Debian, "distro.debian_sub"),
        ]),
        ui::actions(vec![
            ui::ghost(|| t!("common.back"), store::back_from_install_wsl),
            ui::primary(move || t!(keys().2), store::after_install_wsl),
        ]),
    ])
    .into_element()
}

// --- Linux user --------------------------------------------------------------

fn user() -> AnyElement {
    let error = || {
        let name = store::user();
        if !name.is_empty() && !crate::system::valid_user(&name) {
            Some(t!("user.error_name"))
        } else if !store::repeat().is_empty() && store::password() != store::repeat() {
            Some(t!("user.error_mismatch"))
        } else {
            None
        }
    };
    let resumed = store::resumed();
    let mut children = vec![
        ui::icon(ui::USER, ui::ACCENT_LIGHT),
        ui::title(|| t!("user.title")),
        ui::sub(move || if resumed { t!("user.sub_resume") } else { t!("user.sub") }),
    ];
    let mut fields = view().w_full().gap_3().mb_2();
    if !resumed {
        fields = fields.child(ui::field("user", || t!("user.name"), false, store::user, |v| {
            store::set_user(v.trim().to_lowercase())
        }));
    }
    fields = fields.child(
        view()
            .flex_row()
            .gap_3()
            .child(ui::field("password", || t!("user.password"), true, store::password, store::set_password))
            .child(ui::field("repeat", || t!("user.repeat"), true, store::repeat, store::set_repeat)),
    );
    children.push(fields.into_element());
    children.push(
        view()
            .w_full()
            .h(px(20.0))
            .mb_3()
            .child(
                text(move || error().unwrap_or_default())
                    .text_size(px(12.0))
                    .text_color(rgb(ui::DANGER)),
            )
            .into_element(),
    );
    let mut buttons = Vec::new();
    if !resumed {
        buttons.push(ui::ghost(|| t!("common.back"), store::back_from_user));
    }
    buttons.push(ui::primary_if(store::user_ok, || t!("common.continue"), store::after_user));
    children.push(ui::actions(buttons));
    ui::screen(children).into_element()
}

// --- Distro (WSL base) -------------------------------------------------------

fn distro() -> AnyElement {
    let env = store::env();
    let mut rows: Vec<AnyElement> = env
        .usable_distros()
        .into_iter()
        .map(|distro| {
            let name = distro.name.clone();
            let chosen = name.clone();
            let label = name.clone();
            let (running, default) = (distro.running, distro.default);
            ui::option(
                Mark::Radio,
                ui::SERVER,
                move || store::distro().as_deref() == Some(name.as_str()),
                || true,
                move || label.clone(),
                move || if running { t!("distro.running") } else { t!("distro.stopped") },
                move || default.then(|| (t!("distro.default"), false)),
                move || store::set_distro(chosen.clone()),
            )
        })
        .collect();
    rows.push(ui::option(
        Mark::More,
        ui::PLUS,
        || false,
        || true,
        || t!("distro.add"),
        || t!("distro.add_sub"),
        none,
        || {
            store::set_mode(InstallMode::Add);
            store::go(Screen::InstallWsl);
        },
    ));
    ui::screen(vec![
        ui::title(|| t!("distro.title")),
        ui::sub(|| t!("distro.sub")),
        ui::options(rows),
        ui::actions(vec![
            ui::ghost(|| t!("common.back"), || store::go(Screen::Base)),
            ui::primary_if(|| store::distro().is_some(), || t!("common.continue"), store::after_distro),
        ]),
    ])
    .into_element()
}

// --- Virtualization off ------------------------------------------------------

fn novirt() -> AnyElement {
    ui::screen(vec![
        ui::icon(ui::CPU, ui::DANGER),
        ui::title(|| t!("novirt.title")),
        ui::sub(|| t!("novirt.sub")),
        ui::actions(vec![
            ui::ghost(|| t!("common.back"), || store::go(Screen::Base)),
            ui::primary(|| t!("novirt.use_windows"), store::use_windows),
        ]),
    ])
    .into_element()
}

// --- Summary -----------------------------------------------------------------

fn summary_rows() -> Vec<(String, String)> {
    let env = store::env();
    let plan = store::plan();
    let version = if env.needs_app() {
        env.latest.map(|r| r.version).unwrap_or_else(|| t!("common.version_unknown"))
    } else {
        format!("{} · {}", env.app_version.unwrap_or_default(), t!("summary.keep"))
    };
    let mut rows = vec![(t!("summary.version"), version)];
    match plan.base {
        Base::Wsl => {
            rows.push((t!("summary.base"), t!("base.wsl")));
            let distro = match plan.new_distro {
                Some(new) => t!("summary.distro_new", distro = t!(new.label_key())),
                None => plan.base_distro.clone().unwrap_or_default(),
            };
            rows.push((t!("summary.distro"), distro));
            if plan.enable_wsl {
                rows.push((t!("summary.also"), t!("summary.also_wsl")));
            }
            rows.push((t!("summary.boot"), t!("summary.boot_wsl")));
        }
        Base::Windows => {
            rows.push((t!("summary.base"), t!("base.windows")));
            let hosts = if plan.host_distros.is_empty() {
                t!("summary.hosts_none")
            } else {
                plan.host_distros.join(", ")
            };
            rows.push((t!("summary.hosts"), hosts));
            if plan.enable_wsl {
                rows.push((t!("summary.also"), t!("summary.also_wsl")));
            }
        }
    }
    rows
}

fn summary() -> AnyElement {
    ui::screen(vec![
        ui::title(|| t!("summary.title")),
        ui::sub(|| t!("summary.sub")),
        ui::summary(summary_rows),
        ui::actions(vec![
            ui::ghost(|| t!("common.back"), store::back_from_summary),
            ui::primary(|| t!("summary.install"), || store::go(Screen::Progress)),
        ]),
    ])
    .into_element()
}

// --- Progress ----------------------------------------------------------------

fn step_label(step: &Step, percent: Option<u8>) -> String {
    match step {
        Step::Download => match percent {
            Some(pct) => t!("step.download_pct", pct = pct),
            None => t!("step.download"),
        },
        Step::InstallApp => t!("step.install_app"),
        Step::EnableWsl => t!("step.enable_wsl"),
        Step::InstallDistro(d) => t!("step.install_distro", distro = d),
        Step::CreateUser(_) => t!("step.create_user"),
        Step::Packages(_) => t!("step.packages"),
        Step::Bridge(d) => t!("step.bridge", distro = d),
        Step::AddHost(d) => t!("step.add_host", distro = d),
        Step::BaseWsl(_) => t!("step.base_wsl"),
        Step::BaseWindows => t!("step.base_windows"),
        Step::Verify => t!("step.verify"),
    }
}

fn progress() -> AnyElement {
    // The screen owns the work: it stays up until the work ends.
    store::start_install();
    let failed = || matches!(store::run_state(), Run::Failed(_));
    let status = move || match store::run_state() {
        Run::Failed(_) => t!("progress.failed"),
        _ => {
            let steps = store::steps();
            steps
                .get(store::current())
                .map(|step| step_label(step, store::percent()))
                .unwrap_or_default()
        }
    };
    ui::screen(vec![
        view().mb_5().child(ui::logo(52.0)).into_element(),
        ui::title(|| {
            if store::resumed() {
                t!("progress.title_resume")
            } else {
                t!("progress.title")
            }
        }),
        ui::progress_bar(store::progress),
        text(status)
            .text_size(px(12.5))
            .mb_2()
            .text_color(move || if failed() { rgb(ui::DANGER) } else { rgb(ui::MUTED) })
            .into_element(),
        when(store::show_log, || {
            scroll()
                .w_full()
                .h(px(110.0))
                .mt_2()
                .p_3()
                .rounded(px(12.0))
                .bg(rgb(ui::SURFACE))
                .border_1()
                .border_color(rgb(ui::BORDER))
                .child(
                    text(|| store::log_lines().join("\n"))
                        .text_size(px(11.5))
                        .font_family(SharedString::from("Cascadia Mono, Consolas, monospace"))
                        .text_color(rgb(ui::MUTED)),
                )
        })
        .into_element(),
        view()
            .mt_3()
            .child(ui::link(
                None,
                || if store::show_log() { t!("progress.hide") } else { t!("progress.details") },
                store::toggle_log,
            ))
            .into_element(),
        when(failed, || {
            view().mt_4().child(ui::actions(vec![
                ui::ghost(|| t!("common.close"), quit),
                ui::primary(|| t!("progress.retry"), store::start_install),
            ]))
        })
        .into_element(),
    ])
    .into_element()
}

// --- Reboot ------------------------------------------------------------------

fn reboot() -> AnyElement {
    ui::screen(vec![
        ui::icon(ui::ROTATE, ui::WARNING),
        ui::title(|| t!("reboot.title")),
        ui::sub(|| t!("reboot.sub")),
        ui::actions(vec![
            ui::ghost(|| t!("reboot.later"), quit),
            ui::primary(|| t!("reboot.now"), crate::system::reboot),
        ]),
    ])
    .into_element()
}

// --- Done --------------------------------------------------------------------

fn done() -> AnyElement {
    let plan = store::plan();
    let base = plan.base;
    let message = {
        let plan = plan.clone();
        move || match plan.base {
            Base::Wsl => t!("done.wsl", distro = plan.base_distro.clone().unwrap_or_default()),
            Base::Windows if plan.host_distros.is_empty() => t!("done.windows"),
            Base::Windows => t!("done.windows_hosts", hosts = plan.host_distros.join(", ")),
        }
    };
    let app_running = store::env().app_running;
    let mut children = vec![
        ui::icon(ui::CHECK, ui::SUCCESS),
        ui::title(|| t!("done.title")),
        ui::sub(message),
    ];
    if app_running {
        children.push(ui::note(true, || t!("done.app_running")));
    } else if base == Base::Wsl {
        children.push(ui::note(false, || t!("done.claude_login")));
    }
    children.push(ui::actions(vec![
        ui::ghost(|| t!("common.close"), quit),
        ui::primary(
            || t!("done.open"),
            move || {
                crate::system::open_app(base);
                quit();
            },
        ),
    ]));
    ui::screen(children).into_element()
}
