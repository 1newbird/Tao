import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { exec } from "node:child_process";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import readline from "node:readline";
import { promisify } from "node:util";

const startedAt = Date.now();
const argumentsByName = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  argumentsByName.set(process.argv[index], process.argv[index + 1]);
}

const piRoot = resolve(argumentsByName.get("--pi-root") ?? process.cwd());
const taoHome = resolve(argumentsByName.get("--tao-home") ?? join(process.env.USERPROFILE ?? process.cwd(), ".tao"));
const fallbackCwd = resolve(argumentsByName.get("--cwd") ?? piRoot);
const sessionsDirectory = join(taoHome, "sessions");
const sessionHandles = new Map();
const sessionCreations = new Map();
const pendingPermissions = new Map();
const DEFAULT_PERMISSION_TIMEOUT_MS = 60_000;
let shuttingDown = false;
let sdk;
let sharedModelRuntime;
const execAsync = promisify(exec);

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function response(id, success, dataOrError) {
  write(success
    ? { type: "response", id, success: true, data: dataOrError ?? null }
    : { type: "response", id, success: false, error: String(dataOrError) });
}

function emitRuntimeState() {
  write({ type: "runtime_state", pid: process.pid, sessionCount: sessionHandles.size, uptimeMs: Date.now() - startedAt });
}

function emitEvent(conversationId, requestId, category, event, text, elapsedMs, extra = {}) {
  write({
    type: "event",
    payload: {
      version: 1,
      category,
      event,
      conversationId,
      requestId: requestId ?? null,
      ...(text === undefined ? {} : { text }),
      ...(elapsedMs === undefined ? {} : { elapsedMs }),
      ...extra,
    },
  });
}

function normalizePermissionTimeoutMs(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_PERMISSION_TIMEOUT_MS;
  return Math.min(600_000, Math.max(5_000, Math.round(numeric)));
}

function nowIso() {
  return new Date().toISOString();
}

function emitTrace(handle, requestId, trace, event = "updated") {
  emitEvent(handle.conversationId, requestId, "trace", event, trace.summary, trace.elapsedMs, {
    traceId: trace.id,
    ...(trace.parentId ? { parentTraceId: trace.parentId } : {}),
    traceKind: trace.kind,
    traceStatus: trace.status,
    traceTitle: trace.title,
    ...(trace.summary ? { traceSummary: trace.summary } : {}),
    ...(trace.startedAt ? { traceStartedAt: trace.startedAt } : {}),
    ...(trace.endedAt ? { traceEndedAt: trace.endedAt } : {}),
    ...(trace.provider ? { traceProvider: trace.provider } : {}),
    ...(trace.model ? { traceModel: trace.model } : {}),
    ...(trace.tool ? { tool: trace.tool } : {}),
    ...(trace.action ? { action: trace.action } : {}),
    ...(trace.detail ? { detail: trace.detail } : {}),
    ...(trace.metadata ? { traceMetadata: trace.metadata } : {}),
  });
}

function nextTraceId(active, kind) {
  active.traceSequence += 1;
  return `${active.requestId}-${kind}-${active.traceSequence}`;
}

function addTrace(active, handle, kind, title, fields = {}) {
  const trace = {
    id: fields.id ?? nextTraceId(active, kind),
    kind,
    title: truncateDisplay(title, 120),
    status: fields.status ?? "running",
    startedAt: fields.startedAt ?? nowIso(),
    ...(fields.parentId ? { parentId: fields.parentId } : {}),
    ...(fields.summary ? { summary: truncateDisplay(fields.summary, 240) } : {}),
    ...(fields.provider ? { provider: truncateDisplay(fields.provider, 80) } : {}),
    ...(fields.model ? { model: truncateDisplay(fields.model, 120) } : {}),
    ...(fields.tool ? { tool: fields.tool } : {}),
    ...(fields.action ? { action: fields.action } : {}),
    ...(fields.detail ? { detail: truncateDisplay(fields.detail, 160) } : {}),
    ...(fields.metadata ? { metadata: fields.metadata } : {}),
  };
  active.traces.push(trace);
  emitTrace(handle, active.requestId, trace, "started");
  return trace.id;
}

function updateTrace(active, handle, traceId, patch = {}) {
  if (!active || !traceId) return false;
  const index = active.traces.findIndex((trace) => trace.id === traceId);
  if (index < 0) return false;
  const previous = active.traces[index];
  const next = {
    ...previous,
    ...patch,
    ...(patch.title === undefined ? {} : { title: truncateDisplay(patch.title, 120) }),
    ...(patch.summary === undefined ? {} : { summary: patch.summary ? truncateDisplay(patch.summary, 240) : undefined }),
    ...(patch.detail === undefined ? {} : { detail: patch.detail ? truncateDisplay(patch.detail, 160) : undefined }),
  };
  if ((patch.status === "completed" || patch.status === "error" || patch.status === "stopped") && !next.endedAt) {
    next.endedAt = nowIso();
  }
  if (next.endedAt && next.startedAt && next.elapsedMs === undefined) {
    const elapsedMs = Date.parse(next.endedAt) - Date.parse(next.startedAt);
    if (Number.isFinite(elapsedMs) && elapsedMs >= 0) next.elapsedMs = elapsedMs;
  }
  active.traces[index] = next;
  emitTrace(handle, active.requestId, next, "updated");
  return true;
}

function finishActiveTraces(active, handle, status) {
  for (const trace of active.traces) {
    if (trace.status === "running") {
      updateTrace(active, handle, trace.id, { status });
    }
  }
}

function safeUsageMetadata(usage) {
  if (!usage || typeof usage !== "object") return undefined;
  const metadata = {};
  for (const [sourceKey, targetKey] of [
    ["input", "inputTokens"],
    ["output", "outputTokens"],
    ["cacheRead", "cacheReadTokens"],
    ["cacheWrite", "cacheWriteTokens"],
    ["reasoning", "reasoningTokens"],
    ["totalTokens", "totalTokens"],
  ]) {
    if (Number.isFinite(usage[sourceKey])) metadata[targetKey] = usage[sourceKey];
  }
  if (usage.cost && typeof usage.cost === "object" && Number.isFinite(usage.cost.total)) {
    metadata.cost = Number(usage.cost.total.toFixed(6));
  }
  return Object.keys(metadata).length ? metadata : undefined;
}

function stopReasonLabel(reason) {
  if (reason === "stop") return "模型返回完成";
  if (reason === "toolUse") return "模型请求工具";
  if (reason === "length") return "达到输出长度限制";
  if (reason === "aborted") return "已停止";
  if (reason === "error") return "模型调用失败";
  if (reason === "deferred") return "模型响应已延后";
  return reason ? `结束原因：${reason}` : "模型调用结束";
}

function loadRuntimeProfile() {
  const path = join(taoHome, "runtime", "profile.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`无法读取 Runtime 配置：${error instanceof Error ? error.message : String(error)}`);
  }
}

function resourceLoaderOptions(permissionContext, profile = loadRuntimeProfile()) {
  const workingNotesPrompt = [
    "工作过程说明：当任务需要使用工具或经过多个步骤时，在下一次工具调用前用中文简短说明准备做什么；完成一个关键步骤后，如果还要继续，可以用中文简短说明刚刚确认了什么以及下一步。说明应是面向用户的简洁工作记录，不要暴露隐藏思考、原始工具参数、完整命令输出或文件内容。简单问答直接回答，不要为了显示流程而添加套话。",
  ].join("\n");
  const options = {
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  };
  if (profile?.skillsEnabled) {
    options.additionalSkillPaths = [join(taoHome, "skills")];
  }
  if (profile?.extensionsEnabled) {
    options.additionalExtensionPaths = [join(taoHome, "extensions")];
  }
  if (permissionContext) {
    options.extensionFactories = [
      createTaoPermissionExtension(
        permissionContext.conversationId,
        permissionContext.cwd,
        permissionContext.customTools,
      ),
    ];
  }
  if (!profile?.enabled) {
    return { ...options, appendSystemPrompt: [workingNotesPrompt] };
  }

  const systemPrompt = String(profile.systemPrompt ?? "").trim();
  const conversationPrompt = String(profile.conversationPrompt ?? "").trim();
  if (profile.systemPromptMode === "replace" && systemPrompt) {
    options.systemPrompt = systemPrompt;
    options.appendSystemPrompt = [workingNotesPrompt, conversationPrompt].filter(Boolean);
  } else {
    const appended = [workingNotesPrompt, systemPrompt, conversationPrompt].filter(Boolean);
    if (appended.length) options.appendSystemPrompt = appended;
  }
  return options;
}

const BUILTIN_TOOL_NAMES = ["read", "bash", "edit", "write", "grep", "find", "ls"];

function customToolSchema(configuration) {
  const fallback = {
    type: "object",
    properties: {
      input: {
        type: "string",
        description: "传给工具的输入",
      },
    },
    required: ["input"],
    additionalProperties: false,
  };
  const raw = typeof configuration?.inputSchema === "string"
    ? configuration.inputSchema.trim()
    : "";
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && parsed.type === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function customToolTemplateValue(params, key) {
  if (key === "input") return JSON.stringify(params ?? {});
  const value = params?.[key];
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

function renderCustomToolTemplate(template, params) {
  return String(template ?? "").replace(
    /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g,
    (_match, key) => customToolTemplateValue(params, key),
  );
}

function normalizeCustomToolOutput(value, maxLength = 20_000) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}\n[输出已截断]`;
}

async function executeConfiguredCustomTool(configuration, params, cwd, signal) {
  const kind = String(configuration?.kind ?? "command").toLowerCase();
  if (kind === "http") {
    const url = renderCustomToolTemplate(configuration.url, params);
    if (!url.trim()) throw new Error("自定义 HTTP 工具缺少 URL");
    let headers = {};
    if (configuration.headers?.trim()) {
      try {
        headers = JSON.parse(configuration.headers);
      } catch {
        throw new Error("自定义 HTTP 工具的请求头不是有效 JSON");
      }
    }
    const method = String(configuration.method || "GET").toUpperCase();
    const body = renderCustomToolTemplate(configuration.bodyTemplate, params);
    const response = await fetch(url, {
      method,
      headers,
      ...(body.trim() && !["GET", "HEAD"].includes(method) ? { body } : {}),
      signal,
    });
    const responseText = await response.text();
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${normalizeCustomToolOutput(responseText, 2_000)}`);
    }
    return normalizeCustomToolOutput(responseText);
  }

  const command = renderCustomToolTemplate(configuration.command, params).trim();
  if (!command) throw new Error("自定义命令工具缺少命令模板");
  const result = await execAsync(command, {
    cwd,
    windowsHide: true,
    timeout: 120_000,
    maxBuffer: 2 * 1024 * 1024,
    signal,
    env: {
      ...process.env,
      TAO_TOOL_INPUT_JSON: JSON.stringify(params ?? {}),
    },
  });
  const output = [result.stdout, result.stderr].filter((value) => value?.trim()).join("\n");
  return normalizeCustomToolOutput(output || `命令执行完成（退出码 ${result.code ?? 0}）`);
}

function configuredCustomTools(profile, cwd) {
  const configurations = Array.isArray(profile?.customTools)
    ? profile.customTools.filter((tool) => tool?.enabled && tool?.name)
    : [];
  return configurations.map((configuration) => sdk.defineTool({
    name: configuration.name,
    label: configuration.label || configuration.name,
    description: configuration.description || `Tao 自定义工具：${configuration.name}`,
    promptSnippet: configuration.description || `调用 Tao 自定义工具 ${configuration.name}`,
    parameters: customToolSchema(configuration),
    execute: async (_toolCallId, params, signal) => ({
      content: [{
        type: "text",
        text: await executeConfiguredCustomTool(configuration, params, cwd, signal),
      }],
      details: {},
    }),
  }));
}

function customToolPermissionMode(configuration) {
  const mode = String(configuration?.permissionMode ?? configuration?.permission_mode ?? "ask").toLowerCase();
  return ["ask", "allow", "deny"].includes(mode) ? mode : "ask";
}

function sessionToolSelection(profile) {
  const customTools = Array.isArray(profile?.customTools)
    ? profile.customTools.filter((tool) => tool?.enabled && tool?.name).map((tool) => tool.name)
    : [];
  if (profile?.toolMode === "custom") {
    const enabled = Array.isArray(profile.enabledTools)
      ? profile.enabledTools.filter((tool) => BUILTIN_TOOL_NAMES.includes(tool))
      : [];
    return [...new Set([...enabled, ...customTools])];
  }
  return customTools.length
    ? [...new Set(["read", "bash", "edit", "write", ...customTools])]
    : undefined;
}

function createRuntimeSettingsManager() {
  const settingsPath = join(taoHome, "settings.json");
  let userSettings = {};
  if (existsSync(settingsPath)) {
    try {
      userSettings = JSON.parse(readFileSync(settingsPath, "utf8"));
    } catch (error) {
      throw new Error(`无法读取 Pi 设置：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const providerRetry = userSettings.retry?.provider ?? {};
  return sdk.SettingsManager.inMemory({
    ...userSettings,
    retry: {
      ...(userSettings.retry ?? {}),
      provider: {
        ...providerRetry,
        timeoutMs: providerRetry.timeoutMs ?? 60_000,
        maxRetries: providerRetry.maxRetries ?? 2,
        maxRetryDelayMs: providerRetry.maxRetryDelayMs ?? 10_000,
      },
    },
    httpIdleTimeoutMs: userSettings.httpIdleTimeoutMs ?? 60_000,
  });
}

function resolveSessionCwd(command) {
  const configured = typeof command.workspacePath === "string" ? command.workspacePath.trim() : "";
  if (!configured) return fallbackCwd;
  const workspace = resolve(configured);
  if (!existsSync(workspace) || !statSync(workspace).isDirectory()) {
    throw new Error(`会话工作区目录不存在：${workspace}`);
  }
  return workspace;
}

function sessionFingerprint(command) {
  return JSON.stringify({
    provider: command.provider?.trim(),
    model: command.model?.trim(),
    thinkingLevel: command.thinkingLevel?.trim(),
    workspacePath: resolveSessionCwd(command),
    profile: loadRuntimeProfile(),
  });
}

function textPhase(block) {
  if (typeof block?.textSignature !== "string" || !block.textSignature.trim().startsWith("{")) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(block.textSignature);
    return parsed?.phase === "commentary" || parsed?.phase === "final_answer"
      ? parsed.phase
      : undefined;
  } catch {
    return undefined;
  }
}

function extractText(message, phase) {
  if (typeof message?.content === "string") return phase === "commentary" ? "" : message.content;
  if (!Array.isArray(message?.content)) return "";
  return message.content
    .filter((block) => {
      if (block?.type !== "text" || typeof block.text !== "string") return false;
      const blockPhase = textPhase(block);
      return phase === "commentary" ? blockPhase === "commentary" : blockPhase !== "commentary";
    })
    .map((block) => block.text)
    .join("");
}

function hasToolCall(message) {
  return Array.isArray(message?.content)
    && message.content.some((block) => block?.type === "toolCall");
}

function extractFinalText(message) {
  return hasToolCall(message) ? "" : extractText(message);
}

function extractPreamble(message) {
  if (hasToolCall(message)) {
    return message.content
      .filter((block) => block?.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("");
  }
  return extractText(message, "commentary");
}

function updateTextPhase(update) {
  if (!Number.isInteger(update?.contentIndex)) return undefined;
  const block = update.partial?.content?.[update.contentIndex];
  return textPhase(block);
}

function extractThinking(message) {
  if (!Array.isArray(message?.content)) return "";
  return message.content
    .filter((block) => block?.type === "thinking" && typeof block.thinking === "string")
    .map((block) => block.thinking)
    .filter((text) => text.trim())
    .join("\n\n");
}

function normalizePromptMessages(messages, metadata = {}) {
  const normalized = [];
  let skippedInitialUser = false;
  let assistantError;
  for (const message of messages) {
    if (message?.role === "user") {
      if (!skippedInitialUser) {
        skippedInitialUser = true;
        continue;
      }
      const content = extractText(message);
      if (content.trim()) normalized.push({ role: "user", content });
      continue;
    }
    if (message?.role !== "assistant") continue;
    if (message.stopReason === "error") {
      assistantError = message.errorMessage || "Pi 没有返回文本";
      continue;
    }
    const content = extractFinalText(message);
    if (content.trim() || message.stopReason === "aborted") {
      const thinking = extractThinking(message);
      normalized.push({
        role: "assistant",
        content: content.trim() ? content : "生成已停止，可以继续提问。",
        status: message.stopReason === "aborted" ? "stopped" : null,
        ...(thinking ? { thinking } : {}),
      });
    }
  }
  if (!normalized.some((message) => message.role === "assistant")) {
    throw new Error(assistantError ?? "Pi 没有返回文本");
  }
  const assistant = [...normalized].reverse().find((message) => message.role === "assistant");
  if (assistant) {
    if (metadata.durationMs !== undefined) assistant.durationMs = metadata.durationMs;
    if (Array.isArray(metadata.activities) && metadata.activities.length > 0) {
      assistant.activities = metadata.activities;
    }
    if (Array.isArray(metadata.traces) && metadata.traces.length > 0) {
      assistant.traces = metadata.traces;
    }
  }
  return normalized;
}

function truncateDisplay(value, maxLength = 120) {
  const normalized = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(1, maxLength - 1))}…`;
}

function truncatePreamble(value, maxLength = 600) {
  const normalized = typeof value === "string"
    ? value.replace(/[^\S\r\n]+/g, " ").replace(/\n{3,}/g, "\n\n").trim()
    : "";
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(1, maxLength - 1))}…`;
}

function sanitizeCommandPreview(command) {
  if (typeof command !== "string" || !command.trim()) return "";
  const firstLine = command
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return "";
  return truncateDisplay(
    firstLine
      .replace(
        /\b(api[_-]?key|token|password|secret|authorization)\s*([=:]\s*|\s+)\S+/gi,
        "$1=***",
      )
      .replace(/\b(?:sk|pk)-[A-Za-z0-9_-]{10,}\b/g, "token=***"),
  );
}

function safeToolName(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized.replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 32) || "tool";
}

function toolAction(toolName) {
  if (toolName === "read") return "read_file";
  if (toolName === "ls") return "read_directory";
  if (toolName === "find") return "search_files";
  if (toolName === "grep") return "search_content";
  if (toolName === "bash") return "execute_command";
  if (toolName === "edit") return "edit_file";
  if (toolName === "write") return "write_file";
  return "invoke_tool";
}

function toolSummaryText(summary, phase, isError = false) {
  const detail = summary.detail;
  const suffix = detail ? `：${detail}` : "";
  if (isError || phase === "failed") {
    return detail ? `操作未完成：${detail}` : "工具调用未完成";
  }
  if (phase === "ended") {
    if (summary.action === "read_file") return detail ? `已读取 ${detail}` : "文件读取完成";
    if (summary.action === "read_directory") return detail ? `已读取目录 ${detail}` : "目录读取完成";
    if (summary.action === "search_files") return "文件搜索完成";
    if (summary.action === "search_content") return "内容搜索完成";
    if (summary.action === "execute_command") return "命令执行完成";
    if (summary.action === "edit_file" || summary.action === "write_file") {
      return detail ? `已修改 ${detail}` : "文件修改完成";
    }
    return "工具调用完成";
  }
  if (summary.action === "read_file") return detail ? `正在读取 ${detail}` : "正在读取文件";
  if (summary.action === "read_directory") return detail ? `正在读取目录 ${detail}` : "正在读取目录";
  if (summary.action === "search_files") return "正在搜索文件";
  if (summary.action === "search_content") return "正在搜索内容";
  if (summary.action === "execute_command") return `正在执行命令${suffix}`;
  if (summary.action === "edit_file" || summary.action === "write_file") {
    return detail ? `正在修改 ${detail}` : "正在修改文件";
  }
  return "正在调用工具";
}

function toolSummary(handle, toolEvent, phase, isError = false) {
  const tool = safeToolName(toolEvent.toolName);
  const action = toolAction(tool);
  const rawTarget = toolEvent.args?.path
    ?? toolEvent.args?.file_path
    ?? toolEvent.args?.directory;
  const detail = action === "execute_command"
    ? sanitizeCommandPreview(toolEvent.args?.command)
    : truncateDisplay(safeDisplayPath(handle, rawTarget));
  const summary = { tool, action, detail: detail || undefined };

  return {
    ...summary,
    text: toolSummaryText(summary, phase, isError),
  };
}

function permissionId() {
  return `permission-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function displayToolLabel(toolName) {
  if (toolName === "bash") return "执行命令";
  if (toolName === "read") return "读取文件";
  if (toolName === "ls") return "读取目录";
  if (toolName === "grep") return "搜索内容";
  if (toolName === "find") return "搜索文件";
  if (toolName === "edit") return "修改文件";
  if (toolName === "write") return "写入文件";
  return "调用工具";
}

function displayRiskLabel(risk) {
  if (risk === "high") return "高风险";
  if (risk === "medium") return "需要确认";
  return "低风险";
}

function normalizePathTarget(cwd, raw) {
  if (typeof raw !== "string" || !raw.trim()) {
    return {
      raw: "",
      display: "",
      scope: "workspace",
      inWorkspace: true,
      sensitive: false,
    };
  }
  const resolved = isAbsolute(raw) ? resolve(raw) : resolve(cwd, raw);
  const workspaceReal = safeRealpath(cwd);
  const resolvedReal = existsSync(resolved) ? safeRealpath(resolved) : resolved;
  const relativePath = relative(workspaceReal, resolvedReal);
  const inWorkspace = relativePath === "" || (!!relativePath && !relativePath.startsWith("..") && !isAbsolute(relativePath));
  const display = inWorkspace
    ? (relativePath ? relativePath.replaceAll("\\", "/") : ".")
    : basename(resolvedReal);
  return {
    raw,
    resolved,
    display: truncateDisplay(display || basename(resolvedReal), 160),
    scope: inWorkspace ? "workspace" : "outside_workspace",
    inWorkspace,
    sensitive: isSensitivePath(resolvedReal, display),
  };
}

function safeRealpath(path) {
  try {
    return realpathSync.native(path);
  } catch {
    try {
      return realpathSync(path);
    } catch {
      return resolve(path);
    }
  }
}

function isSensitivePath(resolvedPath, displayPath) {
  const normalized = `${displayPath || ""}/${resolvedPath || ""}`.replaceAll("\\", "/").toLowerCase();
  return [
    "/.git/",
    ".git/",
    ".env",
    ".npmrc",
    ".pypirc",
    "id_rsa",
    "id_dsa",
    "id_ecdsa",
    "id_ed25519",
    "known_hosts",
    "credentials",
    "secrets",
    "token",
    "private_key",
  ].some((marker) => normalized.includes(marker));
}

function permissionTargetFromInput(cwd, toolName, input) {
  const raw = input?.path
    ?? input?.file_path
    ?? input?.directory
    ?? input?.dir
    ?? input?.cwd;
  if (typeof raw === "string" && raw.trim()) return normalizePathTarget(cwd, raw);
  if (toolName === "grep" || toolName === "find" || toolName === "ls") return normalizePathTarget(cwd, ".");
  return normalizePathTarget(cwd, "");
}

function classifyCommand(command) {
  const preview = sanitizeCommandPreview(command);
  const normalized = typeof command === "string" ? command.replace(/\s+/g, " ").trim() : "";
  const lower = normalized.toLowerCase();
  const systemDenyPatterns = [
    /\bsudo\b/,
    /\brunas\b/,
    /\bshutdown\b/,
    /\breboot\b/,
    /\bdiskpart\b/,
    /\bformat\s+[a-z]:/i,
    /\bbcdedit\b/,
    /\breg\s+delete\b/,
    /\btakeown\b/,
    /\bicacls\b/,
  ];
  const destructivePatterns = [
    /\brm\s+(-[a-z]*r[a-z]*f?|-[a-z]*f[a-z]*r)\b/i,
    /\brm\s+(-[a-z]*r|--recursive)\b/i,
    /\brmdir\b/i,
    /\brd\s+\/s\b/i,
    /\bdel\s+(\/s|\/q)\b/i,
    /\bremove-item\b.*\b(-recurse|-force)\b/i,
    /\bgit\s+(reset|clean)\b/i,
    /\bgit\s+checkout\b.*\s(--|\.)/i,
  ];
  const writeOrNetworkPatterns = [
    /\b(npm|pnpm|yarn|bun)\s+(install|add|remove|update|upgrade)\b/i,
    /\b(pip|pip3|uv)\s+install\b/i,
    /\bgit\s+(push|commit|merge|rebase|pull|fetch)\b/i,
    /\b(curl|wget|iwr|irm)\b/i,
    /\|\s*(sh|bash|zsh|powershell|pwsh|iex)\b/i,
    /\b(node|python|python3|ruby|perl|bash|sh|powershell|pwsh|cmd)\s+(-e|-c|\/c)\b/i,
    /(^|[^>])>\s*[^>&]/,
    /(^|[^>])>>\s*[^&]/,
    /\btee\b/i,
    /\b(chmod|chown)\b/i,
    /\b(mv|move|copy|cp)\b/i,
  ];
  const readOnlyPatterns = [
    /^\s*(pwd|cd|ls|dir)(\s|$)/i,
    /^\s*(cat|type|more|less|head|tail)\s+/i,
    /^\s*(rg|grep|find|fd)\s+/i,
    /^\s*git\s+(status|diff|log|show|branch|rev-parse)\b/i,
    /^\s*(npm|pnpm|yarn|bun)\s+(test|run\s+test|exec\s+tsc|run\s+check)\b/i,
    /^\s*(node|npm|pnpm|yarn|bun|python|python3|cargo|rustc|go|deno)\s+(--version|-v|version)\b/i,
  ];

  if (systemDenyPatterns.some((pattern) => pattern.test(lower))) {
    return {
      decision: "deny",
      risk: "high",
      reason: "命令包含系统级或提权操作，当前版本默认拒绝。",
      preview,
      scope: "system",
    };
  }
  if (destructivePatterns.some((pattern) => pattern.test(lower))) {
    return {
      decision: "ask",
      risk: "high",
      reason: "命令可能删除、回滚或覆盖文件，需要确认。",
      preview,
      scope: "destructive",
    };
  }
  if (writeOrNetworkPatterns.some((pattern) => pattern.test(lower))) {
    return {
      decision: "ask",
      risk: "medium",
      reason: "命令可能修改文件、安装依赖、访问网络或执行脚本，需要确认。",
      preview,
      scope: "command",
    };
  }
  if (readOnlyPatterns.some((pattern) => pattern.test(normalized))) {
    return {
      decision: "allow",
      risk: "low",
      reason: "看起来是只读命令，已自动允许。",
      preview,
      scope: "command",
    };
  }
  return {
    decision: "ask",
    risk: "medium",
    reason: "无法可靠判断命令影响范围，需要确认。",
    preview,
    scope: "unknown_command",
  };
}

function classifyToolPermission(cwd, toolName, input, customTools = []) {
  const safeTool = safeToolName(toolName);
  const action = toolAction(safeTool);
  const customTool = Array.isArray(customTools)
    ? customTools.find((tool) => String(tool?.name ?? "").trim().toLowerCase() === safeTool)
    : undefined;
  if (customTool) {
    const mode = customToolPermissionMode(customTool);
    const label = String(customTool.label ?? customTool.name ?? safeTool).trim() || safeTool;
    return {
      tool: safeTool,
      action: "custom_tool",
      title: label,
      decision: mode,
      risk: mode === "deny" ? "high" : "medium",
      reason: mode === "allow"
        ? "该自定义工具已配置为自动允许。"
        : mode === "deny"
          ? "该自定义工具已配置为禁止执行。"
          : "该自定义工具需要用户确认后才能执行。",
      scope: "custom_tool",
      target: label,
      canRemember: mode === "ask",
      enforcedDeny: mode === "deny",
    };
  }
  if (safeTool === "bash") {
    const command = classifyCommand(input?.command);
    return {
      tool: safeTool,
      action,
      title: "执行命令",
      decision: command.decision,
      risk: command.risk,
      reason: command.reason,
      scope: command.scope,
      commandPreview: command.preview,
      target: command.preview,
      canRemember: true,
    };
  }

  const target = permissionTargetFromInput(cwd, safeTool, input);
  if (target.sensitive) {
    return {
      tool: safeTool,
      action,
      title: displayToolLabel(safeTool),
      decision: action === "read_file" || action === "read_directory" || action === "search_files" || action === "search_content"
        ? "ask"
        : "deny",
      risk: "high",
      reason: "目标路径看起来包含密钥、环境配置或版本控制数据。",
      scope: "sensitive_path",
      target: target.display,
      canRemember: true,
    };
  }
  if (!target.inWorkspace) {
    return {
      tool: safeTool,
      action,
      title: displayToolLabel(safeTool),
      decision: "ask",
      risk: "medium",
      reason: "目标路径位于当前工作区之外，需要确认。",
      scope: "outside_workspace",
      target: target.display,
      canRemember: true,
    };
  }
  if (["read_file", "read_directory", "search_files", "search_content"].includes(action)) {
    return {
      tool: safeTool,
      action,
      title: displayToolLabel(safeTool),
      decision: "allow",
      risk: "low",
      reason: "当前工作区内的只读操作，已自动允许。",
      scope: "workspace",
      target: target.display,
      canRemember: false,
    };
  }
  if (action === "edit_file" || action === "write_file") {
    return {
      tool: safeTool,
      action,
      title: displayToolLabel(safeTool),
      decision: "ask",
      risk: "medium",
      reason: "工具将修改当前工作区文件，需要确认。",
      scope: "workspace_write",
      target: target.display,
      canRemember: true,
    };
  }
  return {
    tool: safeTool,
    action,
    title: displayToolLabel(safeTool),
    decision: "ask",
    risk: "medium",
    reason: "未知工具调用需要确认。",
    scope: "unknown_tool",
    target: target.display,
    canRemember: true,
  };
}

function permissionGrantKey(audit) {
  const identity = audit.commandPreview || audit.target || audit.tool;
  return `${audit.tool}:${audit.action}:${audit.scope}:${identity}`;
}

function permissionSummary(audit, resultText) {
  const target = audit.commandPreview || audit.target;
  return target ? `${resultText}：${target}` : resultText;
}

function emitPermissionDecisionTrace(handle, audit, status, summary) {
  const active = handle?.activeRequest;
  if (!active) return null;
  return addTrace(active, handle, "permission", "权限检查", {
    parentId: active.requestTraceId,
    status,
    summary,
    tool: audit.tool,
    action: audit.action,
    detail: audit.commandPreview || audit.target,
    metadata: {
      risk: audit.risk,
      scope: audit.scope,
      decision: audit.decision,
      reason: audit.reason,
    },
  });
}

function updatePermissionTrace(handle, traceId, audit, status, summary, decision) {
  const active = handle?.activeRequest;
  if (!active || !traceId) return;
  updateTrace(active, handle, traceId, {
    status,
    summary,
    metadata: {
      risk: audit.risk,
      scope: audit.scope,
      decision,
      reason: audit.reason,
    },
  });
}

async function resolvePermission(conversationId, cwd, audit) {
  const handle = sessionHandles.get(conversationId);
  const active = handle?.activeRequest;
  const requestId = active?.requestId ?? null;
  const grantKey = permissionGrantKey(audit);
  if (audit.enforcedDeny) {
    emitPermissionDecisionTrace(handle, audit, "error", permissionSummary(audit, "已按工具配置拒绝"));
    return { allowed: false, decision: "deny", reason: audit.reason };
  }
  if (active?.permissionMode === "full_access") {
    emitPermissionDecisionTrace(handle, audit, "completed", permissionSummary(audit, "完全访问已自动允许"));
    return { allowed: true, decision: "full_access" };
  }
  if (handle?.permissionGrants?.has(grantKey)) {
    emitPermissionDecisionTrace(handle, audit, "completed", permissionSummary(audit, "已按本会话规则允许"));
    return { allowed: true, decision: "allow_session" };
  }

  if (audit.decision === "allow") {
    emitPermissionDecisionTrace(handle, audit, "completed", permissionSummary(audit, "已自动允许"));
    return { allowed: true, decision: "allow" };
  }
  if (audit.decision === "deny") {
    emitPermissionDecisionTrace(handle, audit, "error", permissionSummary(audit, "已自动拒绝"));
    return { allowed: false, decision: "deny", reason: audit.reason };
  }
  if (!handle || !active) {
    return { allowed: false, decision: "deny", reason: "当前没有可交互确认的运行请求" };
  }

  const id = permissionId();
  const timeoutMs = normalizePermissionTimeoutMs(active.permissionTimeoutMs);
  const traceId = addTrace(active, handle, "permission", "等待权限确认", {
    parentId: active.requestTraceId,
    summary: permissionSummary(audit, "等待用户确认"),
    tool: audit.tool,
    action: audit.action,
    detail: audit.commandPreview || audit.target,
    metadata: {
      risk: audit.risk,
      scope: audit.scope,
      reason: audit.reason,
    },
  });
  emitEvent(conversationId, requestId, "permission", "requested", audit.reason, undefined, {
    permissionId: id,
    permissionTitle: audit.title,
    permissionRisk: audit.risk,
    permissionReason: audit.reason,
    permissionTarget: audit.target,
    permissionCommand: audit.commandPreview,
    permissionScope: audit.scope,
    permissionCanRemember: audit.canRemember,
    permissionTimeoutMs: timeoutMs,
    tool: audit.tool,
    action: audit.action,
    detail: audit.commandPreview || audit.target,
  });

  const decision = await waitForPermissionDecision(id, conversationId, requestId, timeoutMs);
  if (decision === "allow_session" && audit.canRemember) {
    handle.permissionGrants.add(grantKey);
  }
  const allowed = decision === "allow_once" || decision === "allow_session";
  updatePermissionTrace(
    handle,
    traceId,
    audit,
    allowed ? "completed" : "error",
    permissionSummary(audit, allowed ? "用户已允许" : "用户已拒绝"),
    decision,
  );
  emitEvent(conversationId, requestId, "permission", allowed ? "allowed" : "denied", allowed ? "用户已允许工具执行" : "用户已拒绝工具执行", undefined, {
    permissionId: id,
    tool: audit.tool,
    action: audit.action,
    detail: audit.commandPreview || audit.target,
  });
  return {
    allowed,
    decision,
    reason: allowed ? undefined : "用户拒绝执行此操作",
  };
}

function waitForPermissionDecision(id, conversationId, requestId, timeoutMs) {
  return new Promise((resolveDecision) => {
    const timer = setTimeout(() => {
      pendingPermissions.delete(id);
      emitEvent(conversationId, requestId, "permission", "denied", "权限确认超时，已拒绝执行", undefined, {
        permissionId: id,
        permissionTimeoutMs: timeoutMs,
      });
      resolveDecision("deny");
    }, timeoutMs);
    pendingPermissions.set(id, {
      conversationId,
      requestId,
      resolve: (decision) => {
        clearTimeout(timer);
        resolveDecision(decision);
      },
    });
  });
}

function resolvePendingPermission(command) {
  const id = typeof command.permissionId === "string" ? command.permissionId : "";
  const pending = pendingPermissions.get(id);
  if (!pending) return null;
  if (command.conversationId && pending.conversationId !== command.conversationId) {
    throw new Error("权限请求不属于当前会话");
  }
  const decision = ["allow_once", "allow_session", "deny"].includes(command.decision)
    ? command.decision
    : "deny";
  pendingPermissions.delete(id);
  pending.resolve(decision);
  return null;
}

function cancelPendingPermissions(conversationId, reason = "请求已取消") {
  for (const [id, pending] of pendingPermissions) {
    if (!conversationId || pending.conversationId === conversationId) {
      pendingPermissions.delete(id);
      emitEvent(pending.conversationId, pending.requestId, "permission", "denied", reason, undefined, {
        permissionId: id,
      });
      pending.resolve("deny");
    }
  }
}

function createTaoPermissionExtension(conversationId, cwd, customTools = []) {
  return {
    name: "tao-permissions",
    hidden: true,
    factory(pi) {
      pi.on("tool_call", async (event) => {
        const audit = classifyToolPermission(cwd, event.toolName, event.input, customTools);
        const result = await resolvePermission(conversationId, cwd, audit);
        if (result.allowed) return undefined;
        return { block: true, reason: `Tao 权限策略已拒绝：${result.reason ?? audit.reason}` };
      });

      pi.on("user_bash", async (event) => {
        const audit = {
          ...classifyToolPermission(event.cwd || cwd, "bash", { command: event.command }, customTools),
          title: "执行用户命令",
        };
        const result = await resolvePermission(conversationId, event.cwd || cwd, audit);
        if (result.allowed) return undefined;
        return {
          result: {
            output: `Tao 权限策略已拒绝：${result.reason ?? audit.reason}`,
            exitCode: 1,
            cancelled: false,
            truncated: false,
          },
        };
      });
    },
  };
}

function nextActivityId(active, prefix) {
  active.activitySequence += 1;
  return `${active.requestId}-${prefix}-${active.activitySequence}`;
}

function addActivity(active, kind, text, state = "active", fields = {}) {
  const textLimit = kind === "preamble" ? 600 : 180;
  const activity = {
    id: fields.id ?? nextActivityId(active, kind),
    kind,
    text: kind === "preamble" ? truncatePreamble(text, textLimit) : truncateDisplay(text, textLimit),
    state,
    ...(fields.tool ? { tool: fields.tool } : {}),
    ...(fields.action ? { action: fields.action } : {}),
    ...(fields.detail ? { detail: truncateDisplay(fields.detail) } : {}),
    ...(fields.elapsedMs === undefined ? {} : { elapsedMs: fields.elapsedMs }),
  };
  active.activities.push(activity);
  return activity.id;
}

function updateActivity(active, activityId, patch) {
  if (!active || !activityId) return false;
  const index = active.activities.findIndex((activity) => activity.id === activityId);
  if (index < 0) return false;
  active.activities[index] = {
    ...active.activities[index],
    ...patch,
    ...(patch.text === undefined
      ? {}
      : {
        text: active.activities[index].kind === "preamble"
          ? truncatePreamble(patch.text, 600)
          : truncateDisplay(patch.text, 180),
      }),
    ...(patch.detail === undefined ? {} : { detail: patch.detail ? truncateDisplay(patch.detail) : undefined }),
  };
  return true;
}

function updateLastActivity(active, kind, patch) {
  const activity = [...active.activities].reverse().find((item) => item.kind === kind && item.state === "active");
  if (!activity) return null;
  updateActivity(active, activity.id, patch);
  return activity.id;
}

function addStageNote(active, text) {
  const normalized = truncateDisplay(text, 180);
  if (!normalized) return null;
  const last = active.activities[active.activities.length - 1];
  if (last?.kind === "note" && last.text === normalized) return last.id;
  return addActivity(active, "note", normalized, "completed");
}

function preambleBlockKey(active, update) {
  const contentIndex = Number.isInteger(update?.contentIndex) ? update.contentIndex : "text";
  return `${active.messageSequence}:${contentIndex}`;
}

function upsertPreambleActivity(active, key, text, state) {
  const existing = active.preambleBlocks.get(key);
  if (existing) {
    existing.text = text;
    updateActivity(active, existing.activityId, { text, state });
    return existing;
  }
  const activityId = addActivity(active, "preamble", text, state);
  const block = { activityId, text };
  active.preambleBlocks.set(key, block);
  return block;
}

function emitPreambleActivity(handle, requestId, block, state) {
  emitEvent(
    handle.conversationId,
    requestId,
    "message",
    "preamble",
    block.text,
    undefined,
    {
      activityId: block.activityId,
      activityState: state,
    },
  );
}

function finishActiveActivities(active, state) {
  active.activities = active.activities.map((activity) =>
    activity.state === "active" ? { ...activity, state } : activity,
  );
}

function bindSessionEvents(handle) {
  return handle.runtime.session.subscribe((event) => {
    const active = handle.activeRequest;
    const requestId = active?.requestId;
    if (event.type === "agent_start") {
      if (active) addStageNote(active, "开始处理请求");
      if (active && !active.agentTraceId) {
        active.agentTraceId = addTrace(active, handle, "runtime", "Agent Loop", {
          parentId: active.requestTraceId,
          summary: "开始处理请求",
        });
      }
      emitEvent(handle.conversationId, requestId, "agent", "started");
      return;
    }
    if (event.type === "agent_end") {
      if (active?.agentTraceId) {
        updateTrace(active, handle, active.agentTraceId, {
          status: "completed",
          summary: event.willRetry ? "Agent Loop 结束，等待自动重试" : "Agent Loop 结束",
        });
      }
      emitEvent(handle.conversationId, requestId, "agent", "ended");
      return;
    }
    if (event.type === "agent_settled") {
      emitEvent(handle.conversationId, requestId, "agent", "settled");
      return;
    }
    if (event.type === "turn_start") {
      const turnIndex = active?.turnCount ?? 0;
      if (active) active.turnCount = turnIndex + 1;
      const text = turnIndex === 0
        ? "正在等待模型响应"
        : toolFollowUpStatus(active?.lastToolName);
      if (active) {
        addStageNote(active, text);
        active.currentModelTraceId = addTrace(active, handle, "model", "模型调用", {
          parentId: active.requestTraceId,
          summary: text,
          provider: active.provider,
          model: active.model,
          metadata: {
            turn: turnIndex + 1,
            thinkingLevel: active.thinkingLevel,
          },
        });
      }
      emitEvent(
        handle.conversationId,
        requestId,
        "turn",
        "started",
        text,
      );
      return;
    }
    if (event.type === "turn_end") {
      emitEvent(handle.conversationId, requestId, "turn", "ended");
      return;
    }
    if (event.type === "message_start" && active) {
      if (event.message?.role === "assistant") {
        if (!active.currentModelTraceId) {
          active.currentModelTraceId = addTrace(active, handle, "model", "模型调用", {
            parentId: active.requestTraceId,
            summary: "正在接收模型输出",
            provider: active.provider,
            model: active.model,
            metadata: {
              turn: active.turnCount,
              thinkingLevel: active.thinkingLevel,
            },
          });
        } else {
          updateTrace(active, handle, active.currentModelTraceId, { summary: "正在接收模型输出" });
        }
        active.messageSequence += 1;
        active.preambleBlocks = new Map();
        active.currentMessageThinking = false;
        const text = active.lastToolName ? toolFollowUpStatus(active.lastToolName) : "正在生成回答";
        addStageNote(active, text);
        emitEvent(
          handle.conversationId,
          requestId,
          "runtime",
          "status",
          text,
        );
      }
      return;
    }
    if (event.type === "message_update" && active) {
      const update = event.assistantMessageEvent;
      if (!update) return;
      const isOutputDelta = update.type === "thinking_delta" || update.type === "text_delta";
      if (isOutputDelta && !active.firstOutputEmitted) {
        active.firstOutputEmitted = true;
        emitEvent(handle.conversationId, requestId, "metric", "first_output", undefined, Date.now() - active.startedAt);
      }
      if (update.type === "thinking_delta") {
        if (typeof update.delta !== "string") return;
        if (!active.currentMessageThinking) {
          active.currentMessageThinking = true;
          addStageNote(active, "正在思考");
          emitEvent(handle.conversationId, requestId, "runtime", "status", "正在思考");
        }
        emitEvent(handle.conversationId, requestId, "message", "thinking_delta", update.delta);
      } else if (update.type === "text_delta") {
        if (typeof update.delta !== "string") return;
        const phase = updateTextPhase(update);
        if (phase === "commentary") {
          const key = preambleBlockKey(active, update);
          const previous = active.preambleBlocks.get(key)?.text ?? "";
          const block = upsertPreambleActivity(active, key, `${previous}${update.delta}`, "active");
          emitPreambleActivity(handle, requestId, block, "active");
          return;
        }
        emitEvent(handle.conversationId, requestId, "message", "text_delta", update.delta);
      } else if (update.type === "text_end" && updateTextPhase(update) === "commentary") {
        const content = typeof update.content === "string" ? update.content : "";
        if (content.trim()) {
          const block = upsertPreambleActivity(
            active,
            preambleBlockKey(active, update),
            content,
            "completed",
          );
          emitPreambleActivity(handle, requestId, block, "completed");
        }
      }
      return;
    }
    if (event.type === "message_end" && event.message?.role === "assistant" && active) {
      if (event.message.stopReason === "aborted") active.aborted = true;
      const preamble = extractPreamble(event.message);
      if (preamble.trim()) {
        const knownPreamble = [...active.preambleBlocks.values()].map((block) => block.text).join("");
        if (knownPreamble.trim() !== preamble.trim()) {
          const activityId = addActivity(active, "preamble", preamble, "completed");
          emitEvent(
            handle.conversationId,
            requestId,
            "message",
            "preamble",
            preamble,
            undefined,
            { activityId, activityState: "completed" },
          );
        } else {
          for (const block of active.preambleBlocks.values()) {
            updateActivity(active, block.activityId, { state: "completed" });
            emitPreambleActivity(handle, requestId, block, "completed");
          }
        }
      }
      if (event.message.stopReason === "stop" || event.message.stopReason === "length" || event.message.stopReason === "aborted") {
        const text = active.aborted ? "回答已停止，正在收尾" : "回答已生成，正在保存会话";
        addStageNote(active, text);
        if (!active.saveTraceId) {
          active.saveTraceId = addTrace(active, handle, "persistence", "保存会话", {
            parentId: active.requestTraceId,
            summary: text,
          });
        }
        emitEvent(
          handle.conversationId,
          requestId,
          "message",
          "ended",
          text,
        );
      }
      if (active.currentModelTraceId) {
        updateTrace(active, handle, active.currentModelTraceId, {
          status: event.message.stopReason === "error" ? "error" : event.message.stopReason === "aborted" ? "stopped" : "completed",
          summary: stopReasonLabel(event.message.stopReason),
          ...(event.message.responseModel ? { model: event.message.responseModel } : {}),
          metadata: {
            ...(safeUsageMetadata(event.message.usage) ?? {}),
            stopReason: event.message.stopReason,
            ...(event.message.responseId ? { responseId: truncateDisplay(event.message.responseId, 80) } : {}),
          },
        });
        active.currentModelTraceId = null;
      }
      return;
    }
    if (event.type === "tool_execution_start") {
      const summary = toolSummary(handle, event, "started");
      if (active) {
        active.toolCounts[event.toolName] = (active.toolCounts[event.toolName] ?? 0) + 1;
        const activityId = addActivity(active, "tool", summary.text, "active", {
          tool: summary.tool,
          action: summary.action,
          detail: summary.detail,
        });
        active.toolDetails[event.toolCallId] = {
          ...summary,
          activityId,
          startedAt: Date.now(),
        };
        const traceId = addTrace(active, handle, "tool", `${summary.tool} 工具`, {
          parentId: active.requestTraceId,
          summary: summary.text,
          tool: summary.tool,
          action: summary.action,
          detail: summary.detail,
        });
        active.toolDetails[event.toolCallId].traceId = traceId;
        active.lastToolName = event.toolName;
        emitEvent(
          handle.conversationId,
          requestId,
          "tool",
          "started",
          summary.text,
          undefined,
          {
            activityId,
            tool: summary.tool,
            action: summary.action,
            ...(summary.detail ? { detail: summary.detail } : {}),
          },
        );
        return;
      }
      emitEvent(handle.conversationId, requestId, "tool", "started", summary.text, undefined, {
        tool: summary.tool,
        action: summary.action,
        ...(summary.detail ? { detail: summary.detail } : {}),
      });
      return;
    }
    if (event.type === "tool_execution_update") {
      const stored = active?.toolDetails?.[event.toolCallId];
      const summary = stored ?? toolSummary(handle, event, "updated");
      if (active && !stored) {
        const activityId = addActivity(active, "tool", summary.text, "active", {
          tool: summary.tool,
          action: summary.action,
          detail: summary.detail,
        });
        active.toolDetails[event.toolCallId] = { ...summary, activityId, startedAt: Date.now() };
      }
      const activityId = active?.toolDetails?.[event.toolCallId]?.activityId;
      const traceId = active?.toolDetails?.[event.toolCallId]?.traceId;
      updateActivity(active, activityId, {
        text: summary.text,
        tool: summary.tool,
        action: summary.action,
        detail: summary.detail,
        state: "active",
      });
      if (active && traceId) {
        updateTrace(active, handle, traceId, {
          summary: summary.text,
          tool: summary.tool,
          action: summary.action,
          detail: summary.detail,
        });
      }
      emitEvent(handle.conversationId, requestId, "tool", "updated", summary.text, undefined, {
        ...(activityId ? { activityId } : {}),
        tool: summary.tool,
        action: summary.action,
        ...(summary.detail ? { detail: summary.detail } : {}),
      });
      return;
    }
    if (event.type === "bash_execution_update") {
      const stored = active
        ? Object.values(active.toolDetails).reverse().find((item) => item.tool === "bash")
        : undefined;
      const text = stored?.text ?? "正在执行命令";
      updateActivity(active, stored?.activityId, { text, state: "active" });
      if (active && stored?.traceId) {
        updateTrace(active, handle, stored.traceId, { summary: text });
      }
      emitEvent(handle.conversationId, requestId, "tool", "updated", text, undefined, {
        ...(stored?.activityId ? { activityId: stored.activityId } : {}),
        ...(stored?.tool ? { tool: stored.tool } : { tool: "bash" }),
        ...(stored?.action ? { action: stored.action } : { action: "execute_command" }),
        ...(stored?.detail ? { detail: stored.detail } : {}),
      });
      return;
    }
    if (event.type === "tool_execution_end") {
      const stored = active?.toolDetails?.[event.toolCallId];
      const summary = stored
        ? {
          ...stored,
          text: toolSummaryText(stored, event.isError ? "failed" : "ended", event.isError),
        }
        : toolSummary(handle, event, event.isError ? "failed" : "ended", event.isError);
      const activityId = stored?.activityId;
      const elapsedMs = stored ? Math.max(0, Date.now() - stored.startedAt) : undefined;
      updateActivity(active, activityId, {
        text: summary.text,
        tool: stored?.tool ?? summary.tool,
        action: stored?.action ?? summary.action,
        detail: stored?.detail ?? summary.detail,
        state: event.isError ? "error" : "completed",
        ...(elapsedMs === undefined ? {} : { elapsedMs }),
      });
      if (active && stored?.traceId) {
        updateTrace(active, handle, stored.traceId, {
          status: event.isError ? "error" : "completed",
          summary: summary.text,
          tool: stored?.tool ?? summary.tool,
          action: stored?.action ?? summary.action,
          detail: stored?.detail ?? summary.detail,
          ...(elapsedMs === undefined ? {} : { elapsedMs }),
        });
      }
      if (active) delete active.toolDetails[event.toolCallId];
      emitEvent(handle.conversationId, requestId, "tool", "ended", summary.text, elapsedMs, {
        ...(activityId ? { activityId } : {}),
        tool: stored?.tool ?? summary.tool,
        action: stored?.action ?? summary.action,
        ...((stored?.detail ?? summary.detail) ? { detail: stored?.detail ?? summary.detail } : {}),
      });
      return;
    }
    if (event.type === "compaction_start") {
      const activityId = active ? addActivity(active, "context", "正在整理上下文") : undefined;
      if (active) {
        active.contextTraceId = addTrace(active, handle, "context", "整理上下文", {
          parentId: active.requestTraceId,
          summary: "正在整理上下文",
          metadata: { reason: event.reason ?? "unknown" },
        });
      }
      emitEvent(handle.conversationId, requestId, "context", "compaction_started", "正在整理上下文", undefined, {
        ...(activityId ? { activityId } : {}),
      });
      return;
    }
    if (event.type === "compaction_end") {
      const text = event.aborted ? "上下文整理已停止" : "上下文整理完成";
      const activityId = active
        ? updateLastActivity(active, "context", {
          text,
          state: event.aborted ? "error" : "completed",
        })
        : null;
      if (active?.contextTraceId) {
        updateTrace(active, handle, active.contextTraceId, {
          status: event.aborted || event.errorMessage ? "error" : "completed",
          summary: event.errorMessage ? truncateDisplay(event.errorMessage, 180) : text,
          metadata: {
            reason: event.reason ?? "unknown",
            ...(event.result?.tokensBefore ? { tokensBefore: event.result.tokensBefore } : {}),
            ...(event.result?.estimatedTokensAfter ? { estimatedTokensAfter: event.result.estimatedTokensAfter } : {}),
            ...(safeUsageMetadata(event.result?.usage) ?? {}),
          },
        });
        active.contextTraceId = null;
      }
      emitEvent(handle.conversationId, requestId, "context", "compaction_ended", text, undefined, {
        ...(activityId ? { activityId } : {}),
      });
      return;
    }
    if (event.type === "auto_retry_start") {
      const text = `模型响应较慢，正在重试（${event.attempt}/${event.maxAttempts}）`;
      const activityId = active ? addActivity(active, "retry", text) : undefined;
      if (active) {
        active.retryTraceId = addTrace(active, handle, "retry", "自动重试", {
          parentId: active.requestTraceId,
          summary: text,
          metadata: {
            attempt: event.attempt,
            maxAttempts: event.maxAttempts,
            delayMs: event.delayMs,
            error: truncateDisplay(event.errorMessage, 180),
          },
        });
      }
      emitEvent(handle.conversationId, requestId, "retry", "started", text, undefined, {
        ...(activityId ? { activityId } : {}),
      });
      return;
    }
    if (event.type === "auto_retry_end") {
      const text = event.success ? "重试成功" : "模型服务暂时不可用";
      const activityId = active
        ? updateLastActivity(active, "retry", {
          text,
          state: event.success ? "completed" : "error",
        })
        : null;
      if (active?.retryTraceId) {
        updateTrace(active, handle, active.retryTraceId, {
          status: event.success ? "completed" : "error",
          summary: event.finalError ? truncateDisplay(event.finalError, 180) : text,
          metadata: {
            attempt: event.attempt,
            ...(event.finalError ? { error: truncateDisplay(event.finalError, 180) } : {}),
          },
        });
        active.retryTraceId = null;
      }
      emitEvent(handle.conversationId, requestId, "retry", "ended", text, undefined, {
        ...(activityId ? { activityId } : {}),
      });
      return;
    }
    if (event.type === "queue_update") {
      const steering = Array.isArray(event.steering) ? event.steering.length : 0;
      const followUp = Array.isArray(event.followUp) ? event.followUp.length : 0;
      emitEvent(handle.conversationId, requestId, "queue", "updated", `调整队列 ${steering} · 后续队列 ${followUp}`);
    }
  });
}

function toolFollowUpStatus(toolName) {
  if (toolName === "read") return "正在根据读取结果整理回答";
  if (toolName === "ls") return "正在根据目录结果整理回答";
  if (toolName === "find") return "正在根据文件搜索结果整理回答";
  if (toolName === "grep") return "正在根据内容搜索结果整理回答";
  if (toolName === "bash") return "正在根据命令结果整理回答";
  if (toolName === "edit" || toolName === "write") return "正在根据修改结果整理回答";
  return "正在根据工具结果整理回答";
}

function buildAttachmentPrompt(command) {
  const attachments = Array.isArray(command.attachments)
    ? command.attachments.filter((attachment) => typeof attachment?.path === "string" && attachment.path.trim())
    : [];
  const message = typeof command.message === "string" ? command.message.trim() : "";
  if (!attachments.length) return message;

  const references = attachments.map((attachment) => {
    const path = attachment.path.replace(/\r?\n/g, " ").trim();
    const name = String(attachment.name ?? basename(path)).replace(/\r?\n/g, " ").trim();
    return `- ${name}: ${path}`;
  }).join("\n");
  const instruction = [
    "[Tao 附件]",
    references,
    "请按需使用 read 工具读取附件内容，再回答用户问题。不要假设尚未读取的附件内容。",
  ].join("\n");
  return [message || "请处理以下附件。", instruction].join("\n\n");
}

function safeDisplayPath(handle, raw) {
  if (typeof raw !== "string" || !raw.trim()) return "";
  const resolved = isAbsolute(raw) ? resolve(raw) : resolve(handle.cwd, raw);
  const relativePath = relative(handle.cwd, resolved);
  return relativePath && !relativePath.startsWith("..") && !isAbsolute(relativePath)
    ? relativePath.replaceAll("\\", "/")
    : basename(resolved);
}

async function disposeSession(conversationId) {
  cancelPendingPermissions(conversationId, "会话已关闭，权限请求已取消");
  const pending = sessionCreations.get(conversationId);
  if (pending) {
    try {
      await pending.promise;
    } catch {
      // A failed creation has no live session to dispose.
    }
  }
  const handle = sessionHandles.get(conversationId);
  if (!handle) return;
  sessionHandles.delete(conversationId);
  handle.unsubscribe?.();
  try {
    await handle.runtime.session.abort();
  } finally {
    await handle.runtime.dispose();
  }
  emitRuntimeState();
}

async function createSession(command, fingerprint) {
  const effectiveProvider = command.provider?.trim();
  const modelId = command.model?.trim();
  const thinkingLevel = command.thinkingLevel?.trim() || "medium";
  if (!effectiveProvider || !modelId) throw new Error("会话缺少 Provider 或 Model");

  const model = sharedModelRuntime.getModel(effectiveProvider, modelId);
  if (!model) throw new Error(`找不到模型：${effectiveProvider}/${modelId}`);

  const sessionCwd = resolveSessionCwd(command);
  const profile = loadRuntimeProfile() ?? {};
  const selectedTools = sessionToolSelection(profile);
  const customTools = configuredCustomTools(profile, sessionCwd);
  const sessionFile = join(sessionsDirectory, `${command.conversationId}.jsonl`);
  const sessionManager = sdk.SessionManager.open(sessionFile, sessionsDirectory, sessionCwd);
  const createRuntime = async ({ cwd, agentDir, sessionManager: manager, sessionStartEvent }) => {
    // Pi's in-memory settings manager retains the user's configured values
    // while applying Tao's request protection without writing settings.json.
    const settingsManager = createRuntimeSettingsManager();
    const resourceLoader = new sdk.DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      ...resourceLoaderOptions({
        conversationId: command.conversationId,
        cwd,
        customTools: profile.customTools,
      }, profile),
    });
    await resourceLoader.reload();
    const services = { cwd, agentDir, modelRuntime: sharedModelRuntime, settingsManager, resourceLoader, diagnostics: [] };
    const created = await sdk.createAgentSessionFromServices({
      services,
      sessionManager: manager,
      sessionStartEvent,
      model,
      thinkingLevel,
      ...(selectedTools ? { tools: selectedTools } : {}),
      ...(customTools.length ? { customTools } : {}),
    });
    return { ...created, services, diagnostics: [] };
  };

  const runtime = await sdk.createAgentSessionRuntime(createRuntime, {
    cwd: sessionCwd,
    agentDir: taoHome,
    sessionManager,
  });
  const handle = {
    conversationId: command.conversationId,
    fingerprint,
    cwd: sessionCwd,
    runtime,
    activeRequest: null,
    permissionGrants: new Set(),
    unsubscribe: null,
  };
  handle.unsubscribe = bindSessionEvents(handle);
  sessionHandles.set(command.conversationId, handle);
  emitRuntimeState();
  return handle;
}

async function testConfiguredCustomTool(command) {
  const configuration = command.tool;
  if (!configuration || typeof configuration !== "object") {
    throw new Error("缺少自定义工具配置");
  }
  if (customToolPermissionMode(configuration) === "deny") {
    throw new Error("该工具的权限模式为“禁止执行”，无法进行测试");
  }
  const cwd = resolveSessionCwd({ workspacePath: command.workspacePath });
  let input = {};
  if (typeof command.input === "string" && command.input.trim()) {
    try {
      input = JSON.parse(command.input);
    } catch {
      input = { input: command.input };
    }
  }
  const output = await executeConfiguredCustomTool(configuration, input, cwd);
  return {
    output,
    tool: configuration.name || "custom_tool",
  };
}

async function ensureSession(command) {
  const fingerprint = sessionFingerprint(command);
  const existing = sessionHandles.get(command.conversationId);
  if (existing?.fingerprint === fingerprint) return existing;
  const creating = sessionCreations.get(command.conversationId);
  if (creating?.fingerprint === fingerprint) return creating.promise;
  if (existing) await disposeSession(command.conversationId);

  const promise = createSession(command, fingerprint);
  sessionCreations.set(command.conversationId, { fingerprint, promise });
  try {
    return await promise;
  } finally {
    if (sessionCreations.get(command.conversationId)?.promise === promise) sessionCreations.delete(command.conversationId);
  }
}

async function prepareSession(command) {
  const started = Date.now();
  await ensureSession(command);
  emitEvent(command.conversationId, command.requestId, "metric", "ready", undefined, Date.now() - started);
  return { conversationId: command.conversationId };
}

async function cancelActiveRequest(command) {
  const handle = sessionHandles.get(command.conversationId);
  if (!handle?.activeRequest) return null;
  cancelPendingPermissions(command.conversationId, "请求已停止，权限确认已取消");
  handle.activeRequest.aborted = true;
  try {
    await handle.runtime.session.abort();
  } catch {
    // The original prompt may have settled between the check and abort.
  }
  const started = Date.now();
  while (handle.activeRequest && Date.now() - started < 5_000) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (handle.activeRequest) {
    await disposeSession(command.conversationId);
  }
  return null;
}

async function promptSession(command) {
  const readyStarted = Date.now();
  emitEvent(command.conversationId, command.requestId, "runtime", "status", "正在连接会话…");
  const handle = await ensureSession(command);
  emitEvent(command.conversationId, command.requestId, "metric", "ready", undefined, Date.now() - readyStarted);
  if (handle.activeRequest) throw new Error("当前会话正在生成，请使用追加消息");

  const startedAt = Date.now();
  const startIndex = handle.runtime.session.messages.length;
  handle.activeRequest = {
    requestId: command.requestId,
    startedAt,
    provider: command.provider,
    model: command.model,
    thinkingLevel: command.thinkingLevel,
    permissionMode: command.permissionMode === "full_access" ? "full_access" : "ask",
    permissionTimeoutMs: normalizePermissionTimeoutMs(command.permissionTimeoutMs),
    firstOutputEmitted: false,
    aborted: false,
    turnCount: 0,
    toolCounts: {},
    toolDetails: {},
    lastToolName: null,
    currentMessageThinking: false,
    messageSequence: 0,
    preambleBlocks: new Map(),
    activitySequence: 0,
    activities: [],
    traceSequence: 0,
    traces: [],
    requestTraceId: null,
    agentTraceId: null,
    currentModelTraceId: null,
    retryTraceId: null,
    contextTraceId: null,
    saveTraceId: null,
  };
  handle.activeRequest.requestTraceId = addTrace(handle.activeRequest, handle, "request", "本轮请求", {
    summary: "请求已进入 Runtime",
    provider: command.provider,
    model: command.model,
    metadata: {
      requestId: command.requestId,
      conversationId: command.conversationId,
      cwd: handle.cwd,
      api: command.api,
      thinkingLevel: command.thinkingLevel,
    },
  });
  const slowResponseTimer = setTimeout(() => {
    if (handle.activeRequest?.requestId === command.requestId && !handle.activeRequest.firstOutputEmitted) {
      emitEvent(command.conversationId, command.requestId, "runtime", "status", "模型响应较慢，仍在等待首包");
    }
  }, 8_000);
  emitEvent(command.conversationId, command.requestId, "runtime", "status", "正在连接模型");
  try {
    await handle.runtime.session.prompt(buildAttachmentPrompt(command), { source: "rpc" });
    const activeRequest = handle.activeRequest;
    const durationMs = Date.now() - startedAt;
    const activityState = activeRequest.aborted ? "error" : "completed";
    finishActiveActivities(activeRequest, activityState);
    if (activeRequest.saveTraceId) {
      updateTrace(activeRequest, handle, activeRequest.saveTraceId, {
        status: activeRequest.aborted ? "stopped" : "completed",
        summary: activeRequest.aborted ? "停止状态已保存" : "会话已保存",
      });
      activeRequest.saveTraceId = null;
    }
    if (activeRequest.requestTraceId) {
      updateTrace(activeRequest, handle, activeRequest.requestTraceId, {
        status: activeRequest.aborted ? "stopped" : "completed",
        summary: activeRequest.aborted ? "请求已停止" : "请求完成",
        elapsedMs: durationMs,
      });
    }
    finishActiveTraces(activeRequest, handle, activeRequest.aborted ? "stopped" : "completed");
    const messages = normalizePromptMessages(handle.runtime.session.messages.slice(startIndex), {
      durationMs,
      activities: activeRequest.activities,
      traces: activeRequest.traces,
    });
    emitEvent(command.conversationId, command.requestId, "turn", activeRequest.aborted ? "aborted" : "completed");
    emitEvent(command.conversationId, command.requestId, "metric", "completed", undefined, durationMs);
    return { messages };
  } catch (error) {
    const message = formatRuntimeError(error);
    if (handle.activeRequest) {
      if (handle.activeRequest.requestTraceId) {
        updateTrace(handle.activeRequest, handle, handle.activeRequest.requestTraceId, {
          status: "error",
          summary: message,
          elapsedMs: Date.now() - startedAt,
        });
      }
      finishActiveTraces(handle.activeRequest, handle, "error");
    }
    emitEvent(command.conversationId, command.requestId, "error", "runtime", message);
    // The RPC response is persisted and shown in the UI after this point.
    // Keep provider internals, stack traces, and gateway payloads inside Node.
    throw new Error(message);
  } finally {
    clearTimeout(slowResponseTimer);
    handle.activeRequest = null;
  }
}

function formatRuntimeError(error) {
  const raw = error instanceof Error ? error.message : String(error);
  const normalized = raw.replace(/\s+/g, " ").trim();
  if (/timeout|timed out|超时|idle/i.test(normalized)) return "模型服务响应超时，请稍后重试";
  if (/overloaded|429|502|503|504|temporarily unavailable/i.test(normalized)) return "模型服务暂时不可用，请稍后再试";
  return normalized.split("\n", 1)[0].slice(0, 240) || "模型请求失败，请稍后重试";
}

async function dispatch(command) {
  switch (command.type) {
    case "ping":
    case "get_status":
      return { pid: process.pid, startedAt, uptimeMs: Date.now() - startedAt, sessionCount: sessionHandles.size };
    case "prepare_session":
      return prepareSession(command);
    case "test_custom_tool":
      return testConfiguredCustomTool(command);
    case "prompt":
      return promptSession(command);
    case "cancel_active":
      return cancelActiveRequest(command);
    case "permission_response":
      return resolvePendingPermission(command);
    case "abort": {
      const handle = sessionHandles.get(command.conversationId);
      if (!handle) throw new Error("当前会话尚未创建");
      if (!handle.activeRequest) throw new Error("当前会话没有正在生成的消息");
      cancelPendingPermissions(command.conversationId, "请求已停止，权限确认已取消");
      handle.activeRequest.aborted = true;
      await handle.runtime.session.abort();
      return null;
    }
    case "steer": {
      const handle = sessionHandles.get(command.conversationId);
      if (!handle) throw new Error("当前会话尚未创建");
      if (!handle.activeRequest) throw new Error("当前会话没有正在生成的消息，不能追加调整");
      await handle.runtime.session.steer(command.message);
      return null;
    }
    case "follow_up": {
      const handle = sessionHandles.get(command.conversationId);
      if (!handle) throw new Error("当前会话尚未创建");
      if (!handle.activeRequest) throw new Error("当前会话没有正在生成的消息，不能排队后续消息");
      await handle.runtime.session.followUp(command.message);
      return null;
    }
    case "close_session":
      await disposeSession(command.conversationId);
      return null;
    default:
      throw new Error(`未知 Runtime 命令：${command.type}`);
  }
}

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  cancelPendingPermissions(null, "Runtime 已关闭，权限请求已取消");
  await Promise.allSettled([...sessionHandles.keys()].map(disposeSession));
  write({ type: "stopping" });
  process.exit(0);
}

try {
  const sdkEntry = pathToFileURL(join(piRoot, "packages", "coding-agent", "src", "index.ts")).href;
  sdk = await import(sdkEntry);
  sharedModelRuntime = await sdk.ModelRuntime.create({ authPath: join(taoHome, "auth.json"), modelsPath: join(taoHome, "models.json") });
  await sharedModelRuntime.refresh({ allowNetwork: false });
  write({ type: "ready", pid: process.pid, startedAt, sessionCount: 0 });
} catch (error) {
  write({ type: "fatal", message: error instanceof Error ? error.stack ?? error.message : String(error) });
  process.exit(1);
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  let command;
  try {
    command = JSON.parse(line);
  } catch {
    write({ type: "error", message: "invalid runtime command" });
    return;
  }

  if (command.type === "shutdown") {
    void shutdown();
    return;
  }
  void dispatch(command)
    .then((data) => response(command.id, true, data))
    .catch((error) => response(command.id, false, error instanceof Error ? error.message : String(error)));
});

process.stdin.on("end", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
