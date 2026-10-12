import { createHash } from "node:crypto";
import { cp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const piRoot = join(projectRoot, "vendor", "pi");
const resourceRoot = join(projectRoot, "src-tauri", "resources");
const cacheRoot = join(projectRoot, ".tao-release-cache");

const nodeVersion = process.env.TAO_NODE_VERSION?.trim() || "22.19.0";
const nodeArchiveName = `node-v${nodeVersion}-win-x64.zip`;
const nodeDownloadUrl = `https://nodejs.org/dist/v${nodeVersion}/${nodeArchiveName}`;
const nodeArchivePath = join(cacheRoot, nodeArchiveName);
const nodeExtractRoot = join(cacheRoot, `node-v${nodeVersion}-win-x64`);
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

function powershellQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
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

async function downloadNodeArchive() {
  await mkdir(cacheRoot, { recursive: true });
  if (await fileExists(nodeArchivePath)) {
    log(`复用已缓存的 Node ${nodeVersion} 压缩包`);
    return;
  }

  log(`下载 Node ${nodeVersion} Windows x64 运行时`);
  const response = await fetch(nodeDownloadUrl);
  if (!response.ok || !response.body) {
    fail(`无法下载 Node：HTTP ${response.status} ${response.statusText}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  await writeFile(nodeArchivePath, buffer);

  const sumsUrl = `https://nodejs.org/dist/v${nodeVersion}/SHASUMS256.txt`;
  const sumsResponse = await fetch(sumsUrl);
  if (!sumsResponse.ok) {
    fail(`无法下载 Node 校验文件：HTTP ${sumsResponse.status}`);
  }
  const sums = await sumsResponse.text();
  const expected = sums
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .find(([hash, name]) => name === nodeArchiveName)?.[0];
  if (!expected) {
    fail(`Node 校验文件中没有找到 ${nodeArchiveName}`);
  }
  const actual = createHash("sha256").update(buffer).digest("hex");
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    fail(`Node 压缩包校验失败，期望 ${expected}，实际 ${actual}`);
  }
  log("Node 压缩包校验通过");
}

async function extractNode() {
  if (await fileExists(nodeBinaryPath)) {
    return;
  }

  log("解压 Node 运行时");
  await rm(nodeExtractRoot, { recursive: true, force: true });
  await mkdir(cacheRoot, { recursive: true });
  await execFileAsync("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    `Expand-Archive -LiteralPath ${powershellQuote(nodeArchivePath)} -DestinationPath ${powershellQuote(cacheRoot)} -Force`,
  ]);
  await ensureFile(nodeBinaryPath, "Node 可执行文件");
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

  await rm(resourceRoot, { recursive: true, force: true });
  await mkdir(resourceRoot, { recursive: true });

  await copyTree(runtimeScript, join(resourceRoot, "runtime", "tao-runtime.mjs"));
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

  await copyTree(nodeBinaryPath, join(resourceRoot, "node", "node.exe"));
  await writeFile(
    join(resourceRoot, "RELEASE-MANIFEST.json"),
    `${JSON.stringify({
      platform: "windows-x64",
      nodeVersion,
      piSource: "vendor/pi",
      generatedAt: new Date().toISOString(),
    }, null, 2)}\n`,
    "utf8",
  );
}

async function main() {
  if (process.platform !== "win32" || process.arch !== "x64") {
    fail("当前发布准备脚本只支持 Windows x64。");
  }
  if (process.env.CI && process.env.TAO_RELEASE_ALLOW_NETWORK !== "1" && !(await fileExists(nodeArchivePath))) {
    fail("CI 环境禁止隐式下载 Node，请预先缓存 Node 或设置 TAO_RELEASE_ALLOW_NETWORK=1。");
  }

  log(`项目目录：${projectRoot}`);
  log(`Pi 目录：${piRoot}`);
  await downloadNodeArchive();
  await extractNode();
  await prepareResources();
  log("发布资源准备完成");
  log("Tauri 接下来会执行 npm run build 并生成 Windows x64 安装包");
}

await main();
