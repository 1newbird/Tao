use crate::models::{
    ActivityItem, AppSettings, AttachmentReference, ConnectionTestRequest, ConnectionTestResult,
    Conversation, Message, ModelInfo, PrepareSessionRequest, ProviderModel, RetryConfiguration,
    RetryMessageRequest, SendMessageRequest,
    TraceItem,
};
use crate::runtime::TaoRuntimeManager;
use crate::storage;
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

// Long agent turns can finish tools before the final assistant response is
// ready. Keep this as an outer guard only; Pi still owns provider retries.
const RPC_RESPONSE_TIMEOUT: Duration = Duration::from_secs(30 * 60);

struct PiPromptResult {
    messages: Vec<Message>,
}

const MAX_MESSAGE_ATTACHMENTS: usize = 8;
const MAX_ATTACHMENT_SIZE: u64 = 20 * 1024 * 1024;

fn normalize_attachments(
    attachments: &[AttachmentReference],
) -> Result<Vec<AttachmentReference>, String> {
    if attachments.len() > MAX_MESSAGE_ATTACHMENTS {
        return Err(format!("一次最多附加 {} 个文件", MAX_MESSAGE_ATTACHMENTS));
    }

    let mut normalized = Vec::with_capacity(attachments.len());
    for attachment in attachments {
        let raw_path = attachment.path.trim();
        if raw_path.is_empty() {
            return Err("附件路径不能为空".to_string());
        }
        let path = fs::canonicalize(raw_path)
            .map_err(|error| format!("无法读取附件 {}：{error}", raw_path))?;
        let metadata = fs::metadata(&path)
            .map_err(|error| format!("无法读取附件 {}：{error}", path.display()))?;
        if !metadata.is_file() {
            return Err(format!("附件不是文件：{}", path.display()));
        }
        if metadata.len() > MAX_ATTACHMENT_SIZE {
            return Err(format!(
                "附件 {} 超过 20 MB 限制",
                path.file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("未命名文件")
            ));
        }
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .filter(|name| !name.trim().is_empty())
            .ok_or_else(|| format!("无法获取附件文件名：{}", path.display()))?;
        let extension = Path::new(name)
            .extension()
            .and_then(|extension| extension.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        normalized.push(AttachmentReference {
            path: path.to_string_lossy().into_owned(),
            name: name.to_string(),
            extension,
            size: metadata.len(),
        });
    }
    Ok(normalized)
}

pub async fn test_connection(
    app: &AppHandle,
    request: ConnectionTestRequest,
) -> Result<ConnectionTestResult, String> {
    let base_url = validate_base_url(&request.base_url)?;
    let provider_id = request.provider_id.trim();
    if provider_id.is_empty() {
        return Err("Provider ID 不能为空".to_string());
    }
    let provider_name = if request.provider_name.trim().is_empty() {
        provider_id
    } else {
        request.provider_name.trim()
    };
    let submitted_api_key = request.api_key.trim();
    let saved_api_key = if submitted_api_key.is_empty() {
        storage::load_api_key(app, provider_id)?
    } else {
        None
    };
    let api_key = if submitted_api_key.is_empty() {
        saved_api_key
            .as_deref()
            .ok_or_else(|| "请先填写或保存 API key".to_string())?
    } else {
        submitted_api_key
    };

    let endpoint = if base_url.ends_with("/models") {
        base_url
    } else {
        format!("{base_url}/models")
    };
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|error| format!("无法创建连接测试客户端：{error}"))?;
    let started = Instant::now();
    let response = client
        .get(&endpoint)
        .bearer_auth(api_key)
        .send()
        .await
        .map_err(|error| format!("无法连接模型接口：{error}"))?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| format!("无法读取模型接口响应：{error}"))?;
    if !status.is_success() {
        let detail: String = body.chars().take(500).collect();
        return Err(format!(
            "连接失败（HTTP {}）：{}",
            status.as_u16(),
            if detail.trim().is_empty() {
                "接口未返回错误详情"
            } else {
                detail.trim()
            }
        ));
    }

    let payload: Value = serde_json::from_str(&body)
        .map_err(|error| format!("连接成功，但模型列表不是有效 JSON：{error}"))?;
    let candidates = payload
        .get("data")
        .and_then(Value::as_array)
        .or_else(|| payload.get("models").and_then(Value::as_array))
        .or_else(|| payload.as_array())
        .ok_or_else(|| "连接成功，但响应中没有模型数组（data 或 models）".to_string())?;
    let mut models = candidates
        .iter()
        .filter_map(parse_provider_model)
        .collect::<Vec<_>>();
    models.sort_by(|left, right| left.id.cmp(&right.id));
    models.dedup_by(|left, right| left.id == right.id);
    if models.is_empty() {
        return Err("连接成功，但接口没有返回可用模型".to_string());
    }

    Ok(ConnectionTestResult {
        provider_id: provider_id.to_string(),
        provider_name: provider_name.to_string(),
        endpoint,
        latency_ms: started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64,
        models,
    })
}

fn parse_provider_model(value: &Value) -> Option<ProviderModel> {
    let id = value
        .as_str()
        .or_else(|| value.get("id").and_then(Value::as_str))?
        .trim();
    if id.is_empty() {
        return None;
    }
    let name = value
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .unwrap_or(id);
    Some(ProviderModel {
        id: id.to_string(),
        name: name.to_string(),
        reasoning: value
            .get("reasoning")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        context_window: value
            .get("contextWindow")
            .or_else(|| value.get("context_window"))
            .and_then(Value::as_u64),
        max_tokens: value
            .get("maxTokens")
            .or_else(|| value.get("max_tokens"))
            .and_then(Value::as_u64),
    })
}

pub fn list_models(app: &AppHandle) -> Result<Vec<ModelInfo>, String> {
    let data_dir = resolve_pi_root(app)?.join("packages/ai/src/providers/data");
    let mut models = BTreeMap::new();

    for entry in fs::read_dir(&data_dir).map_err(|error| format!("无法读取 Pi 模型数据：{error}"))? {
        let entry = entry.map_err(|error| format!("无法读取模型文件：{error}"))?;
        let path = entry.path();
        if path.extension().and_then(|extension| extension.to_str()) != Some("json") {
            continue;
        }

        let content = fs::read_to_string(&path)
            .map_err(|error| format!("无法读取模型文件（{}）：{error}", path.display()))?;
        let root: Value = serde_json::from_str(&content)
            .map_err(|error| format!("模型文件格式错误（{}）：{error}", path.display()))?;
        let Some(api_groups) = root.as_object() else {
            continue;
        };

        for (api, group_value) in api_groups {
            let Some(group) = group_value.as_object() else {
                continue;
            };
            for model in group.values().filter_map(Value::as_object) {
                let Some(provider) = model.get("provider").and_then(Value::as_str) else {
                    continue;
                };
                let Some(id) = model.get("id").and_then(Value::as_str) else {
                    continue;
                };
                let name = model.get("name").and_then(Value::as_str).unwrap_or(id);
                let info = ModelInfo {
                    provider: provider.to_string(),
                    id: id.to_string(),
                    name: name.to_string(),
                    reasoning: model.get("reasoning").and_then(Value::as_bool).unwrap_or(false),
                    api: model
                        .get("api")
                        .and_then(Value::as_str)
                        .unwrap_or(api)
                        .to_string(),
                    context_window: model.get("contextWindow").and_then(Value::as_u64),
                    max_tokens: model.get("maxTokens").and_then(Value::as_u64),
                };
                models.insert(format!("{provider}/{id}"), info);
            }
        }
    }

    let custom_path = storage::app_data_root(app)?.join("models.json");
    if custom_path.is_file() {
        let content = fs::read_to_string(&custom_path)
            .map_err(|error| format!("无法读取 Tao 自定义模型配置：{error}"))?;
        let root: Value = serde_json::from_str(&content)
            .map_err(|error| format!("Tao 自定义模型配置格式错误：{error}"))?;
        if let Some(providers) = root.get("providers").and_then(Value::as_object) {
            for (provider, profile) in providers {
                let Some(profile_models) = profile.get("models").and_then(Value::as_array) else {
                    continue;
                };
                let api = profile
                    .get("api")
                    .and_then(Value::as_str)
                    .unwrap_or("openai-completions");
                for model in profile_models {
                    let Some(provider_model) = parse_provider_model(model) else {
                        continue;
                    };
                    models.insert(
                        format!("{provider}/{}", provider_model.id),
                        ModelInfo {
                            provider: provider.clone(),
                            id: provider_model.id,
                            name: provider_model.name,
                            reasoning: provider_model.reasoning,
                            api: api.to_string(),
                            context_window: provider_model.context_window,
                            max_tokens: provider_model.max_tokens,
                        },
                    );
                }
            }
        }
    }

    Ok(models.into_values().collect())
}

pub fn save_global_model_configuration(
    app: &AppHandle,
    settings: &AppSettings,
    api_keys: &BTreeMap<String, String>,
) -> Result<(), String> {
    let agent_dir = storage::app_data_root(app)?;
    write_model_config(&agent_dir, &settings.providers)?;
    for (provider, api_key) in api_keys {
        if !api_key.trim().is_empty() {
            storage::save_api_key(app, provider, api_key)?;
        }
    }
    storage::save_pi_defaults(
        app,
        storage::credential_provider(settings),
        &settings.model,
        &settings.thinking_level,
    )
}

pub fn send_message(
    app: &AppHandle,
    manager: &TaoRuntimeManager,
    mut request: SendMessageRequest,
) -> Result<Conversation, String> {
    let text = request.text.trim();
    let attachments = normalize_attachments(&request.attachments)?;
    request.attachments = attachments.clone();
    let provider = request.provider.trim();
    let model = request.model.trim();
    if request.request_id.trim().is_empty() {
        return Err("请求 ID 不能为空".to_string());
    }
    if text.is_empty() && attachments.is_empty() {
        return Err("消息或附件不能为空".to_string());
    }
    if provider.is_empty() || model.is_empty() {
        return Err("请先配置 Provider 和 Model".to_string());
    }
    let permission_mode = normalize_permission_mode(&request.permission_mode);

    let mut conversation = storage::load_conversation_if_exists(app, &request.conversation_id)?
        .unwrap_or_else(|| {
            let mut conversation =
                storage::new_conversation(provider, model, &request.thinking_level);
            conversation.id = request.conversation_id.clone();
            conversation
        });
    let timestamp = storage::now_millis();
    conversation.messages.push(Message {
        id: storage::new_id("message"),
        role: "user".to_string(),
        content: text.to_string(),
        created_at: timestamp,
        status: None,
        retry: None,
        thinking: None,
        duration_ms: None,
        activities: None,
        traces: None,
        attachments: (!attachments.is_empty()).then_some(attachments.clone()),
    });
    conversation.provider = provider.to_string();
    conversation.model = model.to_string();
    conversation.thinking_level = request.thinking_level.trim().to_string();
    conversation.permission_mode = permission_mode.to_string();
    conversation.updated_at = timestamp;
    if conversation.title == "新对话" {
        conversation.title = if text.is_empty() {
            format!("附件：{}", attachments[0].name)
        } else {
            text.chars().take(24).collect()
        };
    }
    storage::write_conversation(app, &conversation)?;

    match run_pi_rpc(app, manager, &conversation, text, &request) {
        Ok(result) => conversation.messages.extend(result.messages),
        Err(error) => {
            conversation.messages.push(Message {
                id: storage::new_id("message"),
                role: "error".to_string(),
                content: error.clone(),
                created_at: storage::now_millis(),
                status: None,
                retry: Some(RetryConfiguration {
                    provider: request.provider.trim().to_string(),
                    model: request.model.trim().to_string(),
                    base_url: request.base_url.trim().to_string(),
                    api: request.api.trim().to_string(),
                    thinking_level: request.thinking_level.trim().to_string(),
                }),
                thinking: None,
                duration_ms: None,
                activities: None,
                traces: None,
                attachments: None,
            });
            conversation.updated_at = storage::now_millis();
            storage::write_conversation(app, &conversation)?;
            return Err(error);
        }
    }

    conversation.updated_at = storage::now_millis();
    storage::write_conversation(app, &conversation)?;
    Ok(conversation)
}

pub fn retry_message(
    app: &AppHandle,
    manager: &TaoRuntimeManager,
    request: RetryMessageRequest,
) -> Result<Conversation, String> {
    if request.request_id.trim().is_empty() {
        return Err("请求 ID 不能为空".to_string());
    }
    if request.conversation_id.trim().is_empty() || request.error_message_id.trim().is_empty() {
        return Err("重试参数不完整".to_string());
    }

    let mut conversation = storage::load_conversation_if_exists(app, &request.conversation_id)?
        .ok_or_else(|| "找不到需要重试的对话".to_string())?;
    let error_index = conversation
        .messages
        .iter()
        .position(|message| message.id == request.error_message_id && message.role == "error")
        .ok_or_else(|| "找不到需要重试的失败消息".to_string())?;
    let retry = conversation.messages[error_index]
        .retry
        .clone()
        .ok_or_else(|| "这条失败消息没有可重试配置".to_string())?;
    let user_message = conversation.messages[..error_index]
        .iter()
        .rev()
        .find(|message| message.role == "user")
        .cloned()
        .ok_or_else(|| "找不到这次请求对应的用户消息".to_string())?;
    let text = user_message.content.trim().to_string();
    let attachments = user_message.attachments.clone().unwrap_or_default();
    if text.is_empty() && attachments.is_empty() {
        return Err("原始用户消息和附件都为空，无法重试".to_string());
    }

    conversation.messages.remove(error_index);
    conversation.provider = retry.provider.clone();
    conversation.model = retry.model.clone();
    conversation.thinking_level = retry.thinking_level.clone();
    conversation.updated_at = storage::now_millis();
    storage::write_conversation(app, &conversation)?;

    let prompt_request = SendMessageRequest {
        request_id: request.request_id,
        conversation_id: request.conversation_id,
        text,
        provider: retry.provider,
        model: retry.model,
        base_url: retry.base_url,
        api: retry.api,
        thinking_level: retry.thinking_level,
        permission_mode: conversation.permission_mode.clone(),
        permission_timeout_ms: storage::load_settings(app)?.permission_timeout_ms,
        attachments,
    };

    if let Err(error) = manager.request(
        app,
        serde_json::json!({
            "type": "cancel_active",
            "conversationId": conversation.id,
        }),
        Duration::from_secs(30),
    ) {
        if !error.contains("没有正在生成") && !error.contains("尚未创建") {
            return Err(format!("无法清理上一次失败的运行状态：{error}"));
        }
    }

    match run_pi_rpc(app, manager, &conversation, &prompt_request.text, &prompt_request) {
        Ok(result) => conversation.messages.extend(result.messages),
        Err(error) => {
            conversation.messages.push(Message {
                id: storage::new_id("message"),
                role: "error".to_string(),
                content: error.clone(),
                created_at: storage::now_millis(),
                status: None,
                retry: Some(RetryConfiguration {
                    provider: prompt_request.provider.trim().to_string(),
                    model: prompt_request.model.trim().to_string(),
                    base_url: prompt_request.base_url.trim().to_string(),
                    api: prompt_request.api.trim().to_string(),
                    thinking_level: prompt_request.thinking_level.trim().to_string(),
                }),
                thinking: None,
                duration_ms: None,
                activities: None,
                traces: None,
                attachments: None,
            });
            conversation.updated_at = storage::now_millis();
            storage::write_conversation(app, &conversation)?;
            return Err(error);
        }
    }

    conversation.updated_at = storage::now_millis();
    storage::write_conversation(app, &conversation)?;
    Ok(conversation)
}

pub fn prepare_session(
    app: &AppHandle,
    manager: &TaoRuntimeManager,
    request: PrepareSessionRequest,
) -> Result<(), String> {
    let provider = request.provider.trim();
    let model = request.model.trim();
    if request.conversation_id.trim().is_empty() || provider.is_empty() || model.is_empty() {
        return Err("会话预热参数不完整".to_string());
    }
    let conversation = storage::load_conversation_if_exists(app, &request.conversation_id)?
        .unwrap_or_else(|| {
            let mut conversation =
                storage::new_conversation(provider, model, &request.thinking_level);
            conversation.id = request.conversation_id.clone();
            conversation
        });
    let rpc_request = SendMessageRequest {
        request_id: storage::new_id("prepare"),
        conversation_id: request.conversation_id,
        text: String::new(),
        provider: provider.to_string(),
        model: model.to_string(),
        base_url: request.base_url,
        api: request.api,
        thinking_level: request.thinking_level.clone(),
        permission_mode: request.permission_mode.clone(),
        permission_timeout_ms: request.permission_timeout_ms,
        attachments: Vec::new(),
    };
    let _ = manager.request(
        app,
        serde_json::json!({
            "type": "prepare_session",
            "conversationId": conversation.id,
            "requestId": rpc_request.request_id,
            "provider": rpc_request.provider,
            "model": rpc_request.model,
            "baseUrl": rpc_request.base_url,
            "api": rpc_request.api,
            "thinkingLevel": rpc_request.thinking_level,
            "permissionMode": conversation.permission_mode.clone(),
            "permissionTimeoutMs": rpc_request.permission_timeout_ms,
            "workspacePath": conversation.workspace_path,
            "attachments": rpc_request.attachments,
        }),
        Duration::from_secs(120),
    )?;
    Ok(())
}

fn run_pi_rpc(
    app: &AppHandle,
    manager: &TaoRuntimeManager,
    conversation: &Conversation,
    text: &str,
    request: &SendMessageRequest,
) -> Result<PiPromptResult, String> {
    let response = manager.request(
        app,
        serde_json::json!({
            "type": "prompt",
            "conversationId": conversation.id,
            "requestId": request.request_id,
            "message": text,
            "provider": request.provider,
            "model": request.model,
            "baseUrl": request.base_url,
            "api": request.api,
            "thinkingLevel": request.thinking_level,
            "permissionMode": conversation.permission_mode.clone(),
            "permissionTimeoutMs": request.permission_timeout_ms,
            "workspacePath": conversation.workspace_path,
            "attachments": request.attachments,
        }),
        RPC_RESPONSE_TIMEOUT,
    )
    .map_err(|error| {
        if error.contains("等待 Tao Runtime 响应超时") {
            "等待 Tao Runtime 最终回答超时（30 分钟）。工具操作可能已经完成，请查看文件结果后再决定是否重试。".to_string()
        } else {
            error
        }
    })?;
    let values = response
        .get("messages")
        .and_then(Value::as_array)
        .ok_or_else(|| "Tao Runtime 没有返回消息".to_string())?;
    let mut messages = Vec::new();
    for value in values {
        let Some(role) = value.get("role").and_then(Value::as_str) else {
            continue;
        };
        let Some(content) = value.get("content").and_then(Value::as_str) else {
            continue;
        };
        messages.push(Message {
            id: storage::new_id("message"),
            role: role.to_string(),
            content: content.to_string(),
            created_at: storage::now_millis(),
            status: value.get("status").and_then(Value::as_str).map(str::to_string),
            retry: None,
            thinking: value
                .get("thinking")
                .and_then(Value::as_str)
                .map(str::to_string)
                .filter(|thinking| !thinking.trim().is_empty()),
            duration_ms: value.get("durationMs").and_then(Value::as_u64),
            activities: value
                .get("activities")
                .and_then(|activities| serde_json::from_value::<Vec<ActivityItem>>(activities.clone()).ok())
                .filter(|activities| !activities.is_empty()),
            traces: value
                .get("traces")
                .and_then(|traces| serde_json::from_value::<Vec<TraceItem>>(traces.clone()).ok())
                .filter(|traces| !traces.is_empty()),
            attachments: value
                .get("attachments")
                .and_then(|attachments| serde_json::from_value::<Vec<AttachmentReference>>(attachments.clone()).ok())
                .filter(|attachments| !attachments.is_empty()),
        });
    }
    if !messages.iter().any(|message| message.role == "assistant") {
        return Err("Tao Runtime 没有返回回答".to_string());
    }
    Ok(PiPromptResult { messages })
}

fn normalize_permission_mode(mode: &str) -> &str {
    match mode.trim() {
        "full_access" => "full_access",
        _ => "ask",
    }
}

#[cfg(any())]
fn ensure_rpc_process(
    app: &AppHandle,
    manager: &PiManager,
    conversation: &Conversation,
    request: &SendMessageRequest,
) -> Result<(Arc<PiRpcProcess>, bool), String> {
    let fingerprint = configuration_fingerprint(request);
    let (process, reused) = {
        let mut sessions = manager
            .sessions
            .lock()
            .map_err(|_| "当前会话的 Pi 进程状态损坏".to_string())?;
        let process_matches = if let Some(process) = sessions.get(&conversation.id) {
            process.configuration_fingerprint == fingerprint && process.is_running()?
        } else {
            false
        };
        if process_matches {
            (
                sessions
                    .get(&conversation.id)
                    .cloned()
                    .ok_or_else(|| "Pi 进程状态丢失".to_string())?,
                true,
            )
        } else {
            if let Some(process) = sessions.remove(&conversation.id) {
                process.stop();
            }
            let process = Arc::new(start_rpc_process(app, conversation, request, fingerprint)?);
            sessions.insert(conversation.id.clone(), Arc::clone(&process));
            (process, false)
        }
    };
    ensure_process_ready(&process)?;
    Ok((process, reused))
}

#[cfg(any())]
fn start_rpc_process(
    app: &AppHandle,
    conversation: &Conversation,
    request: &SendMessageRequest,
    fingerprint: u64,
) -> Result<PiRpcProcess, String> {
    let pi_root = resolve_pi_root(app)?;
    let tsx_cli = pi_root.join(TSX_ENTRY);
    let pi_cli = pi_root.join(PI_CLI_ENTRY);
    if !tsx_cli.is_file() {
        return Err(format!(
            "Pi 依赖未安装：缺少 {}。请在 vendor\\pi 中执行 npm.cmd install --ignore-scripts",
            tsx_cli.display()
        ));
    }
    if !pi_cli.is_file() {
        return Err(format!("找不到 Pi CLI：{}", pi_cli.display()));
    }

    let agent_dir = storage::app_data_root(app)?;
    let sessions_dir = agent_dir.join("sessions");
    fs::create_dir_all(&sessions_dir).map_err(|error| format!("无法创建 Pi 会话目录：{error}"))?;
    let session_file = sessions_dir.join(format!("{}.jsonl", conversation.id));

    let effective_provider = request.provider.trim();

    let mut command = Command::new("node.exe");
    command
        .arg(TSX_ENTRY)
        .arg(PI_CLI_ENTRY)
        .arg("--mode")
        .arg("rpc")
        .arg("--session")
        .arg(&session_file)
        .arg("--provider")
        .arg(effective_provider)
        .arg("--model")
        .arg(request.model.trim())
        .arg("--thinking")
        .arg(request.thinking_level.trim())
        .arg("--no-extensions")
        .arg("--no-skills")
        .arg("--no-prompt-templates")
        .arg("--no-context-files")
        .arg("--no-approve")
        .arg("--offline")
        .current_dir(&pi_root)
        .env("PI_CODING_AGENT_DIR", &agent_dir)
        .env("NO_COLOR", "1")
        .env("FORCE_COLOR", "0")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let runtime_configuration = storage::load_runtime_configuration(app)?;
    if runtime_configuration.enabled {
        let system_prompt = runtime_configuration.system_prompt.trim();
        if !system_prompt.is_empty() {
            if runtime_configuration.system_prompt_mode == "replace" {
                command.arg("--system-prompt").arg(system_prompt);
            } else {
                command.arg("--append-system-prompt").arg(system_prompt);
            }
        }
        let conversation_prompt = runtime_configuration.conversation_prompt.trim();
        if !conversation_prompt.is_empty() {
            command
                .arg("--append-system-prompt")
                .arg(conversation_prompt);
        }
    }

    #[cfg(target_os = "windows")]
    command.creation_flags(0x08000000);

    let mut child = command
        .spawn()
        .map_err(|error| format!("无法启动 Pi：{error}。请确认 node.exe 已加入 PATH"))?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "无法连接 Pi 标准输入".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "无法连接 Pi 标准输出".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "无法连接 Pi 错误输出".to_string())?;

    let (stdout_sender, stdout_lines) = mpsc::channel();
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            match line {
                Ok(line) => {
                    if stdout_sender.send(line).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    let stderr_lines = Arc::new(Mutex::new(VecDeque::new()));
    let stderr_target = Arc::clone(&stderr_lines);
    thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            if let Ok(mut lines) = stderr_target.lock() {
                lines.push_back(line);
                while lines.len() > 40 {
                    lines.pop_front();
                }
            }
        }
    });

    Ok(PiRpcProcess {
        child: Mutex::new(child),
        stdin: Mutex::new(stdin),
        stdout_lines: Mutex::new(stdout_lines),
        stderr_lines,
        ready: Mutex::new(false),
        configuration_fingerprint: fingerprint,
    })
}

#[cfg(any())]
fn ensure_process_ready(process: &PiRpcProcess) -> Result<(), String> {
    let mut ready = process
        .ready
        .lock()
        .map_err(|_| "Pi 就绪状态损坏".to_string())?;
    if *ready {
        return Ok(());
    }
    let request_id = storage::new_id("state");
    process.send_command(&serde_json::json!({
        "id": request_id,
        "type": "get_state",
    }))?;
    let started = Instant::now();
    let stdout_lines = process
        .stdout_lines
        .lock()
        .map_err(|_| "Pi 输出通道状态损坏".to_string())?;
    loop {
        if started.elapsed() > Duration::from_secs(60) {
            return Err("Pi 启动超时（60 秒）".to_string());
        }
        let line = match stdout_lines.recv_timeout(Duration::from_millis(250)) {
            Ok(line) => line,
            Err(RecvTimeoutError::Timeout) => {
                if !process.is_running()? {
                    let detail = process.stderr_summary();
                    return Err(if detail.trim().is_empty() {
                        "Pi 进程启动后立即退出".to_string()
                    } else {
                        format!("Pi 进程启动失败：{detail}")
                    });
                }
                continue;
            }
            Err(RecvTimeoutError::Disconnected) => {
                return Err("Pi 输出通道已关闭".to_string());
            }
        };
        if line.trim().is_empty() {
            continue;
        }
        let event: Value = serde_json::from_str(line.trim_end_matches('\r'))
            .map_err(|error| format!("Pi 启动返回了无效 JSON：{error}"))?;
        if event.get("type").and_then(Value::as_str) != Some("response")
            || event.get("id").and_then(Value::as_str) != Some(request_id.as_str())
        {
            continue;
        }
        if event.get("success").and_then(Value::as_bool) != Some(true) {
            return Err(event
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("Pi 未能完成启动检查")
                .to_string());
        }
        *ready = true;
        return Ok(());
    }
}

#[cfg(any())]
fn run_rpc_prompt(
    app: &AppHandle,
    request: &SendMessageRequest,
    process: &PiRpcProcess,
    text: &str,
) -> Result<PiPromptResult, String> {
    let command = serde_json::json!({
        "id": request.request_id,
        "type": "prompt",
        "message": text,
    });
    process.send_command(&command)?;
    emit_stream(app, request, "status", Some("正在等待模型响应…".to_string()));

    let started = Instant::now();
    let mut first_output_emitted = false;
    let stdout_lines = process
        .stdout_lines
        .lock()
        .map_err(|_| "Pi 输出通道状态损坏".to_string())?;
    let mut messages = Vec::new();
    let mut current_answer = String::new();
    let mut assistant_error = None;
    let mut initial_user_seen = false;
    let mut aborted = false;
    let mut assistant_turns = 0_u32;

    loop {
        if started.elapsed() > RPC_RESPONSE_TIMEOUT {
            return Err("等待 Pi 响应超时（30 分钟）".to_string());
        }

        let line = match stdout_lines.recv_timeout(Duration::from_millis(250)) {
            Ok(line) => line,
            Err(RecvTimeoutError::Timeout) => {
                if !process.is_running()? {
                    let detail = process.stderr_summary();
                    return Err(if detail.trim().is_empty() {
                        "Pi 进程已意外退出".to_string()
                    } else {
                        format!("Pi 进程已退出：{detail}")
                    });
                }
                continue;
            }
            Err(RecvTimeoutError::Disconnected) => {
                let detail = process.stderr_summary();
                return Err(if detail.trim().is_empty() {
                    "Pi 输出通道已关闭".to_string()
                } else {
                    format!("Pi 输出通道已关闭：{detail}")
                });
            }
        };
        if line.trim().is_empty() {
            continue;
        }
        let event: Value = serde_json::from_str(line.trim_end_matches('\r'))
            .map_err(|error| format!("Pi RPC 返回了无效 JSON：{error}\n{line}"))?;
        match event.get("type").and_then(Value::as_str) {
            Some("response")
                if event.get("id").and_then(Value::as_str) == Some(request.request_id.as_str())
                    && event.get("success").and_then(Value::as_bool) == Some(false) =>
            {
                return Err(event
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("Pi 拒绝了请求")
                    .to_string());
            }
            Some("response") if event.get("success").and_then(Value::as_bool) == Some(false) => {
                emit_stream(
                    app,
                    request,
                    "queue_error",
                    Some(
                        event
                            .get("error")
                            .and_then(Value::as_str)
                            .unwrap_or("Pi 拒绝了追加消息")
                            .to_string(),
                    ),
                );
            }
            Some("message_start") => {
                if event["message"].get("role").and_then(Value::as_str) == Some("assistant") {
                    current_answer.clear();
                    if assistant_turns > 0 {
                        emit_stream(app, request, "turn_start", None);
                    }
                    assistant_turns += 1;
                }
            }
            Some("message_update") => {
                let delta = &event["assistantMessageEvent"];
                let Some(text_delta) = delta.get("delta").and_then(Value::as_str) else {
                    continue;
                };
                let delta_type = delta.get("type").and_then(Value::as_str);
                if matches!(delta_type, Some("thinking_delta" | "text_delta"))
                    && !first_output_emitted
                {
                    first_output_emitted = true;
                    emit_timing(app, request, "first_output", started.elapsed());
                }
                match delta_type {
                    Some("thinking_delta") => {
                        emit_stream(app, request, "thinking_delta", Some(text_delta.to_string()));
                    }
                    Some("text_delta") => {
                        current_answer.push_str(text_delta);
                        emit_stream(app, request, "text_delta", Some(text_delta.to_string()));
                    }
                    _ => {}
                }
            }
            Some("message_end") => {
                let message = &event["message"];
                match message.get("role").and_then(Value::as_str) {
                    Some("user") => {
                        if initial_user_seen {
                            let content = extract_message_text(message);
                            if !content.trim().is_empty() {
                                messages.push(Message {
                                    id: storage::new_id("message"),
                                    role: "user".to_string(),
                                    content,
                                    created_at: storage::now_millis(),
                                    status: None,
                                });
                            }
                        } else {
                            initial_user_seen = true;
                        }
                    }
                    Some("assistant") => {
                        let stop_reason = message.get("stopReason").and_then(Value::as_str);
                        if stop_reason == Some("error") {
                            assistant_error = message
                                .get("errorMessage")
                                .and_then(Value::as_str)
                                .map(str::to_string);
                            continue;
                        }
                        if stop_reason == Some("aborted") {
                            aborted = true;
                        }
                        let authoritative = extract_message_text(message);
                        let content = if authoritative.is_empty() {
                            current_answer.clone()
                        } else {
                            authoritative
                        };
                        if !content.trim().is_empty() || stop_reason == Some("aborted") {
                            messages.push(Message {
                                id: storage::new_id("message"),
                                role: "assistant".to_string(),
                                content: if content.trim().is_empty() {
                                    "生成已停止，可以继续提问。".to_string()
                                } else {
                                    content
                                },
                                created_at: storage::now_millis(),
                                status: (stop_reason == Some("aborted")).then(|| "stopped".to_string()),
                            });
                        }
                        current_answer.clear();
                    }
                    _ => {}
                }
            }
            Some("queue_update") => {
                let steering = event
                    .get("steering")
                    .and_then(Value::as_array)
                    .map_or(0, Vec::len);
                let follow_up = event
                    .get("followUp")
                    .and_then(Value::as_array)
                    .map_or(0, Vec::len);
                emit_stream(
                    app,
                    request,
                    "queue_update",
                    Some(format!("调整队列 {steering} · 后续队列 {follow_up}")),
                );
            }
            Some("agent_settled") => {
                if aborted {
                    emit_stream(app, request, "aborted", None);
                    emit_timing(app, request, "completed", started.elapsed());
                    return Ok(PiPromptResult { messages });
                }
                if !messages.iter().any(|message| message.role == "assistant") {
                    return Err(assistant_error.unwrap_or_else(|| "Pi 没有返回文本".to_string()));
                }
                emit_stream(app, request, "completed", None);
                emit_timing(app, request, "completed", started.elapsed());
                return Ok(PiPromptResult { messages });
            }
            _ => {}
        }
    }
}

#[cfg(any())]
fn emit_timing(
    app: &AppHandle,
    request: &SendMessageRequest,
    phase: &str,
    elapsed: Duration,
) {
    let event = match phase {
        "ready" => "ready",
        "first_output" => "first_output",
        "completed" => "completed",
        _ => phase,
    };
    emit_runtime_event(
        app,
        request,
        "metric",
        event,
        None,
        Some(elapsed.as_millis().min(u128::from(u64::MAX)) as u64),
    );
}

#[cfg(any())]
fn extract_message_text(message: &Value) -> String {
    if let Some(content) = message.get("content").and_then(Value::as_str) {
        return content.to_string();
    }
    message
        .get("content")
        .and_then(Value::as_array)
        .map(|blocks| {
            blocks
                .iter()
                .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
                .filter_map(|block| block.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_default()
}

#[cfg(any())]
fn emit_stream(app: &AppHandle, request: &SendMessageRequest, kind: &str, text: Option<String>) {
    let (category, event) = match kind {
        "status" => ("runtime", "status"),
        "thinking_delta" => ("message", "thinking_delta"),
        "text_delta" => ("message", "text_delta"),
        "turn_start" => ("turn", "started"),
        "queue_update" => ("queue", "updated"),
        "queue_error" => ("queue", "error"),
        "aborted" => ("turn", "aborted"),
        "completed" => ("turn", "completed"),
        "error" => ("error", "runtime"),
        _ => ("runtime", kind),
    };
    emit_runtime_event(app, request, category, event, text, None);
}

#[cfg(any())]
fn emit_runtime_event(
    app: &AppHandle,
    request: &SendMessageRequest,
    category: &str,
    event: &str,
    text: Option<String>,
    elapsed_ms: Option<u64>,
) {
    let _ = app.emit(
        "tao-runtime-event",
        TaoRuntimeEvent {
            version: 1,
            category: category.to_string(),
            event: event.to_string(),
            conversation_id: request.conversation_id.clone(),
            request_id: Some(request.request_id.clone()),
            text,
            elapsed_ms,
        },
    );
}

#[cfg(any())]
fn configuration_fingerprint(request: &SendMessageRequest) -> u64 {
    let mut hasher = DefaultHasher::new();
    request.provider.trim().hash(&mut hasher);
    request.model.trim().hash(&mut hasher);
    request.base_url.trim().hash(&mut hasher);
    request.api.trim().hash(&mut hasher);
    request.thinking_level.trim().hash(&mut hasher);
    hasher.finish()
}

fn resolve_pi_root(app: &AppHandle) -> Result<PathBuf, String> {
    let development_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../vendor/pi");
    if cfg!(debug_assertions) && development_root.join("packages/coding-agent/src/cli.ts").is_file() {
        return Ok(development_root);
    }

    let resource_root = app
        .path()
        .resource_dir()
        .map_err(|error| format!("无法定位应用资源目录：{error}"))?
        .join("pi");
    if resource_root.join("packages/coding-agent/src/cli.ts").is_file() {
        return Ok(resource_root);
    }

    Err("找不到 Tao 内置的 Pi source（vendor/pi）".to_string())
}

fn validate_base_url(value: &str) -> Result<String, String> {
    let value = value.trim().trim_end_matches('/');
    if value.is_empty() {
        return Err("请填写 Base URL，例如 https://example.com/v1".to_string());
    }
    let parsed = reqwest::Url::parse(value).map_err(|error| format!("Base URL 无效：{error}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("Base URL 只支持 http 或 https".to_string());
    }
    Ok(value.to_string())
}

fn write_model_config(
    agent_dir: &std::path::Path,
    providers: &[crate::models::ProviderProfile],
) -> Result<(), String> {
    let mut provider_configs = serde_json::Map::new();
    for provider in providers {
        let base_url = provider.base_url.trim();
        if base_url.is_empty() {
            continue;
        }
        let base_url = validate_base_url(base_url)?;
        if !matches!(provider.api.as_str(), "openai-completions" | "openai-responses") {
            return Err("API 协议无效".to_string());
        }
        let models = provider
            .models
            .iter()
            .map(|model| {
                let mut definition = serde_json::json!({
                    "id": model.id,
                    "name": model.name,
                    "reasoning": model.reasoning,
                    "input": ["text"],
                });
                if let Some(context_window) = model.context_window {
                    definition["contextWindow"] = serde_json::json!(context_window);
                }
                if let Some(max_tokens) = model.max_tokens {
                    definition["maxTokens"] = serde_json::json!(max_tokens);
                }
                definition
            })
            .collect::<Vec<_>>();
        provider_configs.insert(
            provider.id.clone(),
            serde_json::json!({
                "name": provider.name,
                "baseUrl": base_url,
                "api": provider.api,
                "models": models
            }),
        );
    }
    let config = serde_json::json!({ "providers": provider_configs });
    let content = serde_json::to_string_pretty(&config)
        .map_err(|error| format!("无法生成 Pi 自定义模型配置：{error}"))?;
    fs::write(agent_dir.join("models.json"), content)
        .map_err(|error| format!("无法保存 Pi 自定义模型配置：{error}"))
}
