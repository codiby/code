use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use serde::Deserialize;
use tauri::{AppHandle, Manager, RunEvent, State, WebviewUrl, WebviewWindowBuilder};
use tauri::path::BaseDirectory;
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use url::Url;

struct BridgeServerState {
    port: Mutex<Option<u16>>,
    /// Handle to a sidecar server we spawned ourselves. Held so we can kill
    /// it on app exit. `None` when we're piggy-backing on an externally-
    /// installed server (LaunchAgent / SCM service).
    child: Mutex<Option<CommandChild>>,
}

/// Absolute path of the bridge-server port file. Matches the path written by
/// `server/index.ts` at startup so both sides agree without needing a shared
/// config.
///
/// Platform layout:
/// - macOS:   `$HOME/.codiby/server.port`         (launchd service)
/// - Windows: `%PROGRAMDATA%\codiby\server.port`  (CodibyCodeBridge SCM service)
/// - Linux:   `$XDG_CONFIG_HOME/codiby/port`      (fallback to `~/.config/codiby/port`)
fn bridge_port_file() -> PathBuf {
    if cfg!(target_os = "macos") {
        let home = std::env::var("HOME").unwrap_or_default();
        PathBuf::from(home).join(".codiby").join("server.port")
    } else if cfg!(target_os = "windows") {
        let program_data = std::env::var("PROGRAMDATA")
            .unwrap_or_else(|_| r"C:\ProgramData".to_string());
        PathBuf::from(program_data).join("codiby").join("server.port")
    } else {
        // Linux / other unix
        let base = std::env::var("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|_| {
                let home = std::env::var("HOME").unwrap_or_default();
                PathBuf::from(home).join(".config")
            });
        base.join("codiby").join("port")
    }
}

/// Port file used by an in-app spawned sidecar. Distinct from the service
/// port file so a Tauri-managed instance never clobbers the LaunchAgent /
/// SCM service file.
fn app_spawn_port_file() -> PathBuf {
    let mut p = bridge_port_file();
    p.set_file_name("app-server.port");
    p
}

fn read_port(path: &PathBuf) -> Option<u16> {
    std::fs::read_to_string(path).ok()?.trim().parse::<u16>().ok()
}

fn health_check(port: u16) -> bool {
    let null = if cfg!(target_os = "windows") { "NUL" } else { "/dev/null" };
    let out = std::process::Command::new("curl")
        .args([
            "-s",
            "-o", null,
            "-w", "%{http_code}",
            "--max-time", "2",
            &format!("http://localhost:{}/health", port),
        ])
        .output();
    matches!(out, Ok(o) if String::from_utf8_lossy(&o.stdout).trim() == "200")
}

/// Spawn the bundled bun sidecar to run the bridge server. The server picks
/// a free port (CLAUDE_UI_PORT=0) and announces it on stdout via the
/// `BRIDGE_SERVER_PORT:<n>` line we wait for. Stores the child handle so it
/// can be killed on app exit.
async fn spawn_sidecar(app: &AppHandle) -> Result<u16, String> {
    let port_file = app_spawn_port_file();
    if let Some(parent) = port_file.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::remove_file(&port_file);

    let server_js = app
        .path()
        .resolve("server.js", BaseDirectory::Resource)
        .map_err(|e| format!("could not locate bundled server.js: {e}"))?;

    let cmd = app
        .shell()
        .sidecar("bun")
        .map_err(|e| format!("sidecar setup failed: {e}"))?
        // `--spawned-by=app` makes the bridge skip the bulk session boot it
        // would do under launchd. The Tauri shell drives spawning lazily via
        // the `active_tab_change` WS message instead, so only the tab the
        // user is looking at lights up Claude.
        .args([
            server_js.to_string_lossy().into_owned(),
            "--spawned-by=app".to_string(),
        ])
        .env("CODIBY_CODE_PORT_FILE", port_file.to_string_lossy().into_owned())
        .env("CLAUDE_UI_PORT", "3111")
        .env("CLAUDE_UI_HOST", "127.0.0.1");

    let (mut rx, child) = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn bun sidecar: {e}"))?;

    {
        let state = app.state::<BridgeServerState>();
        let mut slot = state.child.lock().unwrap();
        if let Some(prev) = slot.take() {
            let _ = prev.kill();
        }
        *slot = Some(child);
    }

    let deadline = Instant::now() + Duration::from_secs(15);
    let mut last_stderr = String::new();
    while Instant::now() < deadline {
        let remaining = deadline.saturating_duration_since(Instant::now());
        let evt = match tokio::time::timeout(remaining, rx.recv()).await {
            Ok(Some(e)) => e,
            Ok(None) => break,
            Err(_) => break,
        };
        match evt {
            CommandEvent::Stdout(bytes) => {
                let chunk = String::from_utf8_lossy(&bytes);
                for line in chunk.split('\n') {
                    if let Some(rest) = line.trim().strip_prefix("BRIDGE_SERVER_PORT:") {
                        if let Ok(p) = rest.parse::<u16>() {
                            // Drain remaining output forever so the pipe
                            // never fills up and stalls the server.
                            tauri::async_runtime::spawn(async move {
                                while rx.recv().await.is_some() {}
                            });
                            return Ok(p);
                        }
                    }
                }
            }
            CommandEvent::Stderr(bytes) => {
                last_stderr = String::from_utf8_lossy(&bytes).into_owned();
            }
            CommandEvent::Error(e) => {
                last_stderr = e;
            }
            CommandEvent::Terminated(payload) => {
                return Err(format!(
                    "bun sidecar exited before announcing port (code={:?}, signal={:?}). stderr: {}",
                    payload.code, payload.signal, last_stderr
                ));
            }
            _ => {}
        }
    }
    Err(format!(
        "Timed out waiting for bun sidecar to start. Last stderr: {}",
        last_stderr
    ))
}

#[tauri::command]
async fn get_bridge_port(
    app: AppHandle,
    state: State<'_, BridgeServerState>,
) -> Result<u16, String> {
    {
        let cached = state.port.lock().unwrap();
        if let Some(p) = *cached {
            if health_check(p) {
                return Ok(p);
            }
        }
    }

    // 1. Externally-installed service (LaunchAgent / SCM service).
    if let Some(p) = read_port(&bridge_port_file()) {
        if health_check(p) {
            *state.port.lock().unwrap() = Some(p);
            return Ok(p);
        }
    }

    // 2. A sidecar from a previous run of this app that's still alive.
    if let Some(p) = read_port(&app_spawn_port_file()) {
        if health_check(p) {
            *state.port.lock().unwrap() = Some(p);
            return Ok(p);
        }
    }

    // 3. Spawn one.
    let port = spawn_sidecar(&app).await?;
    let mut healthy = false;
    for _ in 0..30 {
        if health_check(port) {
            healthy = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    if !healthy {
        return Err(format!(
            "Spawned bun sidecar on port {port} but health check never passed"
        ));
    }
    *state.port.lock().unwrap() = Some(port);
    Ok(port)
}

/// Generic OAuth-via-webview flow used by sideloaded plugins. The plugin
/// supplies a spec (sourced from its `plugin.json`'s `permissions.oauth`
/// section); this command opens a webview, watches the URL bar, captures the
/// named cookies for the named domain on first matching navigation, and POSTs
/// them to the plugin-scoped bridge endpoint.
///
/// The plugin never sees other plugins' cookies — `cookies_for_url` is called
/// against `cookie_domain` only, and the post target is restricted to
/// `/plugins/<plugin_id>/<credentials_endpoint>`.
#[derive(Debug, Deserialize)]
#[allow(non_snake_case)]
struct OAuthSpec {
    plugin_id: String,
    login_url: String,
    success_path_match: Vec<String>,
    cookie_domain: String,
    cookie_names: Vec<String>,
    /// Path on the bridge under `/plugins/<plugin_id>/...`. Must start with `/`.
    credentials_endpoint: String,
    #[serde(default)]
    window_title: Option<String>,
    #[serde(default)]
    width: Option<f64>,
    #[serde(default)]
    height: Option<f64>,
}

fn validate_plugin_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 31 {
        return Err("plugin_id length must be 1..=31".to_string());
    }
    let ok = id.chars().enumerate().all(|(i, c)| {
        if i == 0 { c.is_ascii_lowercase() || c.is_ascii_digit() }
        else      { c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' }
    });
    if !ok {
        return Err("plugin_id must match [a-z0-9][a-z0-9-]{0,30}".to_string());
    }
    Ok(())
}

#[tauri::command]
async fn plugin_oauth_login(
    app: AppHandle,
    state: State<'_, BridgeServerState>,
    spec: OAuthSpec,
) -> Result<(), String> {
    validate_plugin_id(&spec.plugin_id)?;

    if !spec.credentials_endpoint.starts_with('/') {
        return Err("credentials_endpoint must start with '/'".to_string());
    }
    if spec.cookie_names.is_empty() {
        return Err("cookie_names must not be empty".to_string());
    }
    if spec.success_path_match.is_empty() {
        return Err("success_path_match must not be empty".to_string());
    }

    // Webview labels are namespaced so two plugin login windows can coexist.
    let window_label = format!("plugin-login-{}", spec.plugin_id);
    if let Some(existing) = app.get_webview_window(&window_label) {
        existing.close().map_err(|e| e.to_string())?;
    }

    let login_url: Url = spec
        .login_url
        .parse()
        .map_err(|e: url::ParseError| format!("invalid login_url: {}", e))?;

    let cookie_url: Url = format!("https://{}/", spec.cookie_domain)
        .parse()
        .map_err(|e: url::ParseError| format!("invalid cookie_domain: {}", e))?;

    let success_matches = spec.success_path_match.clone();
    let (tx, rx) = std::sync::mpsc::channel::<()>();

    let title = spec
        .window_title
        .clone()
        .unwrap_or_else(|| format!("Sign in ({})", spec.plugin_id));
    let width = spec.width.unwrap_or(500.0);
    let height = spec.height.unwrap_or(700.0);

    let login_window = WebviewWindowBuilder::new(
        &app,
        &window_label,
        WebviewUrl::External(login_url),
    )
    .title(title)
    .inner_size(width, height)
    .resizable(true)
    .on_navigation(move |url| {
        let path = url.path();
        // Match anywhere in the path — plugins can pass either segments
        // ("/dashboard") or full subpaths ("/auth/callback").
        if success_matches.iter().any(|m| path.contains(m)) {
            let _ = tx.send(());
        }
        true
    })
    .build()
    .map_err(|e| e.to_string())?;

    rx.recv()
        .map_err(|_| "Login window closed before completing auth".to_string())?;

    // Allow cookies to persist before reading them.
    std::thread::sleep(std::time::Duration::from_millis(500));

    let cookies = login_window
        .cookies_for_url(cookie_url)
        .map_err(|e| e.to_string())?;

    let mut captured = serde_json::Map::<String, serde_json::Value>::new();
    for cookie in &cookies {
        let name = cookie.name();
        if spec.cookie_names.iter().any(|n| n == name) {
            captured.insert(
                name.to_string(),
                serde_json::Value::String(cookie.value().to_string()),
            );
        }
    }
    if captured.is_empty() {
        return Err("None of the configured cookies were found after login".to_string());
    }

    let port = get_bridge_port(app.clone(), state).await?;
    let body = serde_json::Value::Object(captured).to_string();
    let target = format!(
        "http://localhost:{}/plugins/{}{}",
        port, spec.plugin_id, spec.credentials_endpoint
    );

    let output = std::process::Command::new("curl")
        .args([
            "-s",
            "-X",
            "PUT",
            "-H",
            "Content-Type: application/json",
            "-d",
            &body,
            &target,
        ])
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err("Failed to deliver credentials to bridge server".to_string());
    }

    login_window.close().map_err(|e| e.to_string())?;
    Ok(())
}

/// Drop the bundled `codiby` CLI into `~/.local/bin` so users can spawn a new
/// session from a terminal with `codiby [path]`. The script is baked into the
/// binary at compile time via `include_str!`. Overwrites whenever the on-disk
/// copy doesn't match the embedded version, so app upgrades automatically
/// refresh the CLI. Best-effort: any failure (no `$HOME`, read-only fs, etc.)
/// is swallowed since the desktop app itself works without the CLI.
#[cfg(unix)]
fn install_cli_script() {
    use std::os::unix::fs::PermissionsExt;

    const SCRIPT: &str = include_str!("../../scripts/codiby");

    let Some(home) = std::env::var_os("HOME") else { return };
    let bin_dir = PathBuf::from(home).join(".local").join("bin");
    let script_path = bin_dir.join("codiby");

    if let Ok(existing) = std::fs::read_to_string(&script_path) {
        if existing == SCRIPT {
            return;
        }
    }
    if std::fs::create_dir_all(&bin_dir).is_err() {
        return;
    }
    if std::fs::write(&script_path, SCRIPT).is_err() {
        return;
    }
    let _ = std::fs::set_permissions(&script_path, std::fs::Permissions::from_mode(0o755));
}

#[cfg(not(unix))]
fn install_cli_script() {}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    install_cli_script();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .manage(BridgeServerState {
            port: Mutex::new(None),
            child: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            get_bridge_port,
            plugin_oauth_login,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        if let RunEvent::Exit = event {
            let state = app_handle.state::<BridgeServerState>();
            let mut slot = state.child.lock().unwrap();
            if let Some(child) = slot.take() {
                let _ = child.kill();
            }
            let _ = std::fs::remove_file(app_spawn_port_file());
        }
    });
}
