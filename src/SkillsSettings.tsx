import { lazy, Suspense, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { RuntimeConfiguration } from "./agent-profiles";

interface Skill { name: string; description: string; filePath: string; disableModelInvocation: boolean }
interface Catalog { directory: string; skills: Skill[]; diagnostics: { path?: string; message: string }[] }
const GithubSkillInstaller = lazy(() => import("./GithubSkillInstaller"));

export function SkillsSettings({ configuration, onChange }: { configuration: RuntimeConfiguration; onChange: (patch: Partial<RuntimeConfiguration>) => void }) {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [adding, setAdding] = useState(false);
  async function refresh() {
    setBusy(true); setError("");
    try { setCatalog(await invoke<Catalog>("list_skills")); } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  }
  useEffect(() => { void refresh(); }, []);
  async function importDirectory() {
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await invoke<{ name: string } | null>("choose_and_import_skill");
      if (result) { setNotice(`已导入 ${result.name}。请保存组合后在新会话中使用。`); await refresh(); }
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  }
  const all = configuration.enabledSkills == null;
  const missing = (configuration.enabledSkills ?? []).filter((name) => catalog && !catalog.skills.some((skill) => skill.name === name));
  return <div className="workspace-section form-section">
    <div className="workspace-heading capability-page-heading"><div><h2>技能 · Skills</h2><p>管理可复用的任务说明，选择当前组合需要的技能。</p></div><button className="secondary-button compact-button" type="button" aria-expanded={adding} onClick={() => setAdding((value) => !value)}>{adding ? "收起添加" : "添加技能"}</button></div>
    {adding && <section className="skill-add-panel" aria-label="添加技能">
      <div className="capability-panel-heading"><strong>添加到共享技能库</strong><button type="button" className="secondary-button compact-button" disabled={busy} onClick={() => void importDirectory()}>导入本地目录</button></div>
      <p className="delegation-hint">导入或安装后立即保存到本机，供所有组合选择。下方的启用与选择需要另行保存组合。</p>
      <Suspense fallback={<p>正在加载 GitHub 安装入口…</p>}><GithubSkillInstaller configuration={configuration} onInstalled={() => void refresh()} /></Suspense>
    </section>}
    <label className="setting-row inline-setting"><span><strong>启用 Tao Skills</strong><small>保存组合后，新会话使用此选择。</small></span><input type="checkbox" checked={configuration.skillsEnabled} onChange={(event) => onChange({ skillsEnabled: event.currentTarget.checked })} /></label>
    <div className="skills-toolbar">
      <button type="button" className="text-button" disabled={busy} onClick={() => void refresh()}>刷新列表</button>
      <label>加载范围 <select aria-label="技能加载范围" disabled={!configuration.skillsEnabled} value={all ? "all" : "selected"} onChange={(event) => onChange({ enabledSkills: event.currentTarget.value === "all" ? null : catalog?.skills.map((skill) => skill.name) ?? [] })}><option value="all">全部已安装技能</option><option value="selected">仅选中的技能</option></select></label>
    </div>
    {busy && <p role="status">正在读取技能…</p>}
    {error && <p className="delegation-hint" role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {catalog && <>
      {!catalog.skills.length && !busy && <div className="capability-empty"><strong>还没有可用技能</strong><p>通过“添加技能”导入本地目录或安装公开 GitHub 技能。</p></div>}
      <div className="skills-list">{catalog.skills.map((skill) => <div className="skill-library-item" key={skill.name}>
        <label className="skill-item">
          <input type="checkbox" disabled={!configuration.skillsEnabled || all} checked={configuration.skillsEnabled && (all || configuration.enabledSkills!.includes(skill.name))} onChange={(event) => onChange({ enabledSkills: event.currentTarget.checked ? [...(configuration.enabledSkills ?? []), skill.name] : configuration.enabledSkills?.filter((name) => name !== skill.name) })} />
          <span><strong>{skill.name}</strong><p>{skill.description}</p><small>{skill.disableModelInvocation ? "仅显式调用" : "可自动匹配，也可显式调用"}</small></span>
        </label>
        <details><summary>使用方式与位置</summary><code>/skill:{skill.name} 你的任务</code><p className="skill-file-path">{skill.filePath}</p></details>
      </div>)}</div>
      {!!missing.length && <p className="delegation-hint" role="status">已选择但未找到：{missing.join("、")}。恢复目录或重新选择加载范围。</p>}
      {!!catalog.diagnostics.length && <details className="skills-diagnostics" open><summary>加载提示（{catalog.diagnostics.length}）</summary>{catalog.diagnostics.map((item, index) => <p key={index}>{item.message}<small>{item.path}</small></p>)}</details>}
      <details className="capability-details"><summary>共享技能目录</summary><code>{catalog.directory}</code><p className="delegation-hint">导入包含 SKILL.md 的单个目录，同时复制附属文件；同名技能不会被覆盖。目录由所有组合共享。</p></details>
    </>}
    <details className="capability-details"><summary>对话安装与运行要求</summary>
      <label className="setting-row inline-setting"><span><strong>允许对话安装技能</strong><small>为主会话提供查看、检查和安装工具。安装共享技能会逐次确认；不运行脚本，不自动修改组合。</small></span><input type="checkbox" checked={configuration.skillInstallEnabled ?? false} onChange={(event) => onChange({ skillInstallEnabled: event.currentTarget.checked })} /></label>
      <p className="delegation-hint">对话输入框的“使用技能”可插入调用命令。自动匹配需要启用 read；仅工作区范围或沙盒可能阻止读取技能目录。显式调用会载入 SKILL.md 正文，附属文件与脚本仍遵循工具权限。安装不自动补齐程序或 MCP，已开启的会话不自动刷新技能文件列表。</p>
    </details>
  </div>;
}

export function SkillComposer({ conversationId, onSelect }: { conversationId: string; onSelect: (name: string) => void }) {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function toggle() {
    if (open) { setOpen(false); return; }
    setOpen(true); setBusy(true); setError(""); setCatalog(null);
    try { setCatalog(await invoke<Catalog>("list_skills", { conversationId })); } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  }
  return <div className="composer-skills">
    <button type="button" className="text-button" aria-expanded={open} onClick={() => void toggle()}>使用技能 {open ? "收起" : "+"}</button>
    {open && <div className="composer-skill-picker">
      {busy && <span role="status">正在读取技能…</span>}
      {error && <span role="alert">{error}</span>}
      {catalog && (catalog.skills.length ? <label>选择技能 <select aria-label="选择对话技能" defaultValue="" onChange={(event) => { if (event.currentTarget.value) { onSelect(event.currentTarget.value); setOpen(false); } }}><option value="" disabled>选择后插入调用命令</option>{catalog.skills.map((skill) => <option key={skill.name} value={skill.name}>{skill.name} — {skill.description}</option>)}</select></label> : <span>当前会话没有可用技能。请在组合的 Skills 页面启用并新建会话。</span>)}
    </div>}
  </div>;
}
