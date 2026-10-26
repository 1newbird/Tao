import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { McpServerConfiguration, RuntimeConfiguration } from "./agent-profiles";

interface McpTool { name: string; description: string; inputSchema: unknown }

function McpServerEditor({ server, configuration, update, remove }: {
  server: McpServerConfiguration; configuration: RuntimeConfiguration;
  update: (patch: Partial<McpServerConfiguration>) => void; remove: () => void;
}) {
  const [tools, setTools] = useState<McpTool[] | null>(null);
  const [status, setStatus] = useState("");
  const [testing, setTesting] = useState(false);
  const [expanded, setExpanded] = useState(!server.url);
  const [outcome, setOutcome] = useState<"success" | "failure" | null>(null);
  const sequence = useRef(0);
  const connection = JSON.stringify([server.url, server.enabled, server.allowPrivate, server.tokenEnv, configuration.execution, configuration.toolPermissions?.mcp_list_tools]);
  useEffect(() => { sequence.current++; setTools(null); setStatus(""); setTesting(false); setOutcome(null); }, [connection]);
  useEffect(() => () => { sequence.current++; }, []);
  async function test() {
    const current = ++sequence.current;
    setTesting(true); setStatus(""); setTools(null); setOutcome(null);
    try {
      const result = await invoke<{ tools: McpTool[] }>("test_mcp_connection", { configuration, serverId: server.id });
      if (current !== sequence.current) return;
      setTools(result.tools); setOutcome("success"); setStatus(`连接成功，发现 ${result.tools.length} 个工具。勾选允许对话使用的工具，再保存组合。`);
    } catch (error) { if (current === sequence.current) { setOutcome("failure"); setStatus(String(error)); } }
    finally { if (current === sequence.current) setTesting(false); }
  }
  const choose = (name: string, checked: boolean) => update({ allowedTools: checked ? [...new Set([...server.allowedTools, name])] : server.allowedTools.filter((item) => item !== name) });
  return <div className="mcp-service-card">
    <div className="service-card-heading"><strong>{server.name || "MCP 服务"}</strong><span className={`capability-state ${!server.enabled ? "disabled" : outcome === "success" ? "enabled" : outcome === "failure" ? "blocked" : "unverified"}`}>{!server.enabled ? "未启用" : testing ? "正在测试" : outcome === "success" ? "本次测试成功" : outcome === "failure" ? "本次测试失败" : server.url ? "已配置 · 待测试" : "待填写地址"}</span></div>
    <p className="service-address">{server.url || "填写服务商提供的 MCP 接口地址"}</p>
    <p className="service-authorization">{server.allowedTools.length ? `当前组合已选 ${server.allowedTools.length} 项工具` : "尚未授权工具"} · 保存组合后生效</p>
    <details open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}><summary>管理连接与工具</summary><div className="mcp-server-editor">
    <label className="setting-row inline-setting"><span><strong>启用此服务</strong><small>对话中仅能调用下面选中的工具。</small></span><input type="checkbox" checked={server.enabled} onChange={(event) => update({ enabled: event.currentTarget.checked })} /></label>
    <label className="setting-field"><span>服务名称</span><input value={server.name} maxLength={100} onChange={(event) => update({ name: event.currentTarget.value })} /></label>
    <label className="setting-field"><span>MCP 接口地址</span><input value={server.url} maxLength={2048} placeholder="https://example.com/mcp" onChange={(event) => update({ url: event.currentTarget.value, allowedTools: [] })} /><small>填写服务商提供的 Streamable HTTP 地址，不含密码、查询参数或片段。支持 JSON 与 POST SSE 响应；更改地址后需重新选择工具。</small></label>
    <label className="setting-field"><span>Bearer 凭据环境变量名称 <em>可选</em></span><input value={server.tokenEnv} maxLength={80} placeholder="MY_MCP_TOKEN" onChange={(event) => update({ tokenEnv: event.currentTarget.value, allowedTools: [] })} /><small>这里只保存变量名。设置系统环境变量并重启 Tao，再在“执行与沙盒 → 工具凭据”中授权该变量；远程认证使用 HTTPS，更改变量后需重新选择工具。</small></label>
    <label className="setting-row inline-setting"><span><strong>允许此接口访问本机或私网</strong><small>仅对本服务地址生效，不放宽网页读取。</small></span><input type="checkbox" checked={server.allowPrivate} onChange={(event) => update({ allowPrivate: event.currentTarget.checked })} /></label>
    <button className="secondary-button compact-button" type="button" disabled={testing || !server.enabled || !server.url.trim()} onClick={() => void test()}>{testing ? "正在连接…" : "测试连接并查看工具"}</button>
    <p className="delegation-hint">使用当前配置进行初始化和读取工具清单，不执行远程工具，不发送会话内容。最多等待约 30 秒。</p>
    {status && <p className={`connection-result ${outcome}`} role="status">{status}</p>}
    {tools && <div className="mcp-tool-list" aria-label={`${server.name} 工具清单`}>
      {tools.map((tool) => <div key={tool.name} className="mcp-tool-item">
        <label className="tool-option"><input type="checkbox" checked={server.allowedTools.includes(tool.name)} onChange={(event) => choose(tool.name, event.currentTarget.checked)} /><span><strong>{tool.name}</strong><small>{tool.description || "此工具未提供描述"}</small></span></label>
        <details><summary>查看输入格式</summary><pre>{JSON.stringify(tool.inputSchema, null, 2)}</pre></details>
      </div>)}
    </div>}
    {server.allowedTools.filter((name) => !tools?.some((tool) => tool.name === name)).map((name) => <label className="tool-option" key={name}><input type="checkbox" checked onChange={() => choose(name, false)} /><span><strong>{name}</strong><small>{tools ? "当前服务未返回此工具，建议取消选择" : "已保存的选择；测试连接可刷新工具清单"}</small></span></label>)}
    {!server.allowedTools.length && <p className="delegation-hint">尚未授权工具。连接成功后，请勾选需要使用的工具。</p>}
    <button className="text-button service-remove" type="button" onClick={remove}>移除服务</button>
    </div></details>
  </div>;
}

export function McpSettings({ configuration, onChange }: { configuration: RuntimeConfiguration; onChange: (patch: Partial<RuntimeConfiguration>) => void }) {
  const servers = configuration.mcpServers ?? [];
  return <section className="workspace-section form-section mcp-settings">
    <div className="workspace-heading capability-page-heading"><div><h2>外部服务 · MCP</h2><p>连接已有服务，为当前组合选择需要的工具。</p></div><button className="secondary-button compact-button" type="button" disabled={servers.length >= 20} onClick={() => onChange({ mcpServers: [...servers, { id: `mcp-${crypto.randomUUID()}`, name: "MCP 服务", enabled: true, url: "", tokenEnv: "", allowPrivate: false, allowedTools: [] }] })}>添加服务</button></div>
    {!servers.length && <div className="capability-empty"><strong>还没有外部服务</strong><p>添加一个 MCP 接口，测试连接后选择允许使用的工具。</p></div>}
    {servers.map((server) => <McpServerEditor key={server.id} server={server} configuration={configuration} update={(patch) => onChange({ mcpServers: servers.map((item) => item.id === server.id ? { ...item, ...patch } : item) })} remove={() => onChange({ mcpServers: servers.filter((item) => item.id !== server.id) })} />)}
    {!!servers.length && <p className="delegation-hint">对话调用默认询问确认，受联网及域名名单约束。远程工具可能修改外部数据，本地文件沙盒无法限制服务端行为；中断后不会自动重试。保存后，新会话使用新配置，已有会话需应用更新后的组合。</p>}
    <details className="capability-details"><summary>支持范围与连接说明</summary><p className="delegation-hint">支持 Streamable HTTP 工具服务，无需额外安装客户端依赖。暂不支持本地 stdio、旧版 SSE、OAuth 登录、资源与提示词接口或服务端请求。Tao 不会自动安装服务。连接测试仅代表本次结果，不等于工具已授权或服务持续可用。</p></details>
  </section>;
}
