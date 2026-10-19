use crate::runtime::TaoRuntimeManager;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MemberControl {
    conversation_id: String,
    run_id: String,
    action: String,
    request_key: String,
    agent_id: Option<String>,
    task_id: Option<String>,
    attempt_id: Option<String>,
    expected_version: Option<u64>,
    body: Option<String>,
    task_name: Option<String>,
}

fn valid_id(value: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > 160 || !value.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_') {
        return Err("协作记录标识无效".into());
    }
    Ok(())
}

#[tauri::command]
pub fn get_member_appearance(app: AppHandle) -> Result<Value, String> {
    let settings = crate::storage::load_settings(&app)?;
    Ok(json!({ "theme": settings.theme, "accentColor": settings.accent_color }))
}

#[tauri::command]
pub async fn get_collaboration(app: AppHandle, conversation_id: String, run_id: Option<String>, agent_id: Option<String>, event_limit: Option<u32>) -> Result<Value, String> {
    valid_id(&conversation_id)?;
    if let Some(id) = &run_id { valid_id(id)?; }
    if let Some(id) = &agent_id { valid_id(id)?; }
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<TaoRuntimeManager>().request(&app, json!({
            "type": if run_id.is_some() { "get_team_view" } else { "list_team_runs" },
            "conversationId": conversation_id, "runId": run_id, "agentId": agent_id, "eventLimit": event_limit.unwrap_or(100),
        }), Duration::from_secs(15))
    }).await.map_err(|error| format!("读取协作记录失败：{error}"))?
}

#[tauri::command]
pub async fn control_collaboration(app: AppHandle, request: MemberControl) -> Result<Value, String> {
    valid_id(&request.conversation_id)?;
    valid_id(&request.run_id)?;
    for id in [&request.agent_id, &request.task_id, &request.attempt_id].into_iter().flatten() { valid_id(id)?; }
    if !["message", "followup", "cancel_task", "cancel_agent", "stop_run"].contains(&request.action.as_str()) || request.request_key.len() > 90 {
        return Err("协作控制操作无效".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<TaoRuntimeManager>().request(&app, json!({
            "type": "control_team", "conversationId": request.conversation_id, "runId": request.run_id,
            "action": request.action, "requestKey": request.request_key, "agentId": request.agent_id,
            "taskId": request.task_id, "attemptId": request.attempt_id, "expectedVersion": request.expected_version,
            "body": request.body, "taskName": request.task_name,
        }), Duration::from_secs(30))
    }).await.map_err(|error| format!("等待成员操作失败：{error}"))?
}

#[tauri::command]
pub async fn open_member_window(app: AppHandle, conversation_id: String, run_id: String, agent_id: String) -> Result<(), String> {
    valid_id(&conversation_id)?;
    valid_id(&run_id)?;
    valid_id(&agent_id)?;
    // Validate ownership through the shared Runtime; opening never creates an AgentSession.
    let view = get_collaboration(app.clone(), conversation_id.clone(), Some(run_id.clone()), Some(agent_id.clone()), Some(1)).await?;
    let member_name = view["agents"].as_array().and_then(|agents| agents.iter().find(|agent| agent["id"].as_str() == Some(&agent_id))).and_then(|agent| agent["name"].as_str()).unwrap_or("协作成员");
    let title = format!("Tao · {} · {}", member_name.chars().take(40).collect::<String>(), run_id.chars().take(8).collect::<String>());
    let mut hasher = DefaultHasher::new();
    (&conversation_id, &run_id, &agent_id).hash(&mut hasher);
    let label = format!("member-{:x}", hasher.finish());
    if let Some(window) = app.get_webview_window(&label) {
        window.show().map_err(|error| error.to_string())?;
        return window.set_focus().map_err(|error| error.to_string());
    }
    let url = format!("index.html?member=1&conversationId={conversation_id}&runId={run_id}&agentId={agent_id}");
    if let Err(error) = WebviewWindowBuilder::new(&app, label.clone(), WebviewUrl::App(url.into()))
        .title(title).inner_size(960.0, 760.0).min_inner_size(650.0, 500.0).build() {
        // Two viewers may request the same window while ownership validation awaits.
        if let Some(window) = app.get_webview_window(&label) {
            window.show().map_err(|error| error.to_string())?;
            window.set_focus().map_err(|error| error.to_string())?;
        } else { return Err(format!("打开成员窗口失败：{error}")); }
    }
    Ok(())
}

#[tauri::command]
pub fn focus_main_window(app: AppHandle, conversation_id: String) -> Result<(), String> {
    valid_id(&conversation_id)?;
    let window = app.get_webview_window("main").ok_or("主窗口已关闭，请重新打开 Tao")?;
    window.emit("tao-open-conversation", json!({ "conversationId": conversation_id })).map_err(|error| error.to_string())?;
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn identifiers_reject_paths_and_url_components() {
        for value in ["", "../root", "D:\\root", "abc?x=y", "abc%20", "abc&root=x"] { assert!(valid_id(value).is_err()); }
        assert!(valid_id("agent-a7f3_123").is_ok());
    }
    #[test]
    fn control_request_cannot_smuggle_runtime_fields() {
        assert!(serde_json::from_value::<MemberControl>(json!({"conversationId":"root","runId":"run","action":"message","requestKey":"key","type":"prompt"})).is_err());
    }
}
