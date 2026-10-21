import { spawn, execFile } from "node:child_process";
import { mkdtemp, readdir, rm, stat, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { verifyReleaseLicenses } from "./release-licenses.mjs";
import { verifyStaticCrt } from "./pe-imports.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const resourceRoot = process.argv[2] === "--resource-root" && process.argv[3]
  ? resolve(process.argv[3])
  : join(projectRoot, "src-tauri", "resources");
const piRoot = join(resourceRoot, "pi");
const nodeExe = join(resourceRoot, "node", "node.exe");
const runtimeScript = join(resourceRoot, "runtime", "tao-runtime.mjs");
const preflight = join(piRoot, "node_modules", "tsx", "dist", "preflight.cjs");
const loader = join(piRoot, "node_modules", "tsx", "dist", "loader.mjs");

function nodeCompatiblePath(value) {
  const prefix = "\\\\?\\";
  if (!value.startsWith(prefix)) return value;
  const remainder = value.slice(prefix.length);
  return remainder.startsWith("UNC\\") ? `\\\\${remainder.slice(4)}` : remainder;
}

function log(message) {
  process.stdout.write(`[Tao 发布验证] ${message}\n`);
}

async function requireFile(path, label) {
  const info = await stat(path).catch(() => null);
  if (!info?.isFile() || info.size === 0) {
    throw new Error(`${label}缺失或为空：${path}`);
  }
}

async function directorySize(path) {
  let bytes = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) bytes += await directorySize(child);
    else if (entry.isFile()) bytes += (await stat(child)).size;
  }
  return bytes;
}

function formatMiB(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

async function verifyRuntimeReady(resourcePath) {
  const home = await mkdtemp(join(tmpdir(), "tao-release-verify-"));
  const effectiveRoot = nodeCompatiblePath(resourcePath);
  const effectivePiRoot = join(effectiveRoot, "pi");
  const effectiveNodeExe = join(effectiveRoot, "node", "node.exe");
  const effectiveRuntimeScript = join(effectiveRoot, "runtime", "tao-runtime.mjs");
  const effectivePreflight = join(effectivePiRoot, "node_modules", "tsx", "dist", "preflight.cjs");
  const effectiveLoader = join(effectivePiRoot, "node_modules", "tsx", "dist", "loader.mjs");
  const loaderUrl = pathToFileURL(effectiveLoader).href;
  if (loaderUrl.includes("%3F/") || !loaderUrl.startsWith("file:///")) {
    throw new Error(`tsx loader 文件 URL 无效：${loaderUrl}`);
  }
  const child = spawn(effectiveNodeExe, [
    "--require", effectivePreflight,
    "--import", loaderUrl,
    effectiveRuntimeScript,
    "--pi-root", effectivePiRoot,
    "--tao-home", home,
    "--cwd", home,
  ], {
    cwd: effectivePiRoot,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: home,
      TSX_TSCONFIG_PATH: join(effectivePiRoot, "tsconfig.json"),
      NO_COLOR: "1",
      FORCE_COLOR: "0",
    },
  });

  let stdout = "";
  let stderr = "";
  const append = (current, chunk) => (current + String(chunk)).slice(-16000);
  child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
  child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });

  try {
    await new Promise((resolveReady, rejectReady) => {
      let settled = false;
      let pingSent = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearInterval(poll);
        clearTimeout(timeout);
        error ? rejectReady(error) : resolveReady();
      };
      const poll = setInterval(() => {
        for (const line of stdout.split(/\r?\n/)) {
          if (!line.trim()) continue;
          let message;
          try { message = JSON.parse(line); } catch { continue; }
          if (message.type === "ready" && !pingSent) {
            pingSent = true;
            child.stdin.write('{"id":"release-verify","type":"ping"}\n');
          }
          if (message.type === "response" && message.id === "release-verify") {
            return message.success && message.data?.pid
              ? finish()
              : finish(new Error(`内置 Runtime ping 失败：${message.error ?? "无响应"}`));
          }
          if (message.type === "fatal") return finish(new Error(`内置 Runtime 初始化失败：${message.message}`));
        }
      }, 25);
      const timeout = setTimeout(() => finish(new Error(`内置 Runtime 未在 45 秒内 ready。stderr: ${stderr || "(空)"}`)), 45_000);
      child.once("error", (error) => finish(new Error(`无法启动内置 Node：${error.message}`)));
      child.once("exit", (code, signal) => finish(new Error(`内置 Runtime 提前退出（${code ?? signal}）。stderr: ${stderr || "(空)"}; stdout: ${stdout || "(空)"}`)));
    });
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      if (child.stdin.writable) child.stdin.write('{"type":"shutdown"}\n');
      await Promise.race([
        new Promise((resolveExit) => child.once("exit", resolveExit)),
        new Promise((resolveDelay) => setTimeout(resolveDelay, 3000)),
      ]);
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
    await rm(home, { recursive: true, force: true });
  }
}

async function main() {
  for (const [path, label] of [
    [nodeExe, "内置 Node"],
    [join(resourceRoot,"native","tao-windows-sandbox.exe"),"Windows 原生沙盒执行器"],
    [runtimeScript, "Tao Runtime"],
    [join(resourceRoot, "runtime", "policy.mjs"), "Tao 权限模块"],
    ...["execution", "execution-policy", "execution-tools", "sandbox-worker", "compaction-policy", "windows-sandbox", "sandbox-node"].map((name) => [join(resourceRoot, "runtime", `${name}.mjs`), `Tao ${name}`]),
    [join(resourceRoot, "node", "BUILD-MANIFEST.json"), "兼容 Node 构建清单"],
    [join(resourceRoot, "node", "npm.cmd"), "内置 npm"],
    [join(resourceRoot, "node", "npx.cmd"), "内置 npx"],
    [join(resourceRoot, "runtime", "multi-agent.mjs"), "Tao 多智能体协调器"],
    [join(resourceRoot, "runtime", "context.mjs"), "Tao 上下文模块"],
    [join(resourceRoot, "runtime", "prompt-policy.mjs"), "Tao 提示词策略"],
    ...["tools", "collaboration", "permissions", "customization"].map((topic) => [join(resourceRoot, "runtime", "docs", `${topic}.md`), `Tao 手册 ${topic}`]),
    [preflight, "tsx preflight"],
    [loader, "tsx loader"],
    [join(piRoot, "packages", "coding-agent", "src", "index.ts"), "Pi 入口"],
    [join(piRoot, "package.json"), "Pi package.json"],
    [join(piRoot, "tsconfig.json"), "Pi tsconfig.json"],
    [join(resourceRoot, "RELEASE-MANIFEST.json"), "发布清单"],
  ]) await requireFile(path, label);

  const licenseCount = await verifyReleaseLicenses(resourceRoot);
  const manifest=JSON.parse(await readFile(join(resourceRoot,"RELEASE-MANIFEST.json"),"utf8"));
  const nodeBuild=JSON.parse(await readFile(join(resourceRoot,"node","BUILD-MANIFEST.json"),"utf8"));
  if(JSON.stringify(nodeBuild)!==JSON.stringify(manifest.nodeBuild)||manifest.nodeVersion!==nodeBuild.nodeVersion)throw new Error("Node 构建信息与发布清单不一致");
  const nodeModule=await import(pathToFileURL(join(resourceRoot,"runtime","sandbox-node.mjs")).href);
  const verifiedNode=await nodeModule.sandboxNodeSource();
  if(resolve(nodeCompatiblePath(verifiedNode.folder)).toLowerCase()!==resolve(nodeCompatiblePath(join(resourceRoot,"node"))).toLowerCase())throw new Error("Node 验证使用了发布目录之外的资源");
  log(`兼容 Node ${nodeBuild.nodeVersion}、上游补丁及 ${nodeBuild.files.length} 个资源 SHA-256 通过`);
  const nativeFile=join(resourceRoot,"native","tao-windows-sandbox.exe");
  if(manifest.nativeSandbox?.file!=="native/tao-windows-sandbox.exe" || manifest.nativeSandbox?.sha256!==createHash("sha256").update(await readFile(nativeFile)).digest("hex")) throw new Error("原生执行器与发布清单不一致");
  const nativeImports=verifyStaticCrt(await readFile(nativeFile));
  verifyStaticCrt(await readFile(nodeExe));
  const nativeProbe=await promisify(execFile)(nativeFile,["--compat-status"],{windowsHide:true,timeout:5000});
  if(JSON.parse(nativeProbe.stdout).capability!=="Tao.WindowsSandbox.Compatibility.v1") throw new Error("原生执行器版本不匹配");
  log(`原生执行器 SHA-256、静态 CRT 与只读探测通过（${nativeImports.length} 项系统 DLL 导入）；此探测不初始化系统权限`);
  log(`${licenseCount} 份许可声明完整，SHA-256 与发布清单一致`);

  const modelData = join(piRoot, "packages", "ai", "src", "providers", "data");
  const modelFiles = (await readdir(modelData)).filter((name) => name.endsWith(".json"));
  if (modelFiles.length < 1) throw new Error(`Pi 模型数据缺失：${modelData}`);
  log(`找到 ${modelFiles.length} 个 Pi 模型数据文件`);

  await verifyRuntimeReady(resourceRoot);
  log("普通路径：内置 Node + Pi + Runtime 已进入 ready，ping 请求成功");
  if (process.platform === "win32") {
    await verifyRuntimeReady(`\\\\?\\${resourceRoot}`);
    log("Windows 扩展路径：Runtime 已进入 ready，ping 请求成功");
  }

  for (const name of ["node", "runtime", "pi"]) {
    log(`${name}: ${formatMiB(await directorySize(join(resourceRoot, name)))}`);
  }
  log(`resources 合计: ${formatMiB(await directorySize(resourceRoot))}`);
}

await main();
