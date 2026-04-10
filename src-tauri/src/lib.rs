use std::sync::Mutex;
use tauri::State;

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
    // (port file might be stale)
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
