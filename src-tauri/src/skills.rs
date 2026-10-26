use crate::{runtime::TaoRuntimeManager, storage, models::RuntimeConfiguration};
use serde_json::{json, Value};
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

#[tauri::command]
pub async fn list_skills(app: AppHandle, conversation_id: Option<String>) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let configuration = match &conversation_id {
            Some(id) => Some(storage::load_conversation_if_exists(&app, id)?.and_then(|c| c.agent_snapshot).ok_or("会话不存在或没有组合快照")?.configuration),
            None => None,
        };
        app.state::<TaoRuntimeManager>().request(&app, json!({"type": "list_skills", "conversationId": conversation_id, "runtimeConfiguration": configuration}), Duration::from_secs(30))
    }).await.map_err(|error| format!("读取技能列表失败：{error}"))?
}

#[tauri::command]
pub async fn choose_and_import_skill(app: AppHandle) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let selected = app.dialog().file().set_title("选择包含 SKILL.md 的技能目录").blocking_pick_folder();
        match selected {
            None => Ok(Value::Null),
            Some(path) => app.state::<TaoRuntimeManager>().request(&app, json!({"type": "import_skill", "directory": path.to_string()}), Duration::from_secs(60)),
        }
    }).await.map_err(|error| format!("导入技能失败：{error}"))?
}

#[tauri::command]
pub async fn inspect_github_skill(app: AppHandle, source: Value, configuration: RuntimeConfiguration) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let configuration = storage::normalize_runtime_configuration(configuration)?;
        app.state::<TaoRuntimeManager>().request(&app, json!({"type": "inspect_github_skill", "source": source, "runtimeConfiguration": configuration}), Duration::from_secs(65))
    }).await.map_err(|error| format!("检查技能失败：{error}"))?
}

#[tauri::command]
pub async fn install_github_skill(app: AppHandle, preview_id: String, configuration: RuntimeConfiguration) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let configuration = storage::normalize_runtime_configuration(configuration)?;
        app.state::<TaoRuntimeManager>().request(&app, json!({"type": "install_github_skill", "previewId": preview_id, "runtimeConfiguration": configuration}), Duration::from_secs(125))
    }).await.map_err(|error| format!("安装技能失败：{error}"))?
}
