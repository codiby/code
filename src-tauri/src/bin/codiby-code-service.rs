// Native Windows Service wrapper for the Codiby Code bridge server.
//
// Registers with the Service Control Manager (SCM), spawns `bun.exe run server.js`
// as a child process under `%PROGRAMDATA%\codiby\`, and forwards SCM stop/shutdown
// signals to kill the child cleanly. stdout/stderr are redirected to rotating-ish
// log files in `%PROGRAMDATA%\codiby\logs\`.
//
// This binary is a no-op on non-Windows platforms so the crate still type-checks
// from macOS/Linux developer boxes.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(not(windows))]
fn main() {
    eprintln!("codiby-code-service is a Windows-only binary");
    std::process::exit(1);
}

#[cfg(windows)]
fn main() -> windows_service::Result<()> {
    service::run()
}

#[cfg(windows)]
mod service {
    use std::ffi::OsString;
    use std::path::PathBuf;
    use std::process::Child;
    use std::sync::{Arc, Mutex};
    use std::thread;
    use std::time::Duration;

    use windows_service::service::{
        ServiceControl, ServiceControlAccept, ServiceExitCode, ServiceState, ServiceStatus,
        ServiceType,
    };
    use windows_service::service_control_handler::{self, ServiceControlHandlerResult};
    use windows_service::{define_windows_service, service_dispatcher};

    /// Must match the name used by `sc.exe create CodibyCodeBridge …`
    const SERVICE_NAME: &str = "CodibyCodeBridge";
    const SERVICE_TYPE: ServiceType = ServiceType::OWN_PROCESS;

    define_windows_service!(ffi_service_main, service_main);

    pub fn run() -> windows_service::Result<()> {
        service_dispatcher::start(SERVICE_NAME, ffi_service_main)
    }

    fn service_main(_args: Vec<OsString>) {
        if let Err(err) = run_service() {
            // Running under SCM; stderr goes nowhere unless redirected, so also
            // touch the logs dir with a best-effort panic marker.
            let _ = std::fs::write(
                data_dir().join("logs").join("service-fatal.log"),
                format!("{err}\n"),
            );
        }
    }

    fn data_dir() -> PathBuf {
        std::env::var_os("PROGRAMDATA")
            .map(|p| PathBuf::from(p).join("codiby"))
            .unwrap_or_else(|| PathBuf::from(r"C:\ProgramData\codiby"))
    }

    fn spawn_bridge() -> std::io::Result<Child> {
        let dir = data_dir();
        let bun = dir.join("bun.exe");
        let server_js = dir.join("server.js");
        let log_dir = dir.join("logs");
        std::fs::create_dir_all(&log_dir)?;

        let stdout = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(log_dir.join("stdout.log"))?;
        let stderr = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(log_dir.join("stderr.log"))?;

        std::process::Command::new(&bun)
            .arg("run")
            .arg(&server_js)
            .current_dir(&dir)
            .env("CLAUDE_UI_PORT", "3111")
            .env("CODIBY_CODE_PORT_FILE", dir.join("server.port"))
            .stdout(stdout)
            .stderr(stderr)
            .spawn()
    }

    fn run_service() -> Result<(), Box<dyn std::error::Error>> {
        let child = Arc::new(Mutex::new(spawn_bridge()?));
        let child_for_handler = Arc::clone(&child);

        let event_handler = move |control_event| -> ServiceControlHandlerResult {
            match control_event {
                ServiceControl::Stop | ServiceControl::Shutdown => {
                    if let Ok(mut c) = child_for_handler.lock() {
                        let _ = c.kill();
                    }
                    ServiceControlHandlerResult::NoError
                }
                ServiceControl::Interrogate => ServiceControlHandlerResult::NoError,
                _ => ServiceControlHandlerResult::NotImplemented,
            }
        };

        let status_handle = service_control_handler::register(SERVICE_NAME, event_handler)?;

        status_handle.set_service_status(ServiceStatus {
            service_type: SERVICE_TYPE,
            current_state: ServiceState::Running,
            controls_accepted: ServiceControlAccept::STOP | ServiceControlAccept::SHUTDOWN,
            exit_code: ServiceExitCode::Win32(0),
            checkpoint: 0,
            wait_hint: Duration::default(),
            process_id: None,
        })?;

        // Poll for child exit instead of blocking on wait() — blocking would
        // hold the mutex and prevent the control handler from killing the
        // child in response to SCM stop signals.
        let exit_code: u32 = loop {
            thread::sleep(Duration::from_millis(500));
            let status = {
                let mut guard = child.lock().unwrap();
                guard.try_wait()?
            };
            if let Some(status) = status {
                break status.code().unwrap_or(1) as u32;
            }
        };

        status_handle.set_service_status(ServiceStatus {
            service_type: SERVICE_TYPE,
            current_state: ServiceState::Stopped,
            controls_accepted: ServiceControlAccept::empty(),
            exit_code: ServiceExitCode::Win32(exit_code),
            checkpoint: 0,
            wait_hint: Duration::default(),
            process_id: None,
        })?;

        Ok(())
    }
}
