use crate::models::{AgentCatalog, AgentProfile, AgentSnapshot, Conversation, RuntimeConfiguration, WorkspaceAgentDefault};
use crate::storage;
use std::collections::HashSet;
use std::fs;
use std::path::Path;
use std::sync::Mutex;
use tauri::AppHandle;

static CATALOG_LOCK: Mutex<()> = Mutex::new(());

pub fn migrate(configuration: RuntimeConfiguration) -> AgentCatalog {
    let tool_ids = configuration.custom_tools.iter().filter(|tool| tool.enabled).map(|tool| tool.id.clone()).collect();
    let tools = configuration.custom_tools.clone();
    let mut configuration = configuration;
    configuration.custom_tools.clear();
    AgentCatalog {
        schema_version: 1,
        revision: 1,
        default_profile_id: "default".into(),
        profiles: vec![AgentProfile { id: "default".into(), name: "默认助手".into(), description: "从原有定制配置迁移".into(), revision: 1, configuration, custom_tool_ids: tool_ids, default_model: None }],
        tools,
        workspace_defaults: Vec::new(),
    }
}

pub fn workspace_key(path: &str) -> String {
    let normalized = path.trim().replace('\\', "/").trim_end_matches('/').to_string();
    #[cfg(target_os = "windows")]
    { normalized.strip_prefix("//?/").unwrap_or(&normalized).to_lowercase() }
    #[cfg(not(target_os = "windows"))]
    { normalized }
}

pub fn snapshot(catalog: &AgentCatalog, id: &str) -> Result<AgentSnapshot, String> {
    let profile = catalog.profiles.iter().find(|item| item.id == id).ok_or_else(|| "找不到智能体组合".to_string())?;
    let mut configuration = profile.configuration.clone();
    configuration.custom_tools = profile.custom_tool_ids.iter().map(|id| {
        let mut tool = catalog.tools.iter().find(|item| &item.id == id).cloned().ok_or_else(|| format!("组合引用的工具不存在：{id}"))?;
        tool.enabled = true;
        Ok(tool)
    }).collect::<Result<Vec<_>, String>>()?;
    Ok(AgentSnapshot { profile_id: profile.id.clone(), name: profile.name.clone(), revision: profile.revision, configuration, default_model: profile.default_model.clone() })
}

pub fn normalize(mut catalog: AgentCatalog) -> Result<AgentCatalog, String> {
    if serde_json::to_vec(&catalog).map_err(|e| e.to_string())?.len() > 2 * 1024 * 1024 { return Err("智能体配置不能超过 2 MB".into()); }
    if catalog.schema_version != 1 { return Err("不支持该智能体配置格式版本".into()); }
    if catalog.profiles.is_empty() || catalog.profiles.len() > 100 || catalog.tools.len() > 200 { return Err("需保留 1–100 个组合，工具数不能超过 200".into()); }
    let normalized_tools = storage::normalize_runtime_configuration(RuntimeConfiguration { custom_tools: catalog.tools, ..Default::default() })?;
    catalog.tools = normalized_tools.custom_tools;
    let mut tool_ids = HashSet::new();
    for tool in &mut catalog.tools {
        if !valid_id(&tool.id) || !tool_ids.insert(tool.id.clone()) { return Err("工具 ID 无效或重复".into()); }
        tool.enabled = true;
    }
    let mut profile_ids = HashSet::new();
    for profile in &mut catalog.profiles {
        if !valid_id(&profile.id) || !profile_ids.insert(profile.id.clone()) { return Err("组合 ID 无效或重复".into()); }
        profile.name = profile.name.trim().to_string();
        profile.description = profile.description.trim().to_string();
        if profile.name.is_empty() || profile.name.chars().count() > 100 || profile.description.len() > 2000 { return Err("组合名称需为 1–100 个字符，说明不能超过 2000 字节".into()); }
        if !profile.configuration.custom_tools.is_empty() { return Err("组合应引用工具库，不能内嵌工具定义".into()); }
        profile.configuration = storage::normalize_runtime_configuration(profile.configuration.clone())?;
        if let Some(model) = &mut profile.default_model {
            model.provider = model.provider.trim().to_string();
            model.model = model.model.trim().to_string();
            if model.provider.is_empty() || model.model.is_empty() || !matches!(model.thinking_level.as_str(), "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max") { return Err("组合默认模型配置无效".into()); }
        }
        let mut seen = HashSet::new();
        profile.custom_tool_ids.retain(|id| seen.insert(id.clone()));
        if profile.custom_tool_ids.iter().any(|id| !tool_ids.contains(id)) { return Err(format!("组合 {} 引用了不存在的工具", profile.name)); }
    }
    if !profile_ids.contains(&catalog.default_profile_id) { return Err("默认组合不存在".into()); }
    for profile in &catalog.profiles {
        if profile.configuration.delegation.allowed_profile_ids.iter().any(|id| !profile_ids.contains(id)) {
            return Err(format!("组合 {} 引用了不存在的子代理组合，请先移除委派引用", profile.name));
        }
    }
    let mut workspaces = HashSet::new();
    for default in &mut catalog.workspace_defaults {
        default.workspace_path = workspace_key(&default.workspace_path);
        if default.workspace_path.is_empty() || !workspaces.insert(default.workspace_path.clone()) || !profile_ids.contains(&default.profile_id) { return Err("项目默认组合配置无效或重复".into()); }
    }
    Ok(catalog)
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 100 && id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-'))
}

pub fn revise(mut catalog: AgentCatalog, previous: &AgentCatalog) -> Result<AgentCatalog, String> {
    for index in 0..catalog.profiles.len() {
        let profile = &catalog.profiles[index];
        let revision = if let Some(old) = previous.profiles.iter().find(|item| item.id == profile.id) {
            let changed = old.name != profile.name || old.description != profile.description || old.default_model != profile.default_model || snapshot(previous, &old.id)?.configuration != snapshot(&catalog, &profile.id)?.configuration;
            if changed { old.revision.checked_add(1).ok_or("组合版本号超出范围")? } else { old.revision.max(1) }
        } else { 1 };
        catalog.profiles[index].revision = revision;
    }
    Ok(catalog)
}

fn load_at(root: &Path) -> Result<AgentCatalog, String> {
    let path = root.join("agents/catalog.json");
    if path.exists() {
        let content = fs::read_to_string(&path).map_err(|e| format!("无法读取智能体配置：{e}"))?;
        return normalize(serde_json::from_str(&content).map_err(|e| format!("智能体配置损坏：{e}"))?);
    }
    let legacy = storage::load_runtime_configuration_at(root)?;
    let catalog = normalize(migrate(storage::normalize_runtime_configuration(legacy)?))?;
    storage::write_json(&path, &catalog, "智能体配置")?;
    Ok(catalog)
}

pub fn load(app: &AppHandle) -> Result<AgentCatalog, String> {
    let _guard = CATALOG_LOCK.lock().map_err(|_| "智能体配置锁不可用")?;
    load_at(&storage::app_data_root(app)?)
}

pub fn delegation_snapshots(app: &AppHandle, parent: Option<&AgentSnapshot>) -> Result<Vec<AgentSnapshot>, String> {
    let Some(parent) = parent else { return Ok(Vec::new()); };
    if !parent.configuration.delegation.enabled { return Ok(Vec::new()); }
    let catalog = load(app)?;
    parent.configuration.delegation.allowed_profile_ids.iter().map(|id| snapshot(&catalog, id)
        .map_err(|_| format!("子代理组合 {id} 已不存在，请为当前会话应用更新后的组合"))).collect()
}

pub fn save(app: &AppHandle, catalog: AgentCatalog) -> Result<AgentCatalog, String> {
    let _guard = CATALOG_LOCK.lock().map_err(|_| "智能体配置锁不可用")?;
    let root = storage::app_data_root(app)?;
    let previous = load_at(&root)?;
    // Reject stale editors rather than overwriting another save or project default.
    if catalog.revision != previous.revision || catalog.profiles.iter().any(|profile| previous.profiles.iter().any(|old| old.id == profile.id && old.revision != profile.revision)) { return Err("配置已被其他操作更新，请点击重新读取后再编辑保存".into()); }
    let mut catalog = revise(normalize(catalog)?, &previous)?;
    catalog.revision = previous.revision.checked_add(1).ok_or("配置版本号超出范围")?;
    fs::create_dir_all(root.join("skills")).map_err(|e| format!("无法创建 Skill 目录：{e}"))?;
    storage::write_json(&root.join("agents/catalog.json"), &catalog, "智能体配置")?;
    Ok(catalog)
}

pub fn for_workspace(app: &AppHandle, workspace: &str) -> Result<AgentSnapshot, String> {
    let catalog = load(app)?;
    let key = workspace_key(workspace);
    let id = catalog.workspace_defaults.iter().find(|item| item.workspace_path == key).map(|item| item.profile_id.as_str()).unwrap_or(&catalog.default_profile_id);
    snapshot(&catalog, id)
}

pub fn ensure_snapshot(app: &AppHandle, conversation: &mut Conversation) -> Result<bool, String> {
    if conversation.agent_snapshot.is_some() { return Ok(false); }
    conversation.agent_snapshot = Some(for_workspace(app, &conversation.workspace_path)?);
    Ok(true)
}

pub fn set_workspace_default(app: &AppHandle, workspace: &str, profile_id: &str) -> Result<AgentCatalog, String> {
    let key = workspace_key(&storage::normalize_workspace_path(workspace)?);
    if key.is_empty() { return Err("请先选择项目目录".into()); }
    let mut catalog = load(app)?;
    if !profile_id.is_empty() { snapshot(&catalog, profile_id)?; }
    catalog.workspace_defaults.retain(|item| item.workspace_path != key);
    if !profile_id.is_empty() { catalog.workspace_defaults.push(WorkspaceAgentDefault { workspace_path: key, profile_id: profile_id.into() }); }
    save(app, catalog)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::CustomToolConfiguration;

    #[test]
    fn migration_preserves_selection_and_snapshot_isolation() {
        let mut config = RuntimeConfiguration { system_prompt: "old".into(), ..Default::default() };
        config.custom_tools.push(CustomToolConfiguration { id: "lookup".into(), name: "lookup".into(), command: "echo ok".into(), ..Default::default() });
        let original = normalize(migrate(config)).unwrap();
        let saved = snapshot(&original, "default").unwrap();
        let mut edited = original.clone();
        edited.profiles[0].configuration.system_prompt = "new".into();
        edited.tools[0].command = "echo changed".into();
        let edited = revise(normalize(edited).unwrap(), &original).unwrap();
        assert_eq!(edited.profiles[0].revision, 2);
        assert_eq!(saved.configuration.system_prompt, "old");
        assert_eq!(saved.configuration.custom_tools[0].command, "echo ok");
        assert!(edited.profiles[0].configuration.custom_tools.is_empty());
    }

    #[test]
    fn revisions_change_only_for_profiles_using_changed_tool() {
        let mut catalog = migrate(RuntimeConfiguration::default());
        catalog.tools.push(CustomToolConfiguration { id: "tool".into(), name: "tool".into(), command: "echo one".into(), ..Default::default() });
        let mut second = catalog.profiles[0].clone();
        second.id = "second".into();
        second.custom_tool_ids.push("tool".into());
        catalog.profiles.push(second);
        let original = normalize(catalog).unwrap();
        let mut edited = original.clone();
        edited.tools[0].command = "echo two".into();
        let revised = revise(edited, &original).unwrap();
        assert_eq!(revised.profiles[0].revision, 1);
        assert_eq!(revised.profiles[1].revision, 2);
        assert_eq!(revise(revised.clone(), &revised).unwrap(), revised);
    }

    #[test]
    fn invalid_references_are_rejected() {
        let mut catalog = migrate(RuntimeConfiguration::default());
        catalog.profiles[0].custom_tool_ids.push("missing".into());
        assert!(normalize(catalog).is_err());
    }

    #[test]
    fn delegation_defaults_validation_and_snapshot_are_compatible() {
        let legacy: RuntimeConfiguration = serde_json::from_str("{}").unwrap();
        assert!(!legacy.delegation.enabled);
        assert!(RuntimeConfiguration::default().delegation.enabled);
        let mut catalog = migrate(legacy);
        catalog.profiles[0].configuration.delegation.enabled = true;
        assert!(normalize(catalog.clone()).is_ok());
        catalog.profiles[0].configuration.delegation.allowed_profile_ids.push("missing".into());
        assert!(normalize(catalog.clone()).is_err());
        catalog.profiles[0].configuration.delegation.allowed_profile_ids = vec!["default".into()];
        let original = normalize(catalog).unwrap();
        let captured = snapshot(&original, "default").unwrap();
        let mut edited = original.clone();
        edited.profiles[0].configuration.delegation.max_concurrent = 2;
        let revised = revise(normalize(edited).unwrap(), &original).unwrap();
        assert_eq!(revised.profiles[0].revision, 2);
        assert_eq!(captured.configuration.delegation.max_concurrent, 3);
        let mut invalid = captured.configuration;
        invalid.delegation.max_tasks = 33;
        assert!(storage::normalize_runtime_configuration(invalid).is_err());
    }

    #[test]
    fn custom_tools_cannot_shadow_coordination_tools() {
        for name in ["read_tao_doc", "spawn_agent", "get_agent_status", "wait_agent", "cancel_agent", "review_agent_task", "list_agents", "send_message", "read_agent_messages", "followup_task", "create_task", "list_tasks", "claim_task", "assign_task", "retry_agent_task", "cancel_task"] {
            let mut configuration = RuntimeConfiguration::default();
            configuration.custom_tools.push(CustomToolConfiguration { id: "fake".into(), name: name.into(), command: "echo bad".into(), ..Default::default() });
            assert!(storage::normalize_runtime_configuration(configuration).is_err(), "{name}");
        }
    }

    #[test]
    fn migration_is_persisted_and_legacy_file_is_preserved() {
        let root = std::env::temp_dir().join(storage::new_id("tao-catalog-test"));
        let legacy = RuntimeConfiguration { system_prompt: "legacy prompt".into(), ..Default::default() };
        storage::write_json(&root.join("runtime/profile.json"), &legacy, "测试").unwrap();
        let first = load_at(&root).unwrap();
        let old_snapshot = snapshot(&first, "default").unwrap();
        let mut updated = first.clone();
        updated.profiles[0].configuration.system_prompt = "updated prompt".into();
        updated = revise(updated, &first).unwrap();
        storage::write_json(&root.join("agents/catalog.json"), &updated, "测试").unwrap();
        assert_eq!(load_at(&root).unwrap(), updated);
        let restored_snapshot: AgentSnapshot = serde_json::from_str(&serde_json::to_string(&old_snapshot).unwrap()).unwrap();
        assert_eq!(restored_snapshot.configuration.system_prompt, "legacy prompt");
        assert_eq!(storage::load_runtime_configuration_at(&root).unwrap(), legacy);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn execution_and_compaction_are_validated_and_snapshot_scoped() {
        let legacy: RuntimeConfiguration = serde_json::from_str("{}").unwrap();
        assert_eq!(legacy.execution.backend, "local");
        assert_eq!(legacy.compaction.mode, "inherit");
        let catalog = migrate(RuntimeConfiguration::default());
        let captured = snapshot(&catalog, "default").unwrap();
        let mut edited = catalog.clone();
        edited.profiles[0].configuration.execution.backend = "docker".into();
        edited.profiles[0].configuration.execution.network = "deny".into();
        edited.profiles[0].configuration.compaction.mode = "automatic".into();
        edited.profiles[0].configuration.compaction.reserve_tokens = 4096;
        let changed = revise(edited, &catalog).unwrap();
        assert_eq!(captured.configuration.execution.backend, "local");
        assert_eq!(changed.profiles[0].revision, catalog.profiles[0].revision + 1);
        let mut invalid = RuntimeConfiguration::default();
        invalid.execution.allowed_env.push("NODE_OPTIONS".into());
        assert!(storage::normalize_runtime_configuration(invalid).is_err());
        let mut invalid_catalog = catalog.clone();
        invalid_catalog.profiles[0].configuration.execution.allowed_env.push("TAO_SANDBOX_CHILD".into());
        assert!(normalize(invalid_catalog).is_err());
        let mut invalid = RuntimeConfiguration::default();
        invalid.execution.allowed_hosts.push("-invalid.example".into());
        assert!(storage::normalize_runtime_configuration(invalid).is_err());
        let mut invalid = RuntimeConfiguration::default();
        invalid.compaction.reserve_tokens = 0;
        assert!(storage::normalize_runtime_configuration(invalid).is_err());
    }
}
