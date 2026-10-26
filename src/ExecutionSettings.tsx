import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { defaultExecution } from "./agent-profiles";
import type { ExecutionConfiguration } from "./agent-profiles";

function NameList({ label, value, placeholder, onChange }: { label: string; value: string[]; placeholder: string; onChange: (value: string[]) => void }) {
  const [text, setText] = useState(value.join("\n"));
  const [focused, setFocused] = useState(false);
  useEffect(() => { if (!focused) setText(value.join("\n")); }, [value, focused]);
  return <label className="setting-field"><span>{label}</span><textarea rows={3} value={text} placeholder={placeholder} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} onChange={(event) => {
    setText(event.currentTarget.value);
    onChange([...new Set(event.currentTarget.value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean))]);
  }} /></label>;
}

export function ExecutionSettings({ value, onChange }: { value?: ExecutionConfiguration; onChange: (value: ExecutionConfiguration) => void }) {
  const policy = { ...defaultExecution(), ...value };
  const [checking, setChecking] = useState(false);
  const [preparingDocker, setPreparingDocker] = useState(false);
  const [preparedImage, setPreparedImage] = useState<{ image: string; message: string } | null>(null);
  const [status, setStatus] = useState("");
  const [nativeWorkspace, setNativeWorkspace] = useState("");
  const currentImage = useRef(policy.image);
  const currentBackend = useRef(policy.backend);
  const latestPolicy = useRef(policy);
  const mounted = useRef(true);
  latestPolicy.current = policy;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  currentBackend.current = policy.backend;
  currentImage.current = policy.image;
  useEffect(() => { setStatus("");setChecking(false); }, [policy.image, policy.backend]);
  const update = (patch: Partial<ExecutionConfiguration>) => onChange({ ...policy, ...patch });
  return <div className="workspace-section form-section">
    <div className="workspace-heading"><span className="eyebrow">Execution</span><h2>权限与执行环境</h2><p>组合决定工具的执行边界，已有会话保留自己的配置版本。子代理的有效权限取父子组合交集。</p></div>
    <section className="profile-form-group"><h3>执行后端</h3>
      <label className="setting-field"><span>工具运行位置</span><select value={policy.backend} onChange={(event) => update({ backend: event.currentTarget.value as ExecutionConfiguration["backend"], ...(event.currentTarget.value !== "local" ? { fileScope: "workspace", network: "deny" } : {}) })}><option value="local">本机运行（无沙盒）</option><option value="docker">Docker 沙盒</option><option value="windows">Windows 原生沙盒（预览）</option></select><small>本机使用当前用户权限；Windows 原生提供系统隔离，无需 Docker；Docker 提供 Linux 环境。此选项只控制工具执行，模型连接和子代理协作分别管理。</small></label>
      {policy.backend === "windows" && <>
        <p className="delegation-hint">使用 Windows AppContainer 和进程树回收，每次操作有独立身份。命令使用 Windows PowerShell，始终断网；“允许联网”只开放受控 HTTP 工具。系统公共资源仍可能可读。</p>
        <p className="delegation-hint">从源码开发时，首次先运行 npm.cmd run tao:node 构建兼容运行时；安装版随包提供。该操作不替换系统 Node。</p>
        <p className="delegation-hint">首次需为工作区执行管理员初始化，只授予 Tao 能力身份必要的路径元数据和设备权限，不创建账户、不改防火墙。重启后可能需要重新初始化。随包 Node 支持子进程与 npm 本地构建；命令临时映射工作区为盘符根目录，结束后释放，不覆盖已有盘符。固定宿主路径、目录链接、硬链接和大型授权目录仍有限制，Windows 10 尚待实机验收。</p>
        <button type="button" className="secondary-button compact-button" disabled={checking} onClick={() => { void invoke<string | null>("choose_workspace_directory").then(path=>{if(path){setNativeWorkspace(path);setStatus("");}}).catch(error=>setStatus(String(error))); }}>选择要准备的工作区</button>
        {nativeWorkspace && <p className="delegation-hint">{nativeWorkspace}</p>}
        <div className="action-row">
          <button type="button" className="secondary-button compact-button" disabled={checking || !nativeWorkspace} onClick={() => {
            setChecking(true);setStatus("");
            void invoke<{available:boolean;error:string|null}>("get_sandbox_status",{image:policy.image,backend:"windows",workspacePath:nativeWorkspace}).then(result=>{if(currentBackend.current==="windows")setStatus(result.available?"原生预览基础环境已准备；工具兼容限制仍适用。":`尚未就绪：${result.error}`);}).catch(error=>{if(currentBackend.current==="windows")setStatus(String(error));}).finally(()=>{if(currentBackend.current==="windows")setChecking(false);});
          }}>检测原生环境</button>
          <button type="button" className="secondary-button compact-button" disabled={checking || !nativeWorkspace} onClick={() => {
            setChecking(true);setStatus("请在 Windows 权限提示中完成初始化…");
            void invoke<{available:boolean;error:string|null}>("initialize_windows_sandbox",{workspacePath:nativeWorkspace}).then(result=>{if(currentBackend.current==="windows")setStatus(result.available?"初始化完成，可将此组合用于该工作区。":`初始化未就绪：${result.error}`);}).catch(error=>{if(currentBackend.current==="windows")setStatus(`初始化未完成：${String(error)}`);}).finally(()=>{if(currentBackend.current==="windows")setChecking(false);});
          }}>管理员初始化</button>
          <button type="button" className="secondary-button compact-button" disabled={checking} onClick={() => {
            setChecking(true);setStatus("请在 Windows 权限提示中确认移除…");
            void invoke("remove_windows_sandbox").then(()=>{if(currentBackend.current==="windows")setStatus("已移除本机共享原生授权；下次使用需重新初始化。会话和工作区文件保留。");}).catch(error=>{if(currentBackend.current==="windows")setStatus(String(error));}).finally(()=>{if(currentBackend.current==="windows")setChecking(false);});
          }}>移除本机原生授权</button>
        </div>
        <p className="delegation-hint">移除会影响本机全部 Tao 原生组合，请先停止正在运行的原生工具。MSI 升级保留授权；明确卸载时移除授权，活动工具会阻止卸载。会话、组合和工作区文件不会删除。</p>
        {status && <p role="status" className="delegation-hint">{status}</p>}
      </>}
      {policy.backend === "docker" && <>
        <label className="setting-field"><span>沙盒镜像</span><input disabled={preparingDocker} value={policy.image} onChange={(event) => update({ image: event.currentTarget.value })} /><small>推荐 Tao 基础镜像：Node 22、Python、Git、rg、curl、jq、压缩工具及 C/C++ 构建工具。需先安装 Docker Desktop 并启用 Linux 容器；工具执行时不会自动拉取镜像。</small></label>
        <button type="button" className="secondary-button compact-button" disabled={checking || preparingDocker} onClick={() => {
          setPreparingDocker(true); setPreparedImage(null); setStatus("正在构建并验收 Tao 基础镜像，首次可能需要数分钟…");
          void invoke<{ image: string; message: string }>("prepare_docker_image").then((result) => { if (mounted.current && currentBackend.current === "docker") { onChange({ ...latestPolicy.current, image: result.image }); setPreparedImage(result); setStatus(""); } }).catch((error) => { if (mounted.current && currentBackend.current === "docker") setStatus(`镜像准备失败：${String(error)}`); }).finally(() => { if (mounted.current) setPreparingDocker(false); });
        }}>{preparingDocker ? "正在准备 Tao 镜像…" : "准备 Tao 基础镜像"}</button>
        <p className="delegation-hint">点击后使用随包配方在本机构建，首次需要下载基础镜像和软件包，并占用磁盘空间。验收通过后选择 tao-runtime:0.1.0；失败保留旧镜像。浏览器、OCR 和项目依赖需另行准备。</p>
        {preparedImage?.image === policy.image && <p className="connection-result success" role="status">{preparedImage.message}</p>}
        <button type="button" className="secondary-button compact-button" disabled={checking || preparingDocker} onClick={() => {
          setChecking(true); const image = policy.image;
          void invoke<{ available: boolean; image: string; error: string | null }>("get_sandbox_status", { image }).then((result) => { if (currentImage.current === image && currentBackend.current === "docker") setStatus(result.available ? `Docker 与镜像可用：${result.image}` : `沙盒不可用：${result.error}`); }).catch((error) => { if (currentImage.current === image && currentBackend.current === "docker") setStatus(`检测失败：${String(error)}`); }).finally(() => {if(currentBackend.current === "docker")setChecking(false);});
        }}>{checking ? "正在检测…" : "检测沙盒环境"}</button>
        {status && <p role="status" className="delegation-hint">{status}</p>}
        <p className="delegation-hint">只挂载所选工作区，不挂载用户目录和 Docker 接口。工作区内允许的修改会直接保存到原文件；每条命令最多执行 120 秒。关闭查看页不会停止任务，停止任务会回收对应容器。</p>
      </>}
    </section>
    <section className="profile-form-group"><h3>文件与网络</h3>
      <div className="two-column-settings">
        <label className="setting-field"><span>文件范围</span><select disabled={policy.backend !== "local"} value={policy.backend !== "local" ? "workspace" : policy.fileScope} onChange={(event) => update({ fileScope: event.currentTarget.value as ExecutionConfiguration["fileScope"] })}><option value="any">按工具审核规则处理</option><option value="workspace">仅当前工作区</option></select></label>
        <label className="setting-field"><span>工作区写入</span><select value={policy.workspaceAccess} onChange={(event) => update({ workspaceAccess: event.currentTarget.value as ExecutionConfiguration["workspaceAccess"] })}><option value="read_write">允许写入，仍遵守工具权限</option><option value="read_only">只读</option></select></label>
        <label className="setting-field"><span>工具联网</span><select value={policy.network} onChange={(event) => update({ network: event.currentTarget.value as ExecutionConfiguration["network"] })}><option value="inherit">跟随后端默认值</option><option value="deny">禁止联网</option><option value="allow">允许联网</option></select><small>默认：本机允许，沙盒禁止。Windows 原生命令始终断网；该规则不影响模型连接。</small></label>
      </div>
      <NameList label="HTTP 工具允许的域名（可选）" value={policy.allowedHosts} placeholder={"api.example.com\nfiles.example.com"} onChange={(allowedHosts) => update({ allowedHosts })} />
      <p className="delegation-hint">空名单表示不额外限制主机；填写后与工具自身名单取交集，使用准确主机名。设置主机名单时，容器命令保持断网，只有受控 HTTP 工具可以访问名单内地址。</p>
      {policy.backend === "local" && (policy.fileScope === "workspace" || policy.workspaceAccess === "read_only" || policy.network === "deny" || policy.allowedHosts.length > 0) && <p className="delegation-hint">这些限制可审核文件与 HTTP 工具；本机程序无法强制这些边界，因此命令和程序工具会被拒绝。需要在这些限制下运行命令时，请选择 Windows 原生或 Docker 沙盒。</p>}
    </section>
    <section className="profile-form-group"><h3>工具凭据</h3>
      <NameList label="允许工具读取的凭据变量名称" value={policy.allowedEnv} placeholder={"SERVICE_TOKEN\nDOCUMENTS_API_KEY"} onChange={(allowedEnv) => update({ allowedEnv })} />
      <p className="delegation-hint">只填写环境变量名称，不填写密钥值。命令不继承全部宿主环境；HTTP 请求头中的 env 引用也须出现在名单中。容器只接收这里明确授权的变量。模型认证由 Tao 独立管理。</p>
    </section>
  </div>;
}
