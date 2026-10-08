import { CSSProperties, FormEvent, Fragment, KeyboardEvent as ReactKeyboardEvent, ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { save } from "@tauri-apps/plugin-dialog";
import "./App.css";

type MessageRole = "user" | "assistant" | "error";

interface Message {
  id: string;
  role: MessageRole;
  content: string;
  createdAt: number;
  status?: string;
  retry?: RetryConfiguration;
  thinking?: string;
  durationMs?: number;
  activities?: ActivityItem[];
  traces?: TraceItem[];
  attachments?: AttachmentReference[];
}

interface AttachmentReference {
  path: string;
  name: string;
  extension: string;
  size: number;
}

interface RetryConfiguration {
  provider: string;
  model: string;
  baseUrl: string;
  api: AppSettings["api"];
  thinkingLevel: AppSettings["thinkingLevel"];
}

type PermissionMode = "ask" | "full_access";

interface Conversation {
  id: string;
  title: string;
  provider: string;
  model: string;
  thinkingLevel: AppSettings["thinkingLevel"];
  permissionMode: PermissionMode;
  createdAt: number;
  updatedAt: number;
  pinned: boolean;
  workspacePath: string;
  workspaceName: string;
  messages: Message[];
}

interface AppSettings {
  provider: string;
  model: string;
  baseUrl: string;
  api: "openai-completions" | "openai-responses";
  thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  permissionTimeoutMs: number;
  accentColor: AccentColor;
  theme: ThemeMode;
  providers: ProviderProfile[];
}

interface ProviderModel {
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow?: number;
  maxTokens?: number;
}

interface ProviderProfile {
  id: string;
  name: string;
  baseUrl: string;
  api: AppSettings["api"];
  models: ProviderModel[];
}

interface AppState {
  conversations: Conversation[];
  settings: AppSettings;
  runtimeConfiguration: RuntimeConfiguration;
  apiKeyConfigured: boolean;
  providerAuthConfigured: Record<string, boolean>;
}

interface RuntimeConfiguration {
  enabled: boolean;
  systemPromptMode: "append" | "replace";
  systemPrompt: string;
  conversationPrompt: string;
  toolMode: "default" | "custom";
  enabledTools: string[];
  skillsEnabled: boolean;
  extensionsEnabled: boolean;
  customTools: CustomToolConfiguration[];
}

interface CustomToolConfiguration {
  id: string;
  name: string;
  label: string;
  description: string;
  kind: "command" | "http";
  enabled: boolean;
  permissionMode: CustomToolPermissionMode;
  command: string;
  method: string;
  url: string;
  headers: string;
  bodyTemplate: string;
  inputSchema: string;
}

interface SaveSettingsResult {
  settings: AppSettings;
  apiKeyConfigured: boolean;
  providerAuthConfigured: Record<string, boolean>;
}

interface ModelInfo {
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
  api: AppSettings["api"];
  contextWindow?: number;
  maxTokens?: number;
}

interface ConnectionTestResult {
  providerId: string;
  providerName: string;
  endpoint: string;
  latencyMs: number;
  models: ProviderModel[];
}

interface TestCustomToolResult {
  output: string;
}

interface ConversationConfiguration {
  provider: string;
  model: string;
  baseUrl: string;
  api: AppSettings["api"];
  thinkingLevel: AppSettings["thinkingLevel"];
  permissionMode: PermissionMode;
  permissionTimeoutMs: number;
}

interface NoticeState {
  conversationId: string | null;
  text: string;
}

interface TaoRuntimeEvent {
  version: 1;
  // Pi event names stay intact; Tao only wraps session/request routing metadata.
  category: string;
  event: string;
  conversationId: string;
  requestId: string | null;
  text?: string;
  elapsedMs?: number;
  activityId?: string;
  activityState?: ActivityState;
  tool?: string;
  action?: string;
  detail?: string;
  permissionId?: string;
  permissionTitle?: string;
  permissionRisk?: PermissionRisk;
  permissionReason?: string;
  permissionTarget?: string;
  permissionCommand?: string;
  permissionScope?: string;
  permissionCanRemember?: boolean;
  permissionTimeoutMs?: number;
  traceId?: string;
  parentTraceId?: string;
  traceKind?: TraceKind;
  traceStatus?: TraceStatus;
  traceTitle?: string;
  traceSummary?: string;
  traceStartedAt?: string;
  traceEndedAt?: string;
  traceProvider?: string;
  traceModel?: string;
  traceMetadata?: Record<string, unknown>;
}

type ActivityState = "active" | "completed" | "error";
type TraceKind = "request" | "runtime" | "model" | "tool" | "retry" | "context" | "persistence" | "queue" | "error" | string;
type TraceStatus = "running" | "completed" | "error" | "stopped";
type PermissionRisk = "low" | "medium" | "high" | string;
type PermissionDecision = "allow_once" | "allow_session" | "deny";

interface ActivityItem {
  id: string;
  kind: "note" | "tool" | "retry" | "context" | "preamble";
  text: string;
  state: ActivityState;
  tool?: string;
  action?: string;
  detail?: string;
  elapsedMs?: number;
}

interface TraceItem {
  id: string;
  kind: TraceKind;
  title: string;
  status: TraceStatus;
  parentId?: string;
  summary?: string;
  startedAt?: string;
  endedAt?: string;
  elapsedMs?: number;
  provider?: string;
  model?: string;
  tool?: string;
  action?: string;
  detail?: string;
  metadata?: Record<string, unknown>;
}

interface PermissionPrompt {
  id: string;
  conversationId: string;
  requestId: string | null;
  title: string;
  risk: PermissionRisk;
  reason: string;
  target?: string;
  command?: string;
  scope?: string;
  canRemember: boolean;
  timeoutMs?: number;
  tool?: string;
  action?: string;
}

type QueueBehavior = "steer" | "follow_up";
type ExportFormat = "markdown" | "json" | "text";
type MainView = "chat" | "customization" | "settings";
type CustomizationSection = "overview" | "prompt" | "context" | "session" | "agent" | "skills" | "extensions";
type SettingsSection = "models" | "appearance" | "language" | "data" | "runtime" | "about";
type AccentColor = "tao" | "developer" | "ocean" | "amber" | "graphite";
type ThemeMode = "light" | "dark" | "system";
type CustomToolPermissionMode = "ask" | "allow" | "deny";

const BUILTIN_TOOL_OPTIONS = [
  ["read", "读取文件"],
  ["bash", "执行命令"],
  ["edit", "编辑文件"],
  ["write", "写入文件"],
  ["grep", "搜索内容"],
  ["find", "搜索文件"],
  ["ls", "读取目录"],
] as const;

const DEFAULT_BUILTIN_TOOL_NAMES = ["read", "bash", "edit", "write"];

const ACCENT_OPTIONS: Array<{
  id: AccentColor;
  label: string;
  color: string;
  strong: string;
  soft: string;
  line: string;
}> = [
  { id: "tao", label: "Tao", color: "#5d7861", strong: "#45614a", soft: "#edf3ed", line: "#b9cbbb" },
  { id: "developer", label: "开发者绿", color: "#2f8057", strong: "#216844", soft: "#eaf5ee", line: "#a9d1b9" },
  { id: "ocean", label: "蓝青", color: "#4b7897", strong: "#345d79", soft: "#edf4f8", line: "#b6cfdf" },
  { id: "amber", label: "琥珀", color: "#a8752d", strong: "#81571e", soft: "#fff5e5", line: "#e1c797" },
  { id: "graphite", label: "石墨", color: "#555b63", strong: "#3d434b", soft: "#eef0f2", line: "#c2c7cc" },
];

const THEME_OPTIONS: Array<{
  id: ThemeMode;
  label: string;
  description: string;
}> = [
  { id: "light", label: "浅色", description: "明亮、清晰的工作界面" },
  { id: "dark", label: "深色", description: "适合长时间开发和夜间使用" },
  { id: "system", label: "跟随系统", description: "根据 Windows 外观自动切换" },
];

const DEFAULT_CUSTOM_TOOL_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    input: { type: "string", description: "传给工具的输入" },
  },
  required: ["input"],
  additionalProperties: false,
}, null, 2);

function newCustomToolConfiguration(index: number): CustomToolConfiguration {
  const suffix = index > 1 ? `_${index}` : "";
  return {
    id: `custom_tool${suffix}`,
    name: `custom_tool${suffix}`,
    label: "自定义工具",
    description: "由 Tao 调用的自定义工具。",
    kind: "command",
    enabled: true,
    permissionMode: "ask",
    command: "echo {{input}}",
    method: "GET",
    url: "",
    headers: "",
    bodyTemplate: "{{input}}",
    inputSchema: DEFAULT_CUSTOM_TOOL_SCHEMA,
  };
}

interface StreamState {
  requestId: string;
  startedAt: number;
  status: string;
  thinking: string;
  thinkingOpen: boolean;
  text: string;
  turnTextStart: number;
  activityOpen: boolean;
  activities: ActivityItem[];
  traces: TraceItem[];
  toolActive: boolean;
  completed: boolean;
  stopping: boolean;
  queued: Array<{ text: string; behavior: QueueBehavior }>;
  readyMs?: number;
  firstOutputMs?: number;
  completedMs?: number;
}

interface RuntimeTiming {
  readyMs?: number;
  firstOutputMs?: number;
  completedMs?: number;
}

interface RuntimeHostStatus {
  running: boolean;
  ready: boolean;
  pid: number | null;
  uptimeMs: number | null;
  sessionCount: number;
  lastError?: string | null;
}

type RightPanelView = "runtime" | "files";
type WorkspacePreviewMode = "file" | "diff";
type WorkspaceMarkdownViewMode = "preview" | "source";

interface WorkspaceEntry {
  name: string;
  relativePath: string;
  kind: "directory" | "file";
  size?: number;
}

interface FileChange {
  path: string;
  status: "modified" | "added" | "deleted" | "renamed" | "untracked" | string;
}

interface WorkspaceListing {
  rootPath: string;
  relativePath: string;
  entries: WorkspaceEntry[];
  changes: FileChange[];
  isGitRepo: boolean;
}

interface WorkspaceFile {
  path: string;
  content: string;
  language: string;
  size: number;
}

interface ActivityPanelProps {
  activities: ActivityItem[];
  thinking?: string;
  durationMs?: number;
  startedAt?: number;
  nowMs?: number;
  live?: boolean;
  open: boolean;
  thinkingOpen: boolean;
  onToggle: () => void;
  onToggleThinking: () => void;
}

interface TracePanelProps {
  traces: TraceItem[];
  openIds: Record<string, boolean>;
  onToggleTrace: (traceId: string) => void;
}

const SIDEBAR_MIN_WIDTH = 200;
const SIDEBAR_MAX_WIDTH = 460;
const RUNTIME_MIN_WIDTH = 360;
const RUNTIME_MAX_WIDTH = 860;
const FILES_DIRECTORY_MIN_WIDTH = 180;
const FILES_DIRECTORY_MAX_WIDTH = 360;

function clampLayoutWidth(value: number, min: number, max: number, fallback: number) {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function providerModelFromInfo(model: ModelInfo): ProviderModel {
  return {
    id: model.id,
    name: model.name,
    reasoning: model.reasoning,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  };
}

function providerProfileFor(
  settings: AppSettings,
  models: ModelInfo[],
  providerId: string,
): ProviderProfile {
  const stored = settings.providers.find((provider) => provider.id === providerId);
  const listedModels = models
    .filter((model) => model.provider === providerId)
    .map(providerModelFromInfo);
  if (stored) {
    const mergedModels = [...stored.models];
    for (const model of listedModels) {
      if (!mergedModels.some((item) => item.id === model.id)) mergedModels.push(model);
    }
    return { ...stored, models: mergedModels };
  }
  if (providerId === settings.provider) {
    return {
      id: providerId,
      name: providerId,
      baseUrl: settings.baseUrl,
      api: settings.api,
      models: listedModels,
    };
  }
  return {
    id: providerId,
    name: providerId,
    baseUrl: "",
    api: listedModels[0] ? models.find((model) => model.provider === providerId)?.api ?? "openai-completions" : "openai-completions",
    models: listedModels,
  };
}

function mergeProviderProfiles(settings: AppSettings, models: ModelInfo[]) {
  const providerIds = new Set<string>([
    settings.provider,
    ...settings.providers.map((provider) => provider.id),
    ...models.map((model) => model.provider),
  ]);
  return [...providerIds]
    .map((providerId) => providerProfileFor(settings, models, providerId))
    .sort((left, right) =>
      Number(right.id === settings.provider) - Number(left.id === settings.provider)
      || left.name.localeCompare(right.name)
      || left.id.localeCompare(right.id),
    );
}

function conversationConfiguration(
  conversation: Conversation,
  settings: AppSettings,
  models: ModelInfo[],
): ConversationConfiguration {
  const provider = providerProfileFor(settings, models, conversation.provider);
  return {
    provider: conversation.provider,
    model: conversation.model,
    baseUrl: provider.baseUrl,
    api: provider.api as AppSettings["api"],
    thinkingLevel: conversation.thinkingLevel,
    permissionMode: conversation.permissionMode ?? "ask",
    permissionTimeoutMs: settings.permissionTimeoutMs ?? 60_000,
  };
}

function upsertProviderProfile(providers: ProviderProfile[], profile: ProviderProfile) {
  const index = providers.findIndex((provider) => provider.id === profile.id);
  if (index < 0) return [...providers, profile];
  return providers.map((provider, providerIndex) => providerIndex === index ? profile : provider);
}

function sortConversations(conversations: Conversation[]) {
  return [...conversations].sort((left, right) =>
    Number(right.pinned) - Number(left.pinned) || right.updatedAt - left.updatedAt,
  );
}

function workspaceLabel(workspacePath: string) {
  if (!workspacePath.trim()) return "未选择工作区";
  const normalized = workspacePath.replace(/[\\/]+$/, "");
  return normalized.split(/[\\/]/).pop() || workspacePath;
}

function directoryLabel(relativePath: string) {
  return relativePath.trim() || ".";
}

function parentDirectory(relativePath: string) {
  const parts = relativePath.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

function isMarkdownPath(path: string) {
  return /\.(md|markdown|mdx)$/i.test(path);
}

function formatFileSize(size?: number) {
  if (size === undefined) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(size < 10 * 1024 ? 1 : 0)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function accentStyle(accentColor: AccentColor, theme: "light" | "dark"): CSSProperties {
  const preset = ACCENT_OPTIONS.find((option) => option.id === accentColor) ?? ACCENT_OPTIONS[0];
  return {
    "--tao-accent": preset.color,
    "--tao-accent-strong": theme === "dark" ? preset.color : preset.strong,
    "--tao-accent-soft": theme === "dark"
      ? `color-mix(in srgb, ${preset.color} 18%, #181b19)`
      : preset.soft,
    "--tao-accent-line": theme === "dark"
      ? `color-mix(in srgb, ${preset.color} 62%, #353a36)`
      : preset.line,
  } as CSSProperties;
}

function changeStatusLabel(status: string) {
  if (status === "added" || status === "untracked") return "新增";
  if (status === "deleted") return "删除";
  if (status === "renamed") return "重命名";
  return "修改";
}

function changeStatusClass(status: string) {
  if (status === "added" || status === "untracked") return "added";
  if (status === "deleted") return "deleted";
  if (status === "renamed") return "renamed";
  return "modified";
}

function WorkspaceClearIcon() {
  return <svg aria-hidden="true" viewBox="0 0 20 20"><path d="m6 6 8 8M14 6l-8 8" /></svg>;
}

function safeLinkHref(value: string) {
  try {
    const url = new URL(value);
    return ["http:", "https:", "mailto:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function formatDuration(durationMs?: number) {
  if (durationMs === undefined) return "计时中";
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  if (totalSeconds < 60) return `${totalSeconds} 秒`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes ? `${hours} 小时 ${remainingMinutes} 分` : `${hours} 小时`;
}

function activityGlyph(activity: ActivityItem) {
  if (activity.kind === "retry") return "↻";
  if (activity.kind === "context") return "·";
  if (activity.kind === "note") return "·";
  if (activity.kind === "preamble") return "·";
  if (activity.tool === "bash") return ">_";
  if (activity.tool === "ls") return "≡";
  if (activity.tool === "edit" || activity.tool === "write") return "✎";
  return "□";
}

function activityStateMark(state: ActivityState, kind: ActivityItem["kind"]) {
  if (kind === "preamble") return "";
  if (state === "completed") return "✓";
  if (state === "error") return "!";
  return "·";
}

function activityText(activity: ActivityItem) {
  if (activity.kind === "tool") {
    return activity.tool ?? "tool";
  }
  return activity.text;
}

function activityToolLabel(activity: ActivityItem) {
  if (activity.action === "execute_command" || activity.tool === "bash") {
    return { label: "[终端]", tool: activity.tool ?? "bash" };
  }
  if (activity.action === "read_file" || activity.tool === "read") {
    return { label: "[读取]", tool: "" };
  }
  if (activity.action === "read_directory" || activity.tool === "ls") {
    return { label: "[目录]", tool: "" };
  }
  if (
    activity.action === "edit_file"
    || activity.action === "write_file"
    || activity.tool === "edit"
    || activity.tool === "write"
  ) {
    return { label: "[编辑]", tool: "" };
  }
  if (
    activity.action === "search_files"
    || activity.action === "search_content"
    || activity.tool === "find"
    || activity.tool === "grep"
  ) {
    return { label: "[搜索]", tool: "" };
  }
  return { label: "[工具]", tool: activity.tool ?? "tool" };
}

function AttachmentList({ attachments }: { attachments: AttachmentReference[] }) {
  if (!attachments.length) return null;
  return (
    <div className="message-attachments" aria-label="消息附件">
      {attachments.map((attachment) => (
        <div className="message-attachment" key={`${attachment.path}-${attachment.size}`} title={attachment.path}>
          <span className="message-attachment-icon" aria-hidden="true">↗</span>
          <span className="message-attachment-name">{attachment.name}</span>
          <small>{formatFileSize(attachment.size)}</small>
        </div>
      ))}
    </div>
  );
}

function ActivityPanel({
  activities,
  thinking,
  durationMs,
  startedAt,
  nowMs,
  live = false,
  open,
  thinkingOpen,
  onToggle,
  onToggleThinking,
}: ActivityPanelProps) {
  const hasThinking = Boolean(thinking?.trim());
  if (!activities.length && !hasThinking && durationMs === undefined && startedAt === undefined) return null;
  const elapsedMs = durationMs ?? (
    startedAt !== undefined && nowMs !== undefined
      ? Math.max(0, nowMs - startedAt)
      : undefined
  );
  const thinkingAnchorIndex = activities.findIndex(
    (activity) => activity.kind === "note" && activity.text.includes("正在思考"),
  );
  const thinkingInsertAfter = thinkingAnchorIndex >= 0
    ? thinkingAnchorIndex
    : activities.length - 1;
  const renderThinking = () => (
    <li className="activity-thinking-item" key="thinking-process">
      <button
        className="activity-thinking-toggle"
        type="button"
        onClick={onToggleThinking}
        aria-expanded={thinkingOpen}
      >
        <span className={`activity-thinking-chevron ${thinkingOpen ? "open" : ""}`} aria-hidden="true">›</span>
        <span className="activity-glyph note" aria-hidden="true">·</span>
        <span>思考过程</span>
      </button>
      {thinkingOpen && <div className="activity-thinking-content">{thinking}</div>}
    </li>
  );
  return (
    <section className={`activity-panel ${live ? "live" : ""}`}>
      <button
        className="activity-toggle"
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-label={`${elapsedMs === undefined ? "工作记录" : `已工作 ${formatDuration(elapsedMs)}`}${live ? "，进行中" : ""}`}
      >
        <span className={`activity-chevron ${open ? "open" : ""}`}>›</span>
        <span className="activity-current">
          {elapsedMs === undefined ? "工作记录" : `已工作 ${formatDuration(elapsedMs)}`}
        </span>
      </button>
      {open && (
        <div className="activity-scroll">
          {(activities.length > 0 || hasThinking) && (
            <ol className="activity-list">
              {activities.map((activity, index) => (
                <Fragment key={activity.id}>
                  {activity.kind === "preamble" ? (
                    <li className={`activity-preamble ${activity.state}`}>
                      <div className="activity-preamble-text">{activityText(activity)}</div>
                    </li>
                  ) : (
                    <li className={`activity-item ${activity.state} ${activity.kind}`}>
                      <span className={`activity-glyph ${activity.tool ?? activity.kind}`} aria-hidden="true">
                        {activityGlyph(activity)}
                      </span>
                      <div className="activity-text">
                        {activity.kind === "tool" ? (
                          <div className="activity-tool-line">
                            <span className="activity-tool-prefix">{activityToolLabel(activity).label}</span>
                            {activityToolLabel(activity).tool && (
                              <span className="activity-tool-name">{activityToolLabel(activity).tool}</span>
                            )}
                            {activity.detail && <span className="activity-detail">{activity.detail}</span>}
                          </div>
                        ) : (
                          <div className="activity-label">{activityText(activity)}</div>
                        )}
                      </div>
                      <span className="activity-state-mark" aria-hidden="true">{activityStateMark(activity.state, activity.kind)}</span>
                    </li>
                  )}
                  {hasThinking && thinkingInsertAfter === index && renderThinking()}
                </Fragment>
              ))}
              {hasThinking && thinkingInsertAfter < 0 && renderThinking()}
            </ol>
          )}
        </div>
      )}
    </section>
  );
}

function formatTraceElapsed(trace: TraceItem) {
  if (trace.elapsedMs !== undefined) return `${trace.elapsedMs < 1000 ? trace.elapsedMs : (trace.elapsedMs / 1000).toFixed(1)}${trace.elapsedMs < 1000 ? "ms" : "s"}`;
  if (!trace.startedAt || !trace.endedAt) return "";
  const elapsed = Date.parse(trace.endedAt) - Date.parse(trace.startedAt);
  if (!Number.isFinite(elapsed) || elapsed < 0) return "";
  return `${elapsed < 1000 ? elapsed : (elapsed / 1000).toFixed(1)}${elapsed < 1000 ? "ms" : "s"}`;
}

function traceKindLabel(kind: TraceKind) {
  if (kind === "request") return "请求";
  if (kind === "runtime") return "Runtime";
  if (kind === "model") return "模型";
  if (kind === "tool") return "工具";
  if (kind === "permission") return "权限";
  if (kind === "retry") return "重试";
  if (kind === "context") return "上下文";
  if (kind === "persistence") return "保存";
  if (kind === "queue") return "队列";
  if (kind === "error") return "错误";
  return kind;
}

function traceStatusLabel(status: TraceStatus) {
  if (status === "running") return "进行中";
  if (status === "completed") return "完成";
  if (status === "stopped") return "已停止";
  return "失败";
}

function permissionRiskLabel(risk: PermissionRisk) {
  if (risk === "high") return "高风险";
  if (risk === "medium") return "需要确认";
  if (risk === "low") return "低风险";
  return risk || "需要确认";
}

function permissionModeLabel(mode: PermissionMode) {
  return mode === "full_access" ? "完全放行" : "询问确认";
}

function customToolPermissionModeLabel(mode: CustomToolPermissionMode) {
  if (mode === "allow") return "自动允许";
  if (mode === "deny") return "禁止执行";
  return "询问确认";
}

function permissionTimeoutSeconds(timeoutMs?: number) {
  const numeric = Number(timeoutMs);
  if (!Number.isFinite(numeric)) return 60;
  return Math.round(Math.min(600_000, Math.max(5_000, numeric)) / 1000);
}

function thinkingLevelLabel(level: AppSettings["thinkingLevel"]) {
  if (level === "off") return "关闭思考";
  if (level === "minimal") return "极简";
  if (level === "low") return "低";
  if (level === "medium") return "中";
  if (level === "high") return "高";
  if (level === "xhigh") return "极高";
  if (level === "max") return "最大";
  return level;
}

function traceFromPayload(payload: TaoRuntimeEvent): TraceItem | null {
  if (!payload.traceId || !payload.traceKind || !payload.traceTitle || !payload.traceStatus) return null;
  return {
    id: payload.traceId,
    kind: payload.traceKind,
    title: payload.traceTitle,
    status: payload.traceStatus,
    parentId: payload.parentTraceId,
    summary: payload.traceSummary ?? payload.text,
    startedAt: payload.traceStartedAt,
    endedAt: payload.traceEndedAt,
    elapsedMs: payload.elapsedMs,
    provider: payload.traceProvider,
    model: payload.traceModel,
    tool: payload.tool,
    action: payload.action,
    detail: payload.detail,
    metadata: payload.traceMetadata,
  };
}

function upsertTraceItem(items: TraceItem[], trace: TraceItem) {
  const index = items.findIndex((item) => item.id === trace.id);
  if (index < 0) return [...items, trace];
  return items.map((item, itemIndex) => itemIndex === index ? { ...item, ...trace } : item);
}

function traceMetadataRows(trace: TraceItem) {
  const rows: Array<[string, string]> = [];
  if (trace.provider) rows.push(["Provider", trace.provider]);
  if (trace.model) rows.push(["Model", trace.model]);
  if (trace.tool) rows.push(["Tool", trace.tool]);
  if (trace.action) rows.push(["Action", trace.action]);
  if (trace.detail) rows.push(["Detail", trace.detail]);
  if (trace.startedAt) rows.push(["Started", trace.startedAt]);
  if (trace.endedAt) rows.push(["Ended", trace.endedAt]);
  if (trace.metadata) {
    for (const [key, value] of Object.entries(trace.metadata)) {
      if (value === undefined || value === null || typeof value === "object") continue;
      rows.push([key, String(value)]);
    }
  }
  return rows;
}

function TracePanel({ traces, openIds, onToggleTrace }: TracePanelProps) {
  if (!traces.length) {
    return <p className="right-section-empty">当前会话还没有 Trace 事件。</p>;
  }
  return (
    <div className="trace-panel">
      {traces.map((trace) => {
        const open = openIds[trace.id] ?? trace.status === "running";
        const elapsed = formatTraceElapsed(trace);
        const rows = traceMetadataRows(trace);
        return (
          <section className={`trace-row ${trace.kind} ${trace.status}`} key={trace.id}>
            <button
              className="trace-row-header"
              type="button"
              aria-expanded={open}
              onClick={() => onToggleTrace(trace.id)}
            >
              <span className={`trace-chevron ${open ? "open" : ""}`} aria-hidden="true">›</span>
              <span className="trace-kind">{traceKindLabel(trace.kind)}</span>
              <span className="trace-title">
                <strong>{trace.title}</strong>
                {trace.summary && <small>{trace.summary}</small>}
              </span>
              <span className={`trace-status ${trace.status}`}>{traceStatusLabel(trace.status)}</span>
              {elapsed && <span className="trace-elapsed">{elapsed}</span>}
            </button>
            {open && (
              <div className="trace-details">
                <dl>
                  <div><dt>Trace ID</dt><dd>{trace.id}</dd></div>
                  {trace.parentId && <div><dt>Parent</dt><dd>{trace.parentId}</dd></div>}
                  {rows.map(([key, value]) => (
                    <div key={`${trace.id}-${key}`}>
                      <dt>{key}</dt>
                      <dd>{value}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

function renderInlineMarkdown(text: string, keyPrefix: string) {
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|~~[^~]+~~|\*[^*]+\*|_[^_]+_|\[[^\]]+\]\(([^)]+)\))/g;
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let index = 0;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index));
    const token = match[0];
    const key = `${keyPrefix}-${index++}`;
    if (token.startsWith("`")) {
      const code = token.slice(1, -1);
      nodes.push(<code className="inline-code" key={key}>{code}</code>);
    } else if (token.startsWith("**") || token.startsWith("__")) {
      nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("~~")) {
      nodes.push(<del key={key}>{token.slice(2, -2)}</del>);
    } else if (token.startsWith("*") || token.startsWith("_")) {
      nodes.push(<em key={key}>{token.slice(1, -1)}</em>);
    } else {
      const label = token.slice(1, token.indexOf("]("));
      const href = safeLinkHref(match[2] ?? "");
      nodes.push(href ? (
        <a key={key} href={href} target="_blank" rel="noreferrer">
          {label}
        </a>
      ) : label);
    }
    lastIndex = match.index + token.length;
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}

interface MarkdownContentProps {
  content: string;
  messageId: string;
  copiedKey?: string;
  onCopy: (text: string, key: string) => void;
}

function MarkdownContent({ content, messageId, copiedKey, onCopy }: MarkdownContentProps) {
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let code: { language: string; lines: string[] } | null = null;
  let blockIndex = 0;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    blocks.push(
      <p key={`${messageId}-p-${blockIndex++}`}>
        {paragraph.flatMap((line, index) => [
          ...(index ? [<br key={`${messageId}-br-${blockIndex}-${index}`} />] : []),
          ...renderInlineMarkdown(line, `${messageId}-inline-${blockIndex}-${index}`),
        ])}
      </p>,
    );
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    const ListTag = list.ordered ? "ol" : "ul";
    blocks.push(
      <ListTag key={`${messageId}-list-${blockIndex++}`}>
        {list.items.map((item, index) => (
          <li key={`${messageId}-li-${index}`}>
            {renderInlineMarkdown(item, `${messageId}-list-inline-${index}`)}
          </li>
        ))}
      </ListTag>,
    );
    list = null;
  };
  const flushCode = () => {
    if (!code) return;
    const codeText = code.lines.join("\n");
    const key = `${messageId}-code-${blockIndex++}`;
    blocks.push(
      <div className="markdown-code-block" key={key}>
        <div className="markdown-code-header">
          <span>{code.language || "code"}</span>
          <button type="button" onClick={() => onCopy(codeText, key)}>
            {copiedKey === key ? "已复制" : "复制代码"}
          </button>
        </div>
        <pre><code>{codeText}</code></pre>
      </div>,
    );
    code = null;
  };

  lines.forEach((line) => {
    const fence = line.match(/^```([A-Za-z0-9_+-]*)\s*$/);
    if (code) {
      if (fence) flushCode();
      else code.lines.push(line);
      return;
    }
    if (fence) {
      flushParagraph();
      flushList();
      code = { language: fence[1] ?? "", lines: [] };
      return;
    }
    if (!line.trim()) {
      flushParagraph();
      flushList();
      return;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      flushList();
      const HeadingTag = `h${heading[1].length}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
      blocks.push(
        <HeadingTag key={`${messageId}-heading-${blockIndex++}`}>
          {renderInlineMarkdown(heading[2], `${messageId}-heading-inline-${blockIndex}`)}
        </HeadingTag>,
      );
      return;
    }
    const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (unordered || ordered) {
      flushParagraph();
      const orderedList = Boolean(ordered);
      if (!list || list.ordered !== orderedList) {
        flushList();
        list = { ordered: orderedList, items: [] };
      }
      list.items.push((ordered?.[1] ?? unordered?.[1] ?? "").trim());
      return;
    }
    if (line.startsWith(">")) {
      flushParagraph();
      flushList();
      blocks.push(
        <blockquote key={`${messageId}-quote-${blockIndex++}`}>
          {renderInlineMarkdown(line.replace(/^>\s?/, ""), `${messageId}-quote-inline-${blockIndex}`)}
        </blockquote>,
      );
      return;
    }
    flushList();
    paragraph.push(line);
  });

  flushParagraph();
  flushList();
  flushCode();
  return <div className="markdown-content">{blocks}</div>;
}

type MarkdownTableAlignment = "left" | "center" | "right" | null;

interface WorkspaceMarkdownPreviewProps {
  content: string;
  filePath: string;
  copiedKey?: string;
  onCopy: (text: string, key: string) => void;
}

function splitMarkdownTableRow(row: string) {
  let value = row.trim();
  if (value.startsWith("|")) value = value.slice(1);
  if (value.endsWith("|")) value = value.slice(0, -1);
  const cells: string[] = [];
  let current = "";
  let escaped = false;
  for (const char of value) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "|") {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  cells.push(current.trim());
  return cells;
}

function markdownTableAlignment(cell: string): MarkdownTableAlignment {
  const normalized = cell.trim();
  if (!/^:?-{3,}:?$/.test(normalized)) return null;
  if (normalized.startsWith(":") && normalized.endsWith(":")) return "center";
  if (normalized.endsWith(":")) return "right";
  if (normalized.startsWith(":")) return "left";
  return null;
}

function isMarkdownTableDelimiter(line: string) {
  const cells = splitMarkdownTableRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

function isMarkdownHorizontalRule(line: string) {
  return /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line);
}

function renderWorkspaceInlineMarkdown(text: string, keyPrefix: string) {
  const pattern = /(!\[[^\]]*]\(([^)]+)\)|`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|~~[^~]+~~|\*[^*]+\*|_[^_]+_|\[[^\]]+]\(([^)]+)\))/g;
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let index = 0;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index));
    const token = match[0];
    const key = `${keyPrefix}-${index++}`;
    if (token.startsWith("![")) {
      const alt = token.slice(2, token.indexOf("](")).trim();
      const source = match[2] ?? "";
      nodes.push(
        <span className="workspace-md-image-placeholder" key={key}>
          <span>图片</span>
          <code>{alt ? `${alt} · ${source}` : source}</code>
        </span>,
      );
    } else if (token.startsWith("`")) {
      nodes.push(<code className="inline-code" key={key}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith("**") || token.startsWith("__")) {
      nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("~~")) {
      nodes.push(<del key={key}>{token.slice(2, -2)}</del>);
    } else if (token.startsWith("*") || token.startsWith("_")) {
      nodes.push(<em key={key}>{token.slice(1, -1)}</em>);
    } else {
      const label = token.slice(1, token.indexOf("]("));
      const href = safeLinkHref(match[3] ?? "");
      nodes.push(href ? (
        <a key={key} href={href} target="_blank" rel="noreferrer">
          {label}
        </a>
      ) : (
        <span className="workspace-md-link-text" key={key}>{label}</span>
      ));
    }
    lastIndex = match.index + token.length;
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}

function WorkspaceMarkdownPreview({ content, filePath, copiedKey, onCopy }: WorkspaceMarkdownPreviewProps) {
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let paragraph: string[] = [];
  let quote: string[] = [];
  let list: { ordered: boolean; task: boolean; items: Array<{ text: string; checked?: boolean }> } | null = null;
  let code: { language: string; lines: string[] } | null = null;
  let blockIndex = 0;

  const keyFor = (kind: string) => `workspace-md-${filePath}-${kind}-${blockIndex++}`;
  const flushParagraph = () => {
    if (!paragraph.length) return;
    const key = keyFor("p");
    blocks.push(
      <p key={key}>
        {paragraph.flatMap((line, index) => [
          ...(index ? [<br key={`${key}-br-${index}`} />] : []),
          ...renderWorkspaceInlineMarkdown(line, `${key}-inline-${index}`),
        ])}
      </p>,
    );
    paragraph = [];
  };
  const flushQuote = () => {
    if (!quote.length) return;
    const key = keyFor("quote");
    blocks.push(
      <blockquote key={key}>
        {quote.map((line, index) => (
          <p key={`${key}-line-${index}`}>
            {renderWorkspaceInlineMarkdown(line, `${key}-inline-${index}`)}
          </p>
        ))}
      </blockquote>,
    );
    quote = [];
  };
  const flushList = () => {
    if (!list) return;
    const key = keyFor("list");
    const ListTag = list.ordered ? "ol" : "ul";
    blocks.push(
      <ListTag className={list.task ? "workspace-md-task-list" : undefined} key={key}>
        {list.items.map((item, index) => (
          <li className={list?.task ? "workspace-md-task-item" : undefined} key={`${key}-item-${index}`}>
            {list?.task && (
              <input checked={Boolean(item.checked)} readOnly tabIndex={-1} type="checkbox" />
            )}
            <span>{renderWorkspaceInlineMarkdown(item.text, `${key}-inline-${index}`)}</span>
          </li>
        ))}
      </ListTag>,
    );
    list = null;
  };
  const flushCode = () => {
    if (!code) return;
    const codeText = code.lines.join("\n");
    const key = keyFor("code");
    blocks.push(
      <div className="markdown-code-block workspace-md-code-block" key={key}>
        <div className="markdown-code-header">
          <span>{code.language || "code"}</span>
          <button type="button" onClick={() => onCopy(codeText, key)}>
            {copiedKey === key ? "已复制" : "复制代码"}
          </button>
        </div>
        <pre><code>{codeText}</code></pre>
      </div>,
    );
    code = null;
  };
  const flushLooseBlocks = () => {
    flushParagraph();
    flushQuote();
    flushList();
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fence = line.match(/^```([A-Za-z0-9_+-]*)\s*$/);
    if (code) {
      if (fence) flushCode();
      else code.lines.push(line);
      continue;
    }
    if (fence) {
      flushLooseBlocks();
      code = { language: fence[1] ?? "", lines: [] };
      continue;
    }
    if (!line.trim()) {
      flushLooseBlocks();
      continue;
    }
    const nextLine = lines[index + 1] ?? "";
    if (line.includes("|") && nextLine.includes("|") && isMarkdownTableDelimiter(nextLine)) {
      flushLooseBlocks();
      const headers = splitMarkdownTableRow(line);
      const alignments = splitMarkdownTableRow(nextLine).map(markdownTableAlignment);
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && lines[index].trim() && lines[index].includes("|")) {
        const row = splitMarkdownTableRow(lines[index]);
        rows.push(headers.map((_, cellIndex) => row[cellIndex] ?? ""));
        index += 1;
      }
      index -= 1;
      const key = keyFor("table");
      blocks.push(
        <div className="workspace-md-table-wrap" key={key}>
          <table>
            <thead>
              <tr>
                {headers.map((header, headerIndex) => (
                  <th
                    key={`${key}-head-${headerIndex}`}
                    style={alignments[headerIndex] ? { textAlign: alignments[headerIndex] } : undefined}
                  >
                    {renderWorkspaceInlineMarkdown(header, `${key}-head-inline-${headerIndex}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={`${key}-row-${rowIndex}`}>
                  {headers.map((_, cellIndex) => (
                    <td
                      key={`${key}-cell-${rowIndex}-${cellIndex}`}
                      style={alignments[cellIndex] ? { textAlign: alignments[cellIndex] } : undefined}
                    >
                      {renderWorkspaceInlineMarkdown(row[cellIndex] ?? "", `${key}-cell-inline-${rowIndex}-${cellIndex}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    if (isMarkdownHorizontalRule(line)) {
      flushLooseBlocks();
      blocks.push(<hr key={keyFor("hr")} />);
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      flushLooseBlocks();
      const HeadingTag = `h${heading[1].length}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
      const key = keyFor("heading");
      blocks.push(
        <HeadingTag key={key}>
          {renderWorkspaceInlineMarkdown(heading[2], `${key}-inline`)}
        </HeadingTag>,
      );
      continue;
    }
    const taskItem = line.match(/^\s*[-*+]\s+\[([ xX])]\s+(.+)$/);
    const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (taskItem || unordered || ordered) {
      flushParagraph();
      flushQuote();
      const nextList = {
        ordered: Boolean(ordered),
        task: Boolean(taskItem),
      };
      if (!list || list.ordered !== nextList.ordered || list.task !== nextList.task) {
        flushList();
        list = { ...nextList, items: [] };
      }
      list.items.push({
        text: (taskItem?.[2] ?? ordered?.[1] ?? unordered?.[1] ?? "").trim(),
        checked: taskItem ? taskItem[1].toLowerCase() === "x" : undefined,
      });
      continue;
    }
    if (line.startsWith(">")) {
      flushParagraph();
      flushList();
      quote.push(line.replace(/^>\s?/, ""));
      continue;
    }
    flushQuote();
    flushList();
    paragraph.push(line);
  }

  flushLooseBlocks();
  flushCode();
  return <div className="workspace-markdown-preview">{blocks}</div>;
}

type DiffLineKind = "meta" | "hunk" | "context" | "add" | "delete";

interface ParsedDiffLine {
  kind: DiffLineKind;
  oldLine?: number;
  newLine?: number;
  content: string;
}

interface ParsedDiffFile {
  displayPath: string;
  oldPath?: string;
  newPath?: string;
  added: number;
  removed: number;
  lines: ParsedDiffLine[];
}

interface ParsedDiff {
  files: ParsedDiffFile[];
  added: number;
  removed: number;
  structured: boolean;
}

function cleanDiffPath(value: string) {
  const trimmed = value.trim().replace(/^"|"$/g, "");
  if (!trimmed || trimmed === "/dev/null") return trimmed;
  return trimmed.replace(/^[ab]\//, "");
}

function parseDiffHeaderPath(line: string, fallbackPath: string) {
  const quoted = line.match(/^diff --git "a\/(.+)" "b\/(.+)"$/);
  if (quoted) return cleanDiffPath(quoted[2]);
  const plain = line.match(/^diff --git a\/(.+) b\/(.+)$/);
  if (plain) return cleanDiffPath(plain[2]);
  return fallbackPath;
}

function parseHunkHeader(line: string) {
  const match = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
  if (!match) return null;
  return {
    oldLine: Number(match[1]),
    newLine: Number(match[2]),
  };
}

function finalizeDiffFile(file: ParsedDiffFile, fallbackPath: string) {
  const displayPath = file.newPath && file.newPath !== "/dev/null"
    ? file.newPath
    : file.oldPath && file.oldPath !== "/dev/null"
      ? file.oldPath
      : file.displayPath || fallbackPath;
  return { ...file, displayPath };
}

function parseWorkspaceDiff(content: string, fallbackPath: string): ParsedDiff {
  const normalized = content.replace(/\r\n?/g, "\n");
  const rawLines = normalized.endsWith("\n") ? normalized.slice(0, -1).split("\n") : normalized.split("\n");
  const lines = rawLines.length === 1 && rawLines[0] === "" ? [] : rawLines;
  const files: ParsedDiffFile[] = [];
  let current: ParsedDiffFile | null = null;
  let oldLine: number | null = null;
  let newLine: number | null = null;
  let structured = false;

  const ensureFile = () => {
    if (!current) {
      current = {
        displayPath: fallbackPath,
        added: 0,
        removed: 0,
        lines: [],
      };
    }
    return current;
  };

  const pushCurrent = () => {
    if (!current) return;
    files.push(finalizeDiffFile(current, fallbackPath));
    current = null;
  };

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      structured = true;
      pushCurrent();
      current = {
        displayPath: parseDiffHeaderPath(line, fallbackPath),
        added: 0,
        removed: 0,
        lines: [{ kind: "meta", content: line }],
      };
      oldLine = null;
      newLine = null;
      continue;
    }

    const file = ensureFile();
    if (line.startsWith("--- ")) {
      structured = true;
      file.oldPath = cleanDiffPath(line.slice(4));
      file.lines.push({ kind: "meta", content: line });
      continue;
    }
    if (line.startsWith("+++ ")) {
      structured = true;
      file.newPath = cleanDiffPath(line.slice(4));
      file.lines.push({ kind: "meta", content: line });
      continue;
    }

    const hunk = parseHunkHeader(line);
    if (hunk) {
      structured = true;
      oldLine = hunk.oldLine;
      newLine = hunk.newLine;
      file.lines.push({ kind: "hunk", content: line });
      continue;
    }

    if (oldLine !== null && newLine !== null && line.startsWith("+")) {
      file.added += 1;
      file.lines.push({ kind: "add", newLine, content: line.slice(1) });
      newLine += 1;
      continue;
    }
    if (oldLine !== null && newLine !== null && line.startsWith("-")) {
      file.removed += 1;
      file.lines.push({ kind: "delete", oldLine, content: line.slice(1) });
      oldLine += 1;
      continue;
    }
    if (oldLine !== null && newLine !== null && line.startsWith(" ")) {
      file.lines.push({ kind: "context", oldLine, newLine, content: line.slice(1) });
      oldLine += 1;
      newLine += 1;
      continue;
    }

    file.lines.push({ kind: "meta", content: line });
  }

  pushCurrent();
  return {
    files,
    added: files.reduce((total, file) => total + file.added, 0),
    removed: files.reduce((total, file) => total + file.removed, 0),
    structured,
  };
}

function diffLineMarker(kind: DiffLineKind) {
  if (kind === "add") return "+";
  if (kind === "delete") return "-";
  if (kind === "context") return "";
  return "";
}

function WorkspaceDiffPreview({ content, filePath }: { content: string; filePath: string }) {
  const parsed = parseWorkspaceDiff(content, filePath);
  if (!content.trim()) {
    return <div className="diff-empty-state">当前文件暂无 Git Diff。</div>;
  }
  if (!parsed.structured || !parsed.files.length) {
    return (
      <pre className="diff-preview diff-preview-raw"><code>{content}</code></pre>
    );
  }
  return (
    <div className="workspace-diff-preview">
      <div className="diff-overview">
        <strong>{parsed.files.length > 1 ? `${parsed.files.length} 个 Diff 片段` : parsed.files[0].displayPath}</strong>
        <span>
          <b className="diff-added">+{parsed.added}</b>
          <b className="diff-removed">-{parsed.removed}</b>
        </span>
      </div>
      {parsed.files.map((file, fileIndex) => (
        <section className="diff-file-card" key={`${file.displayPath}-${fileIndex}`}>
          <div className="diff-file-header">
            <strong>{file.displayPath}</strong>
            <span>
              <b className="diff-added">+{file.added}</b>
              <b className="diff-removed">-{file.removed}</b>
            </span>
          </div>
          <div className="diff-lines" role="table" aria-label={`${file.displayPath} Diff`}>
            {file.lines.map((line, lineIndex) => (
              <div className={`diff-line ${line.kind}`} role="row" key={`${file.displayPath}-${lineIndex}`}>
                <span className="diff-line-number old" role="cell">{line.oldLine ?? ""}</span>
                <span className="diff-line-number new" role="cell">{line.newLine ?? ""}</span>
                <span className="diff-line-marker" role="cell">{diffLineMarker(line.kind)}</span>
                <code role="cell">{line.content || " "}</code>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function App() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState("");
  const [settings, setSettings] = useState<AppSettings>({
    provider: "openai",
    model: "gpt-4o-mini",
    baseUrl: "",
    api: "openai-completions",
    thinkingLevel: "medium",
    permissionTimeoutMs: 60_000,
    accentColor: "tao",
    theme: "light",
    providers: [],
  });
  const [prefersDarkTheme, setPrefersDarkTheme] = useState(() => (
    typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-color-scheme: dark)").matches
  ));
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [apiKey, setApiKey] = useState("");
  const [apiKeyConfigured, setApiKeyConfigured] = useState(false);
  const [providerAuthConfigured, setProviderAuthConfigured] = useState<Record<string, boolean>>({});
  const [apiKeys, setApiKeys] = useState<Record<string, string>>({});
  const [selectedSettingsProvider, setSelectedSettingsProvider] = useState("openai");
  const [expandedProviderId, setExpandedProviderId] = useState<string | null>("openai");
  const [providerModelSelections, setProviderModelSelections] = useState<Record<string, string>>({});
  const [providerDraft, setProviderDraft] = useState<ProviderProfile>({
    id: "openai",
    name: "openai",
    baseUrl: "",
    api: "openai-completions",
    models: [],
  });
  const [input, setInput] = useState("");
  const [queueBehavior, setQueueBehavior] = useState<QueueBehavior>("steer");
  const [preparingIds, setPreparingIds] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [startupStatus, setStartupStatus] = useState("正在打开 Tao…");
  const [generatingIds, setGeneratingIds] = useState<Record<string, boolean>>({});
  const [runtimeOpen, setRuntimeOpen] = useState(false);
  const [mainView, setMainView] = useState<MainView>("chat");
  const [customizationSection, setCustomizationSection] = useState<CustomizationSection>("overview");
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("models");
  const [runtimeConfiguration, setRuntimeConfiguration] = useState<RuntimeConfiguration>({
    enabled: true,
    systemPromptMode: "append",
    systemPrompt: "",
    conversationPrompt: "",
    toolMode: "default",
    enabledTools: [...BUILTIN_TOOL_OPTIONS.map(([name]) => name)],
    skillsEnabled: false,
    extensionsEnabled: false,
    customTools: [],
  });
  const [runtimeDraft, setRuntimeDraft] = useState(runtimeConfiguration);
  const [messageAttachments, setMessageAttachments] = useState<AttachmentReference[]>([]);
  const [customToolTestInput, setCustomToolTestInput] = useState("{}");
  const [customToolTestOutput, setCustomToolTestOutput] = useState("");
  const [testingCustomToolId, setTestingCustomToolId] = useState<string | null>(null);
  const [notice, setNotice] = useState<NoticeState>({ conversationId: null, text: "" });
  const [testingConnection, setTestingConnection] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [streams, setStreams] = useState<Record<string, StreamState>>({});
  const [timings, setTimings] = useState<Record<string, RuntimeTiming>>({});
  const [conversationSearch, setConversationSearch] = useState("");
  const [unreadIds, setUnreadIds] = useState<Record<string, boolean>>({});
  const [copiedKey, setCopiedKey] = useState<string | undefined>();
  const [clockMs, setClockMs] = useState(() => Date.now());
  const [messageActivities, setMessageActivities] = useState<Record<string, ActivityItem[]>>({});
  const [messageTraces, setMessageTraces] = useState<Record<string, TraceItem[]>>({});
  const [messageActivityOpen, setMessageActivityOpen] = useState<Record<string, boolean>>({});
  const [messageThinkingOpen, setMessageThinkingOpen] = useState<Record<string, boolean>>({});
  const [traceOpen, setTraceOpen] = useState<Record<string, boolean>>({});
  const [exportOpen, setExportOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Conversation | null>(null);
  const [deletingConversationId, setDeletingConversationId] = useState<string | null>(null);
  const [permissionRequests, setPermissionRequests] = useState<PermissionPrompt[]>([]);
  const [permissionSubmitting, setPermissionSubmitting] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [rightPanelView, setRightPanelView] = useState<RightPanelView>("runtime");
  const [filesExpanded, setFilesExpanded] = useState(false);
  const [workspaceListing, setWorkspaceListing] = useState<WorkspaceListing | null>(null);
  const [workspaceLoading, setWorkspaceLoading] = useState(false);
  const [workspaceError, setWorkspaceError] = useState("");
  const [workspaceFile, setWorkspaceFile] = useState<WorkspaceFile | null>(null);
  const [workspaceFileLoading, setWorkspaceFileLoading] = useState(false);
  const [workspaceFileError, setWorkspaceFileError] = useState("");
  const [workspacePreviewMode, setWorkspacePreviewMode] = useState<WorkspacePreviewMode>("file");
  const [workspaceMarkdownViewMode, setWorkspaceMarkdownViewMode] = useState<WorkspaceMarkdownViewMode>("preview");
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("tao.layout") ?? "{}") as { sidebarWidth?: number };
      return clampLayoutWidth(saved.sidebarWidth ?? Number.NaN, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH, 252);
    } catch {
      return 252;
    }
  });
  const [runtimeWidth, setRuntimeWidth] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("tao.layout") ?? "{}") as { runtimeWidth?: number };
      return clampLayoutWidth(saved.runtimeWidth ?? Number.NaN, RUNTIME_MIN_WIDTH, RUNTIME_MAX_WIDTH, 520);
    } catch {
      return 520;
    }
  });
  const [filesDirectoryWidth, setFilesDirectoryWidth] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("tao.layout") ?? "{}") as { filesDirectoryWidth?: number };
      return clampLayoutWidth(saved.filesDirectoryWidth ?? Number.NaN, FILES_DIRECTORY_MIN_WIDTH, FILES_DIRECTORY_MAX_WIDTH, 240);
    } catch {
      return 240;
    }
  });
  const [resizing, setResizing] = useState(false);
  const [runtimeHost, setRuntimeHost] = useState<RuntimeHostStatus>({
    running: false,
    ready: false,
    pid: null,
    uptimeMs: null,
    sessionCount: 0,
    lastError: null,
  });
  const [runtimeRecovering, setRuntimeRecovering] = useState(false);
  const initialized = useRef(false);
  const activeIdRef = useRef("");
  const streamsRef = useRef<Record<string, StreamState>>({});
  const completedActivitiesRef = useRef<Record<string, ActivityItem[]>>({});
  const completedTracesRef = useRef<Record<string, TraceItem[]>>({});
  const preparingRef = useRef(new Set<string>());
  const generatingRef = useRef(new Set<string>());
  const messagesEnd = useRef<HTMLDivElement>(null);
  const scrollFrame = useRef<number | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const resizeRef = useRef<{ side: "sidebar" | "runtime" | "directory"; startX: number; startWidth: number } | null>(null);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return undefined;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = (event: MediaQueryListEvent) => setPrefersDarkTheme(event.matches);
    media.addEventListener?.("change", handleChange);
    return () => media.removeEventListener?.("change", handleChange);
  }, []);

  useEffect(() => {
    streamsRef.current = streams;
  }, [streams]);

  function appendStreamDelta(payload: TaoRuntimeEvent) {
    const conversationId = payload.conversationId;
    const requestId = payload.requestId;
    const delta = payload.text ?? "";
    if (!delta) return;

    setStreams((current) => {
      const stream = current[conversationId];
      if (!stream || stream.requestId !== requestId) return current;
      const next = { ...stream };
      if (payload.event === "thinking_delta") {
        next.thinking += delta;
        next.status = "正在思考";
      } else if (payload.event === "text_delta") {
        next.text += delta;
        next.status = "正在生成回答";
      }
      return { ...current, [conversationId]: next };
    });
  }

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        localStorage.setItem("tao.layout", JSON.stringify({ sidebarWidth, runtimeWidth, filesDirectoryWidth }));
      } catch {
        // Layout persistence is best-effort; it must not affect the chat UI.
      }
    }, 150);
    return () => window.clearTimeout(timer);
  }, [filesDirectoryWidth, runtimeWidth, sidebarWidth]);

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      const resize = resizeRef.current;
      if (!resize) return;
      if (resize.side === "sidebar") {
        setSidebarWidth(clampLayoutWidth(
          resize.startWidth + event.clientX - resize.startX,
          SIDEBAR_MIN_WIDTH,
          SIDEBAR_MAX_WIDTH,
          resize.startWidth,
        ));
      } else if (resize.side === "runtime") {
        setRuntimeWidth(clampLayoutWidth(
          resize.startWidth + resize.startX - event.clientX,
          RUNTIME_MIN_WIDTH,
          RUNTIME_MAX_WIDTH,
          resize.startWidth,
        ));
      } else {
        setFilesDirectoryWidth(clampLayoutWidth(
          resize.startWidth + resize.startX - event.clientX,
          FILES_DIRECTORY_MIN_WIDTH,
          FILES_DIRECTORY_MAX_WIDTH,
          resize.startWidth,
        ));
      }
    };
    const handlePointerUp = () => {
      if (!resizeRef.current) return;
      resizeRef.current = null;
      setResizing(false);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, []);

  function beginResize(side: "sidebar" | "runtime" | "directory", event: React.PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    resizeRef.current = {
      side,
      startX: event.clientX,
      startWidth: side === "sidebar" ? sidebarWidth : side === "runtime" ? runtimeWidth : filesDirectoryWidth,
    };
    setResizing(true);
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture is not available in every WebView implementation.
    }
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }

  async function copyText(text: string, key: string) {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.setAttribute("readonly", "");
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        const copied = document.execCommand("copy");
        textarea.remove();
        if (!copied) throw new Error("copy failed");
      }
      setCopiedKey(key);
      window.setTimeout(() => setCopiedKey((current) => current === key ? undefined : current), 1600);
    } catch {
      setNotice({ conversationId: activeIdRef.current || null, text: "复制失败，请手动选择文本复制。" });
    }
  }

  function sanitizeFileName(value: string) {
    return value.replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, " ").trim().slice(0, 100) || "未命名会话";
  }

  async function exportConversation(format: ExportFormat) {
    if (!activeConversation) return;
    const title = activeConversation.title || "新对话";
    const workspace = activeConversation.workspacePath || "默认工作区";
    const roleLabel = (role: MessageRole) => role === "user" ? "你" : role === "assistant" ? "Tao" : "运行错误";
    let content = "";
    let extension = "txt";
    if (format === "json") {
      content = JSON.stringify(activeConversation, null, 2);
      extension = "json";
    } else if (format === "markdown") {
      content = [
        `# ${title}`,
        "",
        `- 工作区：${workspace}`,
        `- 导出时间：${new Date().toLocaleString("zh-CN")}`,
        "",
        ...activeConversation.messages.flatMap((message) => [
          `## ${roleLabel(message.role)}`,
          "",
          message.content,
          "",
        ]),
      ].join("\n");
      extension = "md";
    } else {
      content = [
        `会话：${title}`,
        `工作区：${workspace}`,
        "",
        ...activeConversation.messages.flatMap((message) => [
          `${roleLabel(message.role)}：`,
          message.content,
          "",
        ]),
      ].join("\n");
    }
    const defaultFileName = `Tao-${sanitizeFileName(title)}-${new Date().toISOString().slice(0, 10)}.${extension}`;
    try {
      const targetPath = await save({
        title: "导出 Tao 会话",
        defaultPath: defaultFileName,
        filters: [{ name: extension === "md" ? "Markdown" : extension.toUpperCase(), extensions: [extension] }],
      });
      setExportOpen(false);
      if (!targetPath) {
        setNotice({ conversationId: null, text: "已取消导出。" });
        return;
      }
      await invoke("write_export_file", { path: targetPath, content });
      setNotice({ conversationId: null, text: `已导出到：${targetPath}` });
    } catch (error: unknown) {
      setExportOpen(false);
      setNotice({ conversationId: null, text: `导出失败：${String(error)}` });
    }
  }

  function openMainView(view: Exclude<MainView, "chat">) {
    if (mainView === view) {
      setMainView("chat");
      setNotice({ conversationId: null, text: "" });
      return;
    }
    if (view === "customization") {
      setRuntimeDraft(runtimeConfiguration);
    }
    setMainView(view);
    setNotice({ conversationId: null, text: "" });
  }

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;

    setStartupStatus("正在读取 Tao 配置…");
    void invoke<AppState>("get_app_state")
      .then(async (state) => {
        const initialConversations = state.conversations.length
          ? state.conversations
          : [await invoke<Conversation>("create_conversation")];
        setConversations(sortConversations(initialConversations));
        const initialId = initialConversations[0]?.id ?? "";
        activeIdRef.current = initialId;
        setActiveId(initialId);
        setSettings(state.settings);
        setRuntimeConfiguration(state.runtimeConfiguration);
        setRuntimeDraft(state.runtimeConfiguration);
        setApiKeyConfigured(state.apiKeyConfigured);
        setProviderAuthConfigured(state.providerAuthConfigured);
        setSelectedSettingsProvider(state.settings.provider);
        setExpandedProviderId(state.settings.provider);
        setLoading(false);
        setStartupStatus("已可输入");
        if (initialConversations[0]) {
          void prepareConversation(
            initialConversations[0],
            conversationConfiguration(initialConversations[0], state.settings, []),
          );
        }
      })
      .catch((error: unknown) => {
        setLoading(false);
        setStartupStatus("启动失败");
        setNotice({ conversationId: null, text: `初始化失败：${String(error)}` });
      });

    void invoke<ModelInfo[]>("list_models")
      .then((listedModels) => {
        setModels(listedModels);
      })
      .catch((error: unknown) => {
        setNotice({ conversationId: null, text: `模型目录加载失败：${String(error)}` });
      });
  }, []);

  useEffect(() => {
    let disposed = false;
    const refreshRuntimeStatus = () => {
      void invoke<RuntimeHostStatus>("get_runtime_status")
        .then((status) => {
          if (!disposed) setRuntimeHost(status);
        })
        .catch(() => {
          if (!disposed) {
            setRuntimeHost((current) => ({ ...current, running: false, ready: false }));
          }
        });
    };
    refreshRuntimeStatus();
    const interval = window.setInterval(refreshRuntimeStatus, 1000);
    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let stopListening: (() => void) | undefined;
    void listen<TaoRuntimeEvent>("tao-runtime-event", ({ payload }) => {
      if (disposed || payload.version !== 1) return;
      if (payload.category === "metric" && payload.elapsedMs !== undefined) {
        setTimings((current) => {
          const timing = current[payload.conversationId] ?? {};
          return {
            ...current,
            [payload.conversationId]: payload.event === "ready"
              ? { ...timing, readyMs: payload.elapsedMs }
              : payload.event === "first_output"
                ? { ...timing, firstOutputMs: payload.elapsedMs }
                : { ...timing, completedMs: payload.elapsedMs },
          };
        });
        setStreams((current) => {
          const stream = current[payload.conversationId];
          if (!stream || stream.requestId !== payload.requestId) return current;
          return {
            ...current,
            [payload.conversationId]: payload.event === "ready"
              ? { ...stream, readyMs: payload.elapsedMs }
              : payload.event === "first_output"
                ? { ...stream, firstOutputMs: payload.elapsedMs }
                : { ...stream, completedMs: payload.elapsedMs },
          };
        });
        return;
      }
      if (payload.category === "permission") {
        if (payload.event === "requested" && payload.permissionId) {
          if (payload.conversationId !== activeIdRef.current) {
            setUnreadIds((current) => ({ ...current, [payload.conversationId]: true }));
          }
          setPermissionRequests((current) => {
            if (current.some((item) => item.id === payload.permissionId)) return current;
            return [
              ...current,
              {
                id: payload.permissionId!,
                conversationId: payload.conversationId,
                requestId: payload.requestId,
                title: payload.permissionTitle ?? "确认工具执行",
                risk: payload.permissionRisk ?? "medium",
                reason: payload.permissionReason ?? payload.text ?? "此操作需要确认。",
                target: payload.permissionTarget,
                command: payload.permissionCommand,
                scope: payload.permissionScope,
                canRemember: Boolean(payload.permissionCanRemember),
                timeoutMs: payload.permissionTimeoutMs,
                tool: payload.tool,
                action: payload.action,
              },
            ];
          });
        } else if (payload.permissionId) {
          setPermissionRequests((current) => current.filter((item) => item.id !== payload.permissionId));
          setPermissionSubmitting(false);
        }
      }
      const isStreamDelta =
        payload.category === "message"
        && (payload.event === "thinking_delta" || payload.event === "text_delta");
      if (isStreamDelta) {
        appendStreamDelta(payload);
        return;
      }
      if (payload.category === "trace") {
        const trace = traceFromPayload(payload);
        if (!trace) return;
        setStreams((current) => {
          const stream = current[payload.conversationId];
          if (!stream || stream.requestId !== payload.requestId) return current;
          return {
            ...current,
            [payload.conversationId]: {
              ...stream,
              traces: upsertTraceItem(stream.traces, trace),
            },
          };
        });
        return;
      }
      if (payload.category === "message" && payload.event === "preamble") {
        setStreams((current) => {
          const stream = current[payload.conversationId];
          if (!stream || stream.requestId !== payload.requestId) return current;
          const next = { ...stream, activities: [...stream.activities] };
          const preamble = payload.text ?? "";
          if (preamble.trim()) {
            const activity = {
              id: payload.activityId ?? `${payload.requestId ?? "runtime"}-preamble-${next.activities.length}`,
              kind: "preamble" as const,
              text: preamble,
              state: payload.activityState ?? "completed",
            };
            const existingIndex = next.activities.findIndex((item) => item.id === activity.id);
            if (existingIndex >= 0) {
              next.activities[existingIndex] = {
                ...next.activities[existingIndex],
                ...activity,
              };
            } else {
              next.activities.push(activity);
            }
            const searchStart = next.turnTextStart;
            const preambleStart = next.text.indexOf(preamble, searchStart);
            if (preambleStart >= searchStart) {
              const before = next.text.slice(0, preambleStart);
              const after = next.text.slice(preambleStart + preamble.length);
              next.text = after.trim()
                ? `${before}${after}`
                : before.replace(/\n\n$/, "");
            }
          }
          return { ...current, [payload.conversationId]: next };
        });
        return;
      }
      if (
        (payload.category === "turn" && ["completed", "aborted"].includes(payload.event))
        || (payload.category === "error" && payload.event === "runtime")
      ) {
        if (payload.conversationId !== activeIdRef.current) {
          setUnreadIds((current) => ({ ...current, [payload.conversationId]: true }));
        }
      }
      if (payload.category === "queue" && payload.event === "error") {
        setNotice({ conversationId: payload.conversationId, text: payload.text ?? "队列消息被拒绝" });
      }
      setStreams((current) => {
        const stream = current[payload.conversationId];
        if (!stream || stream.requestId !== payload.requestId) return current;
        const next = { ...stream };
        next.activities = [...stream.activities];
        const activityFields = (): Partial<ActivityItem> => ({
          ...(payload.activityId ? { id: payload.activityId } : {}),
          ...(payload.tool ? { tool: payload.tool } : {}),
          ...(payload.action ? { action: payload.action } : {}),
          ...(payload.detail ? { detail: payload.detail } : {}),
          ...(payload.elapsedMs === undefined ? {} : { elapsedMs: payload.elapsedMs }),
        });
        const lastActivityIndex = (kind?: ActivityItem["kind"], activityId?: string) => {
          if (activityId) {
            const exactIndex = next.activities.findIndex((item) => item.id === activityId);
            if (exactIndex >= 0) return exactIndex;
          }
          for (let index = next.activities.length - 1; index >= 0; index -= 1) {
            const item = next.activities[index];
            if (item.state === "active" && (!kind || item.kind === kind)) return index;
          }
          return -1;
        };
        const addActivity = (
          kind: ActivityItem["kind"],
          text: string,
          state: ActivityState = "active",
          fields: Partial<ActivityItem> = {},
        ) => {
          next.activities.push({
            id: fields.id ?? `${payload.requestId ?? "runtime"}-${next.activities.length}`,
            kind,
            text,
            state,
            ...fields,
          });
        };
        const updateActivity = (
          kind: ActivityItem["kind"],
          text: string,
          state: ActivityState,
          fields: Partial<ActivityItem> = {},
        ) => {
          const index = lastActivityIndex(kind, fields.id);
          if (index < 0) {
            addActivity(kind, text, state, fields);
            return;
          }
          next.activities[index] = { ...next.activities[index], ...fields, text, state };
        };
        const addNote = (text?: string) => {
          if (!text) return;
          const last = next.activities[next.activities.length - 1];
          if (last?.kind === "note" && last.text === text) return;
          addActivity("note", text, "completed");
        };
        if (payload.category === "runtime" && payload.event === "status") {
          next.status = payload.text ?? next.status;
          if (
            payload.text
            && [
              "正在等待模型响应",
              "正在思考",
              "正在生成回答",
              "正在根据",
              "正在保存会话",
              "模型响应较慢",
              "回答已停止",
            ].some((marker) => payload.text?.includes(marker))
          ) {
            addNote(payload.text);
          }
        } else if (payload.category === "message" && payload.event === "ended") {
          next.status = payload.text ?? "回答已生成，正在保存会话";
          addNote(next.status);
        } else if (payload.category === "turn" && payload.event === "started") {
          if (next.text.trim()) next.text += "\n\n";
          next.turnTextStart = next.text.length;
          next.status = payload.text ?? "正在等待模型响应";
          addNote(next.status);
        } else if (payload.category === "turn" && payload.event === "ended") {
          // Keep the current activity list visible; completion will mark states.
        } else if (payload.category === "tool") {
          next.toolActive = payload.event !== "ended";
          next.status = payload.text ?? next.status;
          const fields = activityFields();
          if (payload.event === "started") {
            addActivity("tool", payload.text ?? "正在调用工具", "active", fields);
          } else if (payload.event === "updated") {
            updateActivity("tool", payload.text ?? "正在执行工具", "active", fields);
          } else if (payload.event === "ended") {
            updateActivity(
              "tool",
              payload.text ?? "工具调用完成",
              payload.text?.includes("未完成") ? "error" : "completed",
              fields,
            );
          }
        } else if (payload.category === "context" || payload.category === "retry") {
          next.status = payload.text ?? next.status;
          const kind = payload.category;
          const isStart = payload.event === "started" || payload.event === "compaction_started";
          const isEnd = payload.event === "ended" || payload.event === "compaction_ended";
          if (isStart) {
            addActivity(kind, payload.text ?? next.status, "active", activityFields());
          } else if (isEnd) {
            updateActivity(
              kind,
              payload.text ?? next.status,
              payload.text?.includes("不可用") || payload.text?.includes("停止") || payload.text?.includes("已停止")
                ? "error"
                : "completed",
              activityFields(),
            );
          }
        } else if (payload.category === "queue" && payload.event === "updated") {
          next.status = payload.text ?? "追加消息已进入队列";
        } else if (payload.category === "queue" && payload.event === "error") {
          next.status = payload.text ?? "追加消息失败";
        } else if (payload.category === "permission") {
          if (payload.event === "requested") {
            next.status = "等待权限确认";
            addNote(payload.text ? `等待权限确认：${payload.text}` : "等待权限确认");
          } else if (payload.event === "allowed") {
            next.status = payload.text ?? "用户已允许工具执行";
            addNote(next.status);
          } else if (payload.event === "denied") {
            next.status = payload.text ?? "用户已拒绝工具执行";
            addNote(next.status);
          }
        } else if (payload.category === "turn" && payload.event === "aborted") {
          next.completed = true;
          next.stopping = false;
          next.activityOpen = false;
          next.thinkingOpen = false;
          next.status = "已停止";
          next.activities = next.activities.map((item) =>
            item.state === "active" ? { ...item, state: "error" } : item,
          );
          completedActivitiesRef.current[payload.conversationId] = next.activities.map((item) => ({ ...item }));
          completedTracesRef.current[payload.conversationId] = next.traces.map((item) => ({ ...item }));
        } else if (payload.category === "turn" && payload.event === "completed") {
          next.completed = true;
          next.activityOpen = false;
          next.thinkingOpen = false;
          next.status = "回答完成";
          next.activities = next.activities.map((item) =>
            item.state === "active" ? { ...item, state: "completed" } : item,
          );
          completedActivitiesRef.current[payload.conversationId] = next.activities.map((item) => ({ ...item }));
          completedTracesRef.current[payload.conversationId] = next.traces.map((item) => ({ ...item }));
        } else if (payload.category === "error" && payload.event === "runtime") {
          next.completed = true;
          next.activityOpen = false;
          next.thinkingOpen = false;
          next.status = payload.text ?? "生成失败";
          next.activities = next.activities.map((item) =>
            item.state === "active" ? { ...item, state: "error" } : item,
          );
          completedActivitiesRef.current[payload.conversationId] = next.activities.map((item) => ({ ...item }));
          completedTracesRef.current[payload.conversationId] = next.traces.map((item) => ({ ...item }));
        }
        return { ...current, [payload.conversationId]: next };
      });
    }).then((unlisten) => {
      if (disposed) unlisten();
      else stopListening = unlisten;
    });
    return () => {
      disposed = true;
      stopListening?.();
    };
  }, []);

  const activeConversation = useMemo(
    () => conversations.find((conversation) => conversation.id === activeId),
    [activeId, conversations],
  );
  const permissionRequest = permissionRequests[0] ?? null;
  const permissionConversation = useMemo(
    () => permissionRequest
      ? conversations.find((conversation) => conversation.id === permissionRequest.conversationId)
      : undefined,
    [conversations, permissionRequest],
  );
  const permissionRequestIsBackground = Boolean(
    permissionRequest && permissionRequest.conversationId !== activeId,
  );
  const activeWorkspacePath = activeConversation?.workspacePath ?? "";
  const lastAssistantMessage = useMemo(() => {
    if (!activeConversation) return undefined;
    for (let index = activeConversation.messages.length - 1; index >= 0; index -= 1) {
      const message = activeConversation.messages[index];
      if (message.role === "assistant") return message;
    }
    return undefined;
  }, [activeConversation]);
  const normalizedSearch = conversationSearch.trim().toLocaleLowerCase();
  const conversationGroups = useMemo(() => {
    const groups = new Map<string, Conversation[]>();
    for (const conversation of sortConversations(conversations)) {
      if (normalizedSearch) {
        const haystack = [
          conversation.title,
          conversation.workspaceName,
          conversation.workspacePath,
          ...conversation.messages.map((message) => message.content),
        ].join("\n").toLocaleLowerCase();
        if (!haystack.includes(normalizedSearch)) continue;
      }
      const key = conversation.workspacePath.trim() || "__none__";
      groups.set(key, [...(groups.get(key) ?? []), conversation]);
    }
    return [...groups.entries()]
      .map(([key, items]) => ({
        key,
        path: key === "__none__" ? "" : key,
        label: key === "__none__" ? "未选择工作区" : (items[0]?.workspaceName || workspaceLabel(key)),
        workspaceName: items[0]?.workspaceName || "",
        conversations: items,
      }))
      .sort((left, right) => {
        if (left.key === "__none__") return 1;
        if (right.key === "__none__") return -1;
        return (right.conversations[0]?.updatedAt ?? 0) - (left.conversations[0]?.updatedAt ?? 0);
      });
  }, [conversations, normalizedSearch]);
  const providerProfiles = useMemo(
    () => mergeProviderProfiles(settings, models),
    [models, settings],
  );
  const settingsProviderProfiles = useMemo(() => {
    const savedIds = new Set(settings.providers.map((provider) => provider.id));
    const savedProfiles = settings.providers
      .map((provider) => providerProfiles.find((profile) => profile.id === provider.id) ?? provider)
      .filter((provider, index, list) => list.findIndex((item) => item.id === provider.id) === index);
    const builtInProfiles = providerProfiles.filter((provider) => !savedIds.has(provider.id));
    return [...savedProfiles, ...builtInProfiles];
  }, [providerProfiles, settings.providers]);
  const selectedSettingsProfile = useMemo(
    () => providerProfiles.find((provider) => provider.id === selectedSettingsProvider)
      ?? providerProfileFor(settings, models, selectedSettingsProvider),
    [models, providerProfiles, selectedSettingsProvider, settings],
  );
  const defaultProviderProfile = providerProfileFor(settings, models, settings.provider);
  const defaultProviderModels = defaultProviderProfile.models;
  const activeConversationProfile = activeConversation
    ? providerProfileFor(settings, models, activeConversation.provider)
    : undefined;
  const activeConversationModels = activeConversationProfile?.models ?? [];
  const activeModelName = activeConversation
    ? activeConversationModels.find((model) => model.id === activeConversation.model)?.name ?? activeConversation.model
    : "未选择模型";
  const activeProviderName = activeConversationProfile?.name ?? activeConversation?.provider ?? "Provider";

  useEffect(() => {
    setProviderDraft(selectedSettingsProfile);
    setApiKey(apiKeys[selectedSettingsProvider] ?? "");
    setConnectionStatus(null);
  }, [apiKeys, selectedSettingsProfile, selectedSettingsProvider]);
  const activeStream = streams[activeId];
  const activeConversationGenerating = Boolean(generatingIds[activeId]);
  const anyConversationGenerating = Object.values(generatingIds).some(Boolean);
  const anyConversationPreparing = Object.values(preparingIds).some(Boolean);
  const runtimeHasError = Boolean(runtimeHost.lastError) && !runtimeHost.ready;
  const rightPanelTraces = activeStream?.traces ?? (
    lastAssistantMessage ? (lastAssistantMessage.traces ?? messageTraces[lastAssistantMessage.id] ?? []) : []
  );
  const rightPanelActivities = activeStream?.activities ?? (
    lastAssistantMessage ? (lastAssistantMessage.activities ?? messageActivities[lastAssistantMessage.id] ?? []) : []
  );

  useEffect(() => {
    setModelMenuOpen(false);
  }, [activeId, activeConversationGenerating]);

  useEffect(() => {
    if (!anyConversationGenerating) return;
    setClockMs(Date.now());
    const timer = window.setInterval(() => setClockMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [anyConversationGenerating]);

  useEffect(() => {
    if (!runtimeOpen || rightPanelView !== "files" || !activeConversation) return;
    setWorkspaceFile(null);
    setWorkspaceFileError("");
    void loadWorkspaceDirectory("");
  }, [activeConversation?.id, activeWorkspacePath, rightPanelView, runtimeOpen]);

  const pageTitle = mainView === "chat"
    ? (activeConversation?.title || "Tao")
    : mainView === "customization"
      ? "定制"
      : "设置";
  const pageSubtitle = mainView === "chat"
    ? runtimeHost.ready
      ? `${startupStatus} · Runtime 已连接`
      : runtimeHost.running
        ? `${startupStatus} · Runtime 后台启动中`
        : `${startupStatus} · Runtime 正在重连`
    : mainView === "customization"
      ? "设计 Tao Runtime 的行为、上下文和扩展"
      : "管理 Tao 的全局配置";

  useEffect(() => {
    if (scrollFrame.current !== null) return;
    scrollFrame.current = window.requestAnimationFrame(() => {
      scrollFrame.current = null;
      messagesEnd.current?.scrollIntoView({ behavior: "auto", block: "end" });
    });
    return () => {
      if (scrollFrame.current !== null) {
        window.cancelAnimationFrame(scrollFrame.current);
        scrollFrame.current = null;
      }
    };
  }, [activeConversation?.messages.length, activeStream?.text, activeStream?.thinking, anyConversationGenerating]);

  useEffect(() => {
    const listener = (event: globalThis.KeyboardEvent) => {
      const modifier = event.ctrlKey || event.metaKey;
      if (modifier && event.key.toLowerCase() === "k") {
        event.preventDefault();
        void createConversation();
        return;
      }
      if (modifier && event.key.toLowerCase() === "p") {
        event.preventDefault();
        setSidebarOpen(true);
        searchInputRef.current?.focus();
        return;
      }
      if (event.key === "Escape" && activeConversationGenerating) {
        event.preventDefault();
        void abortGeneration();
        return;
      }
      if (modifier && event.key.toLowerCase() === "b") {
        event.preventDefault();
        setSidebarOpen((current) => !current);
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [activeConversationGenerating, activeConversation]);

  async function createConversation() {
    setNotice({ conversationId: null, text: "" });
    setMainView("chat");
    try {
      const conversation = await invoke<Conversation>("create_conversation_with_workspace", {
        workspacePath: activeConversation?.workspacePath || null,
        workspaceName: activeConversation?.workspaceName || null,
      });
      setConversations((current) => sortConversations([conversation, ...current]));
      activeIdRef.current = conversation.id;
      setActiveId(conversation.id);
      setInput("");
      setMessageAttachments([]);
      setStartupStatus("已可输入");
      void prepareConversation(conversation);
    } catch (error: unknown) {
      setNotice({ conversationId: null, text: `无法新建对话：${String(error)}` });
    }
  }

  async function selectConversation(conversation: Conversation) {
    setMainView("chat");
    activeIdRef.current = conversation.id;
    setActiveId(conversation.id);
    setUnreadIds((current) => {
      if (!current[conversation.id]) return current;
      const next = { ...current };
      delete next[conversation.id];
      return next;
    });
    setNotice({ conversationId: null, text: "" });
    setInput("");
    setMessageAttachments([]);
    setStartupStatus("已可输入");
  }

  async function updateActiveConversationModel(
    changes: Partial<Pick<Conversation, "provider" | "model" | "thinkingLevel">>,
  ) {
    if (!activeConversation) return;
    if (generatingRef.current.has(activeConversation.id) || preparingRef.current.has(activeConversation.id)) return;

    const provider = changes.provider ?? activeConversation.provider;
    const profile = providerProfileFor(settings, models, provider);
    if (changes.provider && changes.provider !== activeConversation.provider && profile.models.length === 0) {
      setNotice({
        conversationId: activeConversation.id,
        text: "请先测试连接并获取该 Provider 的模型列表。",
      });
      return;
    }
    const model = changes.model ?? (
      provider === activeConversation.provider
        ? activeConversation.model
        : profile.models[0]?.id ?? activeConversation.model
    );
    const thinkingLevel = changes.thinkingLevel ?? activeConversation.thinkingLevel;
    if (
      provider === activeConversation.provider
      && model === activeConversation.model
      && thinkingLevel === activeConversation.thinkingLevel
    ) {
      return;
    }

    try {
      const updated = await invoke<Conversation>("set_conversation_model", {
        request: {
          conversationId: activeConversation.id,
          provider,
          model,
          thinkingLevel,
        },
      });
      setConversations((current) => current.map((conversation) =>
        conversation.id === updated.id ? updated : conversation,
      ));
      setModelMenuOpen(false);
      setNotice({ conversationId: null, text: "" });
      void prepareConversation(updated);
    } catch (error: unknown) {
      setNotice({ conversationId: activeConversation.id, text: `Unable to update conversation model: ${String(error)}` });
    }
  }

  async function updateActiveConversationPermissionMode(permissionMode: PermissionMode) {
    if (!activeConversation) return;
    if (generatingRef.current.has(activeConversation.id) || preparingRef.current.has(activeConversation.id)) return;
    if ((activeConversation.permissionMode ?? "ask") === permissionMode) return;
    try {
      const updated = await invoke<Conversation>("set_conversation_permission_mode", {
        request: {
          conversationId: activeConversation.id,
          permissionMode,
        },
      });
      setConversations((current) => current.map((conversation) =>
        conversation.id === updated.id ? updated : conversation,
      ));
      setNotice({ conversationId: null, text: "" });
    } catch (error: unknown) {
      setNotice({ conversationId: activeConversation.id, text: `权限模式更新失败：${String(error)}` });
    }
  }

  function addProvider() {
    const baseId = "custom-provider";
    let suffix = 1;
    let id = baseId;
    while (providerProfiles.some((provider) => provider.id === id)) {
      suffix += 1;
      id = `${baseId}-${suffix}`;
    }
    const profile: ProviderProfile = {
      id,
      name: id,
      baseUrl: "",
      api: "openai-completions",
      models: [],
    };
    setSettings((current) => ({
      ...current,
      providers: [profile, ...current.providers],
    }));
    setSelectedSettingsProvider(id);
    setExpandedProviderId(id);
    setApiKey("");
    setConnectionStatus(null);
  }

  function removeProvider(providerId: string) {
    if (providerId === settings.provider) {
      setNotice({ conversationId: null, text: "Default Provider cannot be removed." });
      return;
    }
    if (!settings.providers.some((provider) => provider.id === providerId)) {
      setNotice({ conversationId: null, text: "内置 Provider 不能删除。" });
      return;
    }
    if (conversations.some((conversation) => conversation.provider === providerId)) {
      setNotice({
        conversationId: null,
        text: "该 Provider 仍被会话使用，请先切换这些会话的 Provider。",
      });
      return;
    }
    const fallback = providerProfiles.find((provider) => provider.id !== providerId);
    if (!fallback) {
      setNotice({ conversationId: null, text: "Keep at least one Provider." });
      return;
    }
    setSettings((current) => ({
      ...current,
      providers: current.providers.filter((provider) => provider.id !== providerId),
    }));
    setModels((current) => current.filter((model) => model.provider !== providerId));
    if (selectedSettingsProvider === providerId) {
      setSelectedSettingsProvider(fallback.id);
      setExpandedProviderId(fallback.id);
    } else if (expandedProviderId === providerId) {
      setExpandedProviderId(null);
    }
    setApiKeys((current) => {
      const next = { ...current };
      delete next[providerId];
      return next;
    });
    setConnectionStatus(null);
  }

  function updateProviderDraft(patch: Partial<ProviderProfile>) {
    const next = { ...providerDraft, ...patch };
    setProviderDraft(next);
    setSettings((settingsCurrent) => ({
      ...settingsCurrent,
      providers: upsertProviderProfile(settingsCurrent.providers, next),
      ...(next.id === settingsCurrent.provider
        ? {
            baseUrl: next.baseUrl,
            api: next.api,
          }
        : {}),
    }));
  }

  function selectSettingsProvider(providerId: string) {
    const profile = providerProfiles.find((provider) => provider.id === providerId)
      ?? providerProfileFor(settings, models, providerId);
    setSelectedSettingsProvider(providerId);
    setExpandedProviderId(providerId);
    setProviderDraft(profile);
    setApiKey(apiKeys[providerId] ?? "");
    setConnectionStatus(null);
  }

  function toggleProviderCard(providerId: string) {
    if (expandedProviderId === providerId) {
      setExpandedProviderId(null);
      return;
    }
    selectSettingsProvider(providerId);
  }

  function setDefaultProvider(providerId: string, modelId?: string) {
    const profile = providerProfileFor(settings, models, providerId);
    if (profile.models.length === 0) {
      setNotice({
        conversationId: null,
        text: "请先测试连接并获取该 Provider 的模型列表。",
      });
      return;
    }
    setSettings((current) => ({
      ...current,
      provider: providerId,
      model: modelId ?? profile.models[0]?.id ?? current.model,
      baseUrl: profile.baseUrl,
      api: profile.api,
    }));
    if (modelId) {
      setProviderModelSelections((current) => ({ ...current, [providerId]: modelId }));
    }
    selectSettingsProvider(providerId);
  }

  async function restartRuntime() {
    if (runtimeRecovering) return;
    if (anyConversationGenerating || anyConversationPreparing) {
      setNotice({ conversationId: null, text: "请等待当前会话完成后再重启 Runtime。" });
      return;
    }
    setRuntimeRecovering(true);
    setNotice({ conversationId: null, text: "正在重启 Runtime…" });
    try {
      await invoke("stop_runtime");
      await invoke("start_runtime");
      const started = performance.now();
      let ready = false;
      while (performance.now() - started < 10_000) {
        const status = await invoke<RuntimeHostStatus>("get_runtime_status");
        setRuntimeHost(status);
        if (status.ready) {
          ready = true;
          break;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 150));
      }
      if (!ready) {
        throw new Error("Runtime 未能在 10 秒内进入 ready 状态");
      }
      if (activeConversation) {
        const prepared = await prepareConversation(activeConversation);
        if (!prepared) {
          throw new Error("当前会话重新连接失败");
        }
      }
      setNotice({ conversationId: null, text: "Runtime 已恢复，当前会话已重新连接。" });
    } catch (error: unknown) {
      setNotice({ conversationId: null, text: `Runtime 恢复失败：${String(error)}` });
    } finally {
      setRuntimeRecovering(false);
    }
  }

  async function prepareConversation(
    conversation: Conversation,
    configuration = conversationConfiguration(conversation, settings, models),
  ) {
    if (preparingRef.current.has(conversation.id) || generatingRef.current.has(conversation.id)) return true;
    preparingRef.current.add(conversation.id);
    const started = performance.now();
    setPreparingIds((current) => ({ ...current, [conversation.id]: true }));
    try {
      await invoke("prepare_session", {
        request: {
          conversationId: conversation.id,
          provider: configuration.provider,
          model: configuration.model,
          baseUrl: configuration.baseUrl,
          api: configuration.api,
          thinkingLevel: configuration.thinkingLevel,
          permissionMode: configuration.permissionMode,
          permissionTimeoutMs: configuration.permissionTimeoutMs,
        },
      });
      setTimings((current) => ({
        ...current,
        [conversation.id]: {
          ...current[conversation.id],
          readyMs: Math.round(performance.now() - started),
        },
      }));
      return true;
    } catch (error: unknown) {
      setNotice({ conversationId: conversation.id, text: `会话后台连接失败，首次发送时会自动重试：${String(error)}` });
      return false;
    } finally {
      preparingRef.current.delete(conversation.id);
      setPreparingIds((current) => {
        const next = { ...current };
        delete next[conversation.id];
        return next;
      });
    }
  }

  async function answerPermissionRequest(decision: PermissionDecision) {
    if (!permissionRequest || permissionSubmitting) return;
    const effectiveDecision = decision === "allow_session" && !permissionRequest.canRemember
      ? "allow_once"
      : decision;
    setPermissionSubmitting(true);
    try {
      await invoke("resolve_permission_request", {
        response: {
          conversationId: permissionRequest.conversationId,
          requestId: permissionRequest.requestId,
          permissionId: permissionRequest.id,
          decision: effectiveDecision,
        },
      });
      setPermissionRequests((current) => current.filter((item) => item.id !== permissionRequest.id));
    } catch (error: unknown) {
      setNotice({ conversationId: permissionRequest.conversationId, text: `权限确认失败：${String(error)}` });
    } finally {
      setPermissionSubmitting(false);
    }
  }

  function openPermissionConversation() {
    if (!permissionRequest) return;
    const conversation = conversations.find((item) => item.id === permissionRequest.conversationId);
    if (conversation) {
      void selectConversation(conversation);
    }
  }

  async function loadWorkspaceDirectory(relativePath = workspaceListing?.relativePath ?? "") {
    const workspacePath = activeWorkspacePath;
    setWorkspaceLoading(true);
    setWorkspaceError("");
    try {
      const listing = await invoke<WorkspaceListing>("list_workspace", {
        workspacePath,
        relativePath,
      });
      setWorkspaceListing(listing);
    } catch (error: unknown) {
      setWorkspaceError(String(error));
      setWorkspaceListing(null);
    } finally {
      setWorkspaceLoading(false);
    }
  }

  async function openWorkspaceFile(relativePath: string, mode: WorkspacePreviewMode = "file") {
    const workspacePath = activeWorkspacePath;
    setWorkspacePreviewMode(mode);
    setWorkspaceFileLoading(true);
    setWorkspaceFileError("");
    try {
      const file = await invoke<WorkspaceFile>(mode === "diff" ? "read_workspace_diff" : "read_workspace_file", {
        workspacePath,
        relativePath,
      });
      setWorkspaceFile(file);
    } catch (error: unknown) {
      setWorkspaceFile(null);
      setWorkspaceFileError(String(error));
    } finally {
      setWorkspaceFileLoading(false);
    }
  }

  function openRightPanel(view: RightPanelView) {
    setRightPanelView(view);
    setRuntimeOpen(true);
  }

  function requestDeleteConversation(conversation: Conversation) {
    if (generatingRef.current.has(conversation.id)) {
      setNotice({ conversationId: conversation.id, text: "当前对话正在生成，完成后再删除。" });
      return;
    }
    if (preparingRef.current.has(conversation.id)) {
      setNotice({ conversationId: conversation.id, text: "当前对话正在准备，准备完成后再删除。" });
      return;
    }
    setDeleteTarget(conversation);
  }

  async function deleteConversation(conversation: Conversation) {
    if (generatingRef.current.has(conversation.id)) {
      setDeleteTarget(null);
      setNotice({ conversationId: conversation.id, text: "当前对话正在生成，完成后再删除。" });
      return;
    }
    if (preparingRef.current.has(conversation.id)) {
      setDeleteTarget(null);
      setNotice({ conversationId: conversation.id, text: "当前对话正在准备，准备完成后再删除。" });
      return;
    }

    try {
      setDeletingConversationId(conversation.id);
      await invoke("delete_conversation", { conversationId: conversation.id });
      const remaining = conversations.filter((item) => item.id !== conversation.id);
      if (remaining.length > 0) {
        setConversations(remaining);
        if (activeId === conversation.id) {
          activeIdRef.current = remaining[0].id;
          setActiveId(remaining[0].id);
        }
      } else {
        const draft = await invoke<Conversation>("create_conversation_with_workspace", {
          workspacePath: activeConversation?.workspacePath || null,
          workspaceName: activeConversation?.workspaceName || null,
        });
        setConversations([draft]);
        activeIdRef.current = draft.id;
        setActiveId(draft.id);
      }
      setStreams((current) => {
        const next = { ...current };
        delete next[conversation.id];
        return next;
      });
      setGeneratingIds((current) => {
        const next = { ...current };
        delete next[conversation.id];
        return next;
      });
      setUnreadIds((current) => {
        if (!current[conversation.id]) return current;
        const next = { ...current };
        delete next[conversation.id];
        return next;
      });
      setNotice({ conversationId: null, text: "" });
      setDeleteTarget(null);
    } catch (error: unknown) {
      setNotice({ conversationId: conversation.id, text: `无法删除对话：${String(error)}` });
      setDeleteTarget(null);
    } finally {
      setDeletingConversationId(null);
    }
  }

  async function toggleConversationPinned(conversation: Conversation) {
    if (conversation.messages.length === 0) return;
    try {
      const updated = await invoke<Conversation>("set_conversation_pinned", {
        conversationId: conversation.id,
        pinned: !conversation.pinned,
      });
      setConversations((current) => sortConversations(
        current.map((item) => item.id === updated.id ? updated : item),
      ));
      setNotice({
        conversationId: null,
        text: updated.pinned ? "对话已置顶。" : "已取消置顶。",
      });
    } catch (error: unknown) {
      setNotice({ conversationId: conversation.id, text: `无法更新置顶状态：${String(error)}` });
    }
  }

  async function saveModelSettings() {
    setNotice({ conversationId: null, text: "" });
    const submittedApiKeys = apiKey.trim()
      ? { ...apiKeys, [selectedSettingsProvider]: apiKey }
      : apiKeys;
    try {
      const saved = await invoke<SaveSettingsResult>("save_settings", {
        settings,
        apiKeys: submittedApiKeys,
      });
      setSettings(saved.settings);
      setApiKeyConfigured(saved.apiKeyConfigured);
      setProviderAuthConfigured(saved.providerAuthConfigured);
      setApiKeys((current) => {
        const next = { ...current };
        delete next[selectedSettingsProvider];
        return next;
      });
      setApiKey("");
      setNotice({ conversationId: null, text: "全局设置已保存到 .tao。" });
      if (activeConversation) {
        setStartupStatus("已可输入");
        void prepareConversation(
          activeConversation,
          conversationConfiguration(activeConversation, saved.settings, models),
        );
      }
    } catch (error: unknown) {
      setNotice({ conversationId: null, text: `无法保存设置：${String(error)}` });
    }
  }

  async function saveRuntimeConfiguration() {
    if (anyConversationGenerating || anyConversationPreparing) {
      setNotice({ conversationId: null, text: "请等待所有会话运行完成后再保存 Runtime 配置。" });
      return;
    }
    try {
      const saved = await invoke<RuntimeConfiguration>("save_runtime_configuration", {
        configuration: runtimeDraft,
      });
      setRuntimeConfiguration(saved);
      setRuntimeDraft(saved);
      setNotice({ conversationId: null, text: "Runtime 提示词配置已保存。" });
      if (activeConversation) {
        setStartupStatus("已可输入");
        void prepareConversation(activeConversation);
      }
    } catch (error: unknown) {
      setNotice({ conversationId: null, text: `无法保存 Runtime 配置：${String(error)}` });
    }
  }

  function updateRuntimeDraft(patch: Partial<RuntimeConfiguration>) {
    setRuntimeDraft((current) => ({ ...current, ...patch }));
  }

  function addCustomTool() {
    const existing = runtimeDraft.customTools ?? [];
    let index = existing.length + 1;
    let draft = newCustomToolConfiguration(index);
    while (existing.some((tool) => tool.name === draft.name)) {
      index += 1;
      draft = newCustomToolConfiguration(index);
    }
    updateRuntimeDraft({ customTools: [...existing, draft] });
    setCustomToolTestInput(JSON.stringify({ input: "测试输入" }, null, 2));
    setCustomToolTestOutput("");
  }

  function updateCustomTool(toolId: string, patch: Partial<CustomToolConfiguration>) {
    updateRuntimeDraft({
      customTools: (runtimeDraft.customTools ?? []).map((tool) =>
        tool.id === toolId ? { ...tool, ...patch } : tool,
      ),
    });
  }

  function removeCustomTool(toolId: string) {
    updateRuntimeDraft({
      customTools: (runtimeDraft.customTools ?? []).filter((tool) => tool.id !== toolId),
    });
    if (testingCustomToolId === toolId) {
      setTestingCustomToolId(null);
      setCustomToolTestOutput("");
    }
  }

  async function testCustomTool(tool: CustomToolConfiguration) {
    setTestingCustomToolId(tool.id);
    setCustomToolTestOutput("");
    try {
      const result = await invoke<TestCustomToolResult>("test_custom_tool", {
        request: {
          tool,
          input: customToolTestInput,
          workspacePath: activeWorkspacePath || null,
        },
      });
      setCustomToolTestOutput(result.output);
    } catch (error: unknown) {
      setCustomToolTestOutput(`测试失败：${String(error)}`);
    } finally {
      setTestingCustomToolId(null);
    }
  }

  async function chooseConversationWorkspace() {
    if (!activeConversation) return;
    if (generatingRef.current.has(activeConversation.id) || preparingRef.current.has(activeConversation.id)) {
      setNotice({ conversationId: activeConversation.id, text: "请等待当前会话完成准备或生成后再切换工作区。" });
      return;
    }
    try {
      const selected = await invoke<string | null>("choose_workspace_directory");
      if (selected) {
        const updated = await invoke<Conversation>("set_conversation_workspace", {
          conversationId: activeConversation.id,
          workspacePath: selected,
        });
        setConversations((current) => current.map((conversation) =>
          conversation.id === updated.id ? updated : conversation,
        ));
        setNotice({ conversationId: updated.id, text: "当前会话工作区已更新；下次发送会使用该目录。" });
      }
    } catch (error: unknown) {
      setNotice({ conversationId: activeConversation.id, text: `选择工作区失败：${String(error)}` });
    }
  }

  async function chooseMessageAttachments() {
    if (!activeConversation) return;
    if (generatingRef.current.has(activeConversation.id) || preparingRef.current.has(activeConversation.id)) {
      setNotice({ conversationId: activeConversation.id, text: "请等待当前会话完成后再添加附件。" });
      return;
    }
    try {
      const selected = await invoke<AttachmentReference[]>("choose_message_files");
      if (!selected.length) return;
      setMessageAttachments((current) => {
        const existing = new Set(current.map((attachment) => attachment.path));
        const next = [...current];
        for (const attachment of selected) {
          if (!existing.has(attachment.path) && next.length < 8) {
            existing.add(attachment.path);
            next.push(attachment);
          }
        }
        return next;
      });
      setNotice({ conversationId: activeConversation.id, text: "" });
    } catch (error: unknown) {
      setNotice({ conversationId: activeConversation.id, text: `选择附件失败：${String(error)}` });
    }
  }

  function removeMessageAttachment(path: string) {
    setMessageAttachments((current) => current.filter((attachment) => attachment.path !== path));
  }

  async function clearConversationWorkspace() {
    if (!activeConversation) return;
    if (generatingRef.current.has(activeConversation.id) || preparingRef.current.has(activeConversation.id)) {
      setNotice({ conversationId: activeConversation.id, text: "请等待当前会话完成后再清除工作区。" });
      return;
    }
    try {
      const updated = await invoke<Conversation>("set_conversation_workspace", {
        conversationId: activeConversation.id,
        workspacePath: "",
      });
      setConversations((current) => current.map((conversation) =>
        conversation.id === updated.id ? updated : conversation,
      ));
      setNotice({ conversationId: updated.id, text: "已切换到默认工作区。" });
    } catch (error: unknown) {
      setNotice({ conversationId: activeConversation.id, text: `清除工作区失败：${String(error)}` });
    }
  }

  async function renameConversation(conversation: Conversation) {
    const title = window.prompt("重命名会话", conversation.title || "新对话");
    if (title === null || !title.trim() || title.trim() === conversation.title) return;
    try {
      const updated = await invoke<Conversation>("rename_conversation", {
        conversationId: conversation.id,
        title,
      });
      setConversations((current) => sortConversations(current.map((item) => item.id === updated.id ? updated : item)));
    } catch (error: unknown) {
      setNotice({ conversationId: conversation.id, text: `重命名会话失败：${String(error)}` });
    }
  }

  async function renameWorkspace(path: string, currentName: string) {
    if (!path) return;
    const name = window.prompt("重命名工作区", currentName || workspaceLabel(path));
    if (name === null || !name.trim() || name.trim() === currentName) return;
    try {
      const updated = await invoke<Conversation[]>("rename_workspace", {
        workspacePath: path,
        workspaceName: name,
      });
      setConversations(sortConversations(updated));
    } catch (error: unknown) {
      setNotice({ conversationId: null, text: `重命名工作区失败：${String(error)}` });
    }
  }

  async function testConnection() {
    setConnectionStatus(null);
    setTestingConnection(true);
    try {
      const result = await invoke<ConnectionTestResult>("test_connection", {
        request: {
          providerId: providerDraft.id,
          providerName: providerDraft.name,
          baseUrl: providerDraft.baseUrl,
          apiKey: apiKeys[providerDraft.id] ?? apiKey,
        },
      });
      const remoteModels: ModelInfo[] = result.models.map((model) => ({
        provider: result.providerId,
        id: model.id,
        name: model.name,
        reasoning: model.reasoning,
        api: providerDraft.api,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
      }));
      setModels((current) => [
        ...current.filter((model) => model.provider !== result.providerId),
        ...remoteModels,
      ]);
      const updatedProfile: ProviderProfile = {
        ...providerDraft,
        id: result.providerId,
        name: providerDraft.name.trim() || result.providerName,
        models: result.models,
      };
      setProviderDraft(updatedProfile);
      setSettings((current) => ({
        ...current,
        providers: upsertProviderProfile(current.providers, updatedProfile),
        ...(current.provider === result.providerId
          ? {
              baseUrl: updatedProfile.baseUrl,
              api: updatedProfile.api,
              model: updatedProfile.models.some((model) => model.id === current.model)
                ? current.model
                : updatedProfile.models[0]?.id ?? current.model,
            }
          : {}),
      }));
      setConnectionStatus({
        ok: true,
        text: `连接成功，${result.latencyMs} ms，获取到 ${result.models.length} 个模型。`,
      });
    } catch (error: unknown) {
      setConnectionStatus({ ok: false, text: String(error) });
    } finally {
      setTestingConnection(false);
    }
  }

  async function runPrompt(
    conversation: Conversation,
    text: string,
    configuration: ConversationConfiguration,
    options: { retryErrorMessageId?: string; attachments?: AttachmentReference[] } = {},
  ) {
    const conversationId = conversation.id;
    const requestId = crypto.randomUUID();
    const retryErrorMessageId = options.retryErrorMessageId;
    const attachments = options.attachments ?? [];

    setInput("");
    setMessageAttachments([]);
    setNotice({ conversationId, text: "" });
    generatingRef.current.add(conversationId);
    delete completedActivitiesRef.current[conversationId];
    delete completedTracesRef.current[conversationId];
    setGeneratingIds((current) => ({ ...current, [conversationId]: true }));
    setStreams((current) => ({
      ...current,
      [conversationId]: {
        requestId,
        startedAt: Date.now(),
        status: "正在连接服务…",
        thinking: "",
        thinkingOpen: true,
        text: "",
        turnTextStart: 0,
        activityOpen: true,
        activities: [],
        traces: [],
        toolActive: false,
        completed: false,
        stopping: false,
        queued: [],
        readyMs: undefined,
        firstOutputMs: undefined,
        completedMs: undefined,
      },
    }));
    if (retryErrorMessageId) {
      setConversations((current) =>
        current.map((item) =>
          item.id === conversationId
            ? { ...item, messages: item.messages.filter((message) => message.id !== retryErrorMessageId) }
            : item,
        ),
      );
    } else {
      const optimisticMessage: Message = {
        id: `local-${Date.now()}`,
        role: "user",
        content: text,
        createdAt: Date.now(),
        ...(attachments.length ? { attachments } : {}),
      };
      setConversations((current) =>
        current.map((item) =>
          item.id === conversationId
            ? { ...item, messages: [...item.messages, optimisticMessage] }
            : item,
        ),
      );
    }

    try {
      const updatedConversation = await invoke<Conversation>(
        retryErrorMessageId ? "retry_message" : "send_message",
        {
          request: retryErrorMessageId
            ? {
                requestId,
                conversationId,
                errorMessageId: retryErrorMessageId,
              }
            : {
                requestId,
                conversationId,
                text,
                provider: configuration.provider,
                model: configuration.model,
                baseUrl: configuration.baseUrl,
                api: configuration.api,
                thinkingLevel: configuration.thinkingLevel,
                permissionMode: configuration.permissionMode,
                permissionTimeoutMs: configuration.permissionTimeoutMs,
                attachments,
              },
        },
      );
      const completedActivities = completedActivitiesRef.current[conversationId]
        ?? streamsRef.current[conversationId]?.activities
        ?? [];
      const completedTraces = completedTracesRef.current[conversationId]
        ?? streamsRef.current[conversationId]?.traces
        ?? [];
      const completedAssistant = [...updatedConversation.messages]
        .reverse()
        .find((message) => message.role === "assistant");
      let conversationToStore = updatedConversation;
      if (completedAssistant) {
        if (!completedAssistant.activities?.length && completedActivities.length) {
          setMessageActivities((current) => ({
            ...current,
            [completedAssistant.id]: completedActivities,
          }));
        }
        const tracesForMessage = completedAssistant.traces?.length
          ? completedAssistant.traces
          : completedTraces;
        if (tracesForMessage.length) {
          setMessageTraces((current) => ({
            ...current,
            [completedAssistant.id]: tracesForMessage,
          }));
        }
        if (!completedAssistant.traces?.length && completedTraces.length) {
          conversationToStore = {
            ...updatedConversation,
            messages: updatedConversation.messages.map((message) =>
              message.id === completedAssistant.id ? { ...message, traces: completedTraces } : message,
            ),
          };
        }
        setMessageActivityOpen((current) => ({
          ...current,
          [completedAssistant.id]: false,
        }));
        setMessageThinkingOpen((current) => ({
          ...current,
          [completedAssistant.id]: false,
        }));
      }
      setConversations((current) => sortConversations([
        conversationToStore,
        ...current.filter((item) => item.id !== conversationToStore.id),
      ]));
      setStreams((current) => {
        const next = { ...current };
        delete next[conversationId];
        return next;
      });
    } catch (error: unknown) {
      setNotice({ conversationId, text: String(error) });
      try {
        const state = await invoke<AppState>("get_app_state");
        setConversations(sortConversations(state.conversations));
        setSettings(state.settings);
        setApiKeyConfigured(state.apiKeyConfigured);
        setProviderAuthConfigured(state.providerAuthConfigured);
      } catch {
        setNotice({ conversationId, text: `模型调用失败，且无法重新加载会话：${String(error)}` });
      }
      setStreams((current) => {
        const next = { ...current };
        delete next[conversationId];
        return next;
      });
    } finally {
      generatingRef.current.delete(conversationId);
      delete completedActivitiesRef.current[conversationId];
      delete completedTracesRef.current[conversationId];
      setGeneratingIds((current) => {
        const next = { ...current };
        delete next[conversationId];
        return next;
      });
    }
  }

  async function sendMessage(event?: FormEvent) {
    event?.preventDefault();
    const text = input.trim();
    if ((!text && !messageAttachments.length) || !activeConversation) return;
    if (generatingRef.current.has(activeConversation.id)) {
      if (messageAttachments.length) {
        setNotice({ conversationId: activeConversation.id, text: "追加消息暂不支持附件，请等待当前回答完成后再发送。" });
        return;
      }
      await queueMessage(text, queueBehavior);
      return;
    }
    await runPrompt(
      activeConversation,
      text,
      conversationConfiguration(activeConversation, settings, models),
      { attachments: messageAttachments },
    );
    return;

  }

  async function retryFailedMessage(
    conversation: Conversation,
    userMessage: Message,
    errorMessage: Message,
  ) {
    if (!errorMessage.retry) return;
    if (generatingRef.current.has(conversation.id) || preparingRef.current.has(conversation.id)) {
      setNotice({ conversationId: conversation.id, text: "当前会话正在运行，请完成后再重试。" });
      return;
    }
    await runPrompt(
      conversation,
      userMessage.content,
      {
        ...errorMessage.retry,
        permissionMode: conversation.permissionMode ?? "ask",
        permissionTimeoutMs: settings.permissionTimeoutMs ?? 60_000,
      },
      {
        retryErrorMessageId: errorMessage.id,
        attachments: userMessage.attachments ?? [],
      },
    );
  }

  async function queueMessage(text: string, behavior: QueueBehavior) {
    if (!activeConversation || !generatingRef.current.has(activeConversation.id)) return;
    const conversationId = activeConversation.id;
    try {
      await invoke("queue_message", {
        request: { conversationId, text, behavior },
      });
      setInput("");
      setNotice({ conversationId, text: "" });
      setStreams((current) => {
        const stream = current[conversationId];
        if (!stream) return current;
        return {
          ...current,
          [conversationId]: {
            ...stream,
            queued: [...stream.queued, { text, behavior }],
          },
        };
      });
    } catch (error: unknown) {
      setNotice({ conversationId, text: `无法追加消息：${String(error)}` });
    }
  }

  async function abortGeneration() {
    if (!activeConversation || !generatingRef.current.has(activeConversation.id)) return;
    const conversationId = activeConversation.id;
    setStreams((current) => {
      const stream = current[conversationId];
      if (!stream) return current;
      return {
        ...current,
        [conversationId]: { ...stream, stopping: true, status: "正在停止…" },
      };
    });
    try {
      await invoke("abort_generation", { conversationId });
    } catch (error: unknown) {
      setStreams((current) => {
        const stream = current[conversationId];
        if (!stream) return current;
        return {
          ...current,
          [conversationId]: { ...stream, stopping: false, status: "停止失败" },
        };
      });
      setNotice({ conversationId, text: `无法停止生成：${String(error)}` });
    }
  }

  function toggleActivity(conversationId: string) {
    setStreams((current) => {
      const stream = current[conversationId];
      if (!stream) return current;
      return {
        ...current,
        [conversationId]: { ...stream, activityOpen: !stream.activityOpen },
      };
    });
  }

  function toggleMessageActivity(messageId: string) {
    setMessageActivityOpen((current) => ({
      ...current,
      [messageId]: !current[messageId],
    }));
  }

  function toggleStreamThinking(conversationId: string) {
    setStreams((current) => {
      const stream = current[conversationId];
      if (!stream) return current;
      return {
        ...current,
        [conversationId]: { ...stream, thinkingOpen: !stream.thinkingOpen },
      };
    });
  }

  function toggleMessageThinking(messageId: string) {
    setMessageThinkingOpen((current) => ({
      ...current,
      [messageId]: !current[messageId],
    }));
  }

  function toggleTrace(traceId: string) {
    setTraceOpen((current) => ({
      ...current,
      [traceId]: !current[traceId],
    }));
  }

  function handleComposerKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendMessage();
    }
  }

  const effectiveTheme = settings.theme === "dark"
    || (settings.theme === "system" && prefersDarkTheme)
    ? "dark"
    : "light";

  return (
    <div
      className={`app-shell theme-${effectiveTheme} ${sidebarOpen ? "" : "sidebar-collapsed"} ${runtimeOpen ? "runtime-open" : ""} ${filesExpanded ? "files-expanded" : ""} ${resizing ? "resizing" : ""}`}
      style={{
        ...accentStyle(settings.accentColor, effectiveTheme),
        "--tao-sidebar-width": `${sidebarWidth}px`,
        "--tao-runtime-width": `${runtimeWidth}px`,
        "--tao-files-directory-width": `${filesDirectoryWidth}px`,
      } as CSSProperties}
    >
      <button
        className="shell-panel-toggle shell-panel-toggle-left"
        type="button"
        aria-label={sidebarOpen ? "收起对话栏" : "展开对话栏"}
        title={sidebarOpen ? "收起对话栏" : "展开对话栏"}
        aria-pressed={sidebarOpen}
        onClick={() => setSidebarOpen((current) => !current)}
      >
        <svg aria-hidden="true" viewBox="0 0 20 20"><rect x="3" y="4" width="14" height="12" rx="2" /><path d="M7 4v12" /></svg>
      </button>
      <button
        className="shell-panel-toggle shell-panel-toggle-right"
        type="button"
        aria-label={runtimeOpen ? "收起右侧面板" : "展开工作过程"}
        title={runtimeOpen ? "收起右侧面板" : "展开工作过程"}
        aria-pressed={runtimeOpen}
        onClick={() => {
          if (runtimeOpen) {
            setRuntimeOpen(false);
            setFilesExpanded(false);
            return;
          }
          openRightPanel("runtime");
        }}
      >
        <svg aria-hidden="true" viewBox="0 0 20 20"><rect x="3" y="4" width="14" height="12" rx="2" /><path d="M13 4v12" /></svg>
      </button>
      <aside className="sidebar">
        <div className="brand-row">
          <div className="brand-mark">T</div>
          <span>Tao</span>
        </div>

        <button className="new-chat-button" type="button" onClick={() => void createConversation()}>
          <span aria-hidden="true">＋</span>
          新建对话
        </button>

        <button
          className={`primary-nav-button ${mainView === "customization" ? "active" : ""}`}
          type="button"
          onClick={() => openMainView("customization")}
        >
          <svg aria-hidden="true" viewBox="0 0 20 20"><path d="M10 2.5l1.4 4.1 4.1 1.4-4.1 1.4-1.4 4.1-1.4-4.1L4.5 8l4.1-1.4L10 2.5z" /><path d="M15.5 13l.7 2.1 2.1.7-2.1.7-.7 2.1-.7-2.1-2.1-.7 2.1-.7.7-2.1z" /></svg>
          定制
        </button>

        <div className="sidebar-label">对话</div>
        <div className="conversation-search">
          <svg aria-hidden="true" viewBox="0 0 20 20"><circle cx="8.5" cy="8.5" r="4.5" /><path d="m12 12 4.5 4.5" /></svg>
          <input
            ref={searchInputRef}
            aria-label="搜索对话"
            value={conversationSearch}
            onChange={(event) => setConversationSearch(event.currentTarget.value)}
            placeholder="搜索对话"
          />
          {conversationSearch && (
            <button
              type="button"
              aria-label="清除搜索"
              title="清除搜索"
              onClick={() => {
                setConversationSearch("");
                searchInputRef.current?.focus();
              }}
            >
              <WorkspaceClearIcon />
            </button>
          )}
        </div>
        <nav className="conversation-list" aria-label="对话列表">
          {conversationGroups.length ? conversationGroups.map((group) => (
            <section className="workspace-group" key={group.key}>
              <div className="workspace-group-heading" title={group.path || undefined}>
                <svg aria-hidden="true" viewBox="0 0 20 20">
                  <path d="M2.8 5.8a1.5 1.5 0 0 1 1.5-1.5h4l1.6 1.8h6.3a1 1 0 0 1 1 1v7.6a1.5 1.5 0 0 1-1.5 1.5H4.3a1.5 1.5 0 0 1-1.5-1.5z" />
                </svg>
                <span>{group.label}</span>
                {group.path && (
                  <button
                    className="workspace-group-rename"
                    type="button"
                    aria-label="重命名工作区"
                    title="重命名工作区"
                    onClick={() => void renameWorkspace(group.path, group.workspaceName)}
                  >
                    <svg aria-hidden="true" viewBox="0 0 20 20"><path d="m4 14.8-.6 2.8 2.8-.6L15.8 7.4a1.8 1.8 0 0 0-2.5-2.5zM12.3 6.4l1.3 1.3" /></svg>
                  </button>
                )}
              </div>
              {group.conversations.map((conversation) => (
            <div className="conversation-row" key={conversation.id}>
              <button
                className={`conversation-item ${mainView === "chat" && conversation.id === activeId ? "active" : ""}`}
                type="button"
                onClick={() => void selectConversation(conversation)}
              >
                <span className="conversation-title">
                  <span>{conversation.title || "新对话"}</span>
                  {(generatingIds[conversation.id] || preparingIds[conversation.id]) && (
                    <span
                      className={`conversation-runtime-mark ${generatingIds[conversation.id] ? "generating" : "preparing"}`}
                      aria-label={generatingIds[conversation.id] ? "正在生成" : "正在准备"}
                      title={generatingIds[conversation.id] ? "正在生成" : "正在准备"}
                    />
                  )}
                  {unreadIds[conversation.id] && conversation.id !== activeId && !generatingIds[conversation.id] && (
                    <span className="conversation-unread-mark" aria-label="有新的后台回复" title="有新的后台回复" />
                  )}
                </span>
                <time>
                  {new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(
                    conversation.updatedAt,
                  )}
                </time>
              </button>
              <div className="conversation-actions">
                <button
                  className="conversation-action rename"
                  type="button"
                  aria-label={`重命名${conversation.title || "新对话"}`}
                  title="重命名"
                  onClick={() => void renameConversation(conversation)}
                >
                  <svg aria-hidden="true" viewBox="0 0 24 24"><path d="m4 16.8-.8 3.2 3.2-.8L18.2 7.4a2 2 0 0 0-2.8-2.8zM13.8 6.2l4 4" /></svg>
                </button>
                <button
                  className={`conversation-action pin ${conversation.pinned ? "active" : ""}`}
                  type="button"
                  disabled={conversation.messages.length === 0}
                  aria-label={`${conversation.pinned ? "取消置顶" : "置顶"}${conversation.title || "新对话"}`}
                  aria-pressed={conversation.pinned}
                  title={conversation.pinned ? "取消置顶" : "置顶"}
                  onClick={() => void toggleConversationPinned(conversation)}
                >
                  <svg aria-hidden="true" viewBox="0 0 24 24">
                    <path d="M12 17v5M5 3h14M7 3l1 7-3 4h14l-3-4 1-7" />
                  </svg>
                </button>
                <button
                  className="conversation-action delete"
                  type="button"
                  disabled={Boolean(generatingIds[conversation.id] || preparingIds[conversation.id])}
                  aria-label={`删除${conversation.title || "新对话"}`}
                  title="删除"
                  onClick={() => requestDeleteConversation(conversation)}
                >
                  <svg aria-hidden="true" viewBox="0 0 24 24">
                    <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v5M14 11v5" />
                  </svg>
                </button>
              </div>
            </div>
              ))}
            </section>
          )) : (
            <div className="conversation-search-empty">没有匹配的对话</div>
          )}
        </nav>

        <button
          className={`settings-button ${mainView === "settings" ? "active" : ""}`}
          type="button"
          onClick={() => openMainView("settings")}
        >
          <svg aria-hidden="true" viewBox="0 0 20 20"><circle cx="10" cy="10" r="2.5" /><path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M15.3 4.7l-1.4 1.4M6.1 13.9l-1.4 1.4" /></svg>
          设置
        </button>
      </aside>
      <div
        className="resize-handle resize-handle-sidebar"
        role="separator"
        aria-label="调整左侧栏宽度"
        aria-orientation="vertical"
        aria-valuemin={SIDEBAR_MIN_WIDTH}
        aria-valuemax={SIDEBAR_MAX_WIDTH}
        aria-valuenow={sidebarWidth}
        tabIndex={sidebarOpen ? 0 : -1}
        onPointerDown={(event) => beginResize("sidebar", event)}
      />

      <main className="chat-pane">
        <header className="chat-header">
          <div className="chat-header-inner">
            <div className="header-leading">
              {mainView !== "chat" && (
                <button
                  className="back-to-chat-button"
                  type="button"
                  aria-label="返回对话"
                  title="返回对话"
                  onClick={() => {
                    setMainView("chat");
                    setNotice({ conversationId: null, text: "" });
                  }}
                >
                  <svg aria-hidden="true" viewBox="0 0 20 20"><path d="M12.5 4.5 7 10l5.5 5.5" /><path d="M7.5 10H17" /></svg>
                </button>
              )}
              <div className="chat-heading">
                <h1>{pageTitle}</h1>
                {mainView === "chat" && (
                  <div className="chat-workspace-path" title={activeConversation?.workspacePath || "默认工作区"}>
                    <svg aria-hidden="true" viewBox="0 0 20 20"><path d="M2.8 5.8a1.5 1.5 0 0 1 1.5-1.5h4l1.6 1.8h6.3a1 1 0 0 1 1 1v7.6a1.5 1.5 0 0 1-1.5 1.5H4.3a1.5 1.5 0 0 1-1.5-1.5z" /></svg>
                    <span>{activeConversation?.workspaceName || (activeConversation?.workspacePath ? workspaceLabel(activeConversation.workspacePath) : "默认工作区")}</span>
                    {activeConversation?.workspacePath && <span className="chat-workspace-full-path">{activeConversation.workspacePath}</span>}
                    {activeConversation?.workspacePath && (
                      <button
                        className="chat-workspace-clear"
                        type="button"
                        aria-label="清除当前工作区"
                        title="清除工作区，使用默认目录"
                        disabled={activeConversationGenerating || preparingIds[activeId]}
                        onClick={() => void clearConversationWorkspace()}
                      >
                        <WorkspaceClearIcon />
                      </button>
                    )}
                  </div>
                )}
                <p>{pageSubtitle}</p>
              </div>
            </div>
            <div className="header-actions">
              {mainView === "chat" && (
                <span className={`header-runtime-status ${activeConversationGenerating ? "active" : ""}`}>
                  {activeConversationGenerating
                    ? (activeStream?.status ?? "生成中")
                    : preparingIds[activeId]
                      ? "后台连接中 · 可输入"
                      : runtimeHost.ready
                        ? "可用"
                        : "Runtime 启动中 · 可输入"}
                </span>
              )}
              {mainView === "chat" && activeConversation && (
                <div className="export-menu">
                  <button
                    className="runtime-button export-button"
                    type="button"
                    aria-haspopup="menu"
                    aria-expanded={exportOpen}
                    onClick={() => setExportOpen((current) => !current)}
                  >
                    导出
                  </button>
                  {exportOpen && (
                    <div className="export-menu-popover" role="menu">
                      <button type="button" role="menuitem" onClick={() => exportConversation("markdown")}>导出 Markdown</button>
                      <button type="button" role="menuitem" onClick={() => exportConversation("json")}>导出 JSON</button>
                      <button type="button" role="menuitem" onClick={() => exportConversation("text")}>导出纯文本</button>
                    </div>
                  )}
                </div>
              )}
              {mainView === "chat" && (
                <button className="panel-toggle" type="button" aria-label="打开文件面板" title="打开文件面板" onClick={() => openRightPanel("files")}>
                  <svg aria-hidden="true" viewBox="0 0 20 20"><path d="M3.5 5.5a1.5 1.5 0 0 1 1.5-1.5h4l1.4 1.7H15a1.5 1.5 0 0 1 1.5 1.5v7.3A1.5 1.5 0 0 1 15 16H5a1.5 1.5 0 0 1-1.5-1.5z" /></svg>
                </button>
              )}
            </div>
          </div>
        </header>

        {mainView === "chat" && <>
        <section className="message-viewport" aria-live="polite">
          {loading ? (
            <div className="empty-state"><p>正在载入 Tao…</p></div>
          ) : activeConversation?.messages.length ? (
            <div className="message-column">
              {activeConversation.messages.map((message) => (
                <article className={`message ${message.role}`} key={message.id}>
                  {message.role === "error" && <div className="message-avatar">!</div>}
                  <div className="message-body">
                    {message.role === "error" && <div className="message-author">运行错误</div>}
                    {message.role === "assistant" && (
                      <ActivityPanel
                        activities={message.activities ?? messageActivities[message.id] ?? []}
                        thinking={message.thinking}
                        durationMs={message.durationMs}
                        thinkingOpen={messageThinkingOpen[message.id] ?? false}
                        open={messageActivityOpen[message.id] ?? false}
                        onToggle={() => toggleMessageActivity(message.id)}
                        onToggleThinking={() => toggleMessageThinking(message.id)}
                      />
                    )}
                    <div className="message-content">
                      {message.role === "assistant" ? (
                        <MarkdownContent
                          content={message.content}
                          messageId={message.id}
                          copiedKey={copiedKey}
                          onCopy={copyText}
                        />
                        ) : message.content}
                    </div>
                    {message.attachments && <AttachmentList attachments={message.attachments} />}
                    {message.role === "error" && message.retry && (
                      <button
                        className="message-retry-button"
                        type="button"
                        onClick={() => {
                          const conversationForRetry = activeConversation;
                          const userMessage = conversationForRetry?.messages
                            .slice(0, conversationForRetry.messages.indexOf(message))
                            .reverse()
                            .find((item) => item.role === "user");
                          if (conversationForRetry && userMessage) {
                            void retryFailedMessage(conversationForRetry, userMessage, message);
                          }
                        }}
                      >
                        重试
                      </button>
                    )}
                    {message.role === "assistant" && (
                      <button
                        className="message-copy-button"
                        type="button"
                        onClick={() => void copyText(message.content, `message-${message.id}`)}
                      >
                        {copiedKey === `message-${message.id}` ? "已复制" : "复制"}
                      </button>
                    )}
                    {message.status === "stopped" && <div className="message-status">已停止</div>}
                  </div>
                </article>
              ))}
              {activeStream && (
                <article className="message assistant pending">
                  <div className="message-body">
                    <ActivityPanel
                      activities={activeStream.activities}
                      thinking={activeStream.thinking}
                      durationMs={activeStream.completedMs}
                      startedAt={activeStream.startedAt}
                      nowMs={clockMs}
                      live={!activeStream.completed}
                      thinkingOpen={activeStream.thinkingOpen}
                      open={activeStream.activityOpen}
                      onToggle={() => toggleActivity(activeConversation.id)}
                      onToggleThinking={() => toggleStreamThinking(activeConversation.id)}
                    />
                    {!activeStream.text && !activeStream.thinking ? (
                      <div className="thinking-row"><span /><span /><span /></div>
                    ) : null}
                    {activeStream.text && (
                      <div className="message-content streaming-answer">
                        {activeStream.completed ? (
                          <MarkdownContent
                            content={activeStream.text}
                            messageId={`stream-${activeStream.requestId}`}
                            copiedKey={copiedKey}
                            onCopy={copyText}
                          />
                        ) : (
                          <div className="streaming-plain-text">{activeStream.text}</div>
                        )}
                        {!activeStream.completed && <span className="stream-cursor" aria-hidden="true" />}
                      </div>
                    )}
                    {activeStream.text && (
                      <button
                        className="message-copy-button streaming-copy-button"
                        type="button"
                        onClick={() => void copyText(activeStream.text, `stream-${activeStream.requestId}`)}
                      >
                        {copiedKey === `stream-${activeStream.requestId}` ? "已复制" : "复制回答"}
                      </button>
                    )}
                    {activeStream.queued.length > 0 && (
                      <div className="queued-messages" aria-label="已追加的消息">
                        {activeStream.queued.map((queued, index) => (
                          <div key={`${queued.behavior}-${index}`}>
                            <span>{queued.behavior === "steer" ? "调整" : "后续"}</span>
                            {queued.text}
                          </div>
                        ))}
                      </div>
                    )}
                    {!activeStream.completed && (
                      <div className="stream-status active-activity" aria-live="polite">{activeStream.status}</div>
                    )}
                    {activeStream.firstOutputMs !== undefined && (
                      <div className="stream-timing">
                        {activeStream.readyMs !== undefined && `准备 ${(activeStream.readyMs / 1000).toFixed(1)} 秒 · `}
                        首次输出 {(activeStream.firstOutputMs / 1000).toFixed(1)} 秒
                        {activeStream.completedMs !== undefined && ` · 完成 ${(activeStream.completedMs / 1000).toFixed(1)} 秒`}
                      </div>
                    )}
                  </div>
                </article>
              )}
              <div ref={messagesEnd} />
            </div>
          ) : (
            <div className="empty-state">
              <div className="empty-mark">T</div>
              <h2>今天想做什么？</h2>
              <p>选择模型后，发送一条消息验证 Tao 的连接。</p>
            </div>
          )}
        </section>

        <div className="composer-area">
          {notice.text && (notice.conversationId === null || notice.conversationId === activeId) && (
            <div className="notice">{notice.text}</div>
          )}
          {permissionRequest && (
            <section
              className={`permission-popover risk-${permissionRequest.risk}`}
              role="dialog"
              aria-modal="false"
              aria-labelledby="permission-popover-title"
            >
              <div className="permission-popover-header">
                <div>
                  <strong id="permission-popover-title">需要权限确认</strong>
                  <span>{permissionRequest.title} · {permissionRiskLabel(permissionRequest.risk)}</span>
                  <small>
                    来自 {permissionConversation?.title?.trim() || "后台会话"}
                    {permissionRequestIsBackground ? " · 后台等待中" : ""}
                  </small>
                </div>
                {permissionRequests.length > 1 && <small>+{permissionRequests.length - 1}</small>}
              </div>
              {(permissionRequest.command || permissionRequest.target) && (
                <code>{permissionRequest.command || permissionRequest.target}</code>
              )}
              <p>{permissionRequest.reason} {permissionTimeoutSeconds(permissionRequest.timeoutMs)} 秒后自动拒绝。</p>
              <div className="permission-popover-actions">
                {permissionRequestIsBackground && (
                  <button
                    type="button"
                    disabled={permissionSubmitting}
                    onClick={openPermissionConversation}
                  >
                    查看会话
                  </button>
                )}
                <button
                  type="button"
                  disabled={permissionSubmitting}
                  onClick={() => void answerPermissionRequest("deny")}
                >
                  拒绝
                </button>
                <button
                  type="button"
                  disabled={permissionSubmitting}
                  onClick={() => void answerPermissionRequest("allow_once")}
                >
                  本次允许
                </button>
                {permissionRequest.canRemember && (
                  <button
                    className="primary"
                    type="button"
                    disabled={permissionSubmitting}
                    onClick={() => void answerPermissionRequest("allow_session")}
                  >
                    本会话允许
                  </button>
                )}
              </div>
            </section>
          )}
          <form className="composer" onSubmit={(event) => void sendMessage(event)}>
            {messageAttachments.length > 0 && (
              <div className="composer-attachments" aria-label="待发送附件">
                {messageAttachments.map((attachment) => (
                  <div className="composer-attachment" key={attachment.path} title={attachment.path}>
                    <span className="composer-attachment-name">{attachment.name}</span>
                    <small>{formatFileSize(attachment.size)}</small>
                    <button
                      type="button"
                      aria-label={`移除附件 ${attachment.name}`}
                      title="移除附件"
                      onClick={() => removeMessageAttachment(attachment.path)}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
            <textarea
              aria-label="消息"
              disabled={loading}
              onChange={(event) => setInput(event.currentTarget.value)}
              onKeyDown={handleComposerKeyDown}
              placeholder={activeConversationGenerating ? "补充要求或排队下一条消息" : "向 Tao 提问"}
              rows={1}
              value={input}
            />
            <div className="composer-footer">
              <div className="composer-left-controls">
                <button
                  className="attachment-button"
                  type="button"
                  disabled={!activeConversation || activeConversationGenerating || Boolean(preparingIds[activeId])}
                  aria-label="添加附件"
                  title="添加附件（文本、Markdown、代码和配置文件）"
                  onClick={() => void chooseMessageAttachments()}
                >
                  <svg aria-hidden="true" viewBox="0 0 20 20"><path d="m7.2 10.8 4.9-4.9a2.6 2.6 0 0 1 3.7 3.7l-6.9 6.9a4 4 0 0 1-5.7-5.7l7-7" /><path d="m7.4 12.6 5.4-5.4" /></svg>
                </button>
                <select
                  className="permission-mode-select"
                  aria-label="权限模式"
                  disabled={!activeConversation || activeConversationGenerating || Boolean(preparingIds[activeId])}
                  value={activeConversation?.permissionMode ?? "ask"}
                  onChange={(event) => void updateActiveConversationPermissionMode(event.currentTarget.value as PermissionMode)}
                  title={`${permissionModeLabel(activeConversation?.permissionMode ?? "ask")}：${(activeConversation?.permissionMode ?? "ask") === "full_access" ? "本会话自动允许工具调用" : "高风险操作会询问确认"}`}
                >
                  <option value="ask">询问确认</option>
                  <option value="full_access">完全放行</option>
                </select>
                <button
                  className="workspace-selector workspace-selector-bottom"
                  type="button"
                  disabled={!activeConversation || activeConversationGenerating || preparingIds[activeId]}
                  onClick={() => void chooseConversationWorkspace()}
                  title={activeConversation?.workspacePath || "未选择工作区"}
                >
                  <svg aria-hidden="true" viewBox="0 0 20 20">
                    <path d="M2.8 5.8a1.5 1.5 0 0 1 1.5-1.5h4l1.6 1.8h6.3a1 1 0 0 1 1 1v7.6a1.5 1.5 0 0 1-1.5 1.5H4.3a1.5 1.5 0 0 1-1.5-1.5z" />
                  </svg>
                  <span>{activeConversation?.workspacePath ? workspaceLabel(activeConversation.workspacePath) : "默认工作区"}</span>
                </button>
                <span className="composer-shortcut">
                  {activeConversationGenerating ? "Enter 追加 · Shift+Enter 换行" : "Enter 发送 · Shift+Enter 换行"}
                </span>
              </div>
              <span>{activeConversationGenerating ? "Enter 追加 · Shift+Enter 换行" : "Enter 发送 · Shift+Enter 换行"}</span>
              <div className="composer-actions">
                <div className="model-chip-menu" aria-label="当前会话模型">
                  <button
                    className="model-chip-button"
                    type="button"
                    disabled={!activeConversation || activeConversationGenerating || Boolean(preparingIds[activeId])}
                    aria-haspopup="menu"
                    aria-expanded={modelMenuOpen}
                    onClick={() => setModelMenuOpen((current) => !current)}
                    title={`${activeProviderName} / ${activeConversation?.model ?? ""}`}
                  >
                    <span>{activeModelName}</span>
                    <small>{thinkingLevelLabel(activeConversation?.thinkingLevel ?? "medium")}</small>
                  </button>
                  {modelMenuOpen && activeConversation && (
                    <div className="model-config-popover" role="menu">
                      <label>
                        <span>Provider</span>
                        <select
                          aria-label="Provider"
                          value={activeConversation.provider}
                          onChange={(event) => void updateActiveConversationModel({
                            provider: event.currentTarget.value,
                          })}
                        >
                          {providerProfiles.map((provider) => (
                            <option key={provider.id} value={provider.id}>{provider.name}</option>
                          ))}
                        </select>
                      </label>
                      <label>
                        <span>Model</span>
                        <select
                          aria-label="模型"
                          value={activeConversation.model}
                          onChange={(event) => void updateActiveConversationModel({
                            model: event.currentTarget.value,
                          })}
                        >
                          {activeConversation.model && !activeConversationModels.some((model) => model.id === activeConversation.model) && (
                            <option value={activeConversation.model}>{activeConversation.model}</option>
                          )}
                          {activeConversationModels.map((model) => (
                            <option key={`${activeConversation.provider}/${model.id}`} value={model.id}>{model.name}</option>
                          ))}
                        </select>
                      </label>
                      <label>
                        <span>Thinking</span>
                        <select
                          aria-label="思考模式"
                          value={activeConversation.thinkingLevel}
                          onChange={(event) => void updateActiveConversationModel({
                            thinkingLevel: event.currentTarget.value as AppSettings["thinkingLevel"],
                          })}
                        >
                          <option value="off">关闭思考</option>
                          <option value="minimal">极简</option>
                          <option value="low">低</option>
                          <option value="medium">中</option>
                          <option value="high">高</option>
                          <option value="xhigh">极高</option>
                          <option value="max">最大</option>
                        </select>
                      </label>
                    </div>
                  )}
                </div>
                {activeConversationGenerating && (
                  <select
                    aria-label="追加方式"
                    value={queueBehavior}
                    onChange={(event) => setQueueBehavior(event.currentTarget.value as QueueBehavior)}
                  >
                    <option value="steer">立即调整</option>
                    <option value="follow_up">回答后继续</option>
                  </select>
                )}
                {activeConversationGenerating && input.trim() && (
                  <button className="queue-submit" type="submit" aria-label="追加消息" title="追加消息">
                    ↑
                  </button>
                )}
                {activeConversationGenerating ? (
                  <button
                    className="stop-button"
                    type="button"
                    disabled={activeStream?.stopping}
                    aria-label="停止生成"
                    title="停止生成"
                    onClick={() => void abortGeneration()}
                  >
                    <span aria-hidden="true" />
                  </button>
                ) : (
                  <button disabled={(!input.trim() && !messageAttachments.length) || loading} type="submit" aria-label="发送消息">
                    ↑
                  </button>
                )}
              </div>
            </div>
          </form>
          <p className="disclaimer">Tao 可能会出错，请核对重要信息。</p>
        </div>
        </>}

        {mainView === "customization" && (
          <section className="workspace-page">
            <nav className="workspace-subnav" aria-label="定制分类">
              <div className="workspace-subnav-title">Tao Runtime</div>
              {([
                ["overview", "概览"],
                ["prompt", "系统提示词"],
                ["context", "上下文"],
                ["session", "会话策略"],
                ["agent", "工具"],
                ["skills", "Skill"],
                ["extensions", "Extension"],
              ] as Array<[CustomizationSection, string]>).map(([section, label]) => (
                <button
                  className={customizationSection === section ? "active" : ""}
                  key={section}
                  type="button"
                  onClick={() => setCustomizationSection(section)}
                >
                  {label}
                  {!(["overview", "prompt", "agent", "skills"] as CustomizationSection[]).includes(section) && <small>规划中</small>}
                </button>
              ))}
            </nav>
            <div className="workspace-content">
              {notice.text && notice.conversationId === null && <div className="workspace-notice">{notice.text}</div>}
              {customizationSection === "overview" && (
                <div className="workspace-section">
                  <div className="workspace-heading">
                    <span className="eyebrow">定制工作台</span>
                    <h2>设计 Tao 的运行方式</h2>
                    <p>这里负责把产品配置映射到已有的 Prompt、Context、Session、Skill 和 Extension 能力。</p>
                  </div>
                  <div className="capability-grid">
                    <button type="button" onClick={() => setCustomizationSection("prompt")}>
                      <strong>系统提示词</strong><span>已接入</span><p>追加或替换默认提示词，并设置会话约束。</p>
                    </button>
                    <button type="button" onClick={() => setCustomizationSection("context")}>
                      <strong>上下文</strong><span>待接入</span><p>管理用户级、项目级上下文和注入顺序。</p>
                    </button>
                    <button type="button" onClick={() => setCustomizationSection("session")}>
                      <strong>会话策略</strong><span>待接入</span><p>管理压缩、恢复、分支和会话生命周期。</p>
                    </button>
                    <button type="button" onClick={() => setCustomizationSection("agent")}>
                      <strong>工具</strong><span>已接入</span><p>选择内置工具，并添加可以立即测试的自定义工具。</p>
                    </button>
                    <button type="button" onClick={() => setCustomizationSection("skills")}>
                      <strong>Skills</strong><span>已接入</span><p>从 Tao 的统一数据目录加载项目能力说明。</p>
                    </button>
                  </div>
                </div>
              )}
              {customizationSection === "prompt" && (
                <div className="workspace-section form-section">
                  <div className="workspace-heading">
                    <span className="eyebrow">Prompt</span>
                    <h2>系统提示词</h2>
                    <p>使用内置参数配置提示词，不修改已有会话历史。</p>
                  </div>
                  <label className="setting-row inline-setting">
                    <span><strong>启用提示词配置</strong><small>关闭后保留内容，但启动时不会加载。</small></span>
                    <input checked={runtimeDraft.enabled} type="checkbox" onChange={(event) => setRuntimeDraft({ ...runtimeDraft, enabled: event.currentTarget.checked })} />
                  </label>
                  <label className="setting-field">
                    <span>系统提示词模式</span>
                    <select value={runtimeDraft.systemPromptMode} onChange={(event) => setRuntimeDraft({ ...runtimeDraft, systemPromptMode: event.currentTarget.value as RuntimeConfiguration["systemPromptMode"] })}>
                      <option value="append">追加到默认提示词</option>
                      <option value="replace">替换默认提示词</option>
                    </select>
                    <small>追加模式保留默认 Agent 行为；替换模式适合完全自定义。</small>
                  </label>
                  <label className="setting-field">
                    <span>系统提示词</span>
                    <textarea rows={9} value={runtimeDraft.systemPrompt} onChange={(event) => setRuntimeDraft({ ...runtimeDraft, systemPrompt: event.currentTarget.value })} placeholder="例如：始终使用中文回答，先给结论，再给步骤。" />
                  </label>
                  <label className="setting-field">
                    <span>会话附加提示词</span>
                    <textarea rows={6} value={runtimeDraft.conversationPrompt} onChange={(event) => setRuntimeDraft({ ...runtimeDraft, conversationPrompt: event.currentTarget.value })} placeholder="应用到 Tao 每个会话的附加约束。" />
                  </label>
                  <div className="workspace-actions">
                    <span>保存位置：%USERPROFILE%\.tao\runtime\profile.json</span>
                    <button className="primary-button" disabled={anyConversationGenerating || anyConversationPreparing} type="button" onClick={() => void saveRuntimeConfiguration()}>保存配置</button>
                  </div>
                </div>
              )}
              {customizationSection === "agent" && (
                <div className="workspace-section form-section">
                  <div className="workspace-heading">
                    <span className="eyebrow">工具</span>
                    <h2>工具</h2>
                    <p>复用内置工具能力，再通过 Tao 配置自己的工具。保存后，新建或重新连接的会话会使用这里的配置。</p>
                  </div>
                  <label className="setting-field">
                    <span>工具模式</span>
                    <select
                      value={runtimeDraft.toolMode}
                      onChange={(event) => updateRuntimeDraft({
                        toolMode: event.currentTarget.value as RuntimeConfiguration["toolMode"],
                      })}
                    >
                      <option value="default">默认 Coding Agent</option>
                      <option value="custom">自定义工具组合</option>
                    </select>
                    <small>默认模式由内置工具策略决定；自定义模式只启用下面勾选的内置工具和自定义工具。</small>
                  </label>

                  <div className={`customization-block tool-selection-block ${runtimeDraft.toolMode === "default" ? "readonly" : ""}`}>
                    <div className="customization-block-heading">
                      <div>
                        <strong>内置工具</strong>
                        <span>
                          {runtimeDraft.toolMode === "default"
                            ? "当前由内置工具策略决定，勾选状态仅用于展示。"
                            : "勾选当前工具组合可以使用的内置能力。"}
                        </span>
                      </div>
                      {runtimeDraft.toolMode === "custom" && (
                        <button
                          className="text-button"
                          type="button"
                          onClick={() => updateRuntimeDraft({
                            enabledTools: [...BUILTIN_TOOL_OPTIONS.map(([name]) => name)],
                          })}
                        >
                          全部启用
                        </button>
                      )}
                    </div>
                   <div className="tool-option-grid">
                     {BUILTIN_TOOL_OPTIONS.map(([name, label]) => {
                        const checked = runtimeDraft.toolMode === "default"
                          ? DEFAULT_BUILTIN_TOOL_NAMES.includes(name)
                          : runtimeDraft.enabledTools.includes(name);
                        return (
                          <label className={`tool-option ${checked ? "checked" : ""}`} key={name}>
                            <input
                              checked={checked}
                              disabled={runtimeDraft.toolMode === "default"}
                              type="checkbox"
                              onChange={(event) => {
                                const next = event.currentTarget.checked
                                  ? [...runtimeDraft.enabledTools, name]
                                  : runtimeDraft.enabledTools.filter((tool) => tool !== name);
                                updateRuntimeDraft({ enabledTools: [...new Set(next)] });
                              }}
                            />
                            <span>
                              <strong>{label}</strong>
                              <small>{name}</small>
                            </span>
                          </label>
                       );
                     })}
                   </div>
                 </div>

                  <div className="customization-block tool-selection-block custom-tool-selection-block">
                    <div className="customization-block-heading">
                      <div>
                        <strong>自定义工具集</strong>
                        <span>这里的勾选直接决定哪些自定义工具会注册到当前 Agent。</span>
                      </div>
                      {(runtimeDraft.customTools ?? []).length > 0 && (
                        <button
                          className="text-button"
                          type="button"
                          onClick={() => updateRuntimeDraft({
                            customTools: (runtimeDraft.customTools ?? []).map((tool) => ({ ...tool, enabled: true })),
                          })}
                        >
                          全部启用
                        </button>
                      )}
                    </div>
                    {(runtimeDraft.customTools ?? []).length === 0 ? (
                      <div className="custom-tools-empty compact-empty">
                        <span>还没有自定义工具</span>
                        <small>点击下方“新增工具”创建一个工具后，它会出现在这里。</small>
                      </div>
                    ) : (
                      <div className="tool-option-grid">
                        {(runtimeDraft.customTools ?? []).map((tool) => {
                          const permissionMode = tool.permissionMode ?? "ask";
                          return (
                            <label className={`tool-option ${tool.enabled ? "checked" : ""}`} key={`selection-${tool.id}`}>
                              <input
                                checked={tool.enabled}
                                type="checkbox"
                                onChange={(event) => updateCustomTool(tool.id, { enabled: event.currentTarget.checked })}
                              />
                              <span>
                                <strong>{tool.label || tool.name || "未命名工具"}</strong>
                                <small>{tool.name || "未设置名称"} · {customToolPermissionModeLabel(permissionMode)}</small>
                              </span>
                            </label>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  <div className="customization-block custom-tools-block">
                    <div className="customization-block-heading">
                      <div>
                        <strong>自定义工具</strong>
                        <span>先填写工具定义，再在上面的自定义工具集中决定是否启用。</span>
                      </div>
                      <button className="secondary-button compact-button" type="button" onClick={addCustomTool}>
                        新增工具
                      </button>
                    </div>
                    <div className="custom-tool-guide">
                      <strong>填写示例</strong>
                      <span>
                        例如创建 <code>search_docs</code>：显示名称写“搜索文档”，描述写清楚模型什么时候使用；
                        命令工具可使用 <code>{"{{query}}"}</code>，完整 JSON 参数会放在 <code>TAO_TOOL_INPUT_JSON</code>。
                      </span>
                      <span>
                        输入 Schema 示例：<code>{'{"query":"关键词"}'}</code>。HTTP 工具则填写 URL 模板、请求头和请求体模板。
                      </span>
                    </div>
                    {(runtimeDraft.customTools ?? []).length === 0 ? (
                      <div className="custom-tools-empty">
                        <span>还没有自定义工具</span>
                        <small>新增后会自动带有一个可运行的命令示例，权限默认是“询问确认”。</small>
                      </div>
                    ) : (
                      <div className="custom-tools-list">
                        {(runtimeDraft.customTools ?? []).map((tool) => (
                          <section className="custom-tool-card" key={tool.id}>
                            <div className="custom-tool-card-header">
                              <div>
                                <strong>{tool.label || tool.name || "未命名工具"}</strong>
                                <small>{tool.name || "未设置名称"}</small>
                              </div>
                              <div className="custom-tool-card-actions">
                                <label className="compact-switch">
                                  <input
                                    checked={tool.enabled}
                                    type="checkbox"
                                    onChange={(event) => updateCustomTool(tool.id, { enabled: event.currentTarget.checked })}
                                  />
                                  <span>启用</span>
                                </label>
                                <button className="icon-text-button danger-text-button" type="button" onClick={() => removeCustomTool(tool.id)}>
                                  删除
                                </button>
                              </div>
                            </div>
                            <div className="two-column-settings custom-tool-fields">
                              <label className="setting-field">
                                <span>工具名称</span>
                                <input
                                  value={tool.name}
                                  placeholder="例如 search_docs"
                                  onChange={(event) => updateCustomTool(tool.id, {
                                    name: event.currentTarget.value,
                                    id: tool.id === tool.name ? event.currentTarget.value : tool.id,
                                  })}
                                />
                                <small>只能使用字母、数字、下划线和连字符。</small>
                              </label>
                              <label className="setting-field">
                                <span>显示名称</span>
                                <input
                                  value={tool.label}
                                  placeholder="例如 搜索文档"
                                  onChange={(event) => updateCustomTool(tool.id, { label: event.currentTarget.value })}
                                />
                              </label>
                            </div>
                            <label className="setting-field">
                              <span>工具描述</span>
                              <input
                                value={tool.description}
                                placeholder="告诉模型什么时候应该使用这个工具"
                                onChange={(event) => updateCustomTool(tool.id, { description: event.currentTarget.value })}
                              />
                            </label>
                            <div className="two-column-settings custom-tool-meta-fields">
                              <label className="setting-field">
                                <span>执行方式</span>
                                <select
                                  value={tool.kind}
                                  onChange={(event) => updateCustomTool(tool.id, { kind: event.currentTarget.value as CustomToolConfiguration["kind"] })}
                                >
                                  <option value="command">命令</option>
                                  <option value="http">HTTP 请求</option>
                                </select>
                                <small>命令在当前工作区执行；HTTP 按模板请求远程地址。</small>
                              </label>
                              <label className="setting-field">
                                <span>权限模式</span>
                                <select
                                  value={tool.permissionMode ?? "ask"}
                                  onChange={(event) => updateCustomTool(tool.id, {
                                    permissionMode: event.currentTarget.value as CustomToolPermissionMode,
                                  })}
                                >
                                  <option value="ask">询问确认</option>
                                  <option value="allow">自动允许</option>
                                  <option value="deny">禁止执行</option>
                                </select>
                                <small>模型调用此工具时生效；新工具默认询问确认。</small>
                              </label>
                            </div>
                            {tool.kind === "command" ? (
                              <label className="setting-field">
                                <span>命令模板</span>
                                <textarea
                                  rows={3}
                                  value={tool.command}
                                  placeholder="例如：node -e &quot;console.log(process.env.TAO_TOOL_INPUT_JSON)&quot;"
                                  onChange={(event) => updateCustomTool(tool.id, { command: event.currentTarget.value })}
                                />
                                <small>可以使用 {"{{input}}"} 或 {"{{字段名}}"}。完整参数 JSON 也会放在 TAO_TOOL_INPUT_JSON 环境变量中。</small>
                              </label>
                            ) : (
                              <div className="two-column-settings">
                                <label className="setting-field">
                                  <span>请求方法</span>
                                  <select value={tool.method || "GET"} onChange={(event) => updateCustomTool(tool.id, { method: event.currentTarget.value })}>
                                    <option value="GET">GET</option>
                                    <option value="POST">POST</option>
                                    <option value="PUT">PUT</option>
                                    <option value="PATCH">PATCH</option>
                                    <option value="DELETE">DELETE</option>
                                  </select>
                                </label>
                                <label className="setting-field">
                                  <span>URL 模板</span>
                                  <input value={tool.url} placeholder="https://example.com/api?q={{input}}" onChange={(event) => updateCustomTool(tool.id, { url: event.currentTarget.value })} />
                                </label>
                                <label className="setting-field">
                                  <span>请求头 JSON</span>
                                  <textarea rows={3} value={tool.headers} placeholder={'{"Authorization":"Bearer ..."}'} onChange={(event) => updateCustomTool(tool.id, { headers: event.currentTarget.value })} />
                                </label>
                                <label className="setting-field">
                                  <span>请求体模板</span>
                                  <textarea rows={3} value={tool.bodyTemplate} placeholder={'{"input":"{{input}}"}'} onChange={(event) => updateCustomTool(tool.id, { bodyTemplate: event.currentTarget.value })} />
                                </label>
                              </div>
                            )}
                            <label className="setting-field">
                              <span>输入 Schema</span>
                              <textarea
                                rows={6}
                                value={tool.inputSchema}
                                placeholder={DEFAULT_CUSTOM_TOOL_SCHEMA}
                                onChange={(event) => updateCustomTool(tool.id, { inputSchema: event.currentTarget.value })}
                              />
                              <small>必须是 object 类型的 JSON Schema。留空时使用 input 字符串参数。</small>
                            </label>
                            <div className="custom-tool-test">
                              <div className="custom-tool-test-heading">
                                <strong>立即测试</strong>
                                <span>{activeWorkspacePath ? `当前工作区：${workspaceLabel(activeWorkspacePath)}` : "使用默认工作区"}</span>
                              </div>
                              <textarea
                                rows={3}
                                value={customToolTestInput}
                                onChange={(event) => setCustomToolTestInput(event.currentTarget.value)}
                                placeholder={'{"input":"测试输入"}'}
                              />
                              <div className="custom-tool-test-actions">
                                <button
                                  className="secondary-button compact-button"
                                  disabled={testingCustomToolId !== null}
                                  type="button"
                                  onClick={() => void testCustomTool(tool)}
                                >
                                  {testingCustomToolId === tool.id ? "测试中…" : "测试工具"}
                                </button>
                                {customToolTestOutput && <pre>{customToolTestOutput}</pre>}
                              </div>
                            </div>
                          </section>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="workspace-actions">
                    <span>保存位置：%USERPROFILE%\.tao\runtime\profile.json</span>
                    <button className="primary-button" disabled={anyConversationGenerating || anyConversationPreparing} type="button" onClick={() => void saveRuntimeConfiguration()}>保存配置</button>
                  </div>
                </div>
              )}
              {customizationSection === "skills" && (
                <div className="workspace-section form-section">
                  <div className="workspace-heading">
                    <span className="eyebrow">Skills</span>
                    <h2>Tao Skills</h2>
                    <p>Skills 是放在 Tao 产品数据目录中的可组合能力说明。每个 Skill 使用一个目录，并在目录中放置 SKILL.md。</p>
                  </div>
                  <label className="setting-row inline-setting">
                    <span><strong>启用 Tao Skills</strong><small>启用后，Runtime 会从下面的目录发现并加载 Skills。</small></span>
                    <input checked={runtimeDraft.skillsEnabled} type="checkbox" onChange={(event) => updateRuntimeDraft({ skillsEnabled: event.currentTarget.checked })} />
                  </label>
                  <div className="settings-card skill-path-card">
                    <span className="skill-path-label">Skills 目录</span>
                    <code>%USERPROFILE%\.tao\skills</code>
                    <p>这是 Tao 的统一目录，不需要额外维护产品外部的 Pi 配置目录。保存配置时会自动创建该目录。</p>
                  </div>
                  <div className="workspace-actions">
                    <span>当前只接入 Skill 加载；Extension Hooks 后续单独设计。</span>
                    <button className="primary-button" disabled={anyConversationGenerating || anyConversationPreparing} type="button" onClick={() => void saveRuntimeConfiguration()}>保存配置</button>
                  </div>
                </div>
              )}
              {(["context", "session", "extensions"] as CustomizationSection[]).includes(customizationSection) && (
                <div className="workspace-section placeholder-section">
                  <div className="placeholder-icon">◇</div>
                  <h2>{customizationSection === "context" ? "上下文" : customizationSection === "session" ? "会话策略" : "Extension"}</h2>
                  <p>页面入口已经预留，后续会在明确配置边界后接入。</p>
                </div>
              )}
            </div>
          </section>
        )}

        {mainView === "settings" && (
          <section className="workspace-page">
            <nav className="workspace-subnav" aria-label="设置分类">
              <div className="workspace-subnav-title">设置</div>
              {([
                ["models", "模型与 Provider"],
                ["appearance", "外观"],
                ["language", "语言"],
                ["data", "数据与会话"],
                ["runtime", "Runtime"],
                ["about", "关于 Tao"],
              ] as Array<[SettingsSection, string]>).map(([section, label]) => (
                <button className={settingsSection === section ? "active" : ""} key={section} type="button" onClick={() => setSettingsSection(section)}>{label}</button>
              ))}
            </nav>
            <div className="workspace-content">
              {notice.text && notice.conversationId === null && <div className="workspace-notice">{notice.text}</div>}
              {settingsSection === "models" ? (
                <div className="workspace-section form-section">
                  <div className="workspace-heading">
                    <span className="eyebrow">模型</span>
                    <h2>模型与 Provider</h2>
                    <p>管理全局 Provider、认证和新会话使用的默认模型。</p>
                  </div>
                  <div className="provider-manager-toolbar">
                    <div>
                      <strong className="provider-list-title">Provider 配置</strong>
                      <p className="provider-list-description">内置 Provider 和已保存的网关配置会分别显示在这里。</p>
                    </div>
                    <button className="provider-add-button" type="button" onClick={addProvider}>
                      <span className="provider-add-icon" aria-hidden="true">+</span>
                      <span>新增 Provider</span>
                    </button>
                  </div>
                  <div className="provider-list">
                    {settingsProviderProfiles.map((provider) => {
                      const isExpanded = provider.id === expandedProviderId;
                      const isSaved = settings.providers.some((item) => item.id === provider.id);
                      const isDefault = provider.id === settings.provider;
                      const modelSelection = providerModelSelections[provider.id]
                        ?? (isDefault ? settings.model : provider.models[0]?.id ?? "");
                      return (
                        <section className={`provider-card ${isExpanded ? "expanded" : ""}`} key={provider.id}>
                          <button
                            className="provider-card-header"
                            type="button"
                            aria-expanded={isExpanded}
                            onClick={() => toggleProviderCard(provider.id)}
                          >
                            <span className="provider-card-heading">
                              <strong>{provider.name || provider.id}</strong>
                              <span>{provider.id}</span>
                            </span>
                            <span className="provider-card-meta">
                              <span className={`provider-source ${isSaved ? "saved" : "builtin"}`}>{isSaved ? "已保存" : "内置"}</span>
                              <span>{provider.models.length ? `${provider.models.length} 个模型` : "未获取模型"}</span>
                              {isDefault && <span className="provider-default-badge">新会话默认</span>}
                              <span className="provider-card-chevron" aria-hidden="true">{isExpanded ? "−" : "+"}</span>
                            </span>
                          </button>
                          {isExpanded && (
                            <div className="provider-card-body">
                              <div className="settings-card-inner two-column-settings">
                                <label className="setting-field">
                                  <span>Provider ID</span>
                                  <input readOnly value={providerDraft.id} />
                                  <small>ID 用于认证和会话引用，创建后保持不变。</small>
                                </label>
                                <label className="setting-field">
                                  <span>显示名称</span>
                                  <input value={providerDraft.name} onChange={(event) => updateProviderDraft({ name: event.currentTarget.value })} />
                                </label>
                                <label className="setting-field">
                                  <span>Base URL</span>
                                  <input
                                    autoComplete="off"
                                    placeholder="例如 https://example.com/v1"
                                    type="url"
                                    value={providerDraft.baseUrl}
                                    onChange={(event) => {
                                      updateProviderDraft({ baseUrl: event.currentTarget.value });
                                      setConnectionStatus(null);
                                    }}
                                  />
                                  <small>兼容 OpenAI 接口的网关地址；内置 Provider 可以留空。</small>
                                </label>
                                <label className="setting-field">
                                  <span>API 协议</span>
                                  <select value={providerDraft.api} onChange={(event) => updateProviderDraft({ api: event.currentTarget.value as AppSettings["api"] })}>
                                    <option value="openai-completions">OpenAI Chat Completions</option>
                                    <option value="openai-responses">OpenAI Responses</option>
                                  </select>
                                </label>
                              </div>
                              <label className="setting-field">
                                <span>API key</span>
                                <input
                                  autoComplete="off"
                                  placeholder={providerAuthConfigured[providerDraft.id] ? "已保存，留空保持不变" : "输入 API key"}
                                  type="password"
                                  value={apiKey}
                                  onChange={(event) => {
                                    const value = event.currentTarget.value;
                                    setApiKey(value);
                                    setApiKeys((current) => ({ ...current, [providerDraft.id]: value }));
                                    setConnectionStatus(null);
                                  }}
                                />
                                <small>保存到 .tao/auth.json，界面不会重新显示明文。</small>
                              </label>
                              <div className="connection-test-row">
                                <button
                                  className="secondary-button"
                                  disabled={!providerDraft.baseUrl.trim() || (!apiKey.trim() && !providerAuthConfigured[providerDraft.id]) || testingConnection}
                                  type="button"
                                  onClick={() => void testConnection()}
                                >
                                  {testingConnection ? "正在连接…" : "测试连接并获取模型"}
                                </button>
                                {connectionStatus && <p className={`connection-result ${connectionStatus.ok ? "success" : "error"}`}>{connectionStatus.text}</p>}
                              </div>
                              <div className="provider-model-picker">
                                <label className="setting-field">
                                  <span>历史模型</span>
                                  <select
                                    disabled={providerDraft.models.length === 0}
                                    value={modelSelection}
                                    onChange={(event) => {
                                      const modelId = event.currentTarget.value;
                                      setProviderModelSelections((current) => ({ ...current, [providerDraft.id]: modelId }));
                                      if (providerDraft.id === settings.provider) {
                                        setSettings((current) => ({ ...current, model: modelId }));
                                      }
                                    }}
                                  >
                                    {providerDraft.models.length === 0
                                      ? <option value="">尚未获取模型</option>
                                      : providerDraft.models.map((model) => (
                                        <option key={`${providerDraft.id}/${model.id}`} value={model.id}>{model.name} ({model.id})</option>
                                      ))}
                                  </select>
                                  <small>这里显示该 Provider 最近一次获取到并保存的模型；底部会话栏可以切换当前会话模型。</small>
                                </label>
                                {!isDefault && providerDraft.models.length > 0 && (
                                  <button className="secondary-button provider-default-button" type="button" onClick={() => setDefaultProvider(providerDraft.id, modelSelection)}>
                                    设为新会话默认
                                  </button>
                                )}
                              </div>
                              {isDefault && <div className="provider-current-note">当前是新会话默认 Provider。</div>}
                              <div className="provider-card-actions">
                                <button
                                  className="danger-button"
                                  disabled={isDefault || !isSaved}
                                  type="button"
                                  onClick={() => removeProvider(provider.id)}
                                >
                                  删除 Provider
                                </button>
                              </div>
                            </div>
                          )}
                        </section>
                      );
                    })}
                  </div>
                  <div className="settings-card provider-manager-card legacy-provider-manager">
                    <div className="provider-manager-toolbar">
                      <label className="setting-field provider-picker">
                        <span>当前 Provider</span>
                        <select value={selectedSettingsProvider} onChange={(event) => selectSettingsProvider(event.currentTarget.value)}>
                          {providerProfiles.map((provider) => (
                            <option key={provider.id} value={provider.id}>{provider.name} · {provider.id}</option>
                          ))}
                        </select>
                      </label>
                      <div className="provider-manager-actions">
                        <button className="secondary-button" type="button" onClick={addProvider}>新增 Provider</button>
                        <button
                          className="danger-button"
                          disabled={selectedSettingsProvider === settings.provider || !settings.providers.some((provider) => provider.id === selectedSettingsProvider)}
                          type="button"
                          onClick={() => removeProvider(selectedSettingsProvider)}
                        >
                          删除
                        </button>
                      </div>
                    </div>
                    <div className="settings-card-inner two-column-settings">
                      <label className="setting-field">
                        <span>Provider ID</span>
                        <input readOnly value={providerDraft.id} />
                        <small>ID 用于认证和会话引用，创建后保持不变。</small>
                      </label>
                      <label className="setting-field">
                        <span>显示名称</span>
                        <input value={providerDraft.name} onChange={(event) => updateProviderDraft({ name: event.currentTarget.value })} />
                      </label>
                      <label className="setting-field">
                        <span>Base URL</span>
                        <input
                          autoComplete="off"
                          placeholder="例如 https://example.com/v1"
                          type="url"
                          value={providerDraft.baseUrl}
                          onChange={(event) => {
                            updateProviderDraft({ baseUrl: event.currentTarget.value });
                            setConnectionStatus(null);
                          }}
                        />
                        <small>中转站或兼容 OpenAI 接口的网关地址；内置 Provider 可留空。</small>
                      </label>
                      <label className="setting-field">
                        <span>API 协议</span>
                        <select value={providerDraft.api} onChange={(event) => updateProviderDraft({ api: event.currentTarget.value as AppSettings["api"] })}>
                          <option value="openai-completions">OpenAI Chat Completions</option>
                          <option value="openai-responses">OpenAI Responses</option>
                        </select>
                      </label>
                    </div>
                    <label className="setting-field">
                      <span>API key</span>
                      <input
                        autoComplete="off"
                        placeholder={providerAuthConfigured[providerDraft.id] ? "已保存，留空保持不变" : "输入 API key"}
                        type="password"
                        value={apiKey}
                        onChange={(event) => {
                          const value = event.currentTarget.value;
                          setApiKey(value);
                          setApiKeys((current) => ({ ...current, [providerDraft.id]: value }));
                          setConnectionStatus(null);
                        }}
                      />
                      <small>保存到 .tao/auth.json，界面不会重新显示明文。</small>
                    </label>
                    <div className="connection-test-row">
                      <button
                        className="secondary-button"
                        disabled={!providerDraft.baseUrl.trim() || (!apiKey.trim() && !providerAuthConfigured[providerDraft.id]) || testingConnection}
                        type="button"
                        onClick={() => void testConnection()}
                      >
                        {testingConnection ? "正在连接…" : "测试连接并获取模型"}
                      </button>
                      {connectionStatus && <p className={`connection-result ${connectionStatus.ok ? "success" : "error"}`}>{connectionStatus.text}</p>}
                    </div>
                    <div className="provider-model-summary">
                      <div>
                        <strong>可用模型</strong>
                        <span>{providerDraft.models.length ? `${providerDraft.models.length} 个` : "尚未获取"}</span>
                      </div>
                      {providerDraft.models.length > 0 && (
                        <p>{providerDraft.models.map((model) => model.name || model.id).join(" · ")}</p>
                      )}
                    </div>
                  </div>
                  <div className="settings-card two-column-settings">
                    <label className="setting-field">
                      <span>新会话默认 Provider</span>
                      <select value={settings.provider} onChange={(event) => setDefaultProvider(event.currentTarget.value)}>
                        {providerProfiles.map((provider) => <option key={provider.id} value={provider.id}>{provider.name} · {provider.id}</option>)}
                      </select>
                      <small>只影响新建会话，已有会话保留自己的 Provider 和模型。</small>
                    </label>
                    <label className="setting-field">
                      <span>新会话默认模型</span>
                      <select
                        value={settings.model}
                        onChange={(event) => {
                          const modelId = event.currentTarget.value;
                          setSettings((current) => ({ ...current, model: modelId }));
                          setProviderModelSelections((current) => ({ ...current, [settings.provider]: modelId }));
                        }}
                      >
                        {!defaultProviderModels.some((model) => model.id === settings.model) && <option value={settings.model}>{settings.model}</option>}
                        {defaultProviderModels.map((model) => <option key={`${settings.provider}/${model.id}`} value={model.id}>{model.name} ({model.id})</option>)}
                      </select>
                      <small>模型列表来自内置目录或当前 Provider 最近一次获取的远程列表。</small>
                    </label>
                    <label className="setting-field"><span>默认思考模式</span><select value={settings.thinkingLevel} onChange={(event) => setSettings({ ...settings, thinkingLevel: event.currentTarget.value as AppSettings["thinkingLevel"] })}><option value="off">关闭</option><option value="minimal">极简</option><option value="low">低</option><option value="medium">中</option><option value="high">高</option><option value="xhigh">极高</option><option value="max">最大</option></select></label>
                  </div>
                  <div className="workspace-actions"><span>配置保存在 %USERPROFILE%\.tao</span><button className="primary-button" disabled={anyConversationGenerating || anyConversationPreparing} type="button" onClick={() => void saveModelSettings()}>保存设置</button></div>
                </div>
              ) : settingsSection === "appearance" ? (
                <div className="workspace-section form-section">
                  <div className="workspace-heading">
                    <span className="eyebrow">外观</span>
                    <h2>界面主题与强调色</h2>
                    <p>先选择整个 Tao 的明暗主题，再用强调色区分当前会话、工具状态和主要交互。</p>
                  </div>
                  <div className="appearance-setting-group">
                    <div className="appearance-setting-heading">
                      <strong>界面主题</strong>
                      <span>主题会应用到聊天、设置、工作过程、文件预览和权限确认。</span>
                    </div>
                    <div className="theme-choice-grid" role="radiogroup" aria-label="界面主题">
                      {THEME_OPTIONS.map((option) => (
                        <button
                          className={`theme-choice ${settings.theme === option.id ? "active" : ""}`}
                          key={option.id}
                          type="button"
                          role="radio"
                          aria-checked={settings.theme === option.id}
                          onClick={() => setSettings((current) => ({ ...current, theme: option.id }))}
                        >
                          <span className={`theme-choice-preview ${option.id}`} aria-hidden="true">
                            <span />
                            <span />
                            <span />
                          </span>
                          <span className="theme-choice-copy">
                            <strong>{option.label}</strong>
                            <small>{option.description}</small>
                          </span>
                          {settings.theme === option.id && <span className="theme-choice-mark" aria-hidden="true">✓</span>}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="appearance-setting-group accent-setting-group">
                    <div className="appearance-setting-heading">
                      <strong>强调色</strong>
                      <span>用于选中状态、主要按钮、焦点边框和权限提示，不会把整页染成单一颜色。</span>
                    </div>
                  <div className="accent-choice-grid" role="radiogroup" aria-label="界面强调色">
                    {ACCENT_OPTIONS.map((option) => (
                      <button
                        className={`accent-choice ${settings.accentColor === option.id ? "active" : ""}`}
                        key={option.id}
                        type="button"
                        role="radio"
                        aria-checked={settings.accentColor === option.id}
                        onClick={() => setSettings((current) => ({ ...current, accentColor: option.id }))}
                      >
                        <span className="accent-swatch" style={{ background: option.color }} aria-hidden="true" />
                        <span className="accent-choice-copy">
                          <strong>{option.label}</strong>
                          <small>{settings.accentColor === option.id ? "当前使用" : "点击应用"}</small>
                        </span>
                        {settings.accentColor === option.id && <span className="accent-choice-mark" aria-hidden="true">✓</span>}
                      </button>
                      ))}
                  </div>
                  </div>
                  <div className="workspace-actions">
                    <span>
                      当前主题：{THEME_OPTIONS.find((option) => option.id === settings.theme)?.label ?? "浅色"}
                      {" · "}
                      当前强调色：{ACCENT_OPTIONS.find((option) => option.id === settings.accentColor)?.label ?? "Tao"}
                    </span>
                    <button className="primary-button" disabled={anyConversationGenerating || anyConversationPreparing} type="button" onClick={() => void saveModelSettings()}>保存设置</button>
                  </div>
                </div>
              ) : settingsSection === "runtime" ? (
                <div className="workspace-section form-section">
                  <div className="workspace-heading">
                    <span className="eyebrow">权限</span>
                    <h2>权限确认</h2>
                    <p>设置工具执行需要确认时的等待时间。超时后会自动拒绝，不会继续挂起当前回答。</p>
                  </div>
                  <div className="settings-card two-column-settings">
                    <label className="setting-field">
                      <span>确认超时</span>
                      <div className="timeout-input-row">
                        <input
                          min={5}
                          max={600}
                          step={5}
                          type="number"
                          value={permissionTimeoutSeconds(settings.permissionTimeoutMs)}
                          onChange={(event) => {
                            const seconds = Number(event.currentTarget.value);
                            const nextSeconds = Number.isFinite(seconds)
                              ? Math.min(600, Math.max(5, Math.round(seconds)))
                              : 60;
                            setSettings((current) => ({
                              ...current,
                              permissionTimeoutMs: nextSeconds * 1000,
                            }));
                          }}
                        />
                        <span>秒</span>
                      </div>
                      <small>适用于所有会话的询问确认；完全放行模式不会弹出确认。</small>
                    </label>
                    <label className="setting-field">
                      <span>当前策略</span>
                      <select
                        value={permissionTimeoutSeconds(settings.permissionTimeoutMs)}
                        onChange={(event) => {
                          setSettings((current) => ({
                            ...current,
                            permissionTimeoutMs: Number(event.currentTarget.value) * 1000,
                          }));
                        }}
                      >
                        {![15, 30, 60, 120, 300].includes(permissionTimeoutSeconds(settings.permissionTimeoutMs)) && (
                          <option value={permissionTimeoutSeconds(settings.permissionTimeoutMs)}>
                            自定义 {permissionTimeoutSeconds(settings.permissionTimeoutMs)} 秒
                          </option>
                        )}
                        <option value={15}>15 秒</option>
                        <option value={30}>30 秒</option>
                        <option value={60}>60 秒</option>
                        <option value={120}>120 秒</option>
                        <option value={300}>300 秒</option>
                      </select>
                      <small>左侧可以输入自定义秒数，范围 5 到 600 秒。</small>
                    </label>
                  </div>
                  <div className="workspace-actions">
                    <span>当前超时：{permissionTimeoutSeconds(settings.permissionTimeoutMs)} 秒</span>
                    <button className="primary-button" disabled={anyConversationGenerating || anyConversationPreparing} type="button" onClick={() => void saveModelSettings()}>保存设置</button>
                  </div>
                </div>
              ) : (
                <div className="workspace-section placeholder-section">
                  <div className="placeholder-icon">⚙</div>
                  <h2>{settingsSection === "language" ? "语言" : settingsSection === "data" ? "数据与会话" : "关于 Tao"}</h2>
                  <p>{settingsSection === "data" ? "Tao 数据当前统一存储在 %USERPROFILE%\\.tao。后续这里提供会话清理、导入和导出。" : "页面入口已经建立，具体配置将在对应能力接入时逐项实现。"}</p>
                </div>
              )}
            </div>
          </section>
        )}
      </main>

      {runtimeOpen && (
        <>
        {!filesExpanded && (
          <div
            className="resize-handle resize-handle-runtime"
            role="separator"
            aria-label="调整右侧栏宽度"
            aria-orientation="vertical"
            aria-valuemin={RUNTIME_MIN_WIDTH}
            aria-valuemax={RUNTIME_MAX_WIDTH}
            aria-valuenow={runtimeWidth}
            onPointerDown={(event) => beginResize("runtime", event)}
          />
        )}
        <aside className={`runtime-drawer ${rightPanelView === "files" ? "files-view" : ""}`} aria-label="右侧面板">
          <div className="runtime-drawer-header">
            <div>
              <h2>{rightPanelView === "files" ? "文件" : mainView === "chat" ? "运行信息" : mainView === "customization" ? "配置检查器" : "设置摘要"}</h2>
              <p>{rightPanelView === "files" ? (activeConversation?.workspacePath || workspaceListing?.rootPath || "默认工作区") : mainView === "chat" ? (activeConversation?.title || "当前会话") : pageTitle}</p>
            </div>
            <div className="runtime-header-actions">
              {rightPanelView === "files" && (
                <button
                  type="button"
                  onClick={() => setFilesExpanded((current) => !current)}
                  aria-label={filesExpanded ? "退出全界面文件查看" : "展开为全界面文件查看"}
                  title={filesExpanded ? "退出全界面" : "全界面查看"}
                >
                  <span aria-hidden="true">{filesExpanded ? "><" : "<>"}</span>
                </button>
              )}
            </div>
          </div>
          <div className="right-panel-tabs" role="tablist" aria-label="右侧面板">
            <button className={rightPanelView === "runtime" ? "active" : ""} type="button" role="tab" aria-selected={rightPanelView === "runtime"} onClick={() => { setRightPanelView("runtime"); setFilesExpanded(false); }}>工作过程</button>
            <button className={rightPanelView === "files" ? "active" : ""} type="button" role="tab" aria-selected={rightPanelView === "files"} onClick={() => setRightPanelView("files")}>文件</button>
          </div>
          {rightPanelView === "files" ? (
            <div className="files-panel">
              <section className="file-preview-pane" aria-label="文件预览">
                <div className="file-preview-toolbar">
                  <div className="file-preview-title">
                    <strong>{workspaceFile ? workspaceFile.path : "文件预览"}</strong>
                    <span>{workspacePreviewMode === "diff" ? "Diff" : workspaceFile ? formatFileSize(workspaceFile.size) : "选择右侧文件或改动"}</span>
                  </div>
                  <div className="file-preview-actions">
                    {workspacePreviewMode === "file" && workspaceFile && (
                      <div className="preview-mode-toggle" role="tablist" aria-label="Markdown 显示模式">
                        <button
                          className={workspaceMarkdownViewMode === "preview" ? "active" : ""}
                          type="button"
                          role="tab"
                          aria-selected={workspaceMarkdownViewMode === "preview"}
                          onClick={() => setWorkspaceMarkdownViewMode("preview")}
                        >
                          预览
                        </button>
                        <button
                          className={workspaceMarkdownViewMode === "source" ? "active" : ""}
                          type="button"
                          role="tab"
                          aria-selected={workspaceMarkdownViewMode === "source"}
                          onClick={() => setWorkspaceMarkdownViewMode("source")}
                        >
                          源码
                        </button>
                      </div>
                    )}
                    <button type="button" onClick={() => void loadWorkspaceDirectory(workspaceListing?.relativePath ?? "")}>刷新</button>
                  </div>
                </div>
                <div className="file-preview-content">
                  {workspaceFileLoading ? (
                    <div className="file-empty-state">正在读取文件…</div>
                  ) : workspaceFileError ? (
                    <div className="file-empty-state error">{workspaceFileError}</div>
                  ) : workspaceFile ? (
                    workspacePreviewMode === "diff" ? (
                      <WorkspaceDiffPreview content={workspaceFile.content} filePath={workspaceFile.path} />
                    ) : workspaceMarkdownViewMode === "source" ? (
                      <pre className="markdown-source-preview"><code>{workspaceFile.content}</code></pre>
                    ) : (
                      <WorkspaceMarkdownPreview
                        content={workspaceFile.content}
                        filePath={workspaceFile.path}
                        copiedKey={copiedKey}
                        onCopy={copyText}
                      />
                    )
                  ) : (
                    <div className="file-empty-state">
                      <strong>选择一个 Markdown 文件</strong>
                      <span>当前第一阶段支持 Markdown/MDX 只读预览，以及 Git 文本 Diff。</span>
                    </div>
                  )}
                </div>
              </section>
              <div
                className="files-inner-resize"
                role="separator"
                aria-label="调整文件目录宽度"
                aria-orientation="vertical"
                aria-valuemin={FILES_DIRECTORY_MIN_WIDTH}
                aria-valuemax={FILES_DIRECTORY_MAX_WIDTH}
                aria-valuenow={filesDirectoryWidth}
                onPointerDown={(event) => beginResize("directory", event)}
              />
              <aside className="file-directory-pane" aria-label="目录">
                <div className="file-directory-header">
                  <div>
                    <strong>{workspaceListing ? directoryLabel(workspaceListing.relativePath) : "目录"}</strong>
                    <span>{workspaceListing?.isGitRepo ? "Git 工作区" : "非 Git 工作区"}</span>
                  </div>
                  {workspaceListing?.relativePath && (
                    <button type="button" onClick={() => void loadWorkspaceDirectory(parentDirectory(workspaceListing.relativePath))}>上一级</button>
                  )}
                </div>
                {workspaceLoading ? (
                  <div className="file-directory-state">正在读取目录…</div>
                ) : workspaceError ? (
                  <div className="file-directory-state error">{workspaceError}</div>
                ) : workspaceListing ? (
                  <>
                    <div className="file-change-section">
                      <div className="file-section-title">文件改动</div>
                      {workspaceListing.changes.length ? workspaceListing.changes.map((change) => (
                        <button
                          className={`file-change-row ${workspacePreviewMode === "diff" && workspaceFile?.path === change.path ? "active" : ""}`}
                          type="button"
                          key={`${change.status}-${change.path}`}
                          onClick={() => void openWorkspaceFile(change.path, "diff")}
                          title={change.path}
                        >
                          <span className={`file-change-badge ${changeStatusClass(change.status)}`}>{changeStatusLabel(change.status)}</span>
                          <span>{change.path}</span>
                        </button>
                      )) : (
                        <p className="file-section-empty">暂无 Git 改动</p>
                      )}
                    </div>
                    <div className="file-tree-section">
                      <div className="file-section-title">Files</div>
                      <div className="file-tree-list">
                        {workspaceListing.entries.map((entry) => (
                          <button
                            className={`file-tree-row ${entry.kind}`}
                            type="button"
                            key={entry.relativePath || entry.name}
                            onClick={() => entry.kind === "directory" ? void loadWorkspaceDirectory(entry.relativePath) : void openWorkspaceFile(entry.relativePath, "file")}
                            disabled={entry.kind === "file" && !isMarkdownPath(entry.relativePath)}
                            title={entry.kind === "file" && !isMarkdownPath(entry.relativePath) ? "当前阶段只支持 Markdown/MDX 预览" : entry.relativePath}
                          >
                            <span className="file-tree-icon" aria-hidden="true">{entry.kind === "directory" ? "▸" : ""}</span>
                            <span className="file-tree-name">{entry.name}</span>
                            {entry.kind === "file" && <span className="file-tree-size">{formatFileSize(entry.size)}</span>}
                          </button>
                        ))}
                      </div>
                    </div>
                  </>
                ) : (
                  <div className="file-directory-state">尚未读取目录</div>
                )}
              </aside>
            </div>
          ) : mainView === "chat" ? <>
          <div className="runtime-summary">
            <span className={`runtime-state-dot ${activeConversationGenerating ? "running" : runtimeHasError ? "error" : runtimeHost.ready ? "ready" : "preparing"}`} />
            <div>
              <strong>{activeConversationGenerating ? "正在生成" : runtimeHasError ? "Runtime 需要恢复" : runtimeHost.ready ? "Runtime 已连接" : "Runtime 后台启动中"}</strong>
              <small>{runtimeHasError ? "Runtime 出现异常，可尝试重启" : activeStream?.status ?? (preparingIds[activeId] ? "正在后台连接当前会话，可直接输入" : "等待下一条消息")}</small>
            </div>
          </div>
          <section className="right-work-section" aria-label="工作过程">
            <div className="right-section-title">Trace 流</div>
            {rightPanelTraces.length ? (
              <TracePanel
                traces={rightPanelTraces}
                openIds={traceOpen}
                onToggleTrace={toggleTrace}
              />
            ) : activeStream ? (
              <ActivityPanel
                activities={rightPanelActivities}
                thinking={activeStream.thinking}
                durationMs={activeStream.completedMs}
                startedAt={activeStream.startedAt}
                nowMs={clockMs}
                live={!activeStream.completed}
                thinkingOpen={activeStream.thinkingOpen}
                open={activeStream.activityOpen}
                onToggle={() => toggleActivity(activeId)}
                onToggleThinking={() => toggleStreamThinking(activeId)}
              />
            ) : lastAssistantMessage ? (
              <ActivityPanel
                activities={rightPanelActivities}
                thinking={lastAssistantMessage.thinking}
                durationMs={lastAssistantMessage.durationMs}
                thinkingOpen={messageThinkingOpen[lastAssistantMessage.id] ?? false}
                open={messageActivityOpen[lastAssistantMessage.id] ?? false}
                onToggle={() => toggleMessageActivity(lastAssistantMessage.id)}
                onToggleThinking={() => toggleMessageThinking(lastAssistantMessage.id)}
              />
            ) : (
              <p className="right-section-empty">当前会话还没有可显示的工作过程。</p>
            )}
          </section>
          <div className="runtime-recovery-actions">
            <button
              type="button"
              disabled={runtimeRecovering || anyConversationGenerating || anyConversationPreparing}
              onClick={() => void restartRuntime()}
            >
              {runtimeRecovering ? "正在恢复…" : "重启 Runtime"}
            </button>
            {activeConversation && (
              <button
                type="button"
                disabled={runtimeRecovering || anyConversationGenerating || anyConversationPreparing}
                onClick={() => void prepareConversation(activeConversation)}
              >
                重新连接当前会话
              </button>
            )}
          </div>
          <dl className="runtime-details">
            <div><dt>Runtime PID</dt><dd>{runtimeHost.pid ?? "启动中"}</dd></div>
            <div><dt>托管会话</dt><dd>{runtimeHost.sessionCount}</dd></div>
            <div><dt>Provider</dt><dd>{settings.provider}</dd></div>
            <div><dt>Model</dt><dd>{settings.model}</dd></div>
            <div><dt>思考模式</dt><dd>{settings.thinkingLevel}</dd></div>
            <div><dt>准备</dt><dd>{timings[activeId]?.readyMs !== undefined ? `${(timings[activeId].readyMs / 1000).toFixed(1)} 秒` : "尚未记录"}</dd></div>
            <div><dt>首次输出</dt><dd>{timings[activeId]?.firstOutputMs !== undefined ? `${(timings[activeId].firstOutputMs / 1000).toFixed(1)} 秒` : "尚未记录"}</dd></div>
            <div><dt>完整回答</dt><dd>{timings[activeId]?.completedMs !== undefined ? `${(timings[activeId].completedMs / 1000).toFixed(1)} 秒` : "尚未记录"}</dd></div>
            <div><dt>Session</dt><dd>%USERPROFILE%\\.tao\\sessions\\{activeConversation?.id ?? "-"}.jsonl</dd></div>
            <div><dt>工作区</dt><dd>{activeConversation?.workspacePath || "未选择（使用默认目录）"}</dd></div>
          </dl>
          {activeStream?.queued.length ? (
            <div className="runtime-queue">
              <h3>排队消息（{activeStream.queued.length}）</h3>
              {activeStream.queued.map((queued, index) => (
                <p key={`${queued.behavior}-${index}`}>
                  <span>{queued.behavior === "steer" ? "调整" : "后续"}</span>{queued.text}
                </p>
              ))}
            </div>
          ) : null}
          <p className="runtime-note">此处只显示当前状态、思考和正文，不显示工具原始参数、输出或日志。</p>
          </> : mainView === "customization" ? <>
            <div className="runtime-summary">
              <span className={`runtime-state-dot ${runtimeDraft.enabled ? "ready" : ""}`} />
              <div><strong>{runtimeDraft.enabled ? "定制配置已启用" : "定制配置已关闭"}</strong><small>{customizationSection === "prompt" ? "正在编辑提示词" : "等待选择配置项"}</small></div>
            </div>
            <dl className="runtime-details">
              <div><dt>配置文件</dt><dd>%USERPROFILE%\.tao\runtime\profile.json</dd></div>
              <div><dt>提示词</dt><dd>{runtimeDraft.systemPrompt.trim() ? "已配置" : "未配置"}</dd></div>
              <div><dt>加载方式</dt><dd>{runtimeDraft.systemPromptMode === "append" ? "追加默认提示词" : "替换默认提示词"}</dd></div>
              <div><dt>Context</dt><dd>规划中</dd></div>
              <div><dt>Skill</dt><dd>规划中</dd></div>
              <div><dt>Extension</dt><dd>规划中</dd></div>
            </dl>
            <p className="runtime-note">定制页面只开放已经确认映射和安全边界的能力。</p>
          </> : <>
            <div className="runtime-summary">
              <span className="runtime-state-dot ready" />
              <div><strong>Tao 全局设置</strong><small>保存在用户目录</small></div>
            </div>
            <dl className="runtime-details">
              <div><dt>Provider</dt><dd>{settings.provider}</dd></div>
              <div><dt>默认模型</dt><dd>{settings.model}</dd></div>
              <div><dt>思考模式</dt><dd>{settings.thinkingLevel}</dd></div>
              <div><dt>认证</dt><dd>{apiKeyConfigured ? "已配置" : "未配置"}</dd></div>
              <div><dt>数据目录</dt><dd>%USERPROFILE%\.tao</dd></div>
            </dl>
            <p className="runtime-note">设置页管理全局默认值；会话中的选择只影响当前对话。</p>
          </>}
        </aside>
        </>
      )}

      {deleteTarget && (
        <div
          className="delete-confirm-backdrop"
          role="presentation"
          onClick={() => {
            if (deletingConversationId !== deleteTarget.id) setDeleteTarget(null);
          }}
        >
          <section
            className="delete-confirm-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-confirm-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="delete-confirm-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24">
                <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v5M14 11v5" />
              </svg>
            </div>
            <div className="delete-confirm-content">
              <h2 id="delete-confirm-title">删除会话</h2>
              <p>确定删除“{deleteTarget.title || "新对话"}”吗？此操作不能恢复。</p>
            </div>
            <div className="delete-confirm-actions">
              <button
                className="secondary-button"
                type="button"
                disabled={deletingConversationId === deleteTarget.id}
                onClick={() => setDeleteTarget(null)}
              >
                取消
              </button>
              <button
                className="danger-button"
                type="button"
                disabled={deletingConversationId === deleteTarget.id}
                onClick={() => void deleteConversation(deleteTarget)}
              >
                {deletingConversationId === deleteTarget.id ? "删除中…" : "删除"}
              </button>
            </div>
          </section>
        </div>
      )}

    </div>
  );
}

export default App;
