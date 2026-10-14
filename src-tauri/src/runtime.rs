use crate::models::TaoRuntimeEvent;
use crate::storage;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaoRuntimeStatus {
    pub phase: String,
    pub running: bool,
    pub ready: bool,
    pub pid: Option<u32>,
    pub exit_code: Option<i32>,
    pub uptime_ms: Option<u64>,
    pub session_count: usize,
    pub last_error: Option<String>,
    pub node_path: Option<String>,
    pub runtime_path: Option<String>,
    pub pi_path: Option<String>,
}

pub struct TaoRuntimeManager {
    process: Mutex<Option<Arc<TaoRuntimeProcess>>>,
    startup_error: Mutex<Option<String>>,
}

impl Default for TaoRuntimeManager {
    fn default() -> Self {
        Self {
            process: Mutex::new(None),
            startup_error: Mutex::new(None),
        }
    }
}

struct TaoRuntimeProcess {
    child: Mutex<Child>,
    stdin: Mutex<ChildStdin>,
    pending: Arc<Mutex<HashMap<String, Sender<Result<Value, String>>>>>,
    ready: Arc<AtomicBool>,
    session_count: Arc<AtomicUsize>,
    last_error: Arc<Mutex<Option<String>>>,
    fatal_seen: Arc<AtomicBool>,
    pid: u32,
    started_at: Instant,
    node_path: String,
    runtime_path: String,
    pi_path: String,
}

impl TaoRuntimeManager {
    pub fn start(&self, app: &AppHandle) -> Result<(), String> {
        let result = self.start_inner(app);
        if let Ok(mut error) = self.startup_error.lock() {
            *error = result.as_ref().err().cloned();
        }
        result
    }

    fn start_inner(&self, app: &AppHandle) -> Result<(), String> {
        let mut slot = self
            .process
            .lock()
            .map_err(|_| "Tao Runtime 状态不可用".to_string())?;
        if let Some(process) = slot.as_ref() {
            if process.is_running()? {
                return Ok(());
            }
        }

        let script = node_compatible_path(&resolve_runtime_script(app)?);
        let pi_root = node_compatible_path(&resolve_pi_root(app)?);
        // Development builds start in the Tao repository so local testing is
        // convenient. A packaged app must never inherit the build machine's
        // source path; use the user's home directory as the neutral default
        // workspace until a conversation selects its own directory.
        let fallback_cwd = if cfg!(debug_assertions) {
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..")
        } else {
            app.path()
                .home_dir()
                .map_err(|error| format!("无法定位默认工作区：{error}"))?
        };
        let fallback_cwd = node_compatible_path(&fallback_cwd);
        let tsx_preflight = pi_root.join("node_modules/tsx/dist/preflight.cjs");
        let tsx_loader = pi_root.join("node_modules/tsx/dist/loader.mjs");
        if !tsx_preflight.is_file() || !tsx_loader.is_file() {
            return Err(format!(
                "Pi 运行资源不完整：缺少 tsx runtime（{}）。请重新构建或安装完整版本的 Tao",
                pi_root.display()
            ));
        }
        let tao_home = node_compatible_path(&storage::app_data_root(app)?);
        let node_binary = node_compatible_path(&resolve_node_binary(app)?);
        let mut command = Command::new(&node_binary);
        command
            .arg("--require")
            .arg(&tsx_preflight)
            .arg("--import")
            .arg(path_to_file_url(&tsx_loader)?)
            .arg(&script)
            .arg("--pi-root")
            .arg(&pi_root)
            .arg("--tao-home")
            .arg(&tao_home)
            .arg("--cwd")
            .arg(&fallback_cwd)
            .current_dir(&pi_root)
            .env("PI_CODING_AGENT_DIR", &tao_home)
            .env("TSX_TSCONFIG_PATH", pi_root.join("tsconfig.json"))
            .env("NO_COLOR", "1")
            .env("FORCE_COLOR", "0")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        #[cfg(target_os = "windows")]
        std::os::windows::process::CommandExt::creation_flags(&mut command, 0x08000000);

        let mut child = command
            .spawn()
            .map_err(|error| format!("无法启动 Tao Runtime（{}）：{error}", node_binary.display()))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "无法连接 Tao Runtime 输入".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "无法连接 Tao Runtime 输出".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "无法连接 Tao Runtime 错误输出".to_string())?;
        let pid = child.id();

        let pending: Arc<Mutex<HashMap<String, Sender<Result<Value, String>>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let ready = Arc::new(AtomicBool::new(false));
        let session_count = Arc::new(AtomicUsize::new(0));
        let last_error = Arc::new(Mutex::new(None));
        let fatal_seen = Arc::new(AtomicBool::new(false));
        let output_pending = Arc::clone(&pending);
        let output_ready = Arc::clone(&ready);
        let output_session_count = Arc::clone(&session_count);
        let output_error = Arc::clone(&last_error);
        let output_fatal = Arc::clone(&fatal_seen);
        let output_app = app.clone();
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                let Ok(message) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                match message.get("type").and_then(Value::as_str) {
                    Some("ready") => {
                        output_ready.store(true, Ordering::SeqCst);
                        output_session_count.store(
                            message.get("sessionCount").and_then(Value::as_u64).unwrap_or(0) as usize,
                            Ordering::SeqCst,
                        );
                    }
                    Some("runtime_state") => {
                        output_session_count.store(
                            message.get("sessionCount").and_then(Value::as_u64).unwrap_or(0) as usize,
                            Ordering::SeqCst,
                        );
                    }
                    Some("event") => {
                        if let Some(payload) = message.get("payload") {
                            if let Ok(event) = serde_json::from_value::<TaoRuntimeEvent>(payload.clone()) {
                                let _ = output_app.emit("tao-runtime-event", event);
                            }
                        }
                    }
                    Some("response") => {
                        let Some(id) = message.get("id").and_then(Value::as_str) else {
                            continue;
                        };
                        let sender = output_pending.lock().ok().and_then(|mut values| values.remove(id));
                        if let Some(sender) = sender {
                            let result = if message.get("success").and_then(Value::as_bool) == Some(true) {
                                Ok(message.get("data").cloned().unwrap_or(Value::Null))
                            } else {
                                Err(message
                                    .get("error")
                                    .and_then(Value::as_str)
                                    .unwrap_or("Tao Runtime 拒绝了请求")
                                    .to_string())
                            };
                            let _ = sender.send(result);
                        }
                    }
                    Some("fatal") => {
                        output_fatal.store(true, Ordering::SeqCst);
                        let error = message
                            .get("message")
                            .and_then(Value::as_str)
                            .unwrap_or("Tao Runtime 启动失败")
                            .to_string();
                        if let Ok(mut target) = output_error.lock() {
                            *target = Some(error.clone());
                        }
                        fail_pending(&output_pending, &error);
                    }
                    _ => {}
                }
            }
            output_ready.store(false, Ordering::SeqCst);
            if let Ok(mut target) = output_error.lock() {
                if target.is_none() {
                    *target = Some("Tao Runtime 输出通道已关闭".to_string());
                }
            }
            fail_pending(&output_pending, "Tao Runtime 输出通道已关闭");
        });
        let stderr_error = Arc::clone(&last_error);
        let stderr_ready = Arc::clone(&ready);
        let stderr_fatal = Arc::clone(&fatal_seen);
        thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                if !line.trim().is_empty() && !stderr_ready.load(Ordering::SeqCst) && !stderr_fatal.load(Ordering::SeqCst) {
                    if let Ok(mut target) = stderr_error.lock() {
                        let next = match target.as_deref() {
                            Some(previous) if previous.len() < 8_000 => format!("{previous}\n{line}"),
                            Some(previous) => previous.to_string(),
                            None => line,
                        };
                        *target = Some(next);
                    }
                }
            }
        });

        *slot = Some(Arc::new(TaoRuntimeProcess {
            child: Mutex::new(child),
            stdin: Mutex::new(stdin),
            pending,
            ready,
            session_count,
            last_error,
            fatal_seen,
            pid,
            started_at: Instant::now(),
            node_path: node_binary.display().to_string(),
            runtime_path: script.display().to_string(),
            pi_path: pi_root.display().to_string(),
        }));
        Ok(())
    }

    pub fn request(
        &self,
        app: &AppHandle,
        mut command: Value,
        timeout: Duration,
    ) -> Result<Value, String> {
        self.start(app)?;
        let process = self
            .process
            .lock()
            .map_err(|_| "Tao Runtime 状态不可用".to_string())?
            .clone()
            .ok_or_else(|| "Tao Runtime 尚未启动".to_string())?;
        process.wait_ready(timeout.min(Duration::from_secs(30)))?;

        let id = storage::new_id("runtime");
        command
            .as_object_mut()
            .ok_or_else(|| "Runtime 命令格式无效".to_string())?
            .insert("id".to_string(), Value::String(id.clone()));
        let (sender, receiver) = mpsc::channel();
        process
            .pending
            .lock()
            .map_err(|_| "Runtime 请求队列不可用".to_string())?
            .insert(id.clone(), sender);
        if let Err(error) = process.send_command(&command) {
            if let Ok(mut pending) = process.pending.lock() {
                pending.remove(&id);
            }
            return Err(error);
        }
        match receiver.recv_timeout(timeout) {
            Ok(result) => result,
            Err(_) => {
                if let Ok(mut pending) = process.pending.lock() {
                    pending.remove(&id);
                }
                Err("等待 Tao Runtime 响应超时".to_string())
            }
        }
    }

    pub fn status(&self) -> Result<TaoRuntimeStatus, String> {
        let process = self
            .process
            .lock()
            .map_err(|_| "Tao Runtime 状态不可用".to_string())?
            .clone();
        let Some(process) = process else {
            let last_error = self.startup_error.lock().ok().and_then(|value| value.clone());
            return Ok(TaoRuntimeStatus {
                phase: if last_error.is_some() { "failed" } else { "stopped" }.to_string(),
                running: false,
                ready: false,
                pid: None,
                exit_code: None,
                uptime_ms: None,
                session_count: 0,
                last_error,
                node_path: None,
                runtime_path: None,
                pi_path: None,
            });
        };
        let exit = process
            .child
            .lock()
            .map_err(|_| "Tao Runtime 进程状态不可用".to_string())?
            .try_wait()
            .map_err(|error| format!("无法检查 Tao Runtime 状态：{error}"))?;
        let running = exit.is_none();
        let ready = running && process.ready.load(Ordering::SeqCst);
        let fatal = process.fatal_seen.load(Ordering::SeqCst);
        let mut last_error = process.last_error.lock().ok().and_then(|value| value.clone());
        if !running && last_error.is_none() {
            last_error = Some(format!("Tao Runtime 已退出，退出码 {:?}", exit.and_then(|status| status.code())));
        }
        Ok(TaoRuntimeStatus {
            phase: if ready { "ready" } else if fatal || !running { "failed" } else { "starting" }.to_string(),
            running,
            ready,
            pid: running.then_some(process.pid),
            exit_code: exit.and_then(|status| status.code()),
            uptime_ms: running.then_some(process.started_at.elapsed().as_millis() as u64),
            session_count: process.session_count.load(Ordering::SeqCst),
            last_error,
            node_path: Some(process.node_path.clone()),
            runtime_path: Some(process.runtime_path.clone()),
            pi_path: Some(process.pi_path.clone()),
        })
    }

    pub fn restart(&self, app: &AppHandle) -> Result<(), String> {
        self.stop();
        self.start(app)
    }

    pub fn stop(&self) {
        if let Ok(mut slot) = self.process.lock() {
            if let Some(process) = slot.take() {
                process.stop();
            }
        }
    }
}

impl TaoRuntimeProcess {
    fn wait_ready(&self, timeout: Duration) -> Result<(), String> {
        let started = Instant::now();
        loop {
            if self.ready.load(Ordering::SeqCst) {
                return Ok(());
            }
            if self.fatal_seen.load(Ordering::SeqCst) || !self.is_running()? {
                return Err(self
                    .last_error
                    .lock()
                    .ok()
                    .and_then(|value| value.clone())
                    .unwrap_or_else(|| "Tao Runtime 在进入 ready 前已退出".to_string()));
            }
            if started.elapsed() >= timeout {
                let detail = self.last_error.lock().ok().and_then(|value| value.clone());
                return Err(match detail {
                    Some(detail) => format!("Tao Runtime 未在 {} 秒内 ready：{detail}", timeout.as_secs()),
                    None => format!("Tao Runtime 未在 {} 秒内 ready，请检查内置 Pi 资源", timeout.as_secs()),
                });
            }
            thread::sleep(Duration::from_millis(25));
        }
    }

    fn is_running(&self) -> Result<bool, String> {
        self.child
            .lock()
            .map_err(|_| "Tao Runtime 进程状态不可用".to_string())?
            .try_wait()
            .map(|status| status.is_none())
            .map_err(|error| format!("无法检查 Tao Runtime 状态：{error}"))
    }

    fn send_command(&self, command: &Value) -> Result<(), String> {
        let mut stdin = self
            .stdin
            .lock()
            .map_err(|_| "Tao Runtime 输入通道不可用".to_string())?;
        serde_json::to_writer(&mut *stdin, command)
            .map_err(|error| format!("无法编码 Tao Runtime 请求：{error}"))?;
        stdin
            .write_all(b"\n")
            .and_then(|_| stdin.flush())
            .map_err(|error| format!("无法向 Tao Runtime 发送请求：{error}"))
    }

    fn stop(&self) {
        self.ready.store(false, Ordering::SeqCst);
        if let Ok(mut stdin) = self.stdin.lock() {
            let _ = stdin.write_all(b"{\"type\":\"shutdown\"}\n");
            let _ = stdin.flush();
        }
        if let Ok(mut child) = self.child.lock() {
            for _ in 0..20 {
                if child.try_wait().ok().flatten().is_some() {
                    let _ = child.wait();
                    fail_pending(&self.pending, "Tao Runtime 已关闭");
                    return;
                }
                thread::sleep(Duration::from_millis(50));
            }
            #[cfg(target_os = "windows")]
            {
                // A forced host shutdown must also stop its owned tool processes.
                let pid = child.id().to_string();
                let mut terminate = Command::new("taskkill.exe");
                std::os::windows::process::CommandExt::creation_flags(&mut terminate, 0x08000000);
                let _ = terminate.args(["/PID", &pid, "/T", "/F"]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status();
            }
            let _ = child.kill();
            let _ = child.wait();
        }
        self.ready.store(false, Ordering::SeqCst);
        fail_pending(&self.pending, "Tao Runtime 已关闭");
    }
}

impl Drop for TaoRuntimeProcess {
    fn drop(&mut self) {
        self.stop();
    }
}

fn resolve_runtime_script(app: &AppHandle) -> Result<PathBuf, String> {
    let development = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("runtime/tao-runtime.mjs");
    if cfg!(debug_assertions) && development.is_file() {
        return Ok(development);
    }

    let resource = app
        .path()
        .resource_dir()
        .map_err(|error| format!("无法定位 Tao Runtime 资源：{error}"))?
        .join("runtime/tao-runtime.mjs");
    if resource.is_file() {
        return Ok(resource);
    }

    Err(format!("找不到 Tao Runtime 脚本：{}。安装包资源不完整", resource.display()))
}

fn resolve_pi_root(app: &AppHandle) -> Result<PathBuf, String> {
    let development = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../vendor/pi");
    if cfg!(debug_assertions) && development.join("packages/coding-agent/src/index.ts").is_file() {
        return Ok(development);
    }

    let resource = app
        .path()
        .resource_dir()
        .map_err(|error| format!("无法定位 Pi Runtime 资源：{error}"))?
        .join("pi");
    if resource.join("packages/coding-agent/src/index.ts").is_file() {
        return Ok(resource);
    }

    Err(format!("找不到 Tao 内置 Pi 入口：{}。安装包资源不完整", resource.display()))
}

fn resolve_node_binary(app: &AppHandle) -> Result<PathBuf, String> {
    if cfg!(debug_assertions) {
        return Ok(PathBuf::from(if cfg!(windows) { "node.exe" } else { "node" }));
    }

    let resource = app
        .path()
        .resource_dir()
        .map_err(|error| format!("无法定位 Tao Node 资源：{error}"))?
        .join("node")
        .join(if cfg!(windows) { "node.exe" } else { "node" });
    if resource.is_file() {
        return Ok(resource);
    }

    Err(format!(
        "找不到 Tao 内置 Node Runtime：{}。请重新安装完整版本的 Tao。",
        resource.display()
    ))
}

fn fail_pending(
    pending: &Arc<Mutex<HashMap<String, Sender<Result<Value, String>>>>>,
    message: &str,
) {
    let senders = pending
        .lock()
        .map(|mut values| values.drain().map(|(_, sender)| sender).collect::<Vec<_>>())
        .unwrap_or_default();
    for sender in senders {
        let _ = sender.send(Err(message.to_string()));
    }
}

#[cfg(windows)]
fn node_compatible_path(path: &Path) -> PathBuf {
    let raw = path.to_string_lossy();
    if let Some(unc) = raw.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{unc}"));
    }
    if let Some(local) = raw.strip_prefix(r"\\?\") {
        return PathBuf::from(local);
    }
    path.to_path_buf()
}

#[cfg(not(windows))]
fn node_compatible_path(path: &Path) -> PathBuf {
    path.to_path_buf()
}

fn path_to_file_url(path: &Path) -> Result<String, String> {
    url::Url::from_file_path(node_compatible_path(path))
        .map(|url| url.to_string())
        .map_err(|_| format!("无法将 Runtime 路径转换为文件 URL：{}", path.display()))
}

#[cfg(all(test, windows))]
mod tests {
    use super::{node_compatible_path, path_to_file_url};
    use std::path::Path;

    #[test]
    fn verbatim_install_path_becomes_valid_node_file_url() {
        let path = Path::new(r"\\?\D:\software_setup\tao\pi\node_modules\tsx\dist\loader.mjs");
        assert_eq!(
            path_to_file_url(path).unwrap(),
            "file:///D:/software_setup/tao/pi/node_modules/tsx/dist/loader.mjs"
        );
        assert_eq!(
            node_compatible_path(Path::new(r"\\?\D:\software_setup\tao\pi")),
            Path::new(r"D:\software_setup\tao\pi")
        );
    }

    #[test]
    fn file_url_encodes_special_characters() {
        assert_eq!(
            path_to_file_url(Path::new(r"\\?\D:\Tao 安装\pi#1\loader%.mjs")).unwrap(),
            "file:///D:/Tao%20%E5%AE%89%E8%A3%85/pi%231/loader%25.mjs"
        );
    }
}
