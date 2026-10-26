import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { defaultWeb } from "./agent-profiles";
import type { RuntimeConfiguration, WebConfiguration } from "./agent-profiles";
import { useWebCapabilities, WebCapabilityCards } from "./CapabilitySummary";
import type { CapabilitySection } from "./CapabilitySummary";

export function WebSettings({ configuration, onChange, onConfigure }: { configuration: RuntimeConfiguration; onChange: (patch: Partial<RuntimeConfiguration>) => void; onConfigure: (section: CapabilitySection) => void }) {
  const capabilities = useWebCapabilities(configuration);
  const web = { ...defaultWeb(), ...configuration.web };
  const update = (patch: Partial<WebConfiguration>) => onChange({ web: { ...web, ...patch } });
  const policy = configuration.execution;
  const denied = policy?.network === "deny" || (policy?.backend !== undefined && policy.backend !== "local" && policy.network === "inherit");
  const credentialAllowed = policy?.allowedEnv.includes(web.apiKeyEnv) ?? false;
  const searxng = web.provider === "searxng";
  const [testing, setTesting] = useState(false);
  const [testStatus, setTestStatus] = useState("");
  const [testOutcome, setTestOutcome] = useState<"success" | "failure" | null>(null);
  const testSequence = useRef(0);
  const testConfiguration = JSON.stringify({ web, execution: policy, rule: configuration.toolPermissions?.web_search });
  useEffect(() => { testSequence.current++; setTesting(false); setTestStatus(""); setTestOutcome(null); }, [testConfiguration]);
  useEffect(() => () => { testSequence.current++; }, []);
  async function testConnection() {
    const sequence = ++testSequence.current;
    setTesting(true); setTestStatus(""); setTestOutcome(null);
    try {
      const result = await invoke<{ message: string; resultCount: number; warnings: string[] }>("test_web_search", { configuration });
      if (testSequence.current === sequence) { setTestOutcome("success"); setTestStatus(`${result.message} 返回 ${result.resultCount} 条。${result.warnings.join("；")}`); capabilities.refresh(); }
    } catch (error) { if (testSequence.current === sequence) { setTestOutcome("failure"); setTestStatus(String(error)); } }
    finally { if (testSequence.current === sequence) setTesting(false); }
  }
  return <section className="workspace-section form-section web-settings">
    <div className="workspace-heading"><h2>联网检索</h2><p>搜索与网页读取分别配置。更换模型或 API 地址不会自动获得搜索服务。</p></div>
    <WebCapabilityCards value={capabilities.value && testOutcome && capabilities.value.search.state === "unverified" ? { ...capabilities.value, search: { ...capabilities.value.search, state: testOutcome === "success" ? "enabled" : "blocked", label: testOutcome === "success" ? "本次测试成功" : "本次测试失败", detail: testStatus } } : capabilities.value} error={capabilities.error} onConfigure={(section) => { if (section !== "web") onConfigure(section); else document.getElementById("web-options")?.scrollIntoView({ behavior: "smooth", block: "center" }); }} />
    <p className="delegation-hint">以上为当前编辑配置，保存后新会话生效；已有会话需应用新版组合。配置检查不联网，也不验证网站可达性。</p>
    <div id="web-options" className="profile-form-group">
    <div className="tool-option-grid">
      <label className={`tool-option ${web.searchEnabled ? "checked" : ""}`}><input type="checkbox" checked={web.searchEnabled} onChange={(event) => update({ searchEnabled: event.currentTarget.checked })} /><span><strong>联网搜索</strong><small>{searxng ? "SearXNG · 连接自建实例" : "Brave Search · 需要 API 密钥"}</small></span></label>
      <label className={`tool-option ${web.fetchEnabled ? "checked" : ""}`}><input type="checkbox" checked={web.fetchEnabled} onChange={(event) => update({ fetchEnabled: event.currentTarget.checked })} /><span><strong>读取网页</strong><small>公开网页与文本 · 无需搜索密钥</small></span></label>
    </div>
    {web.searchEnabled && <>
      <label className="setting-field"><span>搜索来源</span><select value={web.provider} onChange={(event) => update({ provider: event.currentTarget.value as WebConfiguration["provider"] })}><option value="brave">Brave Search</option><option value="searxng">SearXNG（自建实例）</option></select></label>
      {searxng ? <>
        <label className="setting-field"><span>SearXNG 搜索接口地址</span><input value={web.searxngUrl} maxLength={2048} onChange={(event) => update({ searxngUrl: event.currentTarget.value })} placeholder="http://127.0.0.1:8080/search" /><small>填写完整接口地址，通常以 /search 结尾；支持自定义端口。不要包含密码、密钥或查询参数。实例需在 settings.yml 的 search.formats 中启用 json。</small></label>
        <label className="setting-row inline-setting"><span><strong>允许此搜索接口访问本机或私网</strong><small>仅授权上面配置的搜索接口，不影响普通网页读取。搜索词会发送给此实例及其上游搜索服务。</small></span><input type="checkbox" checked={web.allowPrivateSearch} onChange={(event) => update({ allowPrivateSearch: event.currentTarget.checked })} /></label>
        <p className="delegation-hint">连接已有实例，不会自动部署。当前不支持登录或认证请求头；不跟随重定向。支持日、月、年筛选，具体效果取决于上游引擎。</p>
      </> : <label className="setting-field"><span>搜索密钥环境变量名称</span><input value={web.apiKeyEnv} maxLength={80} onChange={(event) => update({ apiKeyEnv: event.currentTarget.value })} placeholder="BRAVE_SEARCH_API_KEY" /><small>在系统中设置这个变量的值后重启 Tao。这里只保存变量名，请勿粘贴密钥。服务账号及费用由用户管理。</small></label>}
      <button className="secondary-button compact-button" type="button" disabled={testing} onClick={() => void testConnection()}>{testing ? "正在测试…" : "测试搜索连接"}</button>
      <p className="delegation-hint">使用当前未保存配置，发送一次 “SearXNG documentation” 搜索，不会读取会话内容。测试完成后仍需保存组合。</p>
      {testStatus && <div className={`connection-result ${testOutcome}`} role="status"><strong>{testOutcome === "success" ? "本次搜索测试成功" : "本次搜索测试失败"}</strong><p>{testStatus}</p><small>仅代表本次请求结果；更改配置后需重新测试。</small></div>}
    </>}
    {web.searchEnabled && !searxng && !credentialAllowed && <p className="delegation-hint" role="status">请在“执行与沙盒 → 工具凭据”中允许读取 {web.apiKeyEnv || "搜索密钥变量"}。</p>}
    {(web.searchEnabled || web.fetchEnabled) && denied && <p className="delegation-hint" role="status">当前执行策略禁止联网。请在“执行与沙盒”中调整工具联网设置后使用。</p>}
    </div>
    <details className="capability-details"><summary>权限与读取范围</summary><p className="delegation-hint">对话中的工具调用默认询问确认，可在“工具与权限”调整。若设置域名名单，搜索需加入{searxng ? "所配置实例的主机名或 IPv4 地址" : " api.search.brave.com"}，网页读取需加入来源网站。普通网页只读取公开静态 HTML、纯文本和 Markdown，暂不支持登录、动态页面及 PDF。</p></details>
  </section>;
}
