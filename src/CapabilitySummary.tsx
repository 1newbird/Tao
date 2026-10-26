import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { RuntimeConfiguration } from "./agent-profiles";

export type CapabilitySection = "web" | "mcp" | "skills" | "execution" | "agent";
type Status = { state: "disabled" | "blocked" | "missing" | "unverified" | "enabled"; label: string; detail: string; action: CapabilitySection };
export type WebCapabilities = { search: Status; fetch: Status };

export function useWebCapabilities(configuration?: RuntimeConfiguration, conversationId?: string) {
  const [revision, setRevision] = useState(0);
  const key = JSON.stringify({ configuration, conversationId, revision });
  const [result, setResult] = useState<{ key: string; value?: WebCapabilities; error?: string }>();
  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      void invoke<WebCapabilities>("inspect_web_capabilities", conversationId ? { conversationId } : { configuration })
        .then((value) => { if (active) setResult({ key, value }); })
        .catch((error) => { if (active) setResult({ key, error: String(error) }); });
    }, 200);
    return () => { active = false; window.clearTimeout(timer); };
  }, [key]);
  return { value: result?.key === key ? result.value : undefined, error: result?.key === key ? result.error : undefined, refresh: () => setRevision((value) => value + 1) };
}

export function WebCapabilityCards({ value, error, onConfigure }: { value?: WebCapabilities; error?: string; onConfigure?: (section: CapabilitySection) => void }) {
  if (error) return <p className="delegation-hint" role="status">暂时无法检查联网配置：{error}</p>;
  if (!value) return <p className="delegation-hint" role="status">正在检查联网配置…</p>;
  return <div className="web-capability-cards">{(["search", "fetch"] as const).map((name) => {
    const item = value[name];
    return <div className="web-capability-card" key={name}>
      <div><strong>{name === "search" ? "联网搜索" : "网页读取"}</strong><span className={`capability-state ${item.state}`}>{item.label}</span></div>
      <p>{item.detail}</p>
      {onConfigure && <button className="text-button" type="button" onClick={() => onConfigure(item.action)}>{item.action === "execution" ? "检查执行策略" : item.action === "agent" ? "检查工具权限" : "管理联网配置"} →</button>}
    </div>;
  })}</div>;
}

function ConversationCapabilities({ conversationId, configuration, onConfigure }: { conversationId: string; configuration?: RuntimeConfiguration; onConfigure: (section: CapabilitySection) => void }) {
  const web = useWebCapabilities(undefined, conversationId);
  const services = configuration?.mcpServers?.filter((server) => server.enabled) ?? [];
  const authorized = services.reduce((count, server) => count + server.allowedTools.length, 0);
  return <div className="capability-popover" role="region" aria-label="当前会话能力">
    <div className="capability-panel-heading"><strong>当前会话能力</strong><button className="text-button" type="button" onClick={web.refresh}>刷新</button></div>
    <p className="capability-caption">依据此会话的组合版本。连接模型 API 不代表搜索已就绪。</p>
    <WebCapabilityCards value={web.value} error={web.error} onConfigure={onConfigure} />
    <button className="capability-link-row" type="button" onClick={() => onConfigure("mcp")}><strong>外部服务 · MCP</strong><span>{services.length ? `${services.length} 个已启用 · ${authorized} 项已选工具` : "未启用服务"} ↗</span></button>
    {!!services.length && <p className="capability-caption">连接和调用仍需满足网络、凭据与工具权限；服务可用性以实际调用为准。</p>}
    <button className="capability-link-row" type="button" onClick={() => onConfigure("skills")}><strong>技能 · Skills</strong><span>{configuration?.skillsEnabled ? configuration.enabledSkills == null ? "配置为加载全部技能" : `配置为加载 ${configuration.enabledSkills.length} 项` : "未启用"} ↗</span></button>
    {configuration?.skillsEnabled && <p className="capability-caption">实际会话技能见输入框“使用技能”；技能所需程序和权限需另行满足。</p>}
    <p className="capability-caption">管理入口编辑组合；保存后需应用新版组合或新建会话。</p>
  </div>;
}

export function CapabilitySummary({ conversationId, configuration, onConfigure }: { conversationId: string; configuration?: RuntimeConfiguration; onConfigure: (section: CapabilitySection) => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); setOpen(false); trigger.current?.focus(); } };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape, true);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape, true); };
  }, [open]);
  return <div className="capability-menu" ref={root}>
    <button ref={trigger} className="runtime-button capability-trigger" type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>能力</button>
    {open && <ConversationCapabilities conversationId={conversationId} configuration={configuration} onConfigure={(section) => { setOpen(false); onConfigure(section); }} />}
  </div>;
}
