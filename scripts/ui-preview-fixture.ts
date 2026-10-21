import { previewRuns } from "./ui-preview-runs";
import { emptyConfiguration } from "../src/agent-profiles";
import type { AgentCatalog, AgentProfile, CustomToolConfiguration } from "../src/agent-profiles";
import type { TeamView } from "../src/collaboration-types";

const scrollScenario = new URLSearchParams(location.search).get("scenario") === "scroll";
const collaborationScenario = new URLSearchParams(location.search).get("scenario") === "collaboration";
const showcaseScenario = new URLSearchParams(location.search).get("scenario") === "showcase";
const previewReport = `# 多智能体协作测试报告

## 订单核对

| 项目 | 结果 | 说明 |
| :--- | ---: | :---: |
| **有效订单** | 4 | O001、O002、O004、O007 |
| **有效金额** | 720 | 100 + 200 + 300 + 120 |
| 排除项 | 4 | 退款、重复、待支付、非正金额 |

---

### 任务与证据

1. 核算员完成初步核对
   - 读取订单和规则
   - 回复复核员
     - 解释重复订单 O004
     - 排除非正金额 O006
2. 复核员交叉验证

- [x] 双向消息已投递
- [ ] 原生窗口待桌面验收

> 本报告用于检查真实前端渲染。
>
> 长内容更新时，应能自由阅读历史。

\`\`\`json
{"orders": 4, "amount": 720, "evidence": "${"长代码行用于验证只在代码框内横向滚动。".repeat(16)}"}
\`\`\`

[项目说明](https://example.com/docs) · [无效链接](javascript:alert(1))

| 检查项 | 成员 | 状态 | 任务 | 消息 | 证据 | 版本 | 代次 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 双向通信 | 核算员与复核员 | 已验收 | task-preview | message-preview | 原始文件与工具回执 | 11 | 2 |
`;
const previewTrace = (index: number) => ({ id: `preview-trace-${index}`, kind: "runtime", title: `工作过程记录 ${index}`, summary: index === 160 ? "初始记录末尾，后续流式事件继续追加" : "已核对任务状态与消息回执", status: "completed", startedAt: new Date(Date.now() - 10000).toISOString(), endedAt: new Date().toISOString(), metadata: { sequence: index } });

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
const contextBase = "You are Tao, an assistant that helps users complete tasks with the tools and context available in this conversation.\n\nAvailable tools:\n- read: Read files and verify evidence\n\nGuidelines:\n- Be concise in your responses\n- Show file paths clearly";
const contextTools = [{ name: "read", description: "读取工作区内的文件，核对资料来源。", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }];
const contextPlatform = "[Tao 执行规则]\n遵守讨论、只读或执行范围。执行后验证，不虚构操作与结果；失败后核实原因与副作用。\n\n工作过程说明：在关键步骤说明真实进展。\n\n[Tao 按需资料]\n需要了解平台能力时，使用 read_tao_doc 按专题查阅；不预载正文。（此处为 UI 模拟摘要）";
const contextPreview = (configuration: AgentProfile["configuration"]) => {
  const systemPrompt = `${configuration.enabled && configuration.systemPromptMode === "replace" && configuration.systemPrompt ? configuration.systemPrompt + "\n\nAvailable tools:\n- read: Read files and verify evidence" : contextBase}\n\n${contextPlatform}\n\n${configuration.enabled && configuration.systemPromptMode !== "replace" ? configuration.systemPrompt : ""}\n${configuration.enabled ? configuration.conversationPrompt : ""}\n\n工作区：\${workspacePath}\n权限模式：\${permissionMode}\n时间：\${localTime}`;
  return {
  policyVersion: "tao-context-v2", defaultSystemPrompt: `${contextBase}\n\n${contextPlatform}\n\n工作区：\${workspacePath}\n权限模式：\${permissionMode}`, systemPrompt,
  tools: contextTools, warnings: ["这是内存模拟预览，没有读取用户配置或调用模型。", "实际路径、权限、Skills 与扩展在运行时解析。"],
  contentSizes: { systemPromptCharacters: systemPrompt.length, toolDefinitionCharacters: JSON.stringify(contextTools).length },
  sections: [{ id: "base", title: "默认角色与工具指导", source: "内置 tao-context-v2（模拟）", content: contextBase }, { id: "execution", title: "平台执行规则", source: "角色替换时保留", content: contextPlatform }, { id: "documentation", title: "按需文档入口", source: "专题正文不常驻", content: "read_tao_doc: tools / collaboration / permissions / customization" }, { id: "custom", title: "自定义追加", source: "当前组合", content: configuration.systemPrompt || "无" }, { id: "environment", title: "运行环境与权限", source: "每轮请求开始时绑定", content: "工作区：${workspacePath}\n权限模式：${permissionMode}\n系统：${operatingSystem}\n时间：${localTime}" }],
  };
};
const initialContext = { schemaVersion: 1, policyVersion: "tao-context-v1", conversationId: "preview-chat", requestId: "preview-request", capturedAt: Date.now(), conversationStart: true, profile: { profileId: "default", name: "默认助手", revision: 1 }, model: { provider: "preview", id: "tao-preview", api: "openai-completions" }, environment: { workspacePath: "D:/preview/project", permissionMode: "ask", operatingSystem: "win32（模拟）", shell: "bash 工具使用可用的 Bash", localTime: "2026-10-19 10:00:00 GMT+8", timeZone: "Asia/Shanghai" }, systemPrompt: `${contextBase}\n\n工作过程说明：在关键步骤说明进展。\n\n工作区：D:/preview/project\n权限模式：ask\n提示词不会授予额外权限。`, systemPromptTruncated: false, sources: [{ title: "基础提示词", source: "Tao 内置默认（模拟）" }, { title: "工作说明与附加要求", source: "Tao 内置 + 会话组合 v1" }, { title: "环境与权限", source: "本轮请求开始时的 Runtime 状态" }], tools: contextTools, messages: [{ role: "user", characters: 18 }], messageCount: 1, warnings: ["这是模拟的 SDK 输入快照，用于验证界面。", "不包含消息正文、隐藏推理、请求头或密钥。"] };
const snapshot = (profile: AgentProfile) => ({ profileId: profile.id, name: profile.name, revision: profile.revision, configuration: { ...profile.configuration, customTools: catalog.tools.filter((item) => profile.customToolIds.includes(item.id)) }, defaultModel: profile.defaultModel });
let conversations = [{ id: "preview-chat", title: "开始一个新想法", provider: "preview", model: "tao-preview", thinkingLevel: "medium", permissionMode: "ask", workspacePath: "D:/preview/project", workspaceName: "Tao 工作区", pinned: false, createdAt: Date.now(), updatedAt: Date.now(), messages: [] as unknown[], agentSnapshot: { ...snapshot(profiles[0]), revision: 1 } }];
if (showcaseScenario) {
  conversations[0].title = "新对话";
  conversations[0].workspacePath = "";
  conversations[0].workspaceName = "";
  conversations[0].agentSnapshot = snapshot(profiles[0]);
}
if (scrollScenario) {
  conversations[0].title = "Markdown 与滚动验证";
  conversations[0].messages = Array.from({ length: 8 }, (_, index) => [
    { id: `preview-user-${index}`, role: "user", content: `历史问题 ${index + 1}：请核对订单资料。`, createdAt: Date.now() - 20000 },
    { id: `preview-answer-${index}`, role: "assistant", content: index === 7 ? previewReport : `## 历史回答 ${index + 1}\n\n${"这是已保存的历史内容，生成新回答时仍应保持可阅读。\n\n".repeat(8)}`, createdAt: Date.now() - 10000, traces: index === 7 ? Array.from({ length: 160 }, (_, row) => previewTrace(row + 1)) : [] },
  ]).flat();
  conversations.push({ ...structuredClone(conversations[0]), id: "preview-other", title: "另一会话（位置恢复）", messages: [{ id: "other-answer", role: "assistant", content: `# 另一会话\n\n${previewReport}`, createdAt: Date.now() }] });
}
if (collaborationScenario) {
  conversations[0].title = "协作结果与成员查看";
  conversations[0].messages = [
    { id: "team-user", role: "user", content: "请核对资料并整理完整报告。", createdAt: Date.now() - 20000 },
    { id: "team-answer", role: "assistant", content: previewReport, createdAt: Date.now() - 10000 },
  ];
}
const callbacks = new Map<number, (event: unknown) => void>();
let callbackId = 0;
const listeners = new Map<number, { handler: number; event: string }>();
const emit = (payload: Record<string, unknown>) => { for (const [id, listener] of listeners) if (listener.event === "tao-runtime-event") callbacks.get(listener.handler)?.({ event: "tao-runtime-event", id, payload: { version: 1, ...payload } }); };
let finishPrompt: (() => void) | undefined;
const previewTeam: TeamView = {
  conversationId: "preview-chat", runId: "preview-run", rootAgentId: "preview-root", createdAt: Date.now(), closed: false, live: true, closeReason: "", sequence: 5,
  agents: [{ id: "agent-preview-a", name: "资料核查员", state: "running", taskId: "task-preview-a", retired: false, profileId: "research", revision: 2 }, { id: "agent-preview-b", name: "独立复核员", state: "idle", taskId: "task-preview-b", retired: false, profileId: "research", revision: 1 }],
  tasks: [{ id: "task-preview-a", title: "核查资料并整理证据", description: "读取指定资料，给出结论和依据，并向复核员说明发现。", state: "running", version: 3, assignedAgentId: "agent-preview-a", attemptId: "attempt-preview-a", dependsOn: [] }, { id: "task-preview-b", title: "独立复核", description: "检查核查结果，指出需要补充的证据。", state: "accepted", version: 5, assignedAgentId: "agent-preview-b", attemptId: "attempt-preview-b", dependsOn: [] }],
  attempts: [{ id: "attempt-preview-a", taskId: "task-preview-a", agentId: "agent-preview-a", generation: 1, state: "running", result: "", error: "", startedAt: Date.now() }, { id: "attempt-preview-b", taskId: "task-preview-b", agentId: "agent-preview-b", generation: 1, state: "submitted", result: "复核已完成，证据一致。", error: "", modelTurns: 2 }],
  messages: [{ id: "message-preview", from: "agent-preview-b", to: "agent-preview-a", kind: "suggestion", body: "请再核对来源中的第二条规则，并说明判断依据。", delivery: "delivered", createdAt: Date.now() }],
  events: [{ id: "event-tool", agentId: "agent-preview-a", taskId: "task-preview-a", attemptId: "attempt-preview-a", kind: "tool", text: "read", status: "completed", createdAt: Date.now() }, { id: "event-answer", agentId: "agent-preview-a", taskId: "task-preview-a", attemptId: "attempt-preview-a", kind: "assistant", text: "## 已完成初步核查\n\n| 检查项 | 结果 |\n| --- | --- |\n| 来源一致性 | 已核对 |\n| 第二条规则 | 等待进一步确认 |\n\n正在整理证据，稍后提交完整结果。", status: "running", createdAt: Date.now() }], hasEarlierEvents: false, droppedEvents: 0,
};
const previewControls = new Map<string, unknown>();
const historicalTeam: TeamView = structuredClone(previewTeam);
historicalTeam.runId = "history-run";
historicalTeam.createdAt -= 86400000;
historicalTeam.closed = true; historicalTeam.live = false; historicalTeam.closeReason = "历史协作已结束";
historicalTeam.agents.forEach((agent) => { agent.state = "closed"; agent.name = `历史${agent.name}`; });
historicalTeam.tasks.forEach((task) => { task.state = "accepted"; });
historicalTeam.attempts.forEach((attempt) => { attempt.state = "submitted"; attempt.result = "历史验收完成。"; });
historicalTeam.events.forEach((event) => { event.status = "completed"; });
if (collaborationScenario && new URLSearchParams(location.search).get("updates") === "1") {
  const output = previewTeam.events.find((event) => event.kind === "assistant")!;
  output.text = Array.from({ length: 16 }, (_, index) => `### 已保存阶段 ${index + 1}\n\n${"核对证据和任务边界，生成更新期间可以向上阅读。".repeat(5)}\n\n`).join("") + output.text;
  let count = 0;
  const timer = window.setInterval(() => {
    output.text += `\n\n### 实时更新 ${++count}\n\n正在核对第 ${count} 组证据，成员保持同一执行身份。`;
    if (count >= 60) { clearInterval(timer); output.status = "completed"; previewTeam.tasks[0].state = "submitted"; previewTeam.tasks[0].version++; previewTeam.agents[0].state = "idle"; previewTeam.attempts[0].state = "submitted"; previewTeam.attempts[0].result = output.text; }
  }, 500);
}

function executePreviewPrompt(args: any) {
      const conversation = conversations.find((item) => item.id === args.request.conversationId)!;
      if (scrollScenario) {
        return new Promise((resolve) => {
          let index = 0; let output = "";
          const traces: unknown[] = [];
          const timer = window.setInterval(() => {
            index++;
            const delta = index === 1 ? "# 流式回答\n\n| 批次 | 结果 |\n| --- | --- |\n" : index <= 20 ? `| ${index - 1} | 核对完成，金额 720 |\n` : `\n\n### 追加段落 ${index}\n\n${"流式内容持续生成，向上滚动应保持阅读位置。".repeat(4)}`;
            output += delta;
            if (index === 1) {
              emit({ conversationId: conversation.id, requestId: args.request.requestId, category: "message", event: "text_block_end", activityId: `${args.request.requestId}-text-1:0`, action: "commentary", activityState: "completed", text: "我先核对 **订单和规则**，再整理结论。\n\n- 读取 `orders.csv`\n- 交叉验证有效金额" });
              emit({ conversationId: conversation.id, requestId: args.request.requestId, category: "tool", event: "started", tool: "read", text: "正在读取 orders.csv" });
            }
            if (index === 3) emit({ conversationId: conversation.id, requestId: args.request.requestId, category: "tool", event: "ended", tool: "read", text: "读取已完成" });
            emit({ conversationId: conversation.id, requestId: args.request.requestId, category: "message", event: "text_block_delta", activityId: `${args.request.requestId}-text-2:0`, action: "answer", activityState: "active", text: delta });
            const trace = { ...previewTrace(index), id: `live-trace-${index}`, title: `流式记录 ${index}` };
            traces.push(trace);
            emit({ conversationId: conversation.id, requestId: args.request.requestId, category: "trace", event: "updated", traceId: trace.id, traceKind: trace.kind, traceTitle: trace.title, traceStatus: trace.status, traceSummary: trace.summary, traceStartedAt: trace.startedAt, traceMetadata: trace.metadata });
            if (index >= 120) finishPrompt?.();
          }, 500);
          finishPrompt = () => {
            window.clearInterval(timer);
            emit({ conversationId: conversation.id, requestId: args.request.requestId, category: "message", event: "text_block_end", activityId: `${args.request.requestId}-text-2:0`, action: "answer", activityState: "completed", text: output });
            conversation.messages.push({ id: crypto.randomUUID(), role: "assistant", content: output, traces, createdAt: Date.now() });
            emit({ conversationId: conversation.id, requestId: args.request.requestId, category: "turn", event: "completed" });
            resolve(structuredClone(conversation));
            finishPrompt = undefined;
          };
        });
      }
      return new Promise((resolve) => {
        finishPrompt = () => { conversation.messages.push({ id: crypto.randomUUID(), role: "assistant", content: "这是 UI 预览中的模拟回答，未调用模型。", createdAt: Date.now() }); resolve(structuredClone(conversation)); finishPrompt = undefined; };
        emit({ conversationId: conversation.id, requestId: args.request.requestId, category: "turn", event: "started" });
      });

}

const promptProtocol = previewRuns({
  conversations,
  execute(request) { const result = executePreviewPrompt({ request }); const finish = finishPrompt ?? (() => {}); return { result, finish }; },
  emit(update) { for (const [id, listener] of listeners) if (listener.event === "tao-prompt-run") callbacks.get(listener.handler)?.({ event: "tao-prompt-run", id, payload: update }); },
});

const environment = window as unknown as { __TAURI_INTERNALS__: unknown; __TAURI_EVENT_PLUGIN_INTERNALS__: unknown };
environment.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: (id: number) => listeners.delete(id) };
environment.__TAURI_INTERNALS__ = {
  transformCallback(callback: (event: unknown) => void) { callbacks.set(++callbackId, callback); return callbackId; },
  unregisterCallback(id: number) { callbacks.delete(id); },
  async invoke(command: string, args: Record<string, any> = {}) {
    if (command === "preview_context") return contextPreview(args.configuration ?? conversations.find((conversation) => conversation.id === args.conversationId)!.agentSnapshot.configuration);
    if (command === "get_conversation_context") { const conversation = conversations.find((conversation) => conversation.id === args.conversationId)!; return { snapshot: new URLSearchParams(location.search).get("context") === "missing" || conversation.id !== "preview-chat" ? null : structuredClone(initialContext), current: { profile: conversation.agentSnapshot, workspacePath: conversation.workspacePath, permissionMode: conversation.permissionMode, provider: conversation.provider, model: conversation.model } }; }
    if (command === "get_member_appearance") return { theme: settings.theme, accentColor: settings.accentColor };
    if (command === "get_collaboration") {
      if (!collaborationScenario) return { runs: [], warnings: [] };
      if (!args.runId) return { runs: [previewTeam, historicalTeam].map((team) => ({ runId: team.runId, createdAt: team.createdAt, closed: team.closed, members: team.agents.length, tasks: team.tasks.length })), warnings: [] };
      return structuredClone(args.runId === historicalTeam.runId ? historicalTeam : previewTeam);
    }
    if (command === "open_member_window") throw new Error("预览模式不创建原生窗口；独立窗口需在 Tauri 桌面验证");
    if (command === "focus_main_window") return null;
    if (command === "control_collaboration") {
      const input = args.request;
      if (previewControls.has(input.requestKey)) return previewControls.get(input.requestKey);
      const task = previewTeam.tasks.find((item) => item.id === input.taskId)!;
      const agent = previewTeam.agents.find((item) => item.id === input.agentId)!;
      if (!previewTeam.live || task.version !== input.expectedVersion) throw new Error("执行已结束或版本变化，请刷新");
      if (input.action === "message") {
        const message = { id: crypto.randomUUID(), from: "user", to: agent.id, kind: "notice", body: input.body, delivery: "queued", createdAt: Date.now(), targetAttemptId: task.attemptId ?? undefined };
        previewTeam.messages.push(message);
        setTimeout(() => { message.delivery = "delivered"; }, 700);
      }
      if (input.action === "followup") {
        const id = crypto.randomUUID();
        previewTeam.tasks.push({ ...task, id, title: input.taskName, description: input.body, state: "queued", version: 1, attemptId: `attempt-${id}` });
        previewTeam.attempts.push({ id: `attempt-${id}`, taskId: id, agentId: agent.id, generation: 1, state: "queued", result: "", error: "" });
      }
      if (input.action === "cancel_task") { task.state = "cancelled"; task.version++; agent.state = "idle"; }
      if (input.action === "cancel_agent" || input.action === "stop_run") {
        for (const member of previewTeam.agents.filter((item) => input.action === "stop_run" || item.id === agent.id)) {
          member.state = "closed"; member.retired = true;
          for (const item of previewTeam.tasks.filter((item) => item.assignedAgentId === member.id && ["running", "queued"].includes(item.state))) { item.state = "cancelled"; item.version++; }
        }
        if (input.action === "stop_run") { previewTeam.closed = true; previewTeam.live = false; previewTeam.closeReason = "用户停止整轮协作"; }
      }
      const result = { action: input.action }; previewControls.set(input.requestKey, result); return result;
    }
    if (command === "get_app_state") return structuredClone({ conversations, settings, agentCatalog: catalog, runtimeConfiguration: profiles[0].configuration, storageWarnings: [], apiKeyConfigured: true, providerAuthConfigured: { preview: true } });
    if (command === "list_models") return [{ provider: "preview", id: "tao-preview", name: "Tao Preview", reasoning: true, api: "openai-completions", contextWindow: 128000 }];
    if (command === "get_runtime_status") return { phase: "ready", running: true, ready: true, pid: 1234, sessionCount: conversations.length, startedAt: Date.now(), nodePath: "内存预览", runtimePath: "内存预览", piPath: "内存预览", lastError: null };
    if (command === "get_sandbox_status") return { available: true, image: args.image, backend: args.backend || "docker", imageId: "preview-only", error: null };
    if (command === "initialize_windows_sandbox") return { available: true, backend: "windows", preview: true, error: null };
    if (command === "prepare_session") return null;
    if (command === "list_workspace") return { rootPath: "D:/preview/project", relativePath: "", entries: [{ name: "report.md", relativePath: "report.md", kind: "file", size: previewReport.length }], changes: [], isGitRepo: false };
    if (command === "list_workspace_changes") return { workspacePath: "D:/preview/project", isGitRepository: false, entries: [] };
    if (command === "read_workspace_file") return { path: "report.md", content: previewReport, language: "markdown", size: previewReport.length };
    if (command === "plugin:event|listen") { listeners.set(callbackId, { handler: args.handler, event: args.event }); return callbackId; }
    if (command === "plugin:event|unlisten") { listeners.delete(args.eventId); return null; }
    if (command === "get_agent_catalog") return structuredClone(catalog);
    if (command === "parse_agent_catalog") return JSON.parse(args.content);
    if (command === "save_agent_catalog") { catalog = structuredClone(args.catalog); catalog.revision++; catalog.profiles.forEach((profile) => { profile.revision = Math.max(1, profile.revision); }); return structuredClone(catalog); }
    if (command === "set_workspace_agent_default") { catalog.workspaceDefaults = args.profileId ? [{ workspacePath: "d:/preview/project", profileId: args.profileId }] : []; catalog.revision++; return structuredClone(catalog); }
    if (command === "set_conversation_agent") { const conversation = conversations.find((item) => item.id === args.conversationId)!; conversation.agentSnapshot = snapshot(catalog.profiles.find((item) => item.id === args.profileId)!); return structuredClone(conversation); }
    if (command === "create_conversation" || command === "create_conversation_with_workspace") { const conversation = { ...structuredClone(conversations[0]), id: crypto.randomUUID(), title: "新对话", messages: [], promptRuns: [], agentSnapshot: snapshot(catalog.profiles.find((profile) => profile.id === catalog.defaultProfileId)!) }; conversations.push(conversation); return structuredClone(conversation); }
    if (command === "test_custom_tool") return { output: "模拟测试完成：工具输入有效。预览环境不会执行真实程序或 HTTP 请求。" };
    if (["send_message", "retry_message", "list_prompt_runs", "get_prompt_run", "cancel_prompt_run", "retry_save_prompt_run"].includes(command)) return promptProtocol.handle(command, args);
    if (command === "abort_generation") { finishPrompt?.(); return null; }
    if (command === "choose_agent_catalog" || command === "choose_workspace_directory" || command === "choose_message_files" || command.startsWith("plugin:dialog|")) return null;
    throw new Error(`UI 预览未实现命令：${command}`);
  },
};
