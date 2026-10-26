import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { RuntimeConfiguration } from "./agent-profiles";

type Catalog = { kind: "catalog"; repository: string; commit: string; candidates: { path: string }[]; note: string };
type Preview = { kind: "skill"; previewId: string; name: string; description: string; repository: string; path: string; commit: string; directory: string; bytes: number; files: { path: string; size: number }[]; alreadyInstalled: boolean; instructionPreview: string; instructionTruncated: boolean; warnings: string[]; expiresAt: string };

export default function GithubSkillInstaller({ configuration, onInstalled }: { configuration: RuntimeConfiguration; onInstalled: () => void }) {
  const [url, setUrl] = useState("");
  const [ref, setRef] = useState("");
  const [path, setPath] = useState("");
  const [preview, setPreview] = useState<Preview | Catalog | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const generation = useRef(0);
  const policyKey = JSON.stringify([configuration.execution, configuration.toolPermissions]);
  function invalidate() { generation.current++; setPreview(null); setError(""); setNotice(""); setBusy(false); }
  useEffect(() => { invalidate(); return () => { generation.current++; }; }, [policyKey]);
  async function inspect(selection?: { repository: string; commit: string; path: string }) {
    const current = ++generation.current;
    setBusy(true); setError(""); setNotice(""); setPreview(null);
    if (selection) { setUrl(selection.repository); setRef(selection.commit); setPath(selection.path); }
    try {
      const source = selection ? { url: selection.repository, ref: selection.commit, path: selection.path }
        : { url: url.trim(), ...(ref.trim() ? { ref: ref.trim() } : {}), ...(path.trim() ? { path: path.trim() } : {}) };
      const result = await invoke<Preview | Catalog>("inspect_github_skill", { source, configuration });
      if (generation.current === current) setPreview(result);
    } catch (reason) { if (generation.current === current) setError(String(reason)); }
    finally { if (generation.current === current) setBusy(false); }
  }
  async function install() {
    if (preview?.kind !== "skill") return;
    const current = ++generation.current;
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await invoke<{ name: string; message: string; selectedForNewChat: boolean }>("install_github_skill", { previewId: preview.previewId, configuration });
      if (generation.current === current) {
        setPreview(null);
        setNotice(`已安装 ${result.name}。${result.selectedForNewChat ? "当前组合已选中此技能，请保存组合后新建会话使用。" : "请启用 Skills 并选中此技能，保存组合后新建会话使用。"} 所需程序或 MCP 仍需另行配置。`);
        onInstalled();
      }
    } catch (reason) { if (generation.current === current) setError(String(reason)); }
    finally { if (generation.current === current) setBusy(false); }
  }
  return <div className="settings-card github-skill-installer">
    <h3>从 GitHub 安装技能</h3>
    <p>粘贴公开仓库、技能目录或 SKILL.md 链接，先检查再安装。无需 Git、Python 或搜索服务。</p>
    <label className="setting-field"><span>GitHub 地址</span><input aria-label="GitHub 技能地址" disabled={busy} value={url} maxLength={2048} placeholder="https://github.com/owner/repo/tree/main/skills/example" onChange={(event) => { invalidate(); setUrl(event.currentTarget.value); }} /></label>
    <details><summary>指定版本或目录（可选）</summary>
      <label className="setting-field"><span>分支、标签或提交</span><input aria-label="技能 Git ref" disabled={busy} value={ref} maxLength={200} placeholder="默认使用链接版本或仓库默认分支" onChange={(event) => { invalidate(); setRef(event.currentTarget.value); }} /></label>
      <label className="setting-field"><span>仓库内技能目录</span><input aria-label="仓库内技能目录" disabled={busy} value={path} maxLength={512} placeholder="skills/example" onChange={(event) => { invalidate(); setPath(event.currentTarget.value); }} /></label>
      <p>分支名包含斜杠时，请填写仓库根地址，并在这里分别指定版本和目录。</p>
    </details>
    <button className="secondary-button compact-button" type="button" disabled={busy || !url.trim()} onClick={() => void inspect()}>检查技能</button>
    {busy && <p role="status">正在处理 GitHub 技能，请稍候…</p>}
    {error && <p className="delegation-hint" role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {preview?.kind === "catalog" && <div className="github-skill-candidates"><p>{preview.note}</p>{preview.candidates.map((candidate) => <button className="text-button" type="button" disabled={busy} key={candidate.path} onClick={() => void inspect({ repository: preview.repository, commit: preview.commit, path: candidate.path })}>{candidate.path}</button>)}</div>}
    {preview?.kind === "skill" && <div className="github-skill-preview">
      <strong>{preview.name}</strong><p>{preview.description}</p>
      <dl><dt>来源</dt><dd>{preview.repository} / {preview.path || "."}</dd><dt>固定提交</dt><dd><code>{preview.commit}</code></dd><dt>安装位置</dt><dd><code>{preview.directory}</code></dd><dt>文件与大小</dt><dd>{preview.files.length} 个文件，{(preview.bytes / 1024).toFixed(1)} KiB</dd></dl>
      {preview.warnings.map((warning) => <p key={warning} className="delegation-hint">{warning}</p>)}
      <details><summary>技能说明（外部内容）</summary><pre>{preview.instructionPreview}</pre>{preview.instructionTruncated && <p>说明较长，此处仅显示前一部分。</p>}</details>
      <details><summary>文件清单</summary><ul>{preview.files.map((file) => <li key={file.path}>{file.path} · {file.size} 字节</li>)}</ul></details>
      {preview.alreadyInstalled ? <p role="status">同名技能或目录已存在，不会覆盖。</p> : <><p>点击后安装到所有组合共享的技能目录；不运行脚本、不自动启用。检查结果 10 分钟内有效。</p><button type="button" className="primary-button compact-button" disabled={busy} onClick={() => void install()}>安装 {preview.name}</button></>}
    </div>}
  </div>;
}
