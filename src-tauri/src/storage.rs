use crate::models::{
    AppSettings, AppState, Conversation, CustomToolConfiguration, Message, ProviderModel, ProviderProfile,
    RuntimeConfiguration,
};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

static ID_SEQUENCE: AtomicU64 = AtomicU64::new(0);

pub fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub fn new_id(prefix: &str) -> String {
    format!(
        "{prefix}-{}-{}-{}",
        now_millis(),
        std::process::id(),
        ID_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    )
}

pub fn app_data_root(app: &AppHandle) -> Result<PathBuf, String> {
    let root = app
        .path()
        .home_dir()
        .map_err(|error| format!("无法定位用户目录：{error}"))?
        .join(".tao");
    fs::create_dir_all(&root).map_err(|error| format!("无法创建 Tao 数据目录：{error}"))?;
    migrate_data_layout(app, &root)?;
    Ok(root)
}

pub fn conversation_dir(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    validate_id(id)?;
    let directory = app_data_root(app)?.join("conversations").join(id);
    fs::create_dir_all(&directory).map_err(|error| format!("无法创建对话目录：{error}"))?;
    Ok(directory)
}

pub fn get_app_state(app: &AppHandle) -> Result<AppState, String> {
    let settings = load_settings(app)?;
    let conversations = load_conversations(app)?;
    let provider_auth_configured = provider_auth_status(app, &settings)?;

    Ok(AppState {
        conversations,
        api_key_configured: provider_auth_configured
            .get(&settings.provider)
            .copied()
            .unwrap_or(false),
        provider_auth_configured,
        settings,
        runtime_configuration: load_runtime_configuration(app)?,
    })
}

pub fn load_runtime_configuration(app: &AppHandle) -> Result<RuntimeConfiguration, String> {
    let path = app_data_root(app)?.join("runtime").join("profile.json");
    if !path.exists() {
        return Ok(RuntimeConfiguration::default());
    }
    let content = fs::read_to_string(&path)
        .map_err(|error| format!("无法读取 Runtime 配置：{error}"))?;
    let configuration: RuntimeConfiguration =
        serde_json::from_str(&content).map_err(|error| format!("Runtime 配置损坏：{error}"))?;
    normalize_runtime_configuration(configuration)
}

pub fn save_runtime_configuration(
    app: &AppHandle,
    configuration: RuntimeConfiguration,
) -> Result<RuntimeConfiguration, String> {
    if !matches!(configuration.system_prompt_mode.as_str(), "append" | "replace") {
        return Err("系统提示词模式无效".to_string());
    }
    if configuration.system_prompt.len() > 100_000
        || configuration.conversation_prompt.len() > 100_000
    {
        return Err("提示词内容不能超过 100000 个字符".to_string());
    }
    let configuration = normalize_runtime_configuration(configuration)?;
    let runtime_dir = app_data_root(app)?.join("runtime");
    fs::create_dir_all(&runtime_dir)
        .map_err(|error| format!("无法创建 Runtime 配置目录：{error}"))?;
    fs::create_dir_all(app_data_root(app)?.join("skills"))
        .map_err(|error| format!("无法创建 Tao Skills 目录：{error}"))?;
    write_json(&runtime_dir.join("profile.json"), &configuration, "Runtime 配置")?;
    Ok(configuration)
}

fn normalize_runtime_configuration(
    configuration: RuntimeConfiguration,
) -> Result<RuntimeConfiguration, String> {
    if !matches!(configuration.system_prompt_mode.as_str(), "append" | "replace") {
        return Err("系统提示词模式无效".to_string());
    }
    if !matches!(configuration.tool_mode.as_str(), "default" | "custom") {
        return Err("工具模式无效".to_string());
    }

    let mut enabled_tools = Vec::new();
    for tool in configuration.enabled_tools {
        let tool = tool.trim().to_ascii_lowercase();
        if !matches!(
            tool.as_str(),
            "read" | "bash" | "edit" | "write" | "grep" | "find" | "ls"
        ) {
            continue;
        }
        if !enabled_tools.contains(&tool) {
            enabled_tools.push(tool);
        }
    }

    let mut custom_tools = Vec::new();
    for mut tool in configuration.custom_tools {
        tool.id = tool.id.trim().to_string();
        tool.name = tool.name.trim().to_ascii_lowercase();
        tool.label = tool.label.trim().to_string();
        tool.description = tool.description.trim().to_string();
        tool.kind = tool.kind.trim().to_ascii_lowercase();
        tool.permission_mode = tool.permission_mode.trim().to_ascii_lowercase();
        tool.command = tool.command.trim().to_string();
        tool.method = tool.method.trim().to_ascii_uppercase();
        tool.url = tool.url.trim().to_string();
        tool.headers = tool.headers.trim().to_string();
        tool.body_template = tool.body_template.trim().to_string();
        tool.input_schema = tool.input_schema.trim().to_string();
        if tool.id.is_empty() {
            tool.id = tool.name.clone();
        }
        if tool.name.is_empty()
            || !tool
                .name
                .chars()
                .all(|value| value.is_ascii_alphanumeric() || matches!(value, '_' | '-'))
        {
            return Err("自定义工具名称只能使用字母、数字、下划线和连字符".to_string());
        }
        if !matches!(tool.kind.as_str(), "command" | "http") {
            return Err("自定义工具类型无效".to_string());
        }
        if !matches!(tool.permission_mode.as_str(), "ask" | "allow" | "deny") {
            return Err(format!("自定义工具 {} 的权限模式无效", tool.name));
        }
        if matches!(
            tool.name.as_str(),
            "read" | "bash" | "edit" | "write" | "grep" | "find" | "ls"
        ) {
            return Err(format!("自定义工具不能使用内置工具名称：{}", tool.name));
        }
        if tool.description.len() > 2_000 {
            return Err("自定义工具描述不能超过 2000 个字符".to_string());
        }
        if tool.kind == "command" && tool.command.is_empty() {
            return Err(format!("自定义工具 {} 缺少命令模板", tool.name));
        }
        if tool.kind == "http" && tool.url.is_empty() {
            return Err(format!("自定义工具 {} 缺少 URL", tool.name));
        }
        if !tool.input_schema.is_empty() {
            let schema: serde_json::Value = serde_json::from_str(&tool.input_schema)
                .map_err(|_| format!("自定义工具 {} 的输入 Schema 不是有效 JSON", tool.name))?;
            if !schema.is_object() || schema.get("type").and_then(serde_json::Value::as_str) != Some("object") {
                return Err(format!("自定义工具 {} 的输入 Schema 必须是 object", tool.name));
            }
        }
        if custom_tools.iter().any(|item: &CustomToolConfiguration| item.name == tool.name) {
            return Err(format!("自定义工具名称重复：{}", tool.name));
        }
        custom_tools.push(tool);
    }

    Ok(RuntimeConfiguration {
        enabled: configuration.enabled,
        system_prompt_mode: configuration.system_prompt_mode,
        system_prompt: configuration.system_prompt.trim().to_string(),
        conversation_prompt: configuration.conversation_prompt.trim().to_string(),
        tool_mode: configuration.tool_mode,
        enabled_tools,
        skills_enabled: configuration.skills_enabled,
        extensions_enabled: configuration.extensions_enabled,
        custom_tools,
    })
}

pub fn create_conversation(app: &AppHandle) -> Result<Conversation, String> {
    create_conversation_with_workspace(app, None, None)
}

pub fn create_conversation_with_workspace(
    app: &AppHandle,
    workspace_path: Option<&str>,
    workspace_name: Option<&str>,
) -> Result<Conversation, String> {
    let settings = load_settings(app)?;
    let mut conversation = new_conversation(
        &settings.provider,
        &settings.model,
        &settings.thinking_level,
    );
    if let Some(workspace_path) = workspace_path {
        conversation.workspace_path = normalize_workspace_path(workspace_path)?;
        conversation.workspace_name = workspace_name.unwrap_or_default().trim().to_string();
    }
    write_conversation(app, &conversation)?;
    Ok(conversation)
}

pub fn new_conversation(provider: &str, model: &str, thinking_level: &str) -> Conversation {
    let timestamp = now_millis();
    Conversation {
        id: new_id("chat"),
        title: "新对话".to_string(),
        provider: provider.to_string(),
        model: model.to_string(),
        thinking_level: thinking_level.to_string(),
        permission_mode: "ask".to_string(),
        created_at: timestamp,
        updated_at: timestamp,
        pinned: false,
        workspace_path: String::new(),
        workspace_name: String::new(),
        messages: Vec::new(),
    }
}

pub fn load_conversation_if_exists(
    app: &AppHandle,
    id: &str,
) -> Result<Option<Conversation>, String> {
    let path = conversation_dir(app, id)?.join("conversation.json");
    if !path.exists() {
        return Ok(None);
    }
    let content = fs::read_to_string(&path).map_err(|error| format!("无法读取对话：{error}"))?;
    serde_json::from_str(&content)
        .map(Some)
        .map_err(|error| format!("对话数据损坏：{error}"))
}

pub fn delete_conversation(app: &AppHandle, id: &str) -> Result<(), String> {
    validate_id(id)?;
    let root = app_data_root(app)?;
    let conversation_root = root.join("conversations").join(id);
    if conversation_root.exists() {
        fs::remove_dir_all(&conversation_root)
            .map_err(|error| format!("无法删除对话：{error}"))?;
    }
    let session_file = root.join("sessions").join(format!("{id}.jsonl"));
    if session_file.exists() {
        fs::remove_file(&session_file)
            .map_err(|error| format!("无法删除 Pi 会话：{error}"))?;
    }
    Ok(())
}

pub fn write_conversation(app: &AppHandle, conversation: &Conversation) -> Result<(), String> {
    let path = conversation_dir(app, &conversation.id)?.join("conversation.json");
    write_json(&path, conversation, "对话")
}

pub fn set_conversation_pinned(
    app: &AppHandle,
    id: &str,
    pinned: bool,
) -> Result<Conversation, String> {
    let mut conversation = load_conversation_if_exists(app, id)?
        .ok_or_else(|| "空白草稿不需要置顶".to_string())?;
    conversation.pinned = pinned;
    write_conversation(app, &conversation)?;
    Ok(conversation)
}

pub fn set_conversation_workspace(
    app: &AppHandle,
    id: &str,
    workspace_path: &str,
) -> Result<Conversation, String> {
    validate_id(id)?;
    let mut conversation = match load_conversation_if_exists(app, id)? {
        Some(conversation) => conversation,
        None => {
            let settings = load_settings(app)?;
            let mut conversation = new_conversation(
                &settings.provider,
                &settings.model,
                &settings.thinking_level,
            );
            conversation.id = id.to_string();
            conversation
        }
    };
    conversation.workspace_path = normalize_workspace_path(workspace_path)?;
    if conversation.workspace_path.is_empty() {
        conversation.workspace_name.clear();
    }
    conversation.updated_at = now_millis();
    write_conversation(app, &conversation)?;
    Ok(conversation)
}

pub fn set_conversation_model(
    app: &AppHandle,
    id: &str,
    provider: &str,
    model: &str,
    thinking_level: &str,
) -> Result<Conversation, String> {
    validate_id(id)?;
    let provider = provider.trim();
    let model = model.trim();
    let thinking_level = thinking_level.trim();
    if provider.is_empty() || model.is_empty() {
        return Err("Provider 鍜?Model 涓嶈兘涓虹┖".to_string());
    }
    if !valid_thinking_level(thinking_level) {
        return Err("invalid thinking level".to_string());
    }
    let mut conversation = load_conversation_if_exists(app, id)?
        .ok_or_else(|| "conversation not found".to_string())?;
    conversation.provider = provider.to_string();
    conversation.model = model.to_string();
    conversation.thinking_level = thinking_level.to_string();
    conversation.updated_at = now_millis();
    write_conversation(app, &conversation)?;
    Ok(conversation)
}

pub fn set_conversation_permission_mode(
    app: &AppHandle,
    id: &str,
    permission_mode: &str,
) -> Result<Conversation, String> {
    validate_id(id)?;
    let permission_mode = permission_mode.trim();
    if !valid_permission_mode(permission_mode) {
        return Err("invalid permission mode".to_string());
    }
    let mut conversation = load_conversation_if_exists(app, id)?
        .ok_or_else(|| "conversation not found".to_string())?;
    conversation.permission_mode = permission_mode.to_string();
    conversation.updated_at = now_millis();
    write_conversation(app, &conversation)?;
    Ok(conversation)
}

pub fn set_conversation_title(
    app: &AppHandle,
    id: &str,
    title: &str,
) -> Result<Conversation, String> {
    validate_id(id)?;
    let title = title.trim();
    if title.is_empty() {
        return Err("会话名称不能为空".to_string());
    }
    if title.chars().count() > 200 {
        return Err("会话名称不能超过 200 个字符".to_string());
    }
    let mut conversation = load_conversation_if_exists(app, id)?
        .ok_or_else(|| "会话不存在".to_string())?;
    conversation.title = title.to_string();
    conversation.updated_at = now_millis();
    write_conversation(app, &conversation)?;
    Ok(conversation)
}

pub fn rename_workspace(
    app: &AppHandle,
    workspace_path: &str,
    workspace_name: &str,
) -> Result<Vec<Conversation>, String> {
    let canonical = normalize_workspace_path(workspace_path)?;
    if canonical.is_empty() {
        return Err("未选择工作区，无法重命名".to_string());
    }
    let name = workspace_name.trim();
    if name.is_empty() {
        return Err("工作区名称不能为空".to_string());
    }
    if name.chars().count() > 200 {
        return Err("工作区名称不能超过 200 个字符".to_string());
    }
    let mut conversations = load_conversations(app)?;
    for conversation in &mut conversations {
        if conversation.workspace_path == canonical {
            conversation.workspace_name = name.to_string();
            conversation.updated_at = now_millis();
            write_conversation(app, conversation)?;
        }
    }
    Ok(conversations)
}

pub fn save_settings(app: &AppHandle, settings: AppSettings) -> Result<AppSettings, String> {
    let provider = settings.provider.trim();
    let model = settings.model.trim();
    if provider.is_empty() || model.is_empty() {
        return Err("Provider 和 Model 不能为空".to_string());
    }

    let settings = AppSettings {
        provider: provider.to_string(),
        model: model.to_string(),
        base_url: settings.base_url.trim().trim_end_matches('/').to_string(),
        api: settings.api.trim().to_string(),
        thinking_level: settings.thinking_level.trim().to_string(),
        permission_timeout_ms: normalize_permission_timeout_ms(settings.permission_timeout_ms),
        accent_color: settings.accent_color.trim().to_string(),
        theme: settings.theme.trim().to_string(),
        providers: settings.providers.clone(),
    };
    if !matches!(settings.api.as_str(), "openai-completions" | "openai-responses") {
        return Err("API 协议无效".to_string());
    }
    if !matches!(
        settings.thinking_level.as_str(),
        "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
    ) {
        return Err("思考模式无效".to_string());
    }
    let settings = normalize_settings(settings)?;
    let path = app_data_root(app)?.join("tao.json");
    write_json(&path, &settings, "设置")?;
    Ok(settings)
}

pub fn normalize_workspace_path(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() {
        return Ok(String::new());
    }
    let path = PathBuf::from(value);
    if !path.is_dir() {
        return Err(format!("工作区目录不存在：{}", path.display()));
    }
    let canonical = fs::canonicalize(&path)
        .map_err(|error| format!("无法解析工作区目录：{error}"))?;
    Ok(canonical.to_string_lossy().into_owned())
}

pub fn save_api_key(app: &AppHandle, provider: &str, api_key: &str) -> Result<(), String> {
    let api_key = api_key.trim();
    if api_key.is_empty() {
        return Ok(());
    }
    let path = app_data_root(app)?.join("auth.json");
    let mut auth = if path.exists() {
        let content = fs::read_to_string(&path)
            .map_err(|error| format!("无法读取 Pi 认证配置：{error}"))?;
        serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(&content)
            .map_err(|error| format!("Pi 认证配置损坏：{error}"))?
    } else {
        serde_json::Map::new()
    };
    auth.insert(
        provider.to_string(),
        serde_json::json!({ "type": "api_key", "key": api_key }),
    );
    write_json(&path, &auth, "Pi 认证配置")
}

pub fn save_pi_defaults(
    app: &AppHandle,
    provider: &str,
    model: &str,
    thinking_level: &str,
) -> Result<(), String> {
    let path = app_data_root(app)?.join("settings.json");
    let mut settings = if path.exists() {
        let content = fs::read_to_string(&path)
            .map_err(|error| format!("无法读取 Pi 设置：{error}"))?;
        serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(&content)
            .map_err(|error| format!("Pi 设置损坏：{error}"))?
    } else {
        serde_json::Map::new()
    };
    settings.insert("defaultProvider".to_string(), provider.into());
    settings.insert("defaultModel".to_string(), model.into());
    settings.insert("defaultThinkingLevel".to_string(), thinking_level.into());
    write_json(&path, &settings, "Pi 设置")
}

pub fn has_api_key(app: &AppHandle, provider: &str) -> Result<bool, String> {
    Ok(load_api_key(app, provider)?.is_some())
}

pub fn load_api_key(app: &AppHandle, provider: &str) -> Result<Option<String>, String> {
    let path = app_data_root(app)?.join("auth.json");
    if !path.exists() {
        return Ok(None);
    }
    let content = fs::read_to_string(&path)
        .map_err(|error| format!("无法读取 Pi 认证配置：{error}"))?;
    let auth: serde_json::Value = serde_json::from_str(&content)
        .map_err(|error| format!("Pi 认证配置损坏：{error}"))?;
    Ok(auth
        .get(provider)
        .and_then(|credential| credential.get("key"))
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|key| !key.is_empty())
        .map(str::to_string))
}

pub fn credential_provider(settings: &AppSettings) -> &str {
    settings.provider.as_str()
}

pub fn load_settings(app: &AppHandle) -> Result<AppSettings, String> {
    normalize_settings(load_raw_settings(app)?)
}

fn load_raw_settings(app: &AppHandle) -> Result<AppSettings, String> {
    let path = app_data_root(app)?.join("tao.json");
    if !path.exists() {
        return Ok(AppSettings::default());
    }

    let content = fs::read_to_string(&path).map_err(|error| format!("无法读取设置：{error}"))?;
    serde_json::from_str(&content).map_err(|error| format!("设置数据损坏：{error}"))
}

fn normalize_settings(mut settings: AppSettings) -> Result<AppSettings, String> {
    settings.provider = settings.provider.trim().to_string();
    settings.model = settings.model.trim().to_string();
    settings.base_url = settings
        .base_url
        .trim()
        .trim_end_matches('/')
        .to_string();
    settings.api = settings.api.trim().to_string();
    settings.thinking_level = settings.thinking_level.trim().to_string();
    settings.permission_timeout_ms =
        normalize_permission_timeout_ms(settings.permission_timeout_ms);
    settings.accent_color = settings.accent_color.trim().to_ascii_lowercase();
    settings.theme = settings.theme.trim().to_ascii_lowercase();

    if settings.provider.is_empty() || settings.model.is_empty() {
        return Err("Provider 鍜?Model 涓嶈兘涓虹┖".to_string());
    }
    if !valid_api(settings.api.as_str()) {
        return Err("API 鍗忚鏃犳晥".to_string());
    }
    if !valid_thinking_level(settings.thinking_level.as_str()) {
        return Err("invalid thinking level".to_string());
    }
    if !valid_accent_color(settings.accent_color.as_str()) {
        return Err("外观强调色无效".to_string());
    }
    if !valid_theme(settings.theme.as_str()) {
        return Err("界面主题无效".to_string());
    }

    let mut profiles = Vec::new();
    for profile in settings.providers {
        let Some(profile) = normalize_provider_profile(profile) else {
            continue;
        };
        if profiles.iter().any(|item: &ProviderProfile| item.id == profile.id) {
            continue;
        }
        profiles.push(profile);
    }

    if let Some(profile) = profiles.iter_mut().find(|profile| profile.id == settings.provider) {
        if settings.base_url.is_empty() && !profile.base_url.is_empty() {
            settings.base_url = profile.base_url.clone();
        } else {
            profile.base_url = settings.base_url.clone();
        }
        if settings.api == "openai-completions" && profile.api != settings.api {
            settings.api = profile.api.clone();
        } else {
            profile.api = settings.api.clone();
        }
        if !profile.models.iter().any(|model| model.id == settings.model) {
            profile.models.push(default_provider_model(&settings.model));
        }
    } else {
        profiles.push(ProviderProfile {
            id: settings.provider.clone(),
            name: settings.provider.clone(),
            base_url: settings.base_url.clone(),
            api: settings.api.clone(),
            models: vec![default_provider_model(&settings.model)],
        });
    }

    settings.providers = profiles;
    Ok(settings)
}

fn normalize_provider_profile(mut profile: ProviderProfile) -> Option<ProviderProfile> {
    profile.id = profile.id.trim().to_string();
    if profile.id.is_empty() {
        return None;
    }
    profile.name = profile.name.trim().to_string();
    if profile.name.is_empty() {
        profile.name = profile.id.clone();
    }
    profile.base_url = profile
        .base_url
        .trim()
        .trim_end_matches('/')
        .to_string();
    profile.api = profile.api.trim().to_string();
    if !valid_api(profile.api.as_str()) {
        profile.api = "openai-completions".to_string();
    }
    profile.models = normalize_models(profile.models);
    Some(profile)
}

fn normalize_models(models: Vec<ProviderModel>) -> Vec<ProviderModel> {
    let mut normalized = Vec::new();
    for mut model in models {
        model.id = model.id.trim().to_string();
        if model.id.is_empty()
            || normalized
                .iter()
                .any(|item: &ProviderModel| item.id == model.id)
        {
            continue;
        }
        model.name = model.name.trim().to_string();
        if model.name.is_empty() {
            model.name = model.id.clone();
        }
        normalized.push(model);
    }
    normalized
}

fn default_provider_model(model: &str) -> ProviderModel {
    ProviderModel {
        id: model.to_string(),
        name: model.to_string(),
        reasoning: false,
        context_window: Some(128_000),
        max_tokens: Some(16_384),
    }
}

fn valid_api(api: &str) -> bool {
    matches!(api, "openai-completions" | "openai-responses")
}

fn valid_thinking_level(level: &str) -> bool {
    matches!(level, "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max")
}

fn valid_accent_color(color: &str) -> bool {
    matches!(color, "tao" | "developer" | "ocean" | "amber" | "graphite")
}

fn valid_theme(theme: &str) -> bool {
    matches!(theme, "light" | "dark" | "system")
}

pub fn provider_auth_status(
    app: &AppHandle,
    settings: &AppSettings,
) -> Result<BTreeMap<String, bool>, String> {
    let mut provider_ids = BTreeMap::new();
    provider_ids.insert(settings.provider.clone(), ());
    for provider in &settings.providers {
        provider_ids.insert(provider.id.clone(), ());
    }

    let mut status = BTreeMap::new();
    for provider in provider_ids.keys() {
        status.insert(provider.clone(), has_api_key(app, provider)?);
    }
    Ok(status)
}

fn valid_permission_mode(mode: &str) -> bool {
    matches!(mode, "ask" | "full_access")
}

fn normalize_permission_timeout_ms(value: u64) -> u64 {
    value.clamp(5_000, 600_000)
}

fn load_conversations(app: &AppHandle) -> Result<Vec<Conversation>, String> {
    let root = app_data_root(app)?.join("conversations");
    fs::create_dir_all(&root).map_err(|error| format!("无法创建对话目录：{error}"))?;
    let mut conversations = Vec::new();

    for entry in fs::read_dir(&root).map_err(|error| format!("无法读取对话目录：{error}"))? {
        let entry = entry.map_err(|error| format!("无法读取对话目录项：{error}"))?;
        let path = entry.path().join("conversation.json");
        if !path.is_file() {
            continue;
        }
        let content = fs::read_to_string(&path).map_err(|error| format!("无法读取对话：{error}"))?;
        let mut conversation: Conversation = serde_json::from_str(&content)
            .map_err(|error| format!("对话数据损坏（{}）：{error}", path.display()))?;
        reconcile_conversation_from_session(app, &mut conversation)?;
        if conversation.messages.is_empty() && conversation.workspace_path.trim().is_empty() {
            let _ = fs::remove_dir_all(entry.path());
        } else {
            conversations.push(conversation);
        }
    }

    conversations.sort_by(|left: &Conversation, right: &Conversation| {
        right
            .pinned
            .cmp(&left.pinned)
            .then_with(|| right.updated_at.cmp(&left.updated_at))
    });
    Ok(conversations)
}

fn reconcile_conversation_from_session(
    app: &AppHandle,
    conversation: &mut Conversation,
) -> Result<(), String> {
    let session_path = app_data_root(app)?
        .join("sessions")
        .join(format!("{}.jsonl", conversation.id));
    if !session_path.is_file() {
        return Ok(());
    }
    let content = fs::read_to_string(&session_path)
        .map_err(|error| format!("无法读取 Pi 会话（{}）：{error}", session_path.display()))?;
    let previous_messages = conversation.messages.clone();
    let mut matched_previous = vec![false; previous_messages.len()];
    let mut session_messages = Vec::new();
    for (index, line) in content.lines().enumerate() {
        let entry: serde_json::Value = serde_json::from_str(line)
            .map_err(|error| format!("Pi 会话数据损坏（{}）：{error}", session_path.display()))?;
        if entry.get("type").and_then(serde_json::Value::as_str) != Some("message") {
            continue;
        }
        let message = &entry["message"];
        let Some(role) = message.get("role").and_then(serde_json::Value::as_str) else {
            continue;
        };
        if !matches!(role, "user" | "assistant") {
            continue;
        }
        let stop_reason = message
            .get("stopReason")
            .and_then(serde_json::Value::as_str);
        let mut message_role = role.to_string();
        let mut message_content = extract_session_message_text(message);
        let mut status = None;
        if role == "assistant" && stop_reason == Some("aborted") {
            status = Some("stopped".to_string());
            if message_content.trim().is_empty() {
                message_content = "上次生成被中断，可以继续提问。".to_string();
            }
        } else if role == "assistant" && stop_reason == Some("error") {
            message_role = "error".to_string();
            if message_content.trim().is_empty() {
                message_content = message
                    .get("errorMessage")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("上次模型请求失败")
                    .to_string();
            }
        }
        if message_content.trim().is_empty() {
            continue;
        }
        let previous_index = previous_messages
            .iter()
            .enumerate()
            .find(|(previous_index, previous)| {
                !matched_previous[*previous_index]
                    && previous.role == message_role
                    && (
                        previous.content == message_content
                            || (
                                message_role == "user"
                                    && previous
                                        .attachments
                                        .as_ref()
                                        .is_some_and(|attachments| {
                                            !attachments.is_empty()
                                                && attachments.iter().all(|attachment| {
                                                    message_content.contains(&attachment.path)
                                                })
                                        })
                            )
                    )
            })
            .map(|(previous_index, _)| previous_index);
        if let Some(previous_index) = previous_index {
            matched_previous[previous_index] = true;
        }
        let previous = previous_index.and_then(|index| previous_messages.get(index));
        if message_role == "user"
            && previous.is_some_and(|message| message.attachments.as_ref().is_some_and(|attachments| !attachments.is_empty()))
        {
            if let Some(previous) = previous {
                message_content = previous.content.clone();
            }
        }
        let thinking = extract_session_message_thinking(message);
        session_messages.push(Message {
            id: format!("session-{}-{index}", conversation.id),
            role: message_role,
            content: message_content,
            created_at: conversation.created_at.saturating_add(index as u64),
            status,
            retry: previous.and_then(|message| message.retry.clone()),
            thinking: if thinking.trim().is_empty() {
                previous.and_then(|message| message.thinking.clone())
            } else {
                Some(thinking)
            },
            duration_ms: previous.and_then(|message| message.duration_ms),
            activities: previous.and_then(|message| message.activities.clone()),
            traces: previous.and_then(|message| message.traces.clone()),
            attachments: previous.and_then(|message| message.attachments.clone()),
        });
    }

    let session_user_count = session_messages
        .iter()
        .filter(|message| message.role == "user")
        .count();
    let projection_user_count = conversation
        .messages
        .iter()
        .filter(|message| message.role == "user")
        .count();
    let session_is_settled = session_messages
        .last()
        .is_some_and(|message| message.role != "user");
    let projection_last_role = conversation.messages.last().map(|message| message.role.as_str());
    let session_last_role = session_messages.last().map(|message| message.role.as_str());
    if session_is_settled
        && session_user_count >= projection_user_count
        && (session_messages.len() > conversation.messages.len()
            || projection_last_role != session_last_role)
    {
        conversation.messages = session_messages;
        write_conversation(app, conversation)?;
    }
    Ok(())
}

fn extract_session_message_text(message: &serde_json::Value) -> String {
    if let Some(content) = message.get("content").and_then(serde_json::Value::as_str) {
        return content.to_string();
    }
    message
        .get("content")
        .and_then(serde_json::Value::as_array)
        .map(|blocks| {
            let has_tool_call = blocks.iter().any(|block| {
                block.get("type").and_then(serde_json::Value::as_str) == Some("toolCall")
            });
            blocks
                .iter()
                .filter(|block| {
                    block.get("type").and_then(serde_json::Value::as_str) == Some("text")
                        && !has_tool_call
                        && !is_commentary_text_block(block)
                })
                .filter_map(|block| block.get("text").and_then(serde_json::Value::as_str))
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_default()
}

fn is_commentary_text_block(block: &serde_json::Value) -> bool {
    let Some(signature) = block
        .get("textSignature")
        .and_then(serde_json::Value::as_str)
    else {
        return false;
    };
    let Ok(signature) = serde_json::from_str::<serde_json::Value>(signature) else {
        return false;
    };
    signature.get("phase").and_then(serde_json::Value::as_str) == Some("commentary")
}

fn extract_session_message_thinking(message: &serde_json::Value) -> String {
    message
        .get("content")
        .and_then(serde_json::Value::as_array)
        .map(|blocks| {
            blocks
                .iter()
                .filter(|block| {
                    block.get("type").and_then(serde_json::Value::as_str) == Some("thinking")
                })
                .filter_map(|block| block.get("thinking").and_then(serde_json::Value::as_str))
                .filter(|thinking| !thinking.trim().is_empty())
                .collect::<Vec<_>>()
                .join("\n\n")
        })
        .unwrap_or_default()
}

fn migrate_data_layout(app: &AppHandle, root: &Path) -> Result<(), String> {
    let marker = root.join(".migration-v2");
    let legacy_root = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法定位旧 Tao 数据目录：{error}"))?;
    let legacy_marker = legacy_root.join(".migrated-to-tao-v2");
    if marker.exists() {
        mark_legacy_migrated(&legacy_root, &legacy_marker)?;
        cleanup_migration_artifacts(root)?;
        return Ok(());
    }

    let conversations_root = root.join("conversations");
    if legacy_root != root && legacy_root.is_dir() && !legacy_marker.exists() {
        let legacy_conversations = legacy_root.join("conversations");
        if legacy_conversations.exists() && !conversations_root.exists() {
            copy_path(&legacy_conversations, &conversations_root)?;
        }
        let legacy_settings = legacy_root.join("settings.json");
        let tao_settings = root.join("tao.json");
        if legacy_settings.is_file() && !tao_settings.exists() {
            fs::copy(&legacy_settings, &tao_settings)
                .map_err(|error| format!("无法迁移 Tao 设置：{error}"))?;
        }
        migrate_pi_agent(&legacy_root.join("pi-agent"), root)?;
    }

    let old_root_settings = root.join("settings.json");
    let tao_settings = root.join("tao.json");
    if is_tao_settings(&old_root_settings)? {
        if !tao_settings.exists() {
            fs::copy(&old_root_settings, &tao_settings)
                .map_err(|error| format!("无法迁移 Tao 设置：{error}"))?;
        }
        let backup = root.join("tao-settings-v1.json");
        if backup.exists() {
            fs::remove_file(&old_root_settings)
                .map_err(|error| format!("无法清理旧 Tao 设置：{error}"))?;
        } else {
            fs::rename(&old_root_settings, &backup)
                .map_err(|error| format!("无法备份旧 Tao 设置：{error}"))?;
        }
    }

    migrate_pi_agent(&root.join("pi-agent"), root)?;
    migrate_pi_sessions(&conversations_root, &root.join("sessions"))?;

    fs::write(marker, "Tao data root migration v2\n")
        .map_err(|error| format!("无法写入 Tao 数据迁移标记：{error}"))?;
    mark_legacy_migrated(&legacy_root, &legacy_marker)?;
    cleanup_migration_artifacts(root)
}

fn mark_legacy_migrated(legacy_root: &Path, marker: &Path) -> Result<(), String> {
    if !legacy_root.is_dir() || marker.exists() {
        return Ok(());
    }
    fs::write(marker, "Migrated to %USERPROFILE%\\.tao\n")
        .map_err(|error| format!("无法标记旧 Tao 数据已迁移：{error}"))
}

fn cleanup_migration_artifacts(root: &Path) -> Result<(), String> {
    let old_pi_agent = root.join("pi-agent");
    if old_pi_agent.exists() {
        fs::remove_dir_all(&old_pi_agent)
            .map_err(|error| format!("无法清理旧 Pi 配置目录：{error}"))?;
    }
    for name in [".migration-v1", "tao-settings-v1.json"] {
        let path = root.join(name);
        if path.exists() {
            fs::remove_file(&path)
                .map_err(|error| format!("无法清理旧迁移文件（{}）：{error}", path.display()))?;
        }
    }
    Ok(())
}

fn migrate_pi_agent(source: &Path, target_root: &Path) -> Result<(), String> {
    if !source.is_dir() {
        return Ok(());
    }
    for entry in fs::read_dir(source).map_err(|error| format!("无法读取旧 Pi 配置：{error}"))? {
        let entry = entry.map_err(|error| format!("无法读取旧 Pi 配置项：{error}"))?;
        let target = target_root.join(entry.file_name());
        if !target.exists() {
            copy_path(&entry.path(), &target)?;
        }
    }
    Ok(())
}

fn migrate_pi_sessions(conversations_root: &Path, sessions_root: &Path) -> Result<(), String> {
    fs::create_dir_all(sessions_root)
        .map_err(|error| format!("无法创建 Pi 会话目录：{error}"))?;
    if !conversations_root.is_dir() {
        return Ok(());
    }
    for entry in fs::read_dir(conversations_root)
        .map_err(|error| format!("无法读取旧会话目录：{error}"))?
    {
        let entry = entry.map_err(|error| format!("无法读取旧会话：{error}"))?;
        if !entry.path().is_dir() {
            continue;
        }
        let source = entry.path().join("pi-session.jsonl");
        let target = sessions_root.join(format!("{}.jsonl", entry.file_name().to_string_lossy()));
        if source.is_file() && !target.exists() {
            fs::copy(&source, &target)
                .map_err(|error| format!("无法迁移 Pi 会话：{error}"))?;
        }
    }
    Ok(())
}

fn is_tao_settings(path: &Path) -> Result<bool, String> {
    if !path.is_file() {
        return Ok(false);
    }
    let content = fs::read_to_string(path)
        .map_err(|error| format!("无法读取旧 Tao 设置：{error}"))?;
    let value: serde_json::Value = serde_json::from_str(&content)
        .map_err(|error| format!("旧 Tao 设置格式错误：{error}"))?;
    Ok(value.get("provider").is_some()
        && value.get("model").is_some()
        && value.get("baseUrl").is_some()
        && value.get("api").is_some())
}

fn copy_path(source: &Path, target: &Path) -> Result<(), String> {
    if source.is_dir() {
        fs::create_dir_all(target).map_err(|error| format!("无法创建迁移目录：{error}"))?;
        for entry in fs::read_dir(source).map_err(|error| format!("无法读取迁移目录：{error}"))? {
            let entry = entry.map_err(|error| format!("无法读取迁移文件：{error}"))?;
            copy_path(&entry.path(), &target.join(entry.file_name()))?;
        }
    } else {
        fs::copy(source, target).map_err(|error| format!("无法迁移 Tao 数据：{error}"))?;
    }
    Ok(())
}

fn validate_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || !id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-' || character == '_')
    {
        return Err("对话 ID 无效".to_string());
    }
    Ok(())
}

fn write_json<T: serde::Serialize>(path: &Path, value: &T, label: &str) -> Result<(), String> {
    let content = serde_json::to_string_pretty(value)
        .map_err(|error| format!("无法序列化{label}：{error}"))?;
    fs::write(path, content).map_err(|error| format!("无法保存{label}：{error}"))
}
