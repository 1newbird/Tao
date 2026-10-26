import { spawn, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep, parse } from "node:path";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { executionConfiguration, toolEnvironment } from "./execution-policy.mjs";
import { runWindowsSandbox, windowsPath } from "./windows-sandbox.mjs";

const execFileAsync = promisify(execFile);
const MAX_OUTPUT = 2 * 1024 * 1024;
const worker = readFileSync(new URL("./sandbox-worker.mjs", import.meta.url), "utf8");
export const SANDBOX_IMAGE = "tao-runtime:0.1.0";

export function runProcess(program, args, { cwd, env, signal, input, onData, allowFailure = false, windowsVerbatimArguments = false } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolveResult, reject) => {
    const child = spawn(program, args, { cwd, env, windowsHide: true, windowsVerbatimArguments, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "", bytes = 0, stopping, failure;
    const stop = () => {
      if (stopping) return;
      failure ??= new Error("工具执行已取消或超时");
      stopping = (async () => {
        if (!child.pid) return;
        if (process.platform === "win32") {
          try { await execFileAsync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 5000 }); } catch { child.kill(); }
        } else { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } }
      })();
    };
    for (const [stream, isError] of [[child.stdout, false], [child.stderr, true]]) stream.setEncoding("utf8").on("data", (data) => {
      bytes += Buffer.byteLength(data);
      if (bytes > MAX_OUTPUT) { failure = new Error("工具输出超过 2 MB 上限"); stop(); return; }
      if (isError) stderr += data.toString(); else stdout += data.toString();
      onData?.(Buffer.from(data));
    });
    child.on("error", (error) => { failure = error; });
    child.stdin.on("error", () => {});
    child.on("close", async (code) => {
      signal?.removeEventListener("abort", stop);
      await stopping;
      if (failure) reject(failure);
      else if (code && !allowFailure) reject(new Error(`程序退出码 ${code}：${stderr.slice(0, 2000) || stdout.slice(0, 2000)}`));
      else resolveResult({ stdout, stderr, exitCode: code });
    });
    signal?.addEventListener("abort", stop, { once: true });
    child.stdin.end(input ?? "");
    if (signal?.aborted) stop();
  });
}

export async function sandboxStatus(image = SANDBOX_IMAGE) {
  executionConfiguration({ image });
  try {
    const context = await runProcess("docker", ["context", "inspect", "--format", "{{json .Endpoints.docker.Host}}"], { env: toolEnvironment({}), signal: AbortSignal.timeout(5000) });
    if (!/^(?:npipe:|unix:)/.test(JSON.parse(context.stdout))) throw new Error("只允许使用本机 Docker 服务，不支持远程 Docker 上下文");
    const host = JSON.parse(context.stdout);
    const info = await runProcess("docker", ["--host", host, "info", "--format", "{{.OSType}}"], { env: toolEnvironment({}), signal: AbortSignal.timeout(5000) });
    if (info.stdout.trim() !== "linux") throw new Error("需要 Docker Linux 容器后端");
    const result = await runProcess("docker", ["--host", host, "image", "inspect", image, "--format", "{{.Id}}"], { env: toolEnvironment({}), signal: AbortSignal.timeout(5000) });
    return { available: true, image, imageId: result.stdout.trim(), host, error: null };
  } catch (error) { return { available: false, image, imageId: null, error: String(error.message ?? error).slice(0, 2000) }; }
}

export function dockerArguments({ name, image, cwd, policy, program, args, env, host }) {
  if (cwd.includes(",") || /[\r\n]/.test(cwd)) throw new Error("容器工作区路径不能含逗号或换行");
  return ["--host", host, "run", "--rm", "--interactive", "--pull=never", "--name", name, "--label", "tao.sandbox=true", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--user=1000:1000", "--pids-limit=64", "--memory=1g", "--cpus=2",
    "--network", policy.network === "deny" || policy.allowedHosts.length ? "none" : "bridge",
    "--mount", `type=bind,source=${cwd},target=/workspace${policy.workspaceAccess === "read_only" ? ",readonly" : ""}`,
    "--tmpfs", "/tmp:rw,nosuid,nodev,size=64m,mode=1777", "--workdir=/workspace", "--env", "HOME=/tmp", "--env", "TMPDIR=/tmp",
    ...Object.entries(env).flatMap(([key, value]) => ["--env", `${key}=${value}`]), "--entrypoint", program, image, ...args];
}

export function createExecutor(configuration, cwd) {
  const policy = executionConfiguration(configuration);
  if(policy.backend === "windows" && windowsPath(resolve(cwd)).startsWith("\\\\")) throw new Error("Windows 原生预览需要本机磁盘工作区");
  const workspace = windowsPath(realpathSync.native(resolve(cwd)));
  if (policy.backend !== "local" && (workspace.toLowerCase() === resolve(homedir()).toLowerCase() || workspace === parse(workspace).root)) throw new Error("请选择具体项目目录，不能把整个用户目录或磁盘作为沙盒工作区");
  const nativeEnvironment = () => toolEnvironment(policy);
  const execute = async (program, args, { signal, input, onData, allowFailure, environment = {}, workerRequest, windowsVerbatimArguments, workspaceDrive = false } = {}) => {
    const executionSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(120_000)]);
    if (policy.backend === "windows") {
      if(windowsVerbatimArguments) throw new Error("原生沙盒要求结构化参数");
      return runWindowsSandbox(workerRequest ? "node" : program, workerRequest ? ["--input-type=module","-e",worker] : args,
        {cwd:workspace,policy,signal:executionSignal,input:workerRequest ? JSON.stringify(workerRequest) : input,onData,allowFailure,environment,workspaceDrive});
    }
    if (policy.backend === "local") {
      if (policy.fileScope === "workspace" || policy.workspaceAccess === "read_only" || policy.network === "deny" || policy.allowedHosts.length) throw new Error("本机进程不能强制执行文件范围、只读或联网限制，请选择 Windows 原生或 Docker 沙盒，或禁用命令工具");
      return runProcess(program, args, { cwd: workspace, env: { ...nativeEnvironment(), ...environment }, signal: executionSignal, input, onData, allowFailure, windowsVerbatimArguments });
    }
    const status = await sandboxStatus(policy.image);
    if (!status.available) throw new Error(`Docker 沙盒不可用，未回退本机执行：${status.error}`);
    const name = `tao-tool-${randomUUID()}`;
    const env = { ...toolEnvironment(policy, process.env, true), ...environment };
    const argv = dockerArguments({ name, image: status.imageId, host: status.host, cwd: workspace, policy, program: "node", args: ["--input-type=module", "-e", worker], env });
    const request = workerRequest ?? { operation: "exec", program, args };
    try { return await runProcess("docker", argv, { env: toolEnvironment({}), signal: executionSignal, input: JSON.stringify(request), onData, allowFailure }); }
    finally {
      // Cancelling only the Docker CLI can leave its container running.
      // Always remove this exact owned container, including an already exited one.
      try { await runProcess("docker", ["--host", status.host, "rm", "--force", name], { env: toolEnvironment({}), signal: AbortSignal.timeout(10_000) }); } catch (error) {
        if (!String(error.message).includes("No such container")) throw new Error(`沙盒回收失败，请检查容器 ${name}：${error.message}`);
      }
    }
  };
  return { policy, execute,
    command: (command, options) => {
      if (policy.backend === "docker") return execute("/bin/bash", ["-c", command], options);
      if (policy.backend === "windows") return execute(`${process.env.SystemRoot || "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,["-NoLogo","-NoProfile","-NonInteractive","-Command",`Set-Location -LiteralPath $env:TAO_SANDBOX_WORKSPACE; if (-not $?) { throw '无法进入工作区' }; ${command}`],{...options,workspaceDrive:true});
      if (process.platform === "win32") return execute(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"${command}"`], { ...options, windowsVerbatimArguments: true });
      return execute("/bin/sh", ["-c", command], options);
    },
    containerPath: (path) => {
      // Tauri canonical paths use \\?\ while model arguments often use DOS paths.
      // Compare the same namespace before resolving or checking containment.
      const normalized = windowsPath(path);
      const target = isAbsolute(normalized) ? resolve(normalized) : resolve(workspace, normalized);
      const part = relative(workspace, target);
      if (part === ".." || part.startsWith(`..${sep}`) || isAbsolute(part)) throw new Error("沙盒路径超出工作区");
      if (policy.backend === "windows") return target;
      return `/workspace${part ? `/${part.split(sep).join("/")}` : ""}`;
    },
  };
}
