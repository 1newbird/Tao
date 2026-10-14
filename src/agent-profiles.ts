export type CustomToolPermissionMode = "ask" | "allow" | "deny";

export interface ToolPermissionConfiguration {
  mode: "inherit" | CustomToolPermissionMode;
  pathScope: "any" | "workspace";
}

export interface CustomToolConfiguration {
  id: string;
  name: string;
  label: string;
  description: string;
  kind: "command" | "http" | "process";
  enabled: boolean;
  permissionMode: CustomToolPermissionMode;
  command: string;
  executable: string;
  arguments: string;
  timeoutMs: number;
  allowedHosts: string[];
  method: string;
  url: string;
  headers: string;
  bodyTemplate: string;
  inputSchema: string;
}

export interface RuntimeConfiguration {
  enabled: boolean;
  systemPromptMode: "append" | "replace";
  systemPrompt: string;
  conversationPrompt: string;
  toolMode: "default" | "custom";
  enabledTools: string[];
  skillsEnabled: boolean;
  extensionsEnabled: boolean;
  customTools: CustomToolConfiguration[];
  toolPermissions: Record<string, ToolPermissionConfiguration>;
}

export interface AgentModelDefaults {
  provider: string;
  model: string;
  thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
}

export interface AgentProfile {
  id: string;
  name: string;
  description: string;
  revision: number;
  configuration: RuntimeConfiguration;
  customToolIds: string[];
  defaultModel?: AgentModelDefaults | null;
}

export interface AgentSnapshot {
  profileId: string;
  name: string;
  revision: number;
  configuration: RuntimeConfiguration;
  defaultModel?: AgentModelDefaults | null;
}

export interface AgentCatalog {
  schemaVersion: number;
  revision: number;
  defaultProfileId: string;
  profiles: AgentProfile[];
  tools: CustomToolConfiguration[];
  workspaceDefaults: Array<{ workspacePath: string; profileId: string }>;
}

export function emptyConfiguration(): RuntimeConfiguration {
  return { enabled: true, systemPromptMode: "append", systemPrompt: "", conversationPrompt: "", toolMode: "custom", enabledTools: [], skillsEnabled: false, extensionsEnabled: false, customTools: [], toolPermissions: {} };
}

export function editorConfiguration(catalog: AgentCatalog, profileId: string): RuntimeConfiguration {
  const profile = catalog.profiles.find((item) => item.id === profileId);
  if (!profile) return emptyConfiguration();
  return structuredClone({ ...profile.configuration, customTools: catalog.tools.map((tool) => ({ ...tool, enabled: profile.customToolIds.includes(tool.id) })) });
}

export function catalogWithEditor(catalog: AgentCatalog, id: string, editor: RuntimeConfiguration): AgentCatalog {
  const renames = new Map<string, string>();
  for (const old of catalog.tools) {
    const updated = editor.customTools.find((tool) => tool.id === old.id);
    if (updated && updated.name !== old.name) renames.set(old.name, updated.name);
  }
  return {
    ...catalog,
    tools: editor.customTools.map((tool) => ({ ...tool, enabled: true })),
    profiles: catalog.profiles.map((profile) => {
      const configuration = profile.id === id ? { ...editor, customTools: [] } : profile.configuration;
      const permissions = Object.fromEntries(Object.entries(configuration.toolPermissions ?? {}).map(([name, rule]) => [renames.get(name) ?? name, rule]));
      return { ...profile, configuration: { ...configuration, toolPermissions: permissions }, customToolIds: profile.id === id ? editor.customTools.filter((tool) => tool.enabled).map((tool) => tool.id) : profile.customToolIds };
    }),
  };
}

function sensitiveKey(key: string): boolean {
  return /authorization|cookie|api.?key|token|secret|password/i.test(key);
}

function redactObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactObject);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sensitiveKey(key) ? exportedCredential(item) : redactObject(item)]));
  return value;
}

function exportedCredential(value: unknown): string {
  if (typeof value === "string" && /\{\{env:[A-Za-z_][A-Za-z0-9_]*\}\}/.test(value)) {
    const literal = value.replace(/\{\{env:[A-Za-z_][A-Za-z0-9_]*\}\}/g, "").trim();
    if (!literal || /^(Bearer|Basic)$/i.test(literal)) return value;
  }
  return "[请配置凭据]";
}

export function exportedTool(tool: CustomToolConfiguration): CustomToolConfiguration {
  const result = { ...tool };
  for (const field of ["headers", "bodyTemplate"] as const) {
    if (!result[field]) continue;
    try { result[field] = JSON.stringify(redactObject(JSON.parse(result[field])), null, 2); }
    catch { result[field] = result[field].replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, "$1[请配置凭据]"); }
  }
  try {
    const url = new URL(result.url);
    let changed = Boolean(url.username || url.password);
    url.username = "";
    url.password = "";
    for (const key of [...url.searchParams.keys()]) if (sensitiveKey(key)) { url.searchParams.set(key, "[请配置凭据]"); changed = true; }
    if (changed) result.url = url.href.replace(/%7B%7B/g, "{{").replace(/%7D%7D/g, "}}");
  } catch { /* URL templates are validated when executed. */ }
  result.command = result.command.replace(/\b(api[_-]?key|token|password|secret)\s*([=:]\s*|\s+)\S+/gi, "$1$2[请配置凭据]");
  return result;
}

export function exportProfile(catalog: AgentCatalog, id: string): AgentCatalog {
  const profile = catalog.profiles.find((item) => item.id === id);
  if (!profile) throw new Error("找不到组合");
  return { schemaVersion: 1, revision: 1, defaultProfileId: id, profiles: [structuredClone(profile)], tools: catalog.tools.filter((tool) => profile.customToolIds.includes(tool.id)).map(exportedTool), workspaceDefaults: [] };
}

export function safeSnapshot(snapshot: AgentSnapshot | null | undefined): AgentSnapshot | null | undefined {
  return snapshot ? { ...snapshot, configuration: { ...snapshot.configuration, customTools: snapshot.configuration.customTools.map(exportedTool) } } : snapshot;
}

export function mergeCatalog(target: AgentCatalog, imported: AgentCatalog): AgentCatalog {
  const result = structuredClone(target);
  const toolIds = new Map<string, string>();
  for (const tool of imported.tools) {
    const sameName = result.tools.find((item) => item.name === tool.name);
    if (sameName) {
      if (comparableTool(sameName) !== comparableTool(tool)) throw new Error(`工具 ${tool.name} 已存在且定义不同，请修改导入文件中的工具名称`);
      toolIds.set(tool.id, sameName.id);
    } else {
      let id = tool.id;
      while (result.tools.some((item) => item.id === id)) id += "_import";
      result.tools.push({ ...tool, id });
      toolIds.set(tool.id, id);
    }
  }
  for (const profile of imported.profiles) {
    let id = profile.id;
    while (result.profiles.some((item) => item.id === id)) id += "_import";
    result.profiles.push({ ...profile, id, revision: 0, customToolIds: profile.customToolIds.map((toolId) => toolIds.get(toolId) ?? toolId) });
  }
  return result;
}

function comparableTool(tool: CustomToolConfiguration): string {
  const result = { ...tool, id: "", enabled: true };
  for (const field of ["headers", "arguments", "inputSchema", "bodyTemplate"] as const) {
    try { result[field] = JSON.stringify(canonicalJson(JSON.parse(result[field]))); } catch { /* Keep non-JSON templates. */ }
  }
  return JSON.stringify(canonicalJson(result));
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonicalJson(item)]));
  return value;
}

export function workspaceKey(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/^\/\/\?\//, "").replace(/\/+$/, "").toLowerCase();
}
