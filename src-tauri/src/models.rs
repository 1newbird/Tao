use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub fn default_thinking_level() -> String {
    "medium".to_string()
}

pub fn default_permission_mode() -> String {
    "ask".to_string()
}

pub fn default_permission_timeout_ms() -> u64 {
    60_000
}

pub fn default_accent_color() -> String {
    "tao".to_string()
}

pub fn default_theme() -> String {
    "light".to_string()
}

pub fn default_custom_tool_permission_mode() -> String {
    "ask".to_string()
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentReference {
    pub path: String,
    pub name: String,
    #[serde(default)]
    pub extension: String,
    pub size: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub id: String,
    pub role: String,
    pub content: String,
    pub created_at: u64,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry: Option<RetryConfiguration>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub activities: Option<Vec<ActivityItem>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub traces: Option<Vec<TraceItem>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attachments: Option<Vec<AttachmentReference>>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ActivityItem {
    pub id: String,
    pub kind: String,
    pub text: String,
    pub state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub action: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub elapsed_ms: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TraceItem {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub elapsed_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub action: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RetryConfiguration {
    pub provider: String,
    pub model: String,
    pub base_url: String,
    pub api: String,
    pub thinking_level: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    pub id: String,
    pub title: String,
    pub provider: String,
    pub model: String,
    #[serde(default = "default_thinking_level")]
    pub thinking_level: String,
    #[serde(default = "default_permission_mode")]
    pub permission_mode: String,
    pub created_at: u64,
    pub updated_at: u64,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub workspace_path: String,
    #[serde(default)]
    pub workspace_name: String,
    pub messages: Vec<Message>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(default)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub provider: String,
    pub model: String,
    pub base_url: String,
    pub api: String,
    pub thinking_level: String,
    #[serde(default = "default_permission_timeout_ms")]
    pub permission_timeout_ms: u64,
    #[serde(default = "default_accent_color")]
    pub accent_color: String,
    #[serde(default = "default_theme")]
    pub theme: String,
    #[serde(default)]
    pub providers: Vec<ProviderProfile>,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            provider: "openai".to_string(),
            model: "gpt-4o-mini".to_string(),
            base_url: String::new(),
            api: "openai-completions".to_string(),
            thinking_level: "medium".to_string(),
            permission_timeout_ms: default_permission_timeout_ms(),
            accent_color: default_accent_color(),
            theme: default_theme(),
            providers: Vec::new(),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppState {
    pub conversations: Vec<Conversation>,
    pub settings: AppSettings,
    pub runtime_configuration: RuntimeConfiguration,
    pub api_key_configured: bool,
    pub provider_auth_configured: BTreeMap<String, bool>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(default)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeConfiguration {
    pub enabled: bool,
    pub system_prompt_mode: String,
    pub system_prompt: String,
    pub conversation_prompt: String,
    pub tool_mode: String,
    #[serde(default)]
    pub enabled_tools: Vec<String>,
    pub skills_enabled: bool,
    pub extensions_enabled: bool,
    #[serde(default)]
    pub custom_tools: Vec<CustomToolConfiguration>,
}

impl Default for RuntimeConfiguration {
    fn default() -> Self {
        Self {
            enabled: true,
            system_prompt_mode: "append".to_string(),
            system_prompt: String::new(),
            conversation_prompt: String::new(),
            tool_mode: "default".to_string(),
            enabled_tools: Vec::new(),
            skills_enabled: false,
            extensions_enabled: false,
            custom_tools: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(default)]
#[serde(rename_all = "camelCase")]
pub struct CustomToolConfiguration {
    pub id: String,
    pub name: String,
    pub label: String,
    pub description: String,
    pub kind: String,
    pub enabled: bool,
    #[serde(default = "default_custom_tool_permission_mode")]
    pub permission_mode: String,
    pub command: String,
    pub method: String,
    pub url: String,
    pub headers: String,
    pub body_template: String,
    pub input_schema: String,
}

impl Default for CustomToolConfiguration {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            label: String::new(),
            description: String::new(),
            kind: "command".to_string(),
            enabled: true,
            permission_mode: default_custom_tool_permission_mode(),
            command: String::new(),
            method: "GET".to_string(),
            url: String::new(),
            headers: String::new(),
            body_template: String::new(),
            input_schema: String::new(),
        }
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestCustomToolRequest {
    pub tool: CustomToolConfiguration,
    pub input: String,
    #[serde(default)]
    pub workspace_path: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestCustomToolResult {
    pub output: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveSettingsResult {
    pub settings: AppSettings,
    pub api_key_configured: bool,
    pub provider_auth_configured: BTreeMap<String, bool>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModel {
    pub id: String,
    pub name: String,
    pub reasoning: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderProfile {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub api: String,
    #[serde(default)]
    pub models: Vec<ProviderModel>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub provider: String,
    pub id: String,
    pub name: String,
    pub reasoning: bool,
    pub api: String,
    pub context_window: Option<u64>,
    pub max_tokens: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendMessageRequest {
    pub request_id: String,
    pub conversation_id: String,
    pub text: String,
    pub provider: String,
    pub model: String,
    pub base_url: String,
    pub api: String,
    pub thinking_level: String,
    #[serde(default = "default_permission_mode")]
    pub permission_mode: String,
    #[serde(default = "default_permission_timeout_ms")]
    pub permission_timeout_ms: u64,
    #[serde(default)]
    pub attachments: Vec<AttachmentReference>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetryMessageRequest {
    pub request_id: String,
    pub conversation_id: String,
    pub error_message_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionResponseRequest {
    pub conversation_id: String,
    pub request_id: Option<String>,
    pub permission_id: String,
    pub decision: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueMessageRequest {
    pub conversation_id: String,
    pub text: String,
    pub behavior: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareSessionRequest {
    pub conversation_id: String,
    pub provider: String,
    pub model: String,
    pub base_url: String,
    pub api: String,
    pub thinking_level: String,
    #[serde(default = "default_permission_mode")]
    pub permission_mode: String,
    #[serde(default = "default_permission_timeout_ms")]
    pub permission_timeout_ms: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetConversationModelRequest {
    pub conversation_id: String,
    pub provider: String,
    pub model: String,
    pub thinking_level: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetConversationPermissionModeRequest {
    pub conversation_id: String,
    pub permission_mode: String,
}

/// Stable Tao-facing event envelope. Pi's RPC event names are translated to
/// this envelope at the Rust boundary so the UI does not depend on Pi's wire
/// protocol.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaoRuntimeEvent {
    pub version: u8,
    pub category: String,
    pub event: String,
    pub conversation_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub elapsed_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub activity_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub activity_state: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permission_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permission_title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permission_risk: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permission_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permission_target: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permission_command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permission_scope: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permission_can_remember: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permission_timeout_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trace_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_trace_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trace_kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trace_status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trace_title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trace_summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trace_started_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trace_ended_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trace_provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trace_model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trace_metadata: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionTestRequest {
    #[serde(default)]
    pub provider_id: String,
    #[serde(default)]
    pub provider_name: String,
    pub base_url: String,
    pub api_key: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionTestResult {
    pub provider_id: String,
    pub provider_name: String,
    pub endpoint: String,
    pub latency_ms: u64,
    pub models: Vec<ProviderModel>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceEntry {
    pub name: String,
    pub relative_path: String,
    pub kind: String,
    pub size: Option<u64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    pub status: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceListing {
    pub root_path: String,
    pub relative_path: String,
    pub entries: Vec<WorkspaceEntry>,
    pub changes: Vec<FileChange>,
    pub is_git_repo: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFile {
    pub path: String,
    pub content: String,
    pub language: String,
    pub size: u64,
}
