import { createHash } from "node:crypto";
import { cp, mkdir, rm, stat, writeFile, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { copyReleaseLicenses } from "./release-licenses.mjs";

const execFileAsync = promisify(execFile);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const piRoot = join(projectRoot, "vendor", "pi");
const resourceRoot = join(projectRoot, "src-tauri", "resources");
const cacheRoot = join(projectRoot, ".tao-release-cache");

const nodeBuildConfiguration = JSON.parse(await readFile(join(projectRoot, "native", "node-runtime", "build-config.json"), "utf8"));
const nodeVersion = nodeBuildConfiguration.version;
if (process.env.TAO_NODE_VERSION?.trim() && process.env.TAO_NODE_VERSION.trim() !== nodeVersion) fail("兼容运行时已固定版本；修改 native/node-runtime/build-config.json 并重新验收后才能升级。");
const nodeArchivePath = join(cacheRoot, "node-native-build", `node-v${nodeVersion}.tar.xz`);
const nodeExtractRoot = join(cacheRoot, "node-native-build", "runtime");
const nodeBinaryPath = join(nodeExtractRoot, "node.exe");
const developmentOnlyNodeModules = new Set([
  "@biomejs", "@rolldown", "@types", "@typescript",
  "husky", "lightningcss", "lightningcss-win32-x64-msvc",
  "shx", "typescript", "vite", "vitest", "vitest-evals",
]);

function log(message) {
  process.stdout.write(`[Tao 发布准备] ${message}\n`);
}

function fail(message) {
  throw new Error(`[Tao 发布准备] ${message}`);
}

async function ensureFile(path, description) {
  try {
    const info = await stat(path);
    if (!info.isFile()) fail(`${description}不是文件：${path}`);
  } catch {
    fail(`找不到${description}：${path}`);
  }
}

async function copyTree(source, target, options = {}) {
  await cp(source, target, {
    recursive: true,
    dereference: true,
    ...options,
  });
}

async function fileExists(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function shouldCopyPiPath(source) {
  const normalized = relative(piRoot, source).split(sep).filter(Boolean);
  if (normalized.length === 0) return true;

  const first = normalized[0];
  if ([".git", ".github", ".husky", ".pi", "docs", "examples", "scripts", "test"].includes(first)) {
    return false;
  }
  if (normalized.includes("node_modules")) {
    return false;
  }
  return true;
}

async function prepareResources() {
  const runtimeScript = join(projectRoot, "src-tauri", "runtime", "tao-runtime.mjs");
  const piPackage = join(piRoot, "package.json");
  const piTsconfig = join(piRoot, "tsconfig.json");
  const piNodeModules = join(piRoot, "node_modules");

  await ensureFile(runtimeScript, "Tao Runtime 脚本");
  await ensureFile(join(piRoot, "packages", "coding-agent", "src", "index.ts"), "Pi coding-agent 源码");
  await ensureFile(join(piNodeModules, "tsx", "dist", "preflight.cjs"), "Pi tsx runtime");
  await ensureFile(join(piNodeModules, "tsx", "dist", "loader.mjs"), "Pi tsx loader");
  await ensureFile(piPackage, "Pi package.json");
  await ensureFile(piTsconfig, "Pi tsconfig.json");
  for (const path of [
    join(projectRoot, "LICENSE"),
    join(projectRoot, "NOTICE"),
    join(projectRoot, "THIRD_PARTY_NOTICES.md"),
    join(piRoot, "LICENSE"),
    join(nodeExtractRoot, "LICENSE"),
  ]) await ensureFile(path, "许可声明");

  await rm(resourceRoot, { recursive: true, force: true });
  await mkdir(resourceRoot, { recursive: true });

  await copyTree(join(projectRoot, "src-tauri", "runtime"), join(resourceRoot, "runtime"));
  await copyTree(join(piRoot, "packages"), join(resourceRoot, "pi", "packages"), {
    filter: shouldCopyPiPath,
  });
  await copyTree(piNodeModules, join(resourceRoot, "pi", "node_modules"), {
    filter: (source) => {
      const relativePath = relative(piNodeModules, source).split(sep).filter(Boolean);
      if (relativePath.length === 0) return true;
      return !relativePath.includes(".cache") && !developmentOnlyNodeModules.has(relativePath[0]);
    },
  });

  for (const file of ["package.json", "package-lock.json", "tsconfig.json", "tsconfig.base.json", ".npmrc"]) {
    const source = join(piRoot, file);
    if (await fileExists(source)) {
      await copyTree(source, join(resourceRoot, "pi", file));
    }
  }

  await copyTree(nodeExtractRoot, join(resourceRoot, "node"));
  await execFileAsync("powershell.exe",["-NoProfile","-ExecutionPolicy","Bypass","-File",join(projectRoot,"scripts","build-windows-sandbox.ps1"),"-Release"],{cwd:projectRoot,windowsHide:true,timeout:120000});
  const nativeSandbox = { file:"native/tao-windows-sandbox.exe", sha256:createHash("sha256").update(await readFile(join(resourceRoot,"native","tao-windows-sandbox.exe"))).digest("hex"), stage:"preview" };
  const licenses = await copyReleaseLicenses({ projectRoot, nodeExtractRoot, resourceRoot });
  await writeFile(
    join(resourceRoot, "RELEASE-MANIFEST.json"),
    `${JSON.stringify({
      platform: "windows-x64",
      nodeVersion,
      nodeBuild: JSON.parse(await readFile(join(nodeExtractRoot, "BUILD-MANIFEST.json"), "utf8")),
      piSource: "vendor/pi",
      taoLicense: "PolyForm-Noncommercial-1.0.0",
      licenses,
      nativeSandbox,
      generatedAt: new Date().toISOString(),
    }, null, 2)}\n`,
    "utf8",
  );
  log(`已复制 ${licenses.length} 份许可声明并记录 SHA-256`);
}

async function main() {
  if (process.platform !== "win32" || process.arch !== "x64") {
    fail("当前发布准备脚本只支持 Windows x64。");
  }
  if (process.env.CI && process.env.TAO_RELEASE_ALLOW_NETWORK !== "1" && !(await fileExists(nodeArchivePath)) && !(await fileExists(join(nodeExtractRoot, "BUILD-MANIFEST.json")))) {
    fail("CI 环境禁止隐式下载 Node，请预先缓存已校验的源码/运行时，或设置 TAO_RELEASE_ALLOW_NETWORK=1。");
  }

  log(`项目目录：${projectRoot}`);
  log(`Pi 目录：${piRoot}`);
  log(`准备 Node ${nodeVersion} 与 AppContainer 上游修复（首次需要 C++ 编译环境）`);
  await execFileAsync(process.execPath, [join(projectRoot, "scripts", "build-sandbox-node.mjs"), ...(process.env.CI && process.env.TAO_RELEASE_ALLOW_NETWORK !== "1" ? ["--offline"] : [])], { cwd: projectRoot, windowsHide: true, timeout: 7200000 });
  await ensureFile(nodeBinaryPath, "兼容 Node 可执行文件");
  await prepareResources();
  log("发布资源准备完成");
  log("本命令仅准备资源；安装包需另行运行 tao:release 或 tauri build");
}

await main();
