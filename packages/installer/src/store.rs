//! The wizard's state: which screen shows, what the user picked, and how the
//! installation is going. Screens read it in bindings and change it through
//! these functions.

use nsh_core::prelude::*;

use crate::system::{self, Base, Env, Event, NewDistro, Outcome, Plan, Reporter, Step};

/// The wizard's screens.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Screen {
    #[default]
    Welcome,
    Base,
    Hosts,
    InstallWsl,
    User,
    Distro,
    NoVirt,
    Summary,
    Progress,
    Reboot,
    Done,
}

/// Why the "install WSL" screen shows.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum InstallMode {
    /// WSL itself is missing.
    #[default]
    New,
    /// WSL is there, with no distro.
    Distro,
    /// The user asked for one more distro.
    Add,
}

/// How the installation is going.
#[derive(Clone, Debug, Default, PartialEq)]
pub enum Run {
    #[default]
    Idle,
    Running,
    Failed(String),
}

/// The screen has a signal of its own: the window rebuilds its content when
/// it changes, and must not on every keystroke elsewhere.
#[derive(Clone, Copy, Default)]
struct Current(Screen);

fn current_screen() -> Signal<Current> {
    global::<Current>()
}

#[derive(Clone, Default)]
struct Wizard {
    /// `None` while the machine is still being looked at.
    env: Option<Env>,
    base: Base,
    /// The WSL base's existing distro.
    distro: Option<String>,
    new_distro: NewDistro,
    mode: InstallMode,
    /// A new distro gets installed (the WSL base's, or a Windows host).
    use_new: bool,
    /// The Windows base's existing distros to add as hosts.
    hosts: Vec<String>,
    host_new: bool,
    user: String,
    password: String,
    repeat: String,
    steps: Vec<Step>,
    current: usize,
    percent: Option<u8>,
    log: Vec<String>,
    run: Run,
    show_log: bool,
    /// The plan saved before the restart, when finishing it.
    resumed: Option<Plan>,
}

fn wizard() -> Signal<Wizard> {
    global::<Wizard>()
}

fn read<R>(f: impl FnOnce(&Wizard) -> R) -> R {
    wizard().with(f)
}

fn write(f: impl FnOnce(&mut Wizard)) {
    wizard().update(f);
}

// --- Reading (tracked where read) --------------------------------------------

pub fn screen() -> Screen {
    current_screen().get().0
}
pub fn env() -> Env {
    read(|w| w.env.clone().unwrap_or_default())
}
pub fn detected() -> bool {
    read(|w| w.env.is_some())
}
pub fn base() -> Base {
    read(|w| w.base)
}
pub fn distro() -> Option<String> {
    read(|w| w.distro.clone())
}
pub fn new_distro() -> NewDistro {
    read(|w| w.new_distro)
}
pub fn mode() -> InstallMode {
    read(|w| w.mode)
}
pub fn hosts() -> Vec<String> {
    read(|w| w.hosts.clone())
}
pub fn host_new() -> bool {
    read(|w| w.host_new)
}
pub fn user() -> String {
    read(|w| w.user.clone())
}
pub fn password() -> String {
    read(|w| w.password.clone())
}
pub fn repeat() -> String {
    read(|w| w.repeat.clone())
}
pub fn steps() -> Vec<Step> {
    read(|w| w.steps.clone())
}
pub fn current() -> usize {
    read(|w| w.current)
}
pub fn percent() -> Option<u8> {
    read(|w| w.percent)
}
pub fn log_lines() -> Vec<String> {
    read(|w| w.log.clone())
}
pub fn run_state() -> Run {
    read(|w| w.run.clone())
}
pub fn show_log() -> bool {
    read(|w| w.show_log)
}
pub fn resumed() -> bool {
    read(|w| w.resumed.is_some())
}
pub fn use_new() -> bool {
    read(|w| w.use_new)
}

/// WSL can be used: it is there, or it was turned on before the restart.
pub fn has_wsl() -> bool {
    read(|w| w.resumed.is_some() || w.env.as_ref().is_some_and(|e| e.wsl))
}
pub fn has_distro() -> bool {
    read(|w| w.env.as_ref().is_some_and(|e| !e.usable_distros().is_empty()))
}
pub fn virtualization() -> bool {
    read(|w| w.env.as_ref().is_none_or(|e| e.virtualization))
}

/// The progress of the whole installation, 0 to 1.
pub fn progress() -> f32 {
    read(|w| {
        let total = w.steps.len().max(1) as f32;
        let within = match (w.steps.get(w.current), w.percent) {
            (Some(Step::Download), Some(pct)) => pct as f32 / 100.0,
            _ => 0.5,
        };
        ((w.current as f32 + within) / total).clamp(0.0, 1.0)
    })
}

/// The user's form is complete and valid.
pub fn user_ok() -> bool {
    read(|w| system::valid_user(&w.user) && !w.password.is_empty() && w.password == w.repeat)
}

// --- Writing -----------------------------------------------------------------

pub fn go(screen: Screen) {
    current_screen().set(Current(screen));
}
pub fn set_base(base: Base) {
    write(|w| w.base = base);
}
pub fn set_distro(name: String) {
    write(|w| w.distro = Some(name));
}
pub fn set_new_distro(distro: NewDistro) {
    write(|w| w.new_distro = distro);
}
pub fn set_mode(mode: InstallMode) {
    write(|w| w.mode = mode);
}
pub fn toggle_host(name: String) {
    write(|w| {
        if let Some(i) = w.hosts.iter().position(|h| *h == name) {
            w.hosts.remove(i);
        } else {
            w.hosts.push(name);
        }
    });
}
pub fn set_host_new(on: bool) {
    write(|w| w.host_new = on);
}
pub fn clear_hosts() {
    write(|w| {
        w.hosts.clear();
        w.host_new = false;
    });
}
pub fn set_user(value: String) {
    write(|w| w.user = value);
}
pub fn set_password(value: String) {
    write(|w| w.password = value);
}
pub fn set_repeat(value: String) {
    write(|w| w.repeat = value);
}
pub fn toggle_log() {
    write(|w| w.show_log = !w.show_log);
}

/// Stores what the machine looked like. A saved plan means the installer
/// reopened after the restart: it asks for the password and carries on.
pub fn detected_env(env: Env) {
    let mut next = None;
    write(|w| {
        if let Some(plan) = env.resume.clone() {
            w.user = plan.user.clone().unwrap_or_default();
            w.base = plan.base;
            w.use_new = plan.new_distro.is_some();
            w.new_distro = plan.new_distro.unwrap_or_default();
            w.resumed = Some(plan);
            next = Some(if w.use_new { Screen::User } else { Screen::Progress });
        }
        let default = env.usable_distros().into_iter().find(|d| d.default).or_else(|| env.usable_distros().into_iter().next());
        w.distro = default.as_ref().map(|d| d.name.clone());
        w.hosts = default.map(|d| vec![d.name]).unwrap_or_default();
        w.env = Some(env);
    });
    if let Some(screen) = next {
        go(screen);
    }
}

// --- Navigation --------------------------------------------------------------

/// From the base screen.
pub fn after_base() {
    let next = match base() {
        Base::Windows if !virtualization() => Screen::Summary,
        Base::Windows => Screen::Hosts,
        Base::Wsl if !virtualization() => Screen::NoVirt,
        Base::Wsl if !has_wsl() => {
            set_mode(InstallMode::New);
            Screen::InstallWsl
        }
        Base::Wsl if !has_distro() => {
            set_mode(InstallMode::Distro);
            Screen::InstallWsl
        }
        Base::Wsl => Screen::Distro,
    };
    go(next);
}

/// From the hosts screen: a new distro needs its user first.
pub fn after_hosts() {
    let new = host_new();
    write(|w| w.use_new = new);
    if new {
        set_mode(if has_wsl() { InstallMode::Distro } else { InstallMode::New });
        go(Screen::InstallWsl);
    } else {
        go(Screen::Summary);
    }
}

/// From the distro screen: an existing distro.
pub fn after_distro() {
    write(|w| w.use_new = false);
    go(Screen::Summary);
}

/// From the "install WSL" screen.
pub fn after_install_wsl() {
    write(|w| w.use_new = true);
    go(Screen::User);
}

/// From the user screen: after a restart it goes straight to the work.
pub fn after_user() {
    go(if resumed() { Screen::Progress } else { Screen::Summary });
}

pub fn back_from_summary() {
    let next = match base() {
        Base::Windows if host_new() => Screen::User,
        Base::Windows if virtualization() => Screen::Hosts,
        Base::Windows => Screen::Base,
        Base::Wsl if use_new() => Screen::User,
        Base::Wsl => Screen::Distro,
    };
    go(next);
}

pub fn back_from_user() {
    go(Screen::InstallWsl);
}

pub fn back_from_install_wsl() {
    let next = match (base(), mode()) {
        (Base::Windows, _) => Screen::Hosts,
        (Base::Wsl, InstallMode::Add) => Screen::Distro,
        (Base::Wsl, _) => Screen::Base,
    };
    go(next);
}

pub fn use_windows() {
    set_base(Base::Windows);
    go(Screen::Summary);
}

// --- The plan ----------------------------------------------------------------

/// What the screens decided (untracked: read when the work starts).
pub fn plan() -> Plan {
    wizard().with_untracked(|w| {
        if let Some(plan) = &w.resumed {
            return Plan {
                password: w.password.clone(),
                ..plan.clone()
            };
        }
        let env = w.env.clone().unwrap_or_default();
        let new = w.use_new.then_some(w.new_distro);
        let new_id = new.map(|d| d.id().to_owned());
        Plan {
            base: w.base,
            install_app: env.needs_app(),
            release_url: env.latest.as_ref().map(|r| r.url.clone()),
            release_size: env.latest.as_ref().map_or(0, |r| r.size),
            enable_wsl: new.is_some() && !env.wsl,
            new_distro: new,
            user: new.map(|_| w.user.clone()),
            password: w.password.clone(),
            base_distro: match w.base {
                Base::Wsl => new_id.clone().or_else(|| w.distro.clone()),
                Base::Windows => None,
            },
            host_distros: match w.base {
                Base::Windows => w.hosts.iter().cloned().chain(new_id).collect(),
                Base::Wsl => Vec::new(),
            },
            port: system::WSL_PORT,
            after_reboot: false,
        }
    })
}

// --- The work ----------------------------------------------------------------

fn apply(event: Event) {
    write(|w| match event {
        Event::Step(i) => {
            w.current = i;
            w.percent = None;
        }
        Event::Percent(pct) => w.percent = Some(pct),
        Event::Log(line) => {
            w.log.push(line);
            let extra = w.log.len().saturating_sub(400);
            w.log.drain(..extra);
        }
    });
}

/// Starts the installation. Called by the progress screen, which owns the
/// task: it stays mounted until the work ends.
pub fn start_install() {
    let plan = plan();
    let steps = plan.steps();
    write(|w| {
        w.steps = steps;
        w.current = 0;
        w.percent = None;
        w.log.clear();
        w.run = Run::Running;
    });
    spawn(async move {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let report = Reporter::new(tx);
        let mut work = std::pin::pin!(blocking(move || system::run(plan, report)));
        let result = loop {
            tokio::select! {
                result = &mut work => break result,
                Some(event) = rx.recv() => apply(event),
            }
        };
        while let Ok(event) = rx.try_recv() {
            apply(event);
        }
        match result {
            Ok(Ok(Outcome::Done)) => {
                write(|w| w.run = Run::Idle);
                go(Screen::Done);
            }
            Ok(Ok(Outcome::Reboot)) => {
                write(|w| w.run = Run::Idle);
                go(Screen::Reboot);
            }
            Ok(Err(error)) => write(|w| {
                w.log.push(error.clone());
                w.run = Run::Failed(error);
                w.show_log = true;
            }),
            Err(error) => write(|w| w.run = Run::Failed(error.to_string())),
        }
    });
}

/// Looks at the machine once, in the background, when the app opens.
pub fn start_detect() {
    spawn(async move {
        match blocking(system::detect).await {
            Ok(env) => detected_env(env),
            Err(error) => {
                log::warn!("detect: {error}");
                detected_env(Env {
                    virtualization: true,
                    ..Env::default()
                });
            }
        }
    });
}
