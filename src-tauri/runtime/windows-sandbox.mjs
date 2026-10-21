import { spawn, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, lstat, unlink, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { release } from "node:os";
import { toolEnvironment } from "./execution-policy.mjs";
import { cacheSandboxNode, sandboxNodeSource } from "./sandbox-node.mjs";

const exec = promisify(execFile);
const bundled = fileURLToPath(new URL("../native/tao-windows-sandbox.exe", import.meta.url));
const development = fileURLToPath(new URL("../resources/native/tao-windows-sandbox.exe", import.meta.url));
let stateRoot;
let cachedNode;
export function windowsPath(path) {
  if(process.platform!=="win32")return path;
  if(path.startsWith("\\\\?\\UNC\\"))return `\\\\${path.slice(8)}`;
  return path.startsWith("\\\\?\\")&&/^[a-z]:\\/i.test(path.slice(4))?path.slice(4):path;
}
export function configureWindowsSandbox(home) { const next=join(windowsPath(resolve(home)),"native-sandbox");if(stateRoot!==next)cachedNode=undefined;stateRoot=next; }
export function windowsSandboxHelper() { return existsSync(bundled) ? bundled : development; }
export async function windowsSandboxStatus(workspace) {
  if (process.platform !== "win32" || process.arch!=="x64" || Number(release().split('.')[0])<10) return { available: false, backend: "windows", code: "unsupported_platform", error: "Windows 原生沙盒需要 Windows 10 或更新系统的 x64 环境" };
  const helper = windowsSandboxHelper();
  if (!existsSync(helper)) return { available: false, backend: "windows", code: "missing_helper", error: "缺少原生执行器，请先运行 scripts/build-windows-sandbox.ps1" };
  try {
    const node = await sandboxNodeSource();
    const result = await exec(helper, ["--compat-status"], { windowsHide: true, timeout: 5000, maxBuffer: 256 * 1024, env: toolEnvironment({}) });
    const details = JSON.parse(result.stdout);
    return { available: details.ready === true, backend: "windows", code: details.ready ? "preview_ready" : "initialization_required", details,
      error: details.ready ? null : "需要管理员初始化此工作区；重启后可能需要重新准备设备权限", preview: true, workspace:workspace??null,
      nodeVersion: node.manifest.nodeVersion, nodeAppContainerPatch: true,
      warnings: ["命令始终断网；npm 下载依赖、需要联网或常驻服务的命令仍受执行策略限制。", "命令使用当前登录会话可见的临时工作区盘符；结束后释放，不覆盖已有盘符。固定宿主绝对路径或访问工作区外配置的构建仍可能被拒绝。", "Windows 10 尚未实机验收；包含目录链接、硬链接或超过 10000 条目的授权目录暂不支持。"] };
  } catch (error) { return { available: false, backend: "windows", code: "probe_failed", error: String(error.message).slice(0, 2000) }; }
}
function inside(parent, child) { const part=relative(windowsPath(parent),windowsPath(child)); return !part || (part!==".." && !part.startsWith(`..${sep}`) && !isAbsolute(part)); }
export async function runWindowsSandbox(program, args, { cwd, policy, signal, input, onData, allowFailure, workspaceDrive = false, environment = {} }) {
  signal?.throwIfAborted();
  if (!stateRoot) throw new Error("Windows 原生沙盒尚未绑定 Tao 数据目录");
  if([cwd,program,stateRoot].some(path=>windowsPath(path).replaceAll('/','\\').startsWith('\\\\'))) throw new Error("Windows 原生预览仅支持本机磁盘路径，不支持 UNC 或设备命名空间路径");
  const status = await windowsSandboxStatus(cwd);
  if (!status.available) throw new Error(`Windows 原生沙盒不可用，未回退本机：${status.error}`);
  const helper = windowsSandboxHelper();
  const nodeSource=await sandboxNodeSource();
  if (inside(cwd, helper) || inside(cwd, process.execPath) || inside(cwd, nodeSource.folder) || inside(cwd, stateRoot)) throw new Error("工作区不能包含 Tao 执行器、Node 或沙盒状态目录，请选择独立项目目录");
  cachedNode ??= cacheSandboxNode(dirname(stateRoot));
  let node;try{node=await cachedNode;}catch(error){cachedNode=undefined;throw error;}
  let executable = program;
  if (["node", "node.exe"].includes(program.toLowerCase()) || program===process.execPath) executable = node;
  else if (!isAbsolute(program)) {
    if (!/^[a-zA-Z0-9_.-]+$/.test(program)) throw new Error("原生程序名称无效");
    const found=await exec(join(process.env.SystemRoot || "C:\\Windows","System32","where.exe"),[program],{windowsHide:true,timeout:5000,cwd:dirname(helper),env:toolEnvironment({})});
    executable=found.stdout.trim().split(/\r?\n/).find(path=>isAbsolute(path)&&existsSync(path));
    if (!executable) throw new Error(`找不到原生工具：${program}`);
  }
  const temporary=join(dirname(stateRoot),"native-tool-temp");
  await mkdir(temporary,{recursive:true});
  const temp=await mkdtemp(join(temporary,"tool-"));
  const inherited=Object.fromEntries(Object.entries({...toolEnvironment(policy),...environment}).map(([name,value])=>[name.toUpperCase(),value]));
  const env={...inherited,PATH:`${dirname(node)};${inherited.PATH||""}`,HOME:temp,USERPROFILE:temp,APPDATA:temp,LOCALAPPDATA:temp,TEMP:temp,TMP:temp};
  const request={id:randomUUID(),program:executable,args,cwd,read:[cwd,dirname(node)],write:[temp,...(policy.workspaceAccess==="read_only"?[]:[cwd])],environment:env,input:input??"",timeoutMs:120000,workspaceDrive};
  try {
    await exec(helper,["--cleanup","--state-root",stateRoot],{windowsHide:true,timeout:15000,env:toolEnvironment({})});
    return await new Promise((resolveResult,reject) => {
      const child=spawn(helper,["--state-root",stateRoot],{windowsHide:true,stdio:["pipe","pipe","pipe"],env:toolEnvironment({})});
      let pending="", result, failure, stderr="", bytes=0, mappedCwd;
      const stop=()=>{ failure??=new Error("原生工具执行已取消或超时"); child.stdin.end("cancel\n"); };
      const deadline=setTimeout(stop,125000);
      const force=setTimeout(()=>child.kill(),135000);
      child.stdin.on("error",()=>{});
      child.stderr.setEncoding("utf8").on("data",data=>{stderr=(stderr+data).slice(-4000);});
      child.stdout.setEncoding("utf8").on("data",data=>{
        pending+=data;
        if (pending.length>24*1024*1024) { failure=new Error("原生执行器响应超过上限"); stop(); return; }
        while(pending.includes("\n")) {
          const end=pending.indexOf("\n"),line=pending.slice(0,end);pending=pending.slice(end+1);
          try {
            const event=JSON.parse(line);
            if(event.type==="error") failure=new Error(event.error);
            else if(event.type==="started" && event.workspaceDrive) { mappedCwd=event.workspaceDrive;onData?.(Buffer.from(`[Tao] 临时工作目录 ${mappedCwd} → ${cwd}；命令结束即释放，后续调用请使用原路径或相对路径。\n`)); }
            else if(event.type==="result") result=event;
            else if(event.type==="data") { const chunk=Buffer.from(event.bytes);bytes+=chunk.length;if(bytes>2*1024*1024){failure=new Error("工具输出超过 2 MB 上限");stop();}else onData?.(chunk); }
          } catch(error) {failure=error;stop();}
        }
      });
      child.on("error",error=>{failure=error;});
      child.on("close",code=>{
        clearTimeout(deadline);clearTimeout(force);signal?.removeEventListener("abort",stop);child.stdin.destroy();
        if(failure) reject(failure);
        else if(code||!result) reject(new Error(`原生执行器异常退出：${code} ${stderr}`));
        else if(result.cancelled) reject(new Error("原生工具已取消、超时或输出超限"));
        else if(result.exitCode&&!allowFailure) reject(new Error(`程序退出码 ${result.exitCode}：${result.stderr.slice(0,2000)||result.stdout.slice(0,2000)}`));
        else resolveResult({stdout:result.stdout,stderr:result.stderr,exitCode:result.exitCode,...(mappedCwd?{mappedCwd,workspace:cwd}:{})});
      });
      child.stdin.write(JSON.stringify(request)+"\n");
      signal?.addEventListener("abort",stop,{once:true});if(signal?.aborted)stop();
    });
  } finally {
    await exec(helper,["--cleanup","--state-root",stateRoot],{windowsHide:true,timeout:15000,env:toolEnvironment({})});
    if((await lstat(temp)).isSymbolicLink()) await unlink(temp);
    else {
      const canonical=await realpath(temp), base=await realpath(temporary);
      if(canonical===base||!inside(base,canonical)) throw new Error("拒绝清理异常的原生临时目录路径");
      await rm(canonical,{recursive:true,force:true});
    }
  }
}
