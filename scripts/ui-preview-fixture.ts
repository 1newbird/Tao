import { emptyConfiguration } from "../src/agent-profiles";
import type { AgentCatalog, AgentProfile, CustomToolConfiguration } from "../src/agent-profiles";

// Loaded only by preview-ui.mjs; never imported by the production entry point.
const tool: CustomToolConfiguration = { id: "lookup", name: "lookup", label: "资料查询", description: "查找指定来源的资料并返回摘要。", kind: "http", enabled: true, permissionMode: "ask", command: "", executable: "", arguments: "[]", timeoutMs: 30000, allowedHosts: ["example.com"], method: "GET", url: "https://example.com/search?q={{query}}", headers: '{"Authorization":"Bearer {{env:TAO_SERVICE_TOKEN}}"}', bodyTemplate: "", inputSchema: '{"type":"object","properties":{"query":{"type":"string"}},"required":["query"]}' };
const profiles: AgentProfile[] = [
  { id: "default", name: "默认助手", description: "日常问答、资料整理与通用任务", revision: 2, configuration: { ...emptyConfiguration(), toolMode: "default", systemPrompt: "你是 Tao 助手，简洁、准确地回答问题。" }, customToolIds: [], defaultModel: null },
  { id: "research", name: "研究助手", description: "阅读资料、核对来源并整理分析结论", revision: 1, configuration: { ...emptyConfiguration(), enabledTools: ["read", "grep", "find", "ls"], systemPrompt: "依据来源进行分析，说明证据与推断。", skillsEnabled: true }, customToolIds: ["lookup"], defaultModel: null },
  { id: "writer", name: "写作助手", description: "组织思路，起草并润色内容", revision: 1, configuration: { ...emptyConfiguration(), enabledTools: ["read", "write", "edit"] }, customToolIds: [], defaultModel: null },
  { id: "long", name: "复杂领域资料分析与流程编排助手的长名称", description: "用于检查长名称的折行和菜单呈现", revision: 1, configuration: emptyConfiguration(), customToolIds: [], defaultModel: null },
];
let catalog: AgentCatalog = { schemaVersion: 1, revision: 1, defaultProfileId: "default", profiles, tools: [tool], workspaceDefaults: [{ workspacePath: "d:/preview/project", profileId: "research" }] };
const settings = { provider: "preview", model: "tao-preview", baseUrl: "", api: "openai-completions", thinkingLevel: "medium", permissionTimeoutMs: 60000, theme: new URLSearchParams(location.search).get("theme") === "dark" ? "dark" : "light", accentColor: "tao", providers: [{ id: "preview", name: "预览模型", baseUrl: "", api: "openai-completions", models: [{ id: "tao-preview", name: "Tao Preview", reasoning: true }] }] };
const snapshot = (profile: AgentProfile) => ({ profileId: profile.id, name: profile.name, revision: profile.revision, configuration: { ...profile.configuration, customTools: catalog.tools.filter((item) => profile.customToolIds.includes(item.id)) }, defaultModel: profile.defaultModel });
let conversations = [{ id: "preview-chat", title: "开始一个新想法", provider: "preview", model: "tao-preview", thinkingLevel: "medium", permissionMode: "ask", workspacePath: "D:/preview/project", workspaceName: "Tao 工作区", pinned: false, createdAt: Date.now(), updatedAt: Date.now(), messages: [] as unknown[], agentSnapshot: { ...snapshot(profiles[0]), revision: 1 } }];
const callbacks = new Map<number, (event: unknown) => void>();
let callbackId = 0;
const listeners = new Map<number, number>();
const emit = (payload: Record<string, unknown>) => { for (const id of listeners.values()) callbacks.get(id)?.({ event: "tao-runtime-event", id, payload: { version: 1, ...payload } }); };
let finishPrompt: (() => void) | undefined;
const environment = window as unknown as { __TAURI_INTERNALS__: unknown; __TAURI_EVENT_PLUGIN_INTERNALS__: unknown };
environment.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: (id: number) => listeners.delete(id) };
environment.__TAURI_INTERNALS__ = {
  transformCallback(callback: (event: unknown) => void) { callbacks.set(++callbackId, callback); return callbackId; },
  unregisterCallback(id: number) { callbacks.delete(id); },
  async invoke(command: string, args: Record<string, any> = {}) {
    if (command === "get_app_state") return structuredClone({ conversations, settings, agentCatalog: catalog, runtimeConfiguration: profiles[0].configuration, storageWarnings: [], apiKeyConfigured: true, providerAuthConfigured: { preview: true } });
    if (command === "list_models") return [{ provider: "preview", id: "tao-preview", name: "Tao Preview", reasoning: true, api: "openai-completions", contextWindow: 128000 }];
    if (command === "get_runtime_status") return { phase: "ready", running: true, ready: true, pid: 1234, sessionCount: conversations.length, startedAt: Date.now(), nodePath: "内存预览", runtimePath: "内存预览", piPath: "内存预览", lastError: null };
    if (command === "prepare_session") return null;
    if (command === "plugin:event|listen") { listeners.set(callbackId, args.handler); return callbackId; }
    if (command === "plugin:event|unlisten") { listeners.delete(args.eventId); return null; }
    if (command === "get_agent_catalog") return structuredClone(catalog);
    if (command === "parse_agent_catalog") return JSON.parse(args.content);
    if (command === "save_agent_catalog") { catalog = structuredClone(args.catalog); catalog.revision++; catalog.profiles.forEach((profile) => { profile.revision = Math.max(1, profile.revision); }); return structuredClone(catalog); }
    if (command === "set_workspace_agent_default") { catalog.workspaceDefaults = args.profileId ? [{ workspacePath: "d:/preview/project", profileId: args.profileId }] : []; catalog.revision++; return structuredClone(catalog); }
    if (command === "set_conversation_agent") { const conversation = conversations.find((item) => item.id === args.conversationId)!; conversation.agentSnapshot = snapshot(catalog.profiles.find((item) => item.id === args.profileId)!); return structuredClone(conversation); }
    if (command === "create_conversation" || command === "create_conversation_with_workspace") { const conversation = { ...structuredClone(conversations[0]), id: crypto.randomUUID(), title: "新对话", messages: [], agentSnapshot: snapshot(catalog.profiles.find((profile) => profile.id === catalog.defaultProfileId)!) }; conversations.push(conversation); return structuredClone(conversation); }
    if (command === "test_custom_tool") return { output: "模拟测试完成：工具输入有效。预览环境不会执行真实程序或 HTTP 请求。" };
    if (command === "send_message") {
      const conversation = conversations.find((item) => item.id === args.request.conversationId)!;
      return new Promise((resolve) => {
        finishPrompt = () => { conversation.messages.push({ id: crypto.randomUUID(), role: "user", content: args.request.content || args.request.message || args.request.prompt || args.request.text, createdAt: Date.now() }, { id: crypto.randomUUID(), role: "assistant", content: "这是 UI 预览中的模拟回答，未调用模型。", createdAt: Date.now() }); resolve(structuredClone(conversation)); finishPrompt = undefined; };
        emit({ conversationId: conversation.id, requestId: args.request.requestId, category: "turn", event: "started" });
      });
    }
    if (command === "abort_generation") { finishPrompt?.(); return null; }
    if (command === "choose_agent_catalog" || command === "choose_workspace_directory" || command === "choose_message_files" || command.startsWith("plugin:dialog|")) return null;
    throw new Error(`UI 预览未实现命令：${command}`);
  },
};
