import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { RuntimeConfiguration } from "./agent-profiles";
import "./context.css";

interface ContextTool { name: string; description: string; parameters: unknown }
interface ContextSection { id: string; title: string; source: string; content: string }
interface ContentSizes { systemPromptCharacters: number; toolDefinitionCharacters: number }
interface ContextTemplate { policyVersion: string; defaultSystemPrompt: string; systemPrompt: string; sections: ContextSection[]; tools: ContextTool[]; warnings: string[]; contentSizes?: ContentSizes }
interface ProfileInfo { profileId: string; name: string; revision: number }
interface ContextSnapshot {
  policyVersion: string; capturedAt: number; conversationStart: boolean; requestId: string; profile: ProfileInfo | null;
  model: { provider: string; id: string; api: string }; systemPrompt: string; systemPromptTruncated: boolean;
  environment: { workspacePath: string; permissionMode: string; operatingSystem: string; shell: string; localTime: string; timeZone: string };
  sources: Array<{ title: string; source: string }>; tools: ContextTool[]; toolCount?: number; toolsTruncated?: boolean;
  messages: Array<{ role: string; characters: number; toolName?: string }>; messageCount: number; warnings: string[]; contentSizes?: ContentSizes;
}
interface ConversationContext { snapshot: ContextSnapshot | null; current: { profile: ProfileInfo | null; workspacePath: string; permissionMode: string; provider: string; model: string } }

function ToolList({ tools }: { tools: ContextTool[] }) {
  return <section className="context-tools"><h3>工具定义 · tools <span>{tools.length}</span></h3><p className="context-muted">独立于 systemPrompt 传递，包含工具说明与参数结构；这些定义也会占用模型上下文。</p>{!tools.length && <p className="context-muted">没有可用工具。</p>}{tools.map((tool) => <details className="context-disclosure" key={tool.name}><summary>{tool.name}</summary><div className="context-disclosure-body"><p>{tool.description}</p><pre>{JSON.stringify(tool.parameters, null, 2)}</pre></div></details>)}</section>;
}

function ContentSize({ sizes, promptLabel = "系统指令" }: { sizes?: ContentSizes; promptLabel?: string }) {
  return sizes ? <p className="context-muted">{promptLabel} {sizes.systemPromptCharacters.toLocaleString()} 字符 · 工具定义 {sizes.toolDefinitionCharacters.toLocaleString()} 字符。字符数不等于 token 数。</p> : null;
}

export function ContextPreview({ configuration }: { configuration: RuntimeConfiguration }) {
  const [result, setResult] = useState<ContextTemplate | null>(null);
  const [tab, setTab] = useState("structure");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const fingerprint = JSON.stringify(configuration);
  const current = useRef(fingerprint);
  current.current = fingerprint;
  useEffect(() => { setResult(null); setError(""); }, [fingerprint]);
  async function load() {
    const requested = fingerprint;
    setBusy(true); setError("");
    try {
      const next = await invoke<ContextTemplate>("preview_context", { configuration });
      if (current.current === requested) setResult(next);
    } catch (reason) { if (current.current === requested) setError(String(reason)); }
    finally { setBusy(false); }
  }
  return <section className="context-preview" aria-label="提示词与上下文预览">
    <header className="context-heading"><div><h3>提示词与上下文</h3><p>查看默认内容和当前草稿的组装方式</p></div><button type="button" onClick={() => void load()} disabled={busy}>{busy ? "正在组装…" : result ? "重新预览" : "查看预览"}</button></header>
    <p className="context-policy">Tao 默认上下文{result ? ` · ${result.policyVersion}` : " · 按层组装"}</p>
    {error && <p className="context-error" role="status">{error}</p>}
    {result && <>
      <nav className="context-tabs" aria-label="上下文预览分类">{[["structure", "组成与来源"], ["default", "默认提示词"], ["compiled", "合成预览"]].map(([id, label]) => <button type="button" key={id} className={tab === id ? "selected" : ""} aria-pressed={tab === id} onClick={() => setTab(id)}>{label}</button>)}</nav>
      {tab === "structure" && <><ol className="context-sections">{result.sections.map((section) => <li key={section.id}><details className="context-disclosure"><summary><strong>{section.title}</strong><small>{section.source}</small></summary><pre>{section.content}</pre></details></li>)}</ol><ToolList tools={result.tools} /></>}
      <ContentSize sizes={result.contentSizes} promptLabel="当前草稿的系统指令" />
      {tab === "default" && <><p className="context-muted">默认角色、平台执行规则、当前工具指导和文档入口的完整模板，不包含组合的业务追加。环境是占位符；组合替换仅改变角色，平台规则仍保留。</p><pre className="context-prompt" tabIndex={0}>{result.defaultSystemPrompt}</pre></>}
      {tab === "compiled" && <><p className="context-muted">这里仅组装 systemPrompt，tools 独立传递，可在“组成与来源”查看。路径、权限和时间尚未绑定；外部资源不在此预览中执行。</p><pre className="context-prompt" tabIndex={0}>{result.systemPrompt}</pre></>}
      {result.warnings.map((warning) => <p className="context-muted" key={warning}>{warning}</p>)}
    </>}
  </section>;
}

export function ContextPanel({ conversationId, generating, updateToken, warning }: { conversationId: string; generating: boolean; updateToken: number; warning: string }) {
  const [result, setResult] = useState<ConversationContext | null>(null);
  const [template, setTemplate] = useState<ContextTemplate | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const request = useRef(0);
  const current = useRef(conversationId);
  const wasGenerating = useRef(generating);
  const lastUpdate = useRef(updateToken);
  current.current = conversationId;
  const load = useCallback(async () => {
    if (!conversationId) return;
    const sequence = ++request.current;
    setBusy(true); setError("");
    try {
      const next = await invoke<ConversationContext>("get_conversation_context", { conversationId });
      if (sequence === request.current && current.current === conversationId) setResult(next);
    } catch (reason) { if (sequence === request.current && current.current === conversationId) setError(String(reason)); }
    finally { if (sequence === request.current) setBusy(false); }
  }, [conversationId]);
  useEffect(() => { setResult(null); setTemplate(null); void load(); return () => { request.current++; }; }, [load]);
  useEffect(() => { if (wasGenerating.current && !generating) void load(); wasGenerating.current = generating; }, [generating, load]);
  useEffect(() => { if (lastUpdate.current !== updateToken) void load(); lastUpdate.current = updateToken; }, [updateToken, load]);
  async function preview() {
    const id = conversationId;
    setBusy(true); setError("");
    try { const next = await invoke<ContextTemplate>("preview_context", { conversationId: id }); if (current.current === id) setTemplate(next); }
    catch (reason) { if (current.current === id) setError(String(reason)); }
    finally { if (current.current === id) setBusy(false); }
  }
  const snapshot = result?.snapshot;
  const active = result?.current;
  const pathKey = (path: string) => path.replace(/\\/g, "/").replace(/^\/\/\?\//, "").replace(/\/$/, "").toLowerCase();
  const changed = snapshot && active && (snapshot.environment.permissionMode !== active.permissionMode || (active.workspacePath && pathKey(snapshot.environment.workspacePath) !== pathKey(active.workspacePath)) || snapshot.model.provider !== active.provider || snapshot.model.id !== active.model || (snapshot.profile && active.profile && (snapshot.profile.profileId !== active.profile.profileId || snapshot.profile.revision !== active.profile.revision)));
  return <section className="context-panel" aria-label="会话上下文">
    <header className="context-heading"><div><h3>{snapshot?.conversationStart ? "会话初始上下文" : "首次记录的上下文"}</h3><p>首次模型调用前的 SDK 输入快照</p></div><button type="button" disabled={busy} onClick={() => void load()}>{busy ? "读取中…" : "刷新"}</button></header>
    <div className="context-panel-scroll" role="region" aria-label="上下文内容" tabIndex={0}>
      {error && <p className="context-error" role="status">{error}</p>}
      {warning && <p className="context-error" role="status">{warning}</p>}
      {!snapshot && !busy && <div className="context-empty"><strong>尚无上下文快照</strong><p>首次实际调用模型后记录。旧会话的原始上下文无法从当前配置还原；不会把模板当作历史快照。</p>{generating && <p>当前正在运行，稍后点击刷新查看。</p>}</div>}
      {snapshot && <>
        <p className="context-policy">{snapshot.policyVersion} · {new Date(snapshot.capturedAt).toLocaleString("zh-CN", { hour12: false })}</p>
        <ContentSize sizes={snapshot.contentSizes} />
        <p className="context-muted">systemPrompt、tools 与 messages 分开记录，未在此页合并为一段提示词。这是供应商适配前的 SDK 输入，实际 HTTP 字段可能不同；历史快照保留当时的真实内容。</p>
        {changed && <p className="context-change" role="status">当前组合、模型、路径或权限已变化。这里保留首次快照，供核对；当前请求按最新有效配置执行。</p>}
        {!snapshot.conversationStart && <p className="context-muted">记录时会话已有历史，这不是该会话最初启动时的上下文。</p>}
        <dl className="context-facts"><div><dt>组合</dt><dd>{snapshot.profile ? `${snapshot.profile.name} · v${snapshot.profile.revision}` : "未记录组合名称"}</dd></div><div><dt>模型</dt><dd>{snapshot.model.provider} / {snapshot.model.id}</dd></div><div><dt>工作区</dt><dd>{snapshot.environment.workspacePath}</dd></div><div><dt>权限模式</dt><dd>{snapshot.environment.permissionMode}</dd></div><div><dt>系统</dt><dd>{snapshot.environment.operatingSystem}</dd></div><div><dt>工具 Shell</dt><dd>{snapshot.environment.shell}</dd></div><div><dt>请求时间</dt><dd>{snapshot.environment.localTime} · {snapshot.environment.timeZone}</dd></div></dl>
        <h3>组成与来源</h3><ol className="context-sources">{snapshot.sources.map((source, index) => <li key={`${index}:${source.title}`}><strong>{source.title}</strong><small>{source.source}</small></li>)}</ol>
        <details className="context-disclosure"><summary>系统指令 · systemPrompt <small>{snapshot.systemPrompt.length.toLocaleString()} 字符</small></summary><pre className="context-prompt" tabIndex={0}>{snapshot.systemPrompt}</pre></details>
        {snapshot.systemPromptTruncated && <p className="context-muted">系统指令超过显示上限，已截断。</p>}
        <ToolList tools={snapshot.tools} />
        {snapshot.toolsTruncated && <p className="context-muted">工具定义超过显示上限；实际有 {snapshot.toolCount} 个工具，此处显示 {snapshot.tools.length} 个。</p>}
        <details className="context-disclosure"><summary>输入消息摘要 <small>{snapshot.messageCount} 条，不保存正文</small></summary><div className="context-message-list">{snapshot.messages.map((message, index) => <div key={index}><span>{index + 1}. {message.role}{message.toolName ? ` · ${message.toolName}` : ""}</span><small>{message.characters.toLocaleString()} 字符</small></div>)}</div></details>
        {snapshot.warnings.map((warning) => <p className="context-muted" key={warning}>{warning}</p>)}
      </>}
      <button type="button" className="context-template-button" disabled={busy} onClick={() => void preview()}>查看会话绑定组合的模板</button>
      {template && <details className="context-disclosure" open><summary>当前组合模板（非实际快照）</summary><pre className="context-prompt" tabIndex={0}>{template.systemPrompt}</pre>{template.warnings.map((warning) => <p className="context-muted" key={warning}>{warning}</p>)}</details>}
    </div>
  </section>;
}
