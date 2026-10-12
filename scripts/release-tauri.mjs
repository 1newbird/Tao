import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageJsonPath = join(projectRoot, "package.json");
const packageLockPath = join(projectRoot, "package-lock.json");
const tauriConfigPath = join(projectRoot, "src-tauri", "tauri.conf.json");
const cargoTomlPath = join(projectRoot, "src-tauri", "Cargo.toml");
const cargoLockPath = join(projectRoot, "src-tauri", "Cargo.lock");
const tauriCliScriptPath = join(projectRoot, "scripts", "tauri-cli.ps1");
const prepareWixScriptPath = join(projectRoot, "scripts", "prepare-wix.ps1");
const verifyMsiScriptPath = join(projectRoot, "scripts", "verify-msi.ps1");
const reportPath = join(projectRoot, ".tao-release-cache", "release-report.json");
const target = "x86_64-pc-windows-msvc";

function log(message) {
  process.stdout.write(`[Tao 发布] ${message}\n`);
}

function fail(message) {
  throw new Error(`[Tao 发布] ${message}`);
}

function parseArgs(argv) {
  let versionInput;
  let bundles;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === "--version") {
      versionInput = argv[index + 1];
      if (!versionInput || versionInput.startsWith("-")) {
        fail("--version 后面必须提供版本号，例如 2.1");
      }
      index += 1;
      continue;
    }

    if (argument.startsWith("--version=")) {
      versionInput = argument.slice("--version=".length);
      if (!versionInput) {
        fail("--version= 后面必须提供版本号，例如 --version=2.1");
      }
      continue;
    }

    if (argument === "--bundles") {
      bundles = argv[index + 1];
      if (!bundles || bundles.startsWith("-")) {
        fail("--bundles 后面必须提供 Tauri bundle 类型");
      }
      index += 1;
      continue;
    }

    if (argument.startsWith("--bundles=")) {
      bundles = argument.slice("--bundles=".length);
      if (!bundles) {
        fail("--bundles= 后面必须提供 Tauri bundle 类型");
      }
      continue;
    }

    if (argument.startsWith("-")) {
      fail(`不支持的发布参数：${argument}`);
    }

    if (versionInput !== undefined) {
      fail(`只能提供一个版本号，重复参数：${argument}`);
    }
    versionInput = argument;
  }

  return { versionInput, bundles };
}

function normalizeVersion(value) {
  const raw = String(value ?? "").trim().replace(/^v/i, "");
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(raw);

  if (!match) {
    fail(`版本号无效：${value}。示例：2.1、2.1.0 或 2.1.0-beta.1`);
  }

  const [, major, minor, patch = "0", prerelease, build] = match;
  return `${major}.${minor}.${patch}${prerelease ? `-${prerelease}` : ""}${build ? `+${build}` : ""}`;
}

function replaceOrFail(text, pattern, replacement, description) {
  if (!pattern.test(text)) {
    fail(`没有找到${description}，未能同步版本号`);
  }
  return text.replace(pattern, replacement);
}

async function updateVersions(version) {
  const packageText = await readFile(packageJsonPath, "utf8");
  const packageData = JSON.parse(packageText);
  const packageVersionPattern = /^(\s*"version"\s*:\s*")[^"]+(")/m;
  const nextPackageText = replaceOrFail(
    packageText,
    packageVersionPattern,
    `$1${version}$2`,
    "package.json 的 version",
  );
  packageData.version = version;
  if (packageData.version !== JSON.parse(nextPackageText).version) {
    fail("package.json 版本更新校验失败");
  }
  await writeFile(packageJsonPath, nextPackageText, "utf8");

  const packageLockText = await readFile(packageLockPath, "utf8");
  const packageLockRootPattern = /^(\s*"version"\s*:\s*")[^"]+(")/m;
  const packageLockPackagePattern = /("packages"\s*:\s*\{\s*""\s*:\s*\{\s*"name"\s*:\s*"tao"\s*,\s*"version"\s*:\s*")[^"]+(")/s;
  let nextPackageLockText = replaceOrFail(
    packageLockText,
    packageLockRootPattern,
    `$1${version}$2`,
    "package-lock.json 的根版本",
  );
  nextPackageLockText = replaceOrFail(
    nextPackageLockText,
    packageLockPackagePattern,
    `$1${version}$2`,
    "package-lock.json 的根 package 版本",
  );
  const packageLockData = JSON.parse(nextPackageLockText);
  if (packageLockData.version !== version || packageLockData.packages?.[""]?.version !== version) {
    fail("package-lock.json 版本更新校验失败");
  }
  await writeFile(packageLockPath, nextPackageLockText, "utf8");

  const tauriText = await readFile(tauriConfigPath, "utf8");
  const tauriVersionPattern = /^(\s*"version"\s*:\s*")[^"]+(")/m;
  const nextTauriText = replaceOrFail(
    tauriText,
    tauriVersionPattern,
    `$1${version}$2`,
    "src-tauri/tauri.conf.json 的 version",
  );
  const tauriData = JSON.parse(nextTauriText);
  if (tauriData.version !== version) {
    fail("src-tauri/tauri.conf.json 版本更新校验失败");
  }
  await writeFile(tauriConfigPath, nextTauriText, "utf8");

  const cargoText = await readFile(cargoTomlPath, "utf8");
  const cargoVersionPattern = /(\[package\][\s\S]*?\r?\nversion\s*=\s*")[^"]+(")/;
  const nextCargoText = replaceOrFail(
    cargoText,
    cargoVersionPattern,
    `$1${version}$2`,
    "src-tauri/Cargo.toml 的 package version",
  );
  await writeFile(cargoTomlPath, nextCargoText, "utf8");

  const cargoLockText = await readFile(cargoLockPath, "utf8");
  const cargoLockVersionPattern = /(\[\[package\]\]\r?\nname\s*=\s*"tao"\r?\nversion\s*=\s*")[^"]+(")/;
  const nextCargoLockText = replaceOrFail(
    cargoLockText,
    cargoLockVersionPattern,
    `$1${version}$2`,
    "src-tauri/Cargo.lock 的 Tao package 版本",
  );
  await writeFile(cargoLockPath, nextCargoLockText, "utf8");
}

function run(command, args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      stdio: "inherit",
      shell: false,
    });

    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      rejectPromise(new Error(`${command} 退出：${code ?? `signal ${signal}`}`));
    });
  });
}

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function inspectBundle(version, bundles) {
  const bundleKind = bundles || "msi";
  const extension = bundleKind === "nsis" ? ".exe" : ".msi";
  const bundleDir = join(projectRoot, "src-tauri", "target", target, "release", "bundle", bundleKind);
  const candidates = (await readdir(bundleDir).catch(() => []))
    .filter((name) => name.toLowerCase().endsWith(extension) && name.includes(version));
  if (candidates.length !== 1) {
    fail(`预期找到一个 ${bundleKind.toUpperCase()} ${version} 安装包，实际找到 ${candidates.length} 个：${bundleDir}`);
  }
  const path = join(bundleDir, candidates[0]);
  const info = await stat(path);
  if (info.size < 1024 * 1024) fail(`安装包异常小：${path}`);
  if (bundleKind === "msi") {
    log("检查 MSI 内的 Node、Runtime、Pi 和模型数据");
    await run("powershell.exe", [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", verifyMsiScriptPath, path,
    ]);
  }
  const hash = await sha256(path);
  await mkdir(join(projectRoot, ".tao-release-cache"), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify({
    version,
    bundleKind,
    path,
    bytes: info.size,
    sha256: hash,
    verifiedAt: new Date().toISOString(),
  }, null, 2)}\n`, "utf8");
  log(`安装包：${path}`);
  log(`大小：${(info.size / 1024 / 1024).toFixed(1)} MiB`);
  log(`SHA-256：${hash}`);
  log(`发布报告：${reportPath}`);
}

async function main() {
  if (process.platform !== "win32" || process.arch !== "x64") {
    fail("当前发布脚本只支持 Windows x64");
  }

  const { versionInput, bundles } = parseArgs(process.argv.slice(2));
  if (bundles && bundles !== "msi" && bundles !== "nsis") {
    fail(`仅支持单独构建 msi 或 nsis，收到：${bundles}`);
  }
  const packageData = JSON.parse(await readFile(packageJsonPath, "utf8"));
  const version = versionInput === undefined
    ? packageData.version
    : normalizeVersion(versionInput);
  if ((!bundles || bundles === "msi") && !/^\d+\.\d+\.\d+$/.test(version)) {
    fail(`MSI 版本必须是纯数字 major.minor.patch，收到：${version}`);
  }

  if (versionInput !== undefined) {
    await updateVersions(version);
    log(`已将 Tao、Tauri、Rust 和锁文件版本同步为 ${version}`);
  } else {
    log(`使用当前项目版本 ${version}`);
  }

  const tauriArgs = ["build", "--target", target];
  if (bundles) {
    tauriArgs.push("--bundles", bundles);
  }

  log("构建前将自动准备并验证内置 Runtime 资源");
  if (!bundles || bundles === "msi") {
    log("准备项目本地 WiX 工具缓存");
    await run("powershell.exe", [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", prepareWixScriptPath,
    ]);
  }
  log(`开始构建 Windows x64 ${bundles ? `${bundles.toUpperCase()} ` : ""}安装包`);
  await run("powershell.exe", [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", tauriCliScriptPath,
    ...tauriArgs,
  ]);
  await inspectBundle(version, bundles);
  log(`发布完成，版本 ${version}`);
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
