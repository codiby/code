//! A pretend machine, for developing the screens anywhere:
//! `CODIBY_INSTALLER_SIM=ok|nodistro|nowsl|novirt|fail nsh run`.

use std::{thread::sleep, time::Duration};

use super::{Distro, Env, Outcome, Plan, Release, Reporter, Step};

/// How long a pretend step takes (`CODIBY_INSTALLER_SIM_MS`, 600 by default).
fn pause(factor: u64) {
    let ms = std::env::var("CODIBY_INSTALLER_SIM_MS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(600u64);
    sleep(Duration::from_millis(ms * factor / 6));
}

pub(super) fn detect(kind: &str) -> Env {
    pause(3);
    let wsl = matches!(kind, "ok" | "nodistro" | "fail");
    Env {
        virtualization: kind != "novirt",
        wsl,
        distros: if matches!(kind, "ok" | "fail") {
            vec![Distro {
                name: "Ubuntu".into(),
                running: true,
                version: 2,
                default: true,
            }]
        } else {
            Vec::new()
        },
        app_version: None,
        latest: Some(Release {
            version: "0.31.109".into(),
            url: "https://example.invalid/Codiby.Code.Setup.exe".into(),
            size: 247_974_700,
        }),
        app_running: false,
        resume: None,
    }
}

pub(super) fn run(plan: Plan, report: Reporter) -> Result<Outcome, String> {
    let fail = std::env::var("CODIBY_INSTALLER_SIM").as_deref() == Ok("fail");
    for (i, step) in plan.steps().iter().enumerate() {
        report.step(i);
        report.log(format!("{step:?}"));
        if *step == Step::Download {
            for pct in (0..=100).step_by(10) {
                report.percent(pct);
                pause(1);
            }
        } else {
            pause(6);
        }
        if fail && matches!(step, Step::Bridge(_)) {
            return Err("simulated failure: curl: (6) Could not resolve host".into());
        }
        if *step == Step::EnableWsl {
            return Ok(Outcome::Reboot);
        }
    }
    Ok(Outcome::Done)
}
