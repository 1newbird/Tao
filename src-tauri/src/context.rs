use crate::{models::RuntimeConfiguration, runtime::TaoRuntimeManager, storage};
use serde_json::{json, Value};
use std::time::Duration;
use tauri::{AppHandle, Manager};

#[tauri::command]
pub async fn inspect_web_capabilities(app: AppHandle, configuration: Option<RuntimeConfiguration>, conversation_id: Option<String>) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // Drafts may be incomplete. The inspector reports their limitations without saving or connecting.
        let configuration = match (configuration, conversation_id) {
            (Some(configuration), None) => configuration,
            (None, Some(id)) => storage::load_conversation_if_exists(&app, &id)?
                .and_then(|conversation| conversation.agent_snapshot)
                .ok_or("会话不存在或没有组合快照")?.configuration,
            _ => return Err("请选择组合草稿或已有会话".into()),
        };
        app.state::<TaoRuntimeManager>().request(&app, json!({ "type": "inspect_web_capabilities", "runtimeConfiguration": configuration }), Duration::from_secs(20))
    }).await.map_err(|error| format!("检查联网配置失败：{error}"))?
}

#[tauri::command]
pub async fn test_mcp_connection(app: AppHandle, configuration: RuntimeConfiguration, server_id: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let configuration = storage::normalize_runtime_configuration(configuration)?;
        app.state::<TaoRuntimeManager>().request(&app, json!({ "type": "test_mcp_connection", "runtimeConfiguration": configuration, "serverId": server_id }), Duration::from_secs(35))
    }).await.map_err(|error| format!("测试 MCP 连接失败：{error}"))?
}

#[tauri::command]
pub async fn test_web_search(app: AppHandle, configuration: RuntimeConfiguration) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let configuration = storage::normalize_runtime_configuration(configuration)?;
        app.state::<TaoRuntimeManager>().request(&app, json!({ "type": "test_web_search", "runtimeConfiguration": configuration }), Duration::from_secs(35))
    }).await.map_err(|error| format!("测试搜索连接失败：{error}"))?
}

#[tauri::command]
pub async fn preview_context(app: AppHandle, configuration: Option<RuntimeConfiguration>, conversation_id: Option<String>) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let configuration = match (configuration, conversation_id) {
            (Some(configuration), None) => storage::normalize_runtime_configuration(configuration)?,
            (None, Some(id)) => storage::load_conversation_if_exists(&app, &id)?
                .and_then(|conversation| conversation.agent_snapshot)
                .ok_or("会话不存在或没有组合快照")?.configuration,
            _ => return Err("请选择组合草稿或已有会话进行预览".into()),
        };
        app.state::<TaoRuntimeManager>().request(&app, json!({ "type": "preview_context", "runtimeConfiguration": configuration }), Duration::from_secs(20))
    }).await.map_err(|error| format!("预览上下文失败：{error}"))?
}

#[tauri::command]
pub async fn get_conversation_context(app: AppHandle, conversation_id: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conversation = storage::load_conversation_if_exists(&app, &conversation_id)?.ok_or("会话不存在")?;
        let path = storage::app_data_root(&app)?.join("contexts").join(format!("{conversation_id}.json"));
        let snapshot = if path.exists() {
            if std::fs::metadata(&path).map_err(|error| error.to_string())?.len() > 2 * 1024 * 1024 { return Err("上下文记录超过读取上限".into()); }
            let value: Value = serde_json::from_str(&std::fs::read_to_string(&path).map_err(|error| error.to_string())?).map_err(|_| "上下文记录损坏")?;
            if value["schemaVersion"] != 1 || value["conversationId"] != conversation_id { return Err("上下文记录格式无效".into()); }
            value
        } else { Value::Null };
        Ok(json!({ "snapshot": snapshot, "current": {
            "profile": conversation.agent_snapshot.as_ref().map(|snapshot| json!({ "profileId": snapshot.profile_id, "name": snapshot.name, "revision": snapshot.revision })),
            "workspacePath": conversation.workspace_path, "permissionMode": conversation.permission_mode,
            "provider": conversation.provider, "model": conversation.model,
        }}))
    }).await.map_err(|error| format!("读取上下文失败：{error}"))?
}
