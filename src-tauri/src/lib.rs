mod models;
mod files;
mod runtime;
mod pi;
mod storage;
mod agents;

use models::{
    AgentCatalog, AppSettings, AppState, AttachmentReference, ConnectionTestRequest, ConnectionTestResult,
    Conversation, ModelInfo, PermissionResponseRequest, PrepareSessionRequest,
    QueueMessageRequest, RetryMessageRequest, RuntimeConfiguration, SaveSettingsResult,
    SendMessageRequest, SetConversationModelRequest,
    SetConversationPermissionModeRequest, WorkspaceFile, WorkspaceListing,
    TestCustomToolRequest, TestCustomToolResult,
};
use std::collections::BTreeMap;
use std::collections::HashSet;
use std::path::PathBuf;
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

#[tauri::command]
fn choose_workspace_directory(app: AppHandle) -> Result<Option<String>, String> {
    let selected = app
        .dialog()
        .file()
        .set_title("选择 Tao 工作区目录")
        .blocking_pick_folder();
    Ok(selected.map(|path| path.to_string()))
}

#[tauri::command]
fn choose_message_files(app: AppHandle) -> Result<Vec<AttachmentReference>, String> {
    const EXTENSIONS: &[&str] = &[
        "txt", "md", "markdown", "mdx", "json", "jsonc", "yaml", "yml", "toml", "xml", "csv",
        "log", "env", "ini", "conf", "rs", "ts", "tsx", "js", "jsx", "mjs", "cjs", "css",
        "scss", "less", "html", "htm", "vue", "svelte", "py", "go", "java", "kt", "swift",
        "c", "h", "cc", "cpp", "hpp", "cs", "sql", "sh", "bash", "ps1", "cmd", "bat",
    ];
    const MAX_FILES: usize = 8;
    const MAX_SIZE: u64 = 20 * 1024 * 1024;

    let selected = app
        .dialog()
        .file()
        .set_title("选择 Tao 附件")
        .add_filter("文本与代码", EXTENSIONS)
        .blocking_pick_files()
        .unwrap_or_default();
    if selected.len() > MAX_FILES {
        return Err(format!("一次最多附加 {} 个文件", MAX_FILES));
    }

    let mut seen = HashSet::new();
    let mut attachments = Vec::with_capacity(selected.len());
    for file in selected {
        let path = std::fs::canonicalize(PathBuf::from(file.to_string()))
            .map_err(|error| format!("无法读取附件：{error}"))?;
        if !seen.insert(path.clone()) {
            continue;
        }
        let metadata = std::fs::metadata(&path)
            .map_err(|error| format!("无法读取附件 {}：{error}", path.display()))?;
        if !metadata.is_file() {
            return Err(format!("附件不是文件：{}", path.display()));
        }
        if metadata.len() > MAX_SIZE {
            return Err(format!(
                "附件 {} 超过 20 MB 限制",
                path.file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("未命名文件")
            ));
        }
        let extension = path
            .extension()
            .and_then(|extension| extension.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        if !EXTENSIONS.iter().any(|item| *item == extension) {
            return Err(format!("暂不支持该附件类型：{}", path.display()));
        }
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| format!("无法获取附件文件名：{}", path.display()))?;
        attachments.push(AttachmentReference {
            path: path.to_string_lossy().into_owned(),
            name: name.to_string(),
            extension,
            size: metadata.len(),
        });
    }
    Ok(attachments)
}

#[tauri::command]
fn write_export_file(path: String, content: String) -> Result<(), String> {
    let target = std::path::PathBuf::from(path.trim());
    if target.as_os_str().is_empty() {
        return Err("导出路径不能为空".to_string());
    }
    std::fs::write(&target, content.as_bytes())
        .map_err(|error| format!("写入导出文件失败：{error}"))
}

#[tauri::command]
fn list_workspace(
    app: AppHandle,
    workspace_path: String,
    relative_path: String,
) -> Result<WorkspaceListing, String> {
    files::list_workspace(&app, &workspace_path, &relative_path)
}

#[tauri::command]
fn read_workspace_file(
    app: AppHandle,
    workspace_path: String,
    relative_path: String,
) -> Result<WorkspaceFile, String> {
    files::read_workspace_file(&app, &workspace_path, &relative_path)
}

#[tauri::command]
fn read_workspace_diff(
    app: AppHandle,
    workspace_path: String,
    relative_path: String,
) -> Result<WorkspaceFile, String> {
    files::read_workspace_diff(&app, &workspace_path, &relative_path)
}

#[tauri::command]
fn get_runtime_status(app: AppHandle) -> Result<runtime::TaoRuntimeStatus, String> {
    app.state::<runtime::TaoRuntimeManager>().status()
}

#[tauri::command]
fn start_runtime(app: AppHandle) -> Result<(), String> {
    app.state::<runtime::TaoRuntimeManager>().start(&app)
}

#[tauri::command]
fn stop_runtime(app: AppHandle) -> Result<(), String> {
    app.state::<runtime::TaoRuntimeManager>().stop();
    Ok(())
}

#[tauri::command]
fn get_app_state(app: AppHandle) -> Result<AppState, String> {
    storage::get_app_state(&app)
}

#[tauri::command]
fn create_conversation(app: AppHandle) -> Result<Conversation, String> {
    storage::create_conversation(&app)
}

#[tauri::command]
fn create_conversation_with_workspace(
    app: AppHandle,
    workspace_path: Option<String>,
    workspace_name: Option<String>,
) -> Result<Conversation, String> {
    storage::create_conversation_with_workspace(
        &app,
        workspace_path.as_deref(),
        workspace_name.as_deref(),
    )
}

#[tauri::command]
async fn delete_conversation(app: AppHandle, conversation_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let manager = app.state::<runtime::TaoRuntimeManager>();
        let runtime_status = manager.status().ok();
        if runtime_status.as_ref().is_some_and(|status| status.ready) {
            if manager
                .request(
                    &app,
                    serde_json::json!({
                        "type": "close_session",
                        "conversationId": conversation_id,
                    }),
                    Duration::from_secs(10),
                )
                .is_err()
            {
                // A live session could recreate its file after deletion.
                manager.stop();
            }
        } else if runtime_status.as_ref().is_some_and(|status| status.running) {
            // A session may still be opening while the host becomes ready.
            manager.stop();
        }
        storage::delete_conversation(&app, &conversation_id)
    })
    .await
    .map_err(|error| format!("等待删除会话失败：{error}"))?
}

#[tauri::command]
fn set_conversation_pinned(
    app: AppHandle,
    conversation_id: String,
    pinned: bool,
) -> Result<Conversation, String> {
    storage::set_conversation_pinned(&app, &conversation_id, pinned)
}

#[tauri::command]
fn set_conversation_workspace(
    app: AppHandle,
    conversation_id: String,
    workspace_path: String,
) -> Result<Conversation, String> {
    storage::set_conversation_workspace(&app, &conversation_id, &workspace_path)
}

#[tauri::command]
fn set_conversation_model(
    app: AppHandle,
    request: SetConversationModelRequest,
) -> Result<Conversation, String> {
    storage::set_conversation_model(
        &app,
        &request.conversation_id,
        &request.provider,
        &request.model,
        &request.thinking_level,
    )
}

#[tauri::command]
fn set_conversation_permission_mode(
    app: AppHandle,
    request: SetConversationPermissionModeRequest,
) -> Result<Conversation, String> {
    storage::set_conversation_permission_mode(
        &app,
        &request.conversation_id,
        &request.permission_mode,
    )
}

#[tauri::command]
fn rename_conversation(
    app: AppHandle,
    conversation_id: String,
    title: String,
) -> Result<Conversation, String> {
    storage::set_conversation_title(&app, &conversation_id, &title)
}

#[tauri::command]
fn rename_workspace(
    app: AppHandle,
    workspace_path: String,
    workspace_name: String,
) -> Result<Vec<Conversation>, String> {
    storage::rename_workspace(&app, &workspace_path, &workspace_name)
}

#[tauri::command]
async fn save_settings(
    app: AppHandle,
    settings: AppSettings,
    api_keys: Option<BTreeMap<String, String>>,
) -> Result<SaveSettingsResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let settings = storage::save_settings(&app, settings)?;
        pi::save_global_model_configuration(&app, &settings, &api_keys.unwrap_or_default())?;
        app.state::<runtime::TaoRuntimeManager>().restart(&app)?;
        let provider_auth_configured = storage::provider_auth_status(&app, &settings)?;
        let api_key_configured = provider_auth_configured
            .get(&settings.provider)
            .copied()
            .unwrap_or(false);
        Ok(SaveSettingsResult {
            settings,
            api_key_configured,
            provider_auth_configured,
        })
    })
    .await
    .map_err(|error| format!("等待保存设置失败：{error}"))?
}

#[tauri::command]
async fn save_runtime_configuration(
    app: AppHandle,
    configuration: RuntimeConfiguration,
) -> Result<RuntimeConfiguration, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let configuration = storage::save_runtime_configuration(&app, configuration)?;
        let mut catalog = agents::load(&app)?;
        let migrated = agents::migrate(configuration.clone());
        for tool in migrated.tools {
            catalog.tools.retain(|old| old.id != tool.id);
            catalog.tools.push(tool);
        }
        let profile = catalog.profiles.iter_mut().find(|profile| profile.id == catalog.default_profile_id).ok_or("默认组合不存在")?;
        profile.configuration = migrated.profiles[0].configuration.clone();
        profile.custom_tool_ids = migrated.profiles[0].custom_tool_ids.clone();
        agents::save(&app, catalog)?;
        Ok(configuration)
    })
    .await
    .map_err(|error| format!("等待保存 Runtime 配置失败：{error}"))?
}

#[tauri::command]
fn save_agent_catalog(app: AppHandle, catalog: AgentCatalog) -> Result<AgentCatalog, String> {
    agents::save(&app, catalog)
}

#[tauri::command]
fn get_agent_catalog(app: AppHandle) -> Result<AgentCatalog, String> { agents::load(&app) }

#[tauri::command]
fn parse_agent_catalog(content: String) -> Result<AgentCatalog, String> {
    if content.len() > 2 * 1024 * 1024 { return Err("配置文件不能超过 2 MB".into()); }
    agents::normalize(serde_json::from_str(&content).map_err(|e| format!("配置 JSON 无效：{e}"))?)
}

#[tauri::command]
fn choose_agent_catalog(app: AppHandle) -> Result<Option<AgentCatalog>, String> {
    let Some(selected) = app.dialog().file().set_title("导入 Tao 智能体组合").add_filter("Tao 组合", &["json"]).blocking_pick_file() else { return Ok(None); };
    let path = PathBuf::from(selected.to_string());
    let metadata = std::fs::metadata(&path).map_err(|e| format!("无法读取配置文件：{e}"))?;
    if !metadata.is_file() || metadata.len() > 2 * 1024 * 1024 { return Err("配置应为不超过 2 MB 的 JSON 文件".into()); }
    parse_agent_catalog(std::fs::read_to_string(path).map_err(|e| format!("无法读取配置文件：{e}"))?).map(Some)
}

#[tauri::command]
fn set_workspace_agent_default(app: AppHandle, workspace_path: String, profile_id: String) -> Result<AgentCatalog, String> {
    agents::set_workspace_default(&app, &workspace_path, &profile_id)
}

#[tauri::command]
async fn set_conversation_agent(app: AppHandle, conversation_id: String, profile_id: String) -> Result<Conversation, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let snapshot = agents::snapshot(&agents::load(&app)?, &profile_id)?;
        let mut conversation = storage::load_conversation_if_exists(&app, &conversation_id)?.ok_or("会话不存在")?;
        let manager = app.state::<runtime::TaoRuntimeManager>();
        if manager.status()?.ready {
            manager.request(&app, serde_json::json!({ "type": "close_idle_session", "conversationId": conversation_id }), Duration::from_secs(10))?;
        }
        if conversation.messages.is_empty() {
            if let Some(defaults) = &snapshot.default_model {
                conversation.provider = defaults.provider.clone();
                conversation.model = defaults.model.clone();
                conversation.thinking_level = defaults.thinking_level.clone();
            }
        }
        conversation.agent_snapshot = Some(snapshot);
        conversation.updated_at = storage::now_millis();
        storage::write_conversation(&app, &conversation)?;
        Ok(conversation)
    }).await.map_err(|e| format!("切换智能体组合失败：{e}"))?
}

#[tauri::command]
async fn test_custom_tool(
    app: AppHandle,
    request: TestCustomToolRequest,
) -> Result<TestCustomToolResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let manager = app.state::<runtime::TaoRuntimeManager>();
        let workspace_path = request
            .workspace_path
            .filter(|path| !path.trim().is_empty())
            .or_else(|| {
                app.path()
                    .home_dir()
                    .ok()
                    .map(|path| path.to_string_lossy().into_owned())
            })
            .ok_or_else(|| "无法定位自定义工具测试工作区".to_string())?;
        let response = manager.request(
            &app,
            serde_json::json!({
                "type": "test_custom_tool",
                "tool": request.tool,
                "input": request.input,
                "workspacePath": workspace_path,
                "permissionRule": request.permission_rule,
            }),
            // Tool timeout is at most 120 seconds; allow its process-tree
            // cancellation and result delivery to finish before the RPC expires.
            Duration::from_secs(130),
        )?;
        Ok(TestCustomToolResult {
            output: response
                .get("output")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default()
                .to_string(),
        })
    })
    .await
    .map_err(|error| format!("等待自定义工具测试失败：{error}"))?
}

#[tauri::command]
fn abort_generation(app: AppHandle, conversation_id: String) -> Result<(), String> {
    app.state::<runtime::TaoRuntimeManager>().request(
        &app,
        serde_json::json!({
            "type": "abort",
            "conversationId": conversation_id,
        }),
        Duration::from_secs(30),
    )?;
    Ok(())
}

#[tauri::command]
fn queue_message(app: AppHandle, request: QueueMessageRequest) -> Result<(), String> {
    let text = request.text.trim();
    if text.is_empty() {
        return Err("追加消息不能为空".to_string());
    }
    let command_type = match request.behavior.as_str() {
        "steer" => "steer",
        "follow_up" => "follow_up",
        _ => return Err("追加方式无效".to_string()),
    };
    app.state::<runtime::TaoRuntimeManager>().request(
        &app,
        serde_json::json!({
            "type": command_type,
            "conversationId": request.conversation_id,
            "message": text,
        }),
        Duration::from_secs(30),
    )?;
    Ok(())
}

#[tauri::command]
fn resolve_permission_request(
    app: AppHandle,
    response: PermissionResponseRequest,
) -> Result<(), String> {
    let permission_id = response.permission_id.trim();
    let conversation_id = response.conversation_id.trim();
    let decision = response.decision.trim();
    if permission_id.is_empty() || conversation_id.is_empty() {
        return Err("权限确认参数不完整".to_string());
    }
    if !matches!(decision, "allow_once" | "allow_session" | "deny") {
        return Err("权限确认结果无效".to_string());
    }
    app.state::<runtime::TaoRuntimeManager>().request(
        &app,
        serde_json::json!({
            "type": "permission_response",
            "conversationId": conversation_id,
            "requestId": response.request_id,
            "permissionId": permission_id,
            "decision": decision,
        }),
        Duration::from_secs(30),
    )?;
    Ok(())
}

#[tauri::command]
async fn prepare_session(app: AppHandle, request: PrepareSessionRequest) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let manager = app.state::<runtime::TaoRuntimeManager>();
        pi::prepare_session(&app, &manager, request)
    })
    .await
    .map_err(|error| format!("等待准备 Tao 会话失败：{error}"))?
}

#[tauri::command]
fn list_models(app: AppHandle) -> Result<Vec<ModelInfo>, String> {
    pi::list_models(&app)
}

#[tauri::command]
async fn test_connection(
    app: AppHandle,
    request: ConnectionTestRequest,
) -> Result<ConnectionTestResult, String> {
    pi::test_connection(&app, request).await
}

#[tauri::command]
async fn send_message(app: AppHandle, request: SendMessageRequest) -> Result<Conversation, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let manager = app.state::<runtime::TaoRuntimeManager>();
        pi::send_message(&app, &manager, request)
    })
        .await
        .map_err(|error| format!("等待 Tao 运行失败：{error}"))?
}

#[tauri::command]
async fn retry_message(app: AppHandle, request: RetryMessageRequest) -> Result<Conversation, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let manager = app.state::<runtime::TaoRuntimeManager>();
        pi::retry_message(&app, &manager, request)
    })
        .await
        .map_err(|error| format!("等待 Tao 运行失败：{error}"))?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(runtime::TaoRuntimeManager::default())
        .setup(|app| {
            let handle = app.handle().clone();
            // Keep the window available so the startup error can be shown and
            // local conversation management remains usable.
            let _ = app.state::<runtime::TaoRuntimeManager>().start(&handle);
            Ok(())
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            get_runtime_status,
            start_runtime,
            stop_runtime,
            get_app_state,
            create_conversation,
            create_conversation_with_workspace,
            delete_conversation,
            set_conversation_pinned,
            set_conversation_workspace,
            set_conversation_model,
            set_conversation_permission_mode,
            rename_conversation,
            rename_workspace,
            save_settings,
            save_runtime_configuration,
            save_agent_catalog,
            get_agent_catalog,
            parse_agent_catalog,
            choose_agent_catalog,
            set_workspace_agent_default,
            set_conversation_agent,
            test_custom_tool,
            abort_generation,
            queue_message,
            resolve_permission_request,
            prepare_session,
            list_models,
            test_connection,
            send_message,
            retry_message,
            choose_workspace_directory,
            choose_message_files,
            list_workspace,
            read_workspace_file,
            read_workspace_diff,
            write_export_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running Tao");
}
