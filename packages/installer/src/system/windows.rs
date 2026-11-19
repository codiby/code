//! The real work on Windows. Everything goes through the system's own tools
//! (`wsl.exe`, `powershell.exe`, `reg.exe`), each with no console window.

use std::{
    collections::HashMap,
    fs,
    io::{Read, Write},
    os::windows::process::CommandExt,
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
    thread::sleep,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde_json::{Value, json};

use super::{Base, Distro, Env, Outcome, Plan, Release, Reporter, Step};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const RELEASE_API: &str = "https://api.github.com/repos/codiby/code/releases/latest";
const ENV_VAR: &str = "CODIBY_BRIDGE_PORT_OVERRIDE";
const RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
const RUN_ONCE_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\RunOnce";
const RUN_VALUE: &str = "CodibyWslBridge";
const RESUME_VALUE: &str = "CodibyInstaller";
const REMOTE_COLORS: [&str; 6] = ["blue", "green", "amber", "violet", "red", "pink"];

const BRIDGE_INSTALL_SH: &str = include_str!("../../assets/bridge-install.sh");
const BRIDGE_PS1: &str = include_str!("../../assets/bridge.ps1");

// --- Paths -------------------------------------------------------------------

fn env_path(name: &str) -> PathBuf {
    PathBuf::from(std::env::var_os(name).unwrap_or_default())
}
fn app_dir() -> PathBuf {
    env_path("LOCALAPPDATA").join(r"Programs\codiby-code")
}
fn app_exe() -> PathBuf {
    app_dir().join("Codiby Code.exe")
}
fn server_js() -> PathBuf {
    app_dir().join(r"resources\server.js")
}
fn state_dir() -> PathBuf {
    env_path("LOCALAPPDATA").join("codiby-base")
}
fn resume_file() -> PathBuf {
    state_dir().join("installer-resume.json")
}
fn remotes_file() -> PathBuf {
    env_path("USERPROFILE").join(r".codiby\ui-remotes.json")
}
fn wsl_shortcut() -> PathBuf {
    env_path("APPDATA").join(r"Microsoft\Windows\Start Menu\Programs\Codiby Code (WSL).lnk")
}

/// A new, empty directory of its own under %TEMP%.
fn fresh_temp_dir(prefix: &str) -> Result<PathBuf, String> {
    let dir = std::env::temp_dir().join(format!("{prefix}-{}", uuid::Uuid::new_v4().simple()));
    fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    Ok(dir)
}

// --- Processes ---------------------------------------------------------------

fn command(program: &str) -> Command {
    let mut cmd = Command::new(program);
    cmd.creation_flags(CREATE_NO_WINDOW);
    // wsl.exe writes UTF-16 unless told otherwise.
    cmd.env("WSL_UTF8", "1");
    cmd
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).replace('\0', "")
}

fn output(mut cmd: Command) -> Result<Output, String> {
    cmd.stdin(Stdio::null())
        .output()
        .map_err(|e| format!("{:?}: {e}", cmd.get_program()))
}

/// Runs `cmd`, logs what it printed, and fails when it fails.
fn checked(report: &Reporter, cmd: Command) -> Result<String, String> {
    let program = cmd.get_program().to_string_lossy().into_owned();
    let out = output(cmd)?;
    let stdout = text(&out.stdout);
    let stderr = text(&out.stderr);
    for line in stdout.lines().chain(stderr.lines()).filter(|l| !l.trim().is_empty()) {
        report.log(line.trim_end().to_owned());
    }
    if out.status.success() {
        Ok(stdout)
    } else {
        let last = stderr
            .lines()
            .chain(stdout.lines())
            .rfind(|l| !l.trim().is_empty())
            .unwrap_or("")
            .trim()
            .to_owned();
        Err(format!("{program} ({}): {last}", out.status))
    }
}

fn powershell(script: &str) -> Command {
    let mut cmd = command("powershell.exe");
    cmd.args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script]);
    cmd
}

/// A PowerShell single-quoted string.
fn ps_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

fn wsl(distro: &str) -> Command {
    let mut cmd = command("wsl.exe");
    cmd.args(["-d", distro]);
    cmd
}

/// `wsl -d distro -u root -- sh -c script sh args...`
fn wsl_root(distro: &str, script: &str, args: &[&str]) -> Command {
    let mut cmd = wsl(distro);
    cmd.args(["-u", "root", "--exec", "sh", "-c", script, "sh"]).args(args);
    cmd
}

fn wslpath(distro: &str, path: &Path) -> Result<String, String> {
    let mut cmd = wsl(distro);
    cmd.args(["--exec", "wslpath", "-u"]).arg(path);
    let out = output(cmd)?;
    if !out.status.success() {
        return Err(format!("wslpath: {}", text(&out.stderr).trim()));
    }
    Ok(text(&out.stdout).trim().to_owned())
}

// --- Detect ------------------------------------------------------------------

pub(super) fn detect() -> Env {
    let wsl = output({
        let mut cmd = command("wsl.exe");
        cmd.arg("--status");
        cmd
    })
    .is_ok_and(|o| o.status.success());
    Env {
        virtualization: virtualization(),
        wsl,
        distros: if wsl { distros() } else { Vec::new() },
        app_version: app_version(),
        latest: latest_release().map_err(|e| log::warn!("release: {e}")).ok(),
        app_running: app_running(),
        resume: fs::read_to_string(resume_file())
            .ok()
            .and_then(|s| serde_json::from_str::<Plan>(&s).ok())
            .map(|plan| Plan { after_reboot: true, ..plan }),
    }
}

fn virtualization() -> bool {
    // Firmware off reads false while Hyper-V already runs, so either counts.
    output(powershell(
        "$p = (Get-CimInstance Win32_Processor | Select-Object -First 1).VirtualizationFirmwareEnabled; \
         $h = (Get-CimInstance Win32_ComputerSystem).HypervisorPresent; [bool]($p -or $h)",
    ))
    .map(|o| text(&o.stdout).trim().eq_ignore_ascii_case("true"))
    .unwrap_or(true)
}

/// `wsl -l -v`: `* Ubuntu    Running    2`, the star on the default.
fn distros() -> Vec<Distro> {
    let Ok(out) = output({
        let mut cmd = command("wsl.exe");
        cmd.args(["-l", "-v"]);
        cmd
    }) else {
        return Vec::new();
    };
    super::parse_distros(&text(&out.stdout))
}

fn app_version() -> Option<String> {
    let exe = app_exe();
    if !exe.exists() {
        return None;
    }
    let out = output(powershell(&format!(
        "(Get-Item {}).VersionInfo.ProductVersion",
        ps_quote(&exe.to_string_lossy())
    )))
    .ok()?;
    Some(text(&out.stdout).trim().to_owned()).filter(|v| !v.is_empty())
}

fn app_running() -> bool {
    output({
        let mut cmd = command("tasklist.exe");
        cmd.args(["/FI", "IMAGENAME eq Codiby Code.exe", "/NH"]);
        cmd
    })
    .is_ok_and(|o| text(&o.stdout).contains("Codiby Code.exe"))
}

/// PowerShell does the HTTPS, so the installer carries no TLS of its own
/// (and no C code to cross-compile).
const TLS12: &str = "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; \
                     $ProgressPreference = 'SilentlyContinue'; ";

fn latest_release() -> Result<Release, String> {
    let out = output(powershell(&format!(
        "{TLS12}(Invoke-WebRequest -UseBasicParsing -TimeoutSec 15 -Headers @{{ 'User-Agent' = 'codiby-installer' }} {}).Content",
        ps_quote(RELEASE_API)
    )))?;
    if !out.status.success() {
        return Err(text(&out.stderr).trim().to_owned());
    }
    let body: Value = serde_json::from_str(text(&out.stdout).trim()).map_err(|e| e.to_string())?;
    let asset = body["assets"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|a| {
            a["name"]
                .as_str()
                .is_some_and(|n| n.contains("Setup") && n.ends_with(".exe"))
        })
        .ok_or("the release has no Windows Setup")?;
    Ok(Release {
        version: body["tag_name"].as_str().unwrap_or_default().trim_start_matches('v').to_owned(),
        url: asset["browser_download_url"].as_str().unwrap_or_default().to_owned(),
        size: asset["size"].as_u64().unwrap_or(0),
    })
}

// --- Run ---------------------------------------------------------------------

pub(super) fn run(plan: Plan, report: Reporter) -> Result<Outcome, String> {
    let mut setup: Option<PathBuf> = None;
    let mut ports = Ports::read();
    if plan.after_reboot {
        // Finish WSL's own update, which its first install leaves for later.
        let mut cmd = command("wsl.exe");
        cmd.arg("--update");
        let _ = checked(&report, cmd);
    }
    for (i, step) in plan.steps().into_iter().enumerate() {
        report.step(i);
        match step {
            Step::Download => setup = Some(download(&plan, &report)?),
            Step::InstallApp => install_app(setup.take(), &report)?,
            Step::EnableWsl => {
                enable_wsl(&plan, &report)?;
                return Ok(Outcome::Reboot);
            }
            Step::InstallDistro(distro) => install_distro(&distro, &report)?,
            Step::CreateUser(distro) => create_user(&plan, &distro, &report)?,
            Step::Packages(distro) => packages(&distro, &report)?,
            Step::Bridge(distro) => bridge(&distro, ports.port_for(&distro), &report)?,
            Step::AddHost(distro) => {
                let port = ports.port_for(&distro);
                add_host(&distro, port, &report)?;
                ports.reserve(&distro, port);
            }
            Step::BaseWsl(distro) => base_wsl(&distro, ports.port_for(&distro), &report)?,
            Step::BaseWindows => base_windows(&report)?,
            Step::Verify => verify(ports.port_for(plan.base_distro.as_deref().unwrap_or("")), &report)?,
        }
    }
    let _ = fs::remove_file(resume_file());
    Ok(Outcome::Done)
}

fn download(plan: &Plan, report: &Reporter) -> Result<PathBuf, String> {
    let url = plan.release_url.as_deref().ok_or("no release to download")?;
    let dir = fresh_temp_dir("codiby-setup")?;
    let path = dir.join("Codiby-Code-Setup.exe");
    report.log(format!("GET {url}"));
    let mut child = powershell(&format!(
        "{TLS12}Invoke-WebRequest -UseBasicParsing -Headers @{{ 'User-Agent' = 'codiby-installer' }} {} -OutFile {}",
        ps_quote(url),
        ps_quote(&path.to_string_lossy())
    ))
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::piped())
    .spawn()
    .map_err(|e| format!("powershell.exe: {e}"))?;
    // The size the release lists: the file grows toward it.
    let total = plan.release_size;
    let mut last = u8::MAX;
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            break status;
        }
        let got = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        if total > 0 {
            let pct = (got * 100 / total).min(99) as u8;
            if pct != last {
                report.percent(pct);
                last = pct;
            }
        }
        sleep(Duration::from_millis(250));
    };
    if !status.success() {
        let mut err = String::new();
        if let Some(mut stderr) = child.stderr.take() {
            let _ = stderr.read_to_string(&mut err);
        }
        return Err(format!("download failed: {}", err.trim()));
    }
    report.percent(100);
    let got = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    report.log(format!("{} MB", got / 1_000_000));
    Ok(path)
}

fn install_app(setup: Option<PathBuf>, report: &Reporter) -> Result<(), String> {
    let setup = setup.ok_or("the download is missing")?;
    if app_running() {
        return Err("Codiby Code is open: quit it (from the tray too) and retry.".into());
    }
    let signature = output(powershell(&format!(
        "(Get-AuthenticodeSignature {}).Status",
        ps_quote(&setup.to_string_lossy())
    )))
    .map(|o| text(&o.stdout).trim().to_owned())
    .unwrap_or_default();
    report.log(format!("signature: {signature}"));
    let mut cmd = command(&setup.to_string_lossy());
    cmd.arg("/S");
    checked(report, cmd)?;
    if let Some(dir) = setup.parent() {
        let _ = fs::remove_dir_all(dir);
    }
    if !app_exe().exists() {
        return Err(format!("{} is missing after the install", app_exe().display()));
    }
    Ok(())
}

/// Turns on WSL as an administrator, and arranges for this installer to
/// open again after the restart.
fn enable_wsl(plan: &Plan, report: &Reporter) -> Result<(), String> {
    fs::create_dir_all(state_dir()).map_err(|e| e.to_string())?;
    let saved = serde_json::to_string_pretty(plan).map_err(|e| e.to_string())?;
    fs::write(resume_file(), saved).map_err(|e| e.to_string())?;
    let me = std::env::current_exe().map_err(|e| e.to_string())?;
    let mut reg = command("reg.exe");
    reg.args(["add", RUN_ONCE_KEY, "/v", RESUME_VALUE, "/t", "REG_SZ", "/f", "/d"])
        .arg(format!("\"{}\" --resume", me.display()));
    checked(report, reg)?;
    // Start-Process -Verb RunAs shows the UAC prompt; declining it throws.
    checked(
        report,
        powershell(
            "$p = Start-Process wsl.exe -ArgumentList '--install','--no-distribution' -Verb RunAs -Wait -PassThru; exit $p.ExitCode",
        ),
    )
    .map_err(|e| format!("WSL wasn't turned on: {e}"))?;
    Ok(())
}

fn install_distro(distro: &str, report: &Reporter) -> Result<(), String> {
    if distros().iter().any(|d| d.name == distro) {
        report.log(format!("{distro} is already installed"));
        return Ok(());
    }
    let mut cmd = command("wsl.exe");
    cmd.args(["--install", "-d", distro, "--no-launch"]);
    checked(report, cmd)?;
    // Some distros register on their first start.
    checked(report, wsl_root(distro, "true", &[]))?;
    Ok(())
}

const CREATE_USER_SH: &str = r#"set -e
u="$1"
if ! id -u "$u" >/dev/null 2>&1; then
  if getent group sudo >/dev/null; then useradd -m -s /bin/bash -G sudo "$u"; else useradd -m -s /bin/bash "$u"; fi
fi
chpasswd
grep -q '^\[user\]' /etc/wsl.conf 2>/dev/null || printf '\n[user]\ndefault=%s\n' "$u" >> /etc/wsl.conf
"#;

fn create_user(plan: &Plan, distro: &str, report: &Reporter) -> Result<(), String> {
    let user = plan.user.as_deref().ok_or("no Linux user")?;
    let mut cmd = wsl_root(distro, CREATE_USER_SH, &[user]);
    // The password goes through stdin, never the command line.
    let mut child = cmd
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    child
        .stdin
        .take()
        .ok_or("no stdin")?
        .write_all(format!("{user}:{}\n", plan.password).as_bytes())
        .map_err(|e| e.to_string())?;
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(format!("useradd: {}", text(&out.stderr).trim()));
    }
    report.log(format!("user {user} created"));
    // The default user applies once the distro restarts.
    let mut cmd = command("wsl.exe");
    cmd.args(["--terminate", distro]);
    checked(report, cmd)?;
    Ok(())
}

fn packages(distro: &str, report: &Reporter) -> Result<(), String> {
    checked(
        report,
        wsl_root(
            distro,
            "if command -v curl >/dev/null && command -v unzip >/dev/null; then echo 'curl, unzip: ok'; \
             else apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl unzip; fi",
            &[],
        ),
    )
    .map(drop)
}

fn bridge(distro: &str, port: u16, report: &Reporter) -> Result<(), String> {
    let dir = fresh_temp_dir("codiby-wsl")?;
    let script = dir.join("bridge-install.sh");
    fs::write(&script, BRIDGE_INSTALL_SH.replace("\r\n", "\n")).map_err(|e| e.to_string())?;
    let result = (|| {
        let path = wslpath(distro, &script)?;
        let mut cmd = wsl(distro);
        cmd.args(["--exec", "sh", &path])
            .arg(server_js())
            .arg(port.to_string());
        checked(report, cmd).map(drop)
    })();
    let _ = fs::remove_dir_all(&dir);
    result
}

fn base_wsl(distro: &str, port: u16, report: &Reporter) -> Result<(), String> {
    let dir = state_dir();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let config = json!({ "base": "WSL", "distro": distro, "port": port });
    fs::write(dir.join("config.json"), config.to_string()).map_err(|e| e.to_string())?;
    let ps1 = dir.join("bridge.ps1");
    fs::write(&ps1, BRIDGE_PS1).map_err(|e| e.to_string())?;
    let hash = checked(
        report,
        powershell(&format!("(Get-FileHash {}).Hash", ps_quote(&server_js().to_string_lossy()))),
    )?;
    fs::write(dir.join("server.sha256"), hash.trim()).map_err(|e| e.to_string())?;

    // SetEnvironmentVariable also tells Explorer, so the next launch sees it.
    checked(
        report,
        powershell(&format!("[Environment]::SetEnvironmentVariable('{ENV_VAR}', '{port}', 'User')")),
    )?;
    let run = format!(
        "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File \"{}\"",
        ps1.display()
    );
    let mut reg = command("reg.exe");
    reg.args(["add", RUN_KEY, "/v", RUN_VALUE, "/t", "REG_SZ", "/f", "/d", &run]);
    checked(report, reg)?;
    checked(
        report,
        powershell(&format!(
            "$s = (New-Object -ComObject WScript.Shell).CreateShortcut({lnk}); \
             $s.TargetPath = 'powershell.exe'; \
             $s.Arguments = {args}; \
             $s.IconLocation = {icon}; \
             $s.Description = {desc}; $s.Save()",
            lnk = ps_quote(&wsl_shortcut().to_string_lossy()),
            args = ps_quote(&format!(
                "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File \"{}\" -Launch",
                ps1.display()
            )),
            icon = ps_quote(&format!("{},0", app_exe().display())),
            desc = ps_quote(&format!("Codiby Code (WSL: {distro})")),
        )),
    )?;
    // Start the server now rather than at the next sign-in. Its output isn't
    // captured: the script leaves a `wsl.exe` running forever to keep the
    // distro up, and that process would inherit a captured pipe and keep it
    // open, so the read never ends and the installer hangs here. The script
    // logs to codiby-base\bridge.log, and Verify checks the server answers.
    let mut cmd = command("powershell.exe");
    cmd.args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"]).arg(&ps1);
    cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    let status = cmd.status().map_err(|e| format!("powershell.exe: {e}"))?;
    report.log(format!("start-up script: {status}"));
    if !status.success() {
        return Err(format!("The start-up script failed ({status}); see {}", dir.join("bridge.log").display()));
    }
    Ok(())
}

fn base_windows(report: &Reporter) -> Result<(), String> {
    checked(
        report,
        powershell(&format!("[Environment]::SetEnvironmentVariable('{ENV_VAR}', $null, 'User')")),
    )?;
    let mut reg = command("reg.exe");
    reg.args(["delete", RUN_KEY, "/v", RUN_VALUE, "/f"]);
    let _ = output(reg);
    let _ = fs::remove_file(wsl_shortcut());
    fs::create_dir_all(state_dir()).map_err(|e| e.to_string())?;
    fs::write(state_dir().join("config.json"), json!({ "base": "Windows" }).to_string())
        .map_err(|e| e.to_string())
}

/// Adds `distro` to the Windows app's remotes, as Settings → Remotes does.
/// The app keeps them in memory, so this is only read on its next start.
fn add_host(distro: &str, port: u16, report: &Reporter) -> Result<(), String> {
    let path = remotes_file();
    let mut remotes: Vec<Value> = fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    if remotes.iter().any(|r| r["wsl"]["distro"] == distro) {
        report.log(format!("{distro} is already a host"));
        return Ok(());
    }
    let used: Vec<&str> = remotes.iter().filter_map(|r| r["color"].as_str()).collect();
    let color = REMOTE_COLORS
        .iter()
        .find(|c| !used.contains(c))
        .unwrap_or(&REMOTE_COLORS[remotes.len() % REMOTE_COLORS.len()]);
    let taken = |name: &str| {
        remotes
            .iter()
            .any(|r| r["name"].as_str().is_some_and(|n| n.eq_ignore_ascii_case(name)))
    };
    let mut name = format!("{distro} (WSL)");
    let mut n = 2;
    while taken(&name) {
        name = format!("{distro} (WSL) {n}");
        n += 1;
    }
    let created = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    remotes.push(json!({
        "id": format!("rmt_{}", uuid::Uuid::new_v4()),
        "name": name,
        "alias": distro,
        "bunPort": port,
        "color": color,
        "createdAt": created,
        "coordination": "write",
        "wsl": { "distro": distro },
    }));
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_string_pretty(&remotes).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    if app_running() {
        report.log("Codiby Code is open: the host appears after it restarts".to_owned());
    }
    Ok(())
}

fn verify(port: u16, report: &Reporter) -> Result<(), String> {
    let url = format!("http://127.0.0.1:{port}/health");
    for _ in 0..40 {
        if let Some(body) = health(port) {
            report.log(body);
            return Ok(());
        }
        sleep(Duration::from_millis(500));
    }
    Err(format!("{url} didn't answer"))
}

/// `GET /health` over a plain socket: the body when it answers 200.
fn health(port: u16) -> Option<String> {
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = std::net::TcpStream::connect_timeout(&addr, Duration::from_secs(2)).ok()?;
    stream.set_read_timeout(Some(Duration::from_secs(2))).ok()?;
    stream
        .write_all(b"GET /health HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n")
        .ok()?;
    let mut response = String::new();
    stream.read_to_string(&mut response).ok()?;
    let (head, body) = response.split_once("\r\n\r\n")?;
    head.split_whitespace()
        .nth(1)
        .filter(|code| *code == "200")
        .map(|_| body.trim().to_owned())
}

/// Each WSL distro shares one network, so each server needs its own port:
/// the one its remote already has, else the first free from 3112.
struct Ports(HashMap<String, u16>);

impl Ports {
    fn read() -> Self {
        let remotes: Vec<Value> = fs::read_to_string(remotes_file())
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        Ports(
            remotes
                .iter()
                .filter_map(|r| {
                    Some((r["wsl"]["distro"].as_str()?.to_owned(), r["bunPort"].as_u64()? as u16))
                })
                .collect(),
        )
    }

    fn port_for(&mut self, distro: &str) -> u16 {
        if let Some(port) = self.0.get(distro) {
            return *port;
        }
        let port = (super::WSL_PORT..)
            .find(|p| !self.0.values().any(|used| used == p))
            .unwrap_or(super::WSL_PORT);
        self.0.insert(distro.to_owned(), port);
        port
    }

    fn reserve(&mut self, distro: &str, port: u16) {
        self.0.insert(distro.to_owned(), port);
    }
}

// --- After -------------------------------------------------------------------

pub(super) fn reboot() {
    let mut cmd = command("shutdown.exe");
    cmd.args(["/r", "/t", "0"]);
    let _ = cmd.spawn();
}

pub(super) fn open_app(base: Base) {
    let _ = match base {
        // The shortcut's script waits for the WSL server, then opens the app.
        Base::Wsl => {
            let mut cmd = command("powershell.exe");
            cmd.args(["-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File"])
                .arg(state_dir().join("bridge.ps1"))
                .arg("-Launch");
            cmd.spawn()
        }
        Base::Windows => Command::new(app_exe()).spawn(),
    };
}
