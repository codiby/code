use std::sync::Mutex;
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder};
use url::Url;

const ARCHITECT_BASE: &str = "https://architect-ou79.onrender.com";

struct BridgeServerState {
    port: Mutex<Option<u16>>,
}

#[tauri::command]
async fn get_bridge_port(state: State<'_, BridgeServerState>) -> Result<u16, String> {
    // Return cached port if available
    {
        let port = state.port.lock().unwrap();
        if let Some(p) = *port {
            return Ok(p);
        }
    }

    // Read port from service port file
    let home = std::env::var("HOME").unwrap_or_default();
    let port_file = format!("{}/.claude/ui-server.port", home);

    let port_str = std::fs::read_to_string(&port_file)
        .map_err(|_| "Bridge server not running. Install it with: cd astro && ./scripts/install-service.sh".to_string())?;

    let port: u16 = port_str.trim().parse()
        .map_err(|_| format!("Invalid port in {}: {}", port_file, port_str.trim()))?;

    // Verify server is actually responding
    let check = std::process::Command::new("curl")
        .args(["-s", "-o", "/dev/null", "-w", "%{http_code}", &format!("http://localhost:{}/health", port)])
        .output();

    match check {
        Ok(output) => {
            let status = String::from_utf8_lossy(&output.stdout);
            if status.trim() != "200" {
                return Err(format!("Bridge server on port {} is not responding. Restart with: launchctl kickstart -k gui/$(id -u)/com.claude-code-ui.server", port));
            }
        }
        Err(_) => {
            return Err("Cannot reach bridge server. Check if it's running.".to_string());
        }
    }

    // Cache the port
    let mut cached = state.port.lock().unwrap();
    *cached = Some(port);

    Ok(port)
}

/// Opens a login window to The Architect, waits for GitHub OAuth to complete,
/// extracts the session cookie, and saves credentials to the bridge server.
#[tauri::command]
async fn architect_login(app: AppHandle, state: State<'_, BridgeServerState>) -> Result<String, String> {
    // Close existing login window if any
    if let Some(existing) = app.get_webview_window("architect-login") {
        existing.close().map_err(|e| e.to_string())?;
    }

    let login_url: Url = format!("{}/login", ARCHITECT_BASE)
        .parse()
        .map_err(|e: url::ParseError| e.to_string())?;

    let (tx, rx) = std::sync::mpsc::channel::<()>();

    let login_window = WebviewWindowBuilder::new(
        &app,
        "architect-login",
        WebviewUrl::External(login_url),
    )
    .title("Login to The Architect")
    .inner_size(500.0, 700.0)
    .resizable(true)
    .on_navigation(move |url| {
        // When the user lands on /workspaces or any non-login page, auth is done
        if let Some(path) = url.path_segments() {
            let segments: Vec<_> = path.collect();
            if segments.contains(&"workspaces")
                || segments.contains(&"ask")
                || segments.contains(&"signals")
                || segments.contains(&"engineering")
            {
                let _ = tx.send(());
            }
        }
        true
    })
    .build()
    .map_err(|e| e.to_string())?;

    // Wait for auth to complete (blocks this async command, not the UI)
    let _ = rx.recv().map_err(|_| "Login window closed before completing auth".to_string())?;

    // Small delay to let cookies settle
    std::thread::sleep(std::time::Duration::from_millis(500));

    // Extract session cookie
    let base_url: Url = ARCHITECT_BASE.parse().map_err(|e: url::ParseError| e.to_string())?;
    let cookies = login_window
        .cookies_for_url(base_url)
        .map_err(|e| e.to_string())?;

    let mut session_token: Option<String> = None;
    let mut gate_password: Option<String> = None;

    for cookie in &cookies {
        let name = cookie.name();
        if name == "__Secure-next-auth.session-token" {
            session_token = Some(cookie.value().to_string());
        } else if name == "site-gate" {
            gate_password = Some(cookie.value().to_string());
        }
    }

    let token = session_token.ok_or("Session cookie not found after login")?;

    // Save credentials to the bridge server
    let port = get_bridge_port(state).await?;
    let body = serde_json::json!({
        "sessionToken": token,
        "gatePassword": gate_password,
    });

    let output = std::process::Command::new("curl")
        .args([
            "-s", "-X", "PUT",
            "-H", "Content-Type: application/json",
            "-d", &body.to_string(),
            &format!("http://localhost:{}/architect/credentials", port),
        ])
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err("Failed to save credentials to bridge server".to_string());
    }

    // Close the login window
    login_window.close().map_err(|e| e.to_string())?;

    Ok(token)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .manage(BridgeServerState {
            port: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            get_bridge_port,
            architect_login,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
