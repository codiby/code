//! What the installer finds on the machine and what it does to it. The
//! screens only build a [`Plan`]; [`run`] carries it out on a blocking
//! thread and reports through [`Event`]s.
//!
//! On Windows the work is real (`windows.rs`). Elsewhere, or with
//! `CODIBY_INSTALLER_SIM` set, it is simulated (`sim.rs`) so the UI can be
//! developed with `nsh run` on any desktop.

use serde::{Deserialize, Serialize};
use tokio::sync::mpsc::UnboundedSender;

mod sim;
#[cfg(target_os = "windows")]
mod windows;

/// The port Codiby's server listens on inside WSL (as Settings → Remotes).
pub const WSL_PORT: u16 = 3112;

/// A WSL distro already on the machine.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Distro {
    pub name: String,
    pub running: bool,
    /// WSL 1 or 2; Codiby needs 2.
    pub version: u8,
    pub default: bool,
}

/// The newest Codiby Code release for Windows.
#[derive(Clone, Debug, PartialEq)]
pub struct Release {
    pub version: String,
    pub url: String,
    pub size: u64,
}

/// What the installer found, silently, when it opened.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Env {
    pub virtualization: bool,
    pub wsl: bool,
    pub distros: Vec<Distro>,
    /// The Codiby Code already installed, if any.
    pub app_version: Option<String>,
    pub latest: Option<Release>,
    pub app_running: bool,
    /// The plan saved before a restart, when the installer was reopened
    /// to finish it.
    pub resume: Option<Plan>,
}

impl Env {
    /// The distros Codiby can use (WSL 2).
    pub fn usable_distros(&self) -> Vec<Distro> {
        self.distros.iter().filter(|d| d.version == 2).cloned().collect()
    }

    /// Whether the app needs downloading (missing or older than the latest).
    pub fn needs_app(&self) -> bool {
        match (&self.app_version, &self.latest) {
            (None, _) => true,
            (Some(have), Some(latest)) => version_lt(have, &latest.version),
            (Some(_), None) => false,
        }
    }
}

/// Which host runs Codiby's server.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum Base {
    #[default]
    Windows,
    Wsl,
}

/// A distro the installer can install.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum NewDistro {
    #[default]
    Ubuntu,
    Debian,
}

impl NewDistro {
    /// Its name for `wsl --install -d`, which is also its name once installed.
    pub fn id(self) -> &'static str {
        match self {
            NewDistro::Ubuntu => "Ubuntu-24.04",
            NewDistro::Debian => "Debian",
        }
    }

    /// The translation key of its display name.
    pub fn label_key(self) -> &'static str {
        match self {
            NewDistro::Ubuntu => "distro.ubuntu",
            NewDistro::Debian => "distro.debian",
        }
    }
}

/// Everything the screens decided.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Plan {
    pub base: Base,
    /// Download and install the app.
    pub install_app: bool,
    pub release_url: Option<String>,
    /// Its size, for the download's progress.
    #[serde(default)]
    pub release_size: u64,
    /// Turn on WSL itself: needs an administrator and a restart.
    pub enable_wsl: bool,
    pub new_distro: Option<NewDistro>,
    /// The Linux user of the new distro.
    pub user: Option<String>,
    /// Never saved: asked again after a restart.
    #[serde(skip)]
    pub password: String,
    /// The WSL base's distro.
    pub base_distro: Option<String>,
    /// The Windows base's WSL hosts.
    pub host_distros: Vec<String>,
    pub port: u16,
    /// Set when the installer reopens after the restart.
    pub after_reboot: bool,
}

/// One step of the installation, in order.
#[derive(Clone, Debug, PartialEq)]
pub enum Step {
    Download,
    InstallApp,
    EnableWsl,
    InstallDistro(String),
    CreateUser(String),
    Packages(String),
    Bridge(String),
    AddHost(String),
    BaseWsl(String),
    BaseWindows,
    Verify,
}

impl Plan {
    /// The steps, in order. With WSL to turn on, they stop there: the rest
    /// runs after the restart.
    pub fn steps(&self) -> Vec<Step> {
        let mut steps = Vec::new();
        if !self.after_reboot {
            if self.install_app {
                steps.push(Step::Download);
                steps.push(Step::InstallApp);
            }
            if self.enable_wsl {
                steps.push(Step::EnableWsl);
                return steps;
            }
        }
        if let Some(distro) = self.new_distro {
            steps.push(Step::InstallDistro(distro.id().to_owned()));
            steps.push(Step::CreateUser(distro.id().to_owned()));
        }
        match self.base {
            Base::Wsl => {
                if let Some(distro) = &self.base_distro {
                    steps.push(Step::Packages(distro.clone()));
                    steps.push(Step::Bridge(distro.clone()));
                    steps.push(Step::BaseWsl(distro.clone()));
                    steps.push(Step::Verify);
                }
            }
            Base::Windows => {
                steps.push(Step::BaseWindows);
                for distro in &self.host_distros {
                    steps.push(Step::Packages(distro.clone()));
                    steps.push(Step::Bridge(distro.clone()));
                    steps.push(Step::AddHost(distro.clone()));
                }
            }
        }
        steps
    }
}

/// What the work reports while it runs.
#[derive(Clone, Debug, PartialEq)]
pub enum Event {
    /// Step `index` of [`Plan::steps`] started.
    Step(usize),
    /// The download's progress, 0 to 100.
    Percent(u8),
    Log(String),
}

/// How the work ended.
#[derive(Clone, Debug, PartialEq)]
pub enum Outcome {
    Done,
    /// WSL was turned on; Windows has to restart to finish.
    Reboot,
}

/// Sends events from the work; a closed UI just stops listening.
#[derive(Clone)]
pub struct Reporter(UnboundedSender<Event>);

impl Reporter {
    pub fn new(tx: UnboundedSender<Event>) -> Self {
        Reporter(tx)
    }
    pub fn step(&self, index: usize) {
        let _ = self.0.send(Event::Step(index));
    }
    pub fn percent(&self, pct: u8) {
        let _ = self.0.send(Event::Percent(pct));
    }
    pub fn log(&self, line: impl Into<String>) {
        let _ = self.0.send(Event::Log(line.into()));
    }
}

fn simulated() -> Option<String> {
    std::env::var("CODIBY_INSTALLER_SIM").ok().filter(|s| !s.is_empty())
}

/// Looks at the machine. Blocking: call it inside `blocking`.
pub fn detect() -> Env {
    #[cfg(target_os = "windows")]
    if simulated().is_none() {
        return windows::detect();
    }
    sim::detect(simulated().as_deref().unwrap_or("ok"))
}

/// Carries out `plan`. Blocking: call it inside `blocking`.
pub fn run(plan: Plan, report: Reporter) -> Result<Outcome, String> {
    #[cfg(target_os = "windows")]
    if simulated().is_none() {
        return windows::run(plan, report);
    }
    sim::run(plan, report)
}

/// Restarts Windows (the simulation only logs it).
pub fn reboot() {
    #[cfg(target_os = "windows")]
    if simulated().is_none() {
        windows::reboot();
        return;
    }
    log::info!("simulated restart");
}

/// Opens Codiby Code (the simulation only logs it).
pub fn open_app(base: Base) {
    #[cfg(target_os = "windows")]
    if simulated().is_none() {
        windows::open_app(base);
        return;
    }
    log::info!("simulated open ({base:?})");
}

/// Whether version `a` is older than `b` ("0.31.109" style, an optional "v").
pub fn version_lt(a: &str, b: &str) -> bool {
    let parse = |v: &str| -> Vec<u64> {
        v.trim_start_matches('v')
            .split('.')
            .map(|p| p.parse().unwrap_or(0))
            .collect()
    };
    let (mut a, mut b) = (parse(a), parse(b));
    let len = a.len().max(b.len());
    a.resize(len, 0);
    b.resize(len, 0);
    a < b
}

/// Reads `wsl -l -v`: `* Ubuntu    Running    2`, the star on the default.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(crate) fn parse_distros(listing: &str) -> Vec<Distro> {
    listing
        .lines()
        .skip(1)
        .filter_map(|line| {
            let default = line.trim_start().starts_with('*');
            let mut parts = line.trim_start().trim_start_matches('*').split_whitespace();
            let (name, state, version) = (parts.next()?, parts.next()?, parts.next()?);
            (!name.starts_with("docker-desktop")).then(|| Distro {
                name: name.to_owned(),
                running: state.eq_ignore_ascii_case("running"),
                version: version.parse().unwrap_or(2),
                default,
            })
        })
        .collect()
}

/// Whether `name` is a valid Linux user name for `useradd`.
pub fn valid_user(name: &str) -> bool {
    let mut chars = name.chars();
    matches!(chars.next(), Some('a'..='z' | '_'))
        && name.len() <= 32
        && chars.all(|c| matches!(c, 'a'..='z' | '0'..='9' | '_' | '-'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_distro_listing() {
        let listing = "  NAME            STATE           VERSION\n\
                       * Ubuntu          Running         2\n  \
                       Debian          Stopped         1\n  \
                       docker-desktop  Stopped         2\n";
        let distros = parse_distros(listing);
        assert_eq!(distros.len(), 2);
        assert!(distros[0].default && distros[0].running && distros[0].version == 2);
        assert!(!distros[1].default && !distros[1].running && distros[1].version == 1);
    }

    #[test]
    fn versions_compare_by_number() {
        assert!(version_lt("0.31.9", "0.31.109"));
        assert!(version_lt("0.31.109", "v0.32.0"));
        assert!(!version_lt("0.31.109.0", "0.31.109"));
        assert!(!version_lt("1.0.0", "0.99.99"));
    }

    #[test]
    fn user_names_follow_useradd() {
        assert!(valid_user("jovaz"));
        assert!(valid_user("dev_2"));
        assert!(!valid_user("Jovaz"));
        assert!(!valid_user("2dev"));
        assert!(!valid_user(""));
        assert!(!valid_user("a b"));
    }

    #[test]
    fn enabling_wsl_stops_before_the_restart() {
        let plan = Plan {
            base: Base::Wsl,
            install_app: true,
            enable_wsl: true,
            new_distro: Some(NewDistro::Ubuntu),
            base_distro: Some("Ubuntu-24.04".into()),
            ..Plan::default()
        };
        assert_eq!(plan.steps(), vec![Step::Download, Step::InstallApp, Step::EnableWsl]);
        let after = Plan { after_reboot: true, ..plan };
        assert_eq!(
            after.steps(),
            vec![
                Step::InstallDistro("Ubuntu-24.04".into()),
                Step::CreateUser("Ubuntu-24.04".into()),
                Step::Packages("Ubuntu-24.04".into()),
                Step::Bridge("Ubuntu-24.04".into()),
                Step::BaseWsl("Ubuntu-24.04".into()),
                Step::Verify,
            ]
        );
    }

    #[test]
    fn the_windows_base_adds_each_host() {
        let plan = Plan {
            host_distros: vec!["Ubuntu".into()],
            ..Plan::default()
        };
        assert_eq!(
            plan.steps(),
            vec![
                Step::BaseWindows,
                Step::Packages("Ubuntu".into()),
                Step::Bridge("Ubuntu".into()),
                Step::AddHost("Ubuntu".into()),
            ]
        );
    }
}
