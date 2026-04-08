use std::sync::Mutex;
use tauri::{Emitter, Manager, State};

struct BridgeServerState {
    port: Mutex<Option<u16>>,
}

#[tauri::command]
async fn start_bridge_server(
    app_handle: tauri::AppHandle,
    state: State<'_, BridgeServerState>,
) -> Result<u16, String> {
    // Check if already running
    {
        let port = state.port.lock().unwrap();
        if let Some(p) = *port {
            return Ok(p);
        }
    }

    // Find the sidecar server.ts path
    let (sidecar_path, working_dir) = {
        let resource_path = app_handle
            .path()
            .resource_dir()
            .ok()
            .map(|p| p.join("sidecar/server.ts"));

        if let Some(path) = resource_path {
            if path.exists() {
                let dir = path.parent().unwrap().to_path_buf();
                (path.clone(), dir)
            } else {
                let exe_dir = std::env::current_exe()
                    .map_err(|e| format!("Failed to get exe path: {}", e))?
                    .parent()
                    .ok_or("Failed to get exe parent dir")?
                    .to_path_buf();

                let src_tauri_dir = exe_dir
                    .parent()
                    .and_then(|p| p.parent())
                    .ok_or("Failed to find src-tauri dir")?
                    .to_path_buf();

                let path = src_tauri_dir.join("sidecar/server.ts");
                (path, src_tauri_dir)
            }
        } else {
            let exe_dir = std::env::current_exe()
                .map_err(|e| format!("Failed to get exe path: {}", e))?
                .parent()
                .ok_or("Failed to get exe parent dir")?
                .to_path_buf();

            let src_tauri_dir = exe_dir
                .parent()
                .and_then(|p| p.parent())
                .ok_or("Failed to find src-tauri dir")?
                .to_path_buf();

            let path = src_tauri_dir.join("sidecar/server.ts");
            (path, src_tauri_dir)
        }
    };

    // Find bun executable - prefer bundled version
    let bun_path = {
        let bundled_bun = app_handle
            .path()
            .resource_dir()
            .ok()
            .map(|p| p.join("sidecar/bun"));

        if let Some(ref path) = bundled_bun {
            if path.exists() {
                path.to_string_lossy().to_string()
            } else {
                let home = std::env::var("HOME").unwrap_or_default();
                let possible_paths = [
                    format!("{}/.bun/bin/bun", home),
                    "/usr/local/bin/bun".to_string(),
                    "/opt/homebrew/bin/bun".to_string(),
                    "bun".to_string(),
                ];

                possible_paths
                    .into_iter()
                    .find(|p| p == "bun" || std::path::Path::new(p).exists())
                    .unwrap_or_else(|| "bun".to_string())
            }
        } else {
            "bun".to_string()
        }
    };

    // Start the Bun sidecar
    let mut child = tokio::process::Command::new(&bun_path)
        .arg("run")
        .arg(&sidecar_path)
        .current_dir(&working_dir)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| {
            format!(
                "Failed to start bridge server: {} (bun: {}, script: {:?})",
                e, bun_path, sidecar_path
            )
        })?;

    // Read the port from stdout
    let stdout = child.stdout.take().ok_or("Failed to capture stdout")?;
    let reader = tokio::io::BufReader::new(stdout);

    use tokio::io::AsyncBufReadExt;
    let mut lines = reader.lines();

    let stderr = child.stderr.take();

    let timeout = tokio::time::Duration::from_secs(10);
    let result = tokio::time::timeout(timeout, async {
        while let Some(line) = lines.next_line().await.map_err(|e| e.to_string())? {
            if line.starts_with("BRIDGE_SERVER_PORT:") {
                let port_str = line.trim_start_matches("BRIDGE_SERVER_PORT:");
                let port: u16 = port_str
                    .parse()
                    .map_err(|_| format!("Invalid port: {}", port_str))?;
                return Ok::<u16, String>(port);
            }
        }
        if let Some(err_stream) = stderr {
            let mut err_reader = tokio::io::BufReader::new(err_stream);
            let mut err_output = String::new();
            use tokio::io::AsyncReadExt;
            let _ = err_reader.read_to_string(&mut err_output).await;
            if !err_output.is_empty() {
                return Err(format!("Bridge server error: {}", err_output));
            }
        }
        Err("No port received from bridge server".to_string())
    })
    .await
    .map_err(|_| "Timeout waiting for bridge server to start")?;

    let port = result?;

    let mut state_port = state.port.lock().unwrap();
    *state_port = Some(port);

    Ok(port)
}

#[tauri::command]
async fn get_bridge_port(state: State<'_, BridgeServerState>) -> Result<Option<u16>, String> {
    let port = state.port.lock().unwrap();
    Ok(*port)
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
            start_bridge_server,
            get_bridge_port,
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.emit("close-requested", ());
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
