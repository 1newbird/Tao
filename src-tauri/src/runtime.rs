use crate::models::TaoRuntimeEvent;
use crate::storage;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
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
    pub running: bool,
    pub ready: bool,
    pub pid: Option<u32>,
    pub uptime_ms: Option<u64>,
    pub session_count: usize,
    pub last_error: Option<String>,
}

pub struct TaoRuntimeManager {
    process: Mutex<Option<Arc<TaoRuntimeProcess>>>,
}

impl Default for TaoRuntimeManager {
    fn default() -> Self {
        Self {
            process: Mutex::new(None),
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
    pid: u32,
    started_at: Instant,
}

impl TaoRuntimeManager {
    pub fn start(&self, app: &AppHandle) -> Result<(), String> {
        let mut slot = self
            .process
            .lock()
            .map_err(|_| "Tao Runtime 状态不可用".to_string())?;
        if let Some(process) = slot.as_ref() {
            if process.is_running()? {
                return Ok(());
            }
        }

        let script = resolve_runtime_script(app)?;
        let pi_root = resolve_pi_root(app)?;
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
        let tsx_preflight = pi_root.join("node_modules/tsx/dist/preflight.cjs");
        let tsx_loader = pi_root.join("node_modules/tsx/dist/loader.mjs");
        if !tsx_preflight.is_file() || !tsx_loader.is_file() {
            return Err(format!(
                "Pi 依赖未安装：缺少 tsx runtime。请在 {} 中执行 npm.cmd install --ignore-scripts",
                pi_root.display()
            ));
        }
        let tao_home = storage::app_data_root(app)?;
        let node_binary = resolve_node_binary(app)?;
        let mut command = Command::new(&node_binary);
        command
            .arg("--require")
            .arg(&tsx_preflight)
            .arg("--import")
            .arg(path_to_file_url(&tsx_loader))
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
        let output_pending = Arc::clone(&pending);
        let output_ready = Arc::clone(&ready);
        let output_session_count = Arc::clone(&session_count);
        let output_error = Arc::clone(&last_error);
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
        thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                if !line.trim().is_empty() {
                    if let Ok(mut target) = stderr_error.lock() {
                        *target = Some(line);
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
            pid,
            started_at: Instant::now(),
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
        if !process.is_running()? {
            return Err(process
                .last_error
                .lock()
                .ok()
                .and_then(|value| value.clone())
                .unwrap_or_else(|| "Tao Runtime 已退出".to_string()));
        }

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
            return Ok(TaoRuntimeStatus {
                running: false,
                ready: false,
                pid: None,
                uptime_ms: None,
                session_count: 0,
                last_error: None,
            });
        };
        let running = process.is_running()?;
        Ok(TaoRuntimeStatus {
            running,
            ready: running && process.ready.load(Ordering::SeqCst),
            pid: Some(process.pid),
            uptime_ms: Some(process.started_at.elapsed().as_millis() as u64),
            session_count: process.session_count.load(Ordering::SeqCst),
            last_error: process.last_error.lock().ok().and_then(|value| value.clone()),
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

    Err("找不到 Tao Runtime 脚本".to_string())
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

    Err("找不到 Tao 内置的 Pi source（vendor/pi）".to_string())
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

fn path_to_file_url(path: &std::path::Path) -> String {
    let encoded = path
        .to_string_lossy()
        .replace('%', "%25")
        .replace(' ', "%20")
        .replace('#', "%23")
        .replace('?', "%3F")
        .replace('\\', "/");
    format!("file:///{encoded}")
}
