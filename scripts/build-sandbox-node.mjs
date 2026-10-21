import { spawn, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, createWriteStream, readFileSync, unlinkSync } from "node:fs";
import { mkdir, readFile, writeFile, rename, copyFile, readdir, cp, open, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configRoot = join(project, "native", "node-runtime");
const config = JSON.parse(await readFile(join(configRoot, "build-config.json"), "utf8"));
const patch = (await readFile(join(configRoot, config.patchFile), "utf8")).replaceAll("\r\n", "\n");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const cache = join(project, ".tao-release-cache", "node-native-build");
const source = join(cache, `node-v${config.version}`);
const output = join(cache, "runtime");
const logPath = join(cache, "build.log");
const identity = { nodeVersion: config.version, sourceSha256: config.sourceSha256, upstreamPatch: config.upstreamPatch, patchSha256: hash(patch) };
const say = text => console.log(`[Tao Node] ${text}`);
if (process.platform !== "win32" || process.arch !== "x64") throw new Error("Node sandbox build requires Windows x64");
await mkdir(cache, { recursive: true });
const manifestPath = join(output, "BUILD-MANIFEST.json");
const stageOnly = process.argv.includes("--stage-only");
if (existsSync(manifestPath) && !process.argv.includes("--rebuild") && !stageOnly) {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (Object.entries(identity).every(([key, value]) => manifest[key] === value) && Array.isArray(manifest.files)
      && hash(await readFile(join(output, "node.exe"))) === manifest.sha256) {
    for (const file of manifest.files) if (hash(await readFile(join(output, file.path))) !== file.sha256) throw new Error(`Cached Node resource is corrupt: ${file.path}`);
    say(`Verified existing Node ${config.version} + AppContainer patch: ${output}`);
    process.exit(0);
  }
  throw new Error("Cached Node build does not match its inputs; rerun with --rebuild");
}
const lockPath = join(cache, "build.lock");
const lockId = `${process.pid}-${Date.now()}`;
for (;;) {
  try {
    const lock = await open(lockPath, "wx");
    try { await lock.writeFile(JSON.stringify({ pid: process.pid, id: lockId })); } finally { await lock.close(); }
    process.on("exit", () => { try { if (JSON.parse(readFileSync(lockPath, "utf8")).id === lockId) unlinkSync(lockPath); } catch {} });
    break;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const previous = JSON.parse(await readFile(lockPath, "utf8"));
    if (!Number.isInteger(previous.pid) || previous.pid <= 0) throw new Error(`Invalid build lock: ${lockPath}`);
    try { process.kill(previous.pid, 0); } catch (probe) {
      if (probe.code === "ESRCH") { await unlink(lockPath); continue; }
    }
    throw new Error(`Another Node build is active (PID ${previous.pid}); wait for it to finish`);
  }
}
const archive = join(cache, `node-v${config.version}.tar.xz`);
if (!existsSync(archive)) {
  if (process.argv.includes("--offline")) throw new Error(`Missing offline source archive: ${archive}`);
  say(`Downloading official source ${config.version}`);
  const response = await fetch(`https://nodejs.org/dist/v${config.version}/node-v${config.version}.tar.xz`, { signal: AbortSignal.timeout(300000) });
  if (!response.ok) throw new Error(`Node download HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (hash(bytes) !== config.sourceSha256) throw new Error("Official source SHA-256 mismatch");
  await writeFile(`${archive}.partial`, bytes);
  await rename(`${archive}.partial`, archive);
}
if (hash(await readFile(archive)) !== config.sourceSha256) throw new Error("Cached source SHA-256 mismatch");
if (!existsSync(join(source, "configure")) || (process.argv.includes("--rebuild") && !stageOnly)) {
  say("Extracting verified source into D/workspace cache");
  await exec("tar.exe", ["-xf", archive, "-C", cache], { windowsHide: true, timeout: 120000 });
}
const pipePath = join(source, "deps", "uv", "src", "win", "pipe.c");
const original = await readFile(pipePath, "utf8");
const before = String.raw`static void uv__unique_pipe_name(unsigned long long ptr, char* name, size_t size) {
  snprintf(name, size, "\\\\?\\pipe\\uv\\%llu-%lu", ptr, GetCurrentProcessId());
}`;
if (!original.includes(patch.trimEnd())) {
  if (!original.includes(before)) throw new Error("Pinned libuv runtime hunk does not match; refusing a fuzzy patch");
  await writeFile(pipePath, original.replace(before, patch.trimEnd()));
}
const vswhere = join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Microsoft Visual Studio", "Installer", "vswhere.exe");
const installation = JSON.parse((await exec(vswhere, ["-latest", "-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-format", "json"], { windowsHide: true })).stdout)[0];
if (!installation) throw new Error("Install Visual Studio C++ x64 Build Tools before building the private Node runtime");
const vsPath = installation.installationPath;
const vcvars = join(vsPath, "VC", "Auxiliary", "Build", "vcvarsall.bat");
const pythonVersion = await exec("python", ["--version"], { windowsHide: true, timeout: 5000 }).then(result => result.stdout.trim()).catch(() => { throw new Error("Install Python 3 and add python.exe to PATH before building the private Node runtime"); });
// Node 22's project generator supports the VS 2022 format; VS 2026/MSVC v145
// can compile that format with an explicit platform toolset. No upstream build
// scripts are patched, and the actual compiler version is recorded below.
const toolset = Number(installation.installationVersion.split(".")[0]) >= 18 ? "v145" : "v143";
const command = join(cache, "compile.cmd");
const configureArgs = ["--dest-cpu=x64", "--openssl-no-asm", "--with-intl=full-icu"];
if (stageOnly) {
  const previous = JSON.parse(await readFile(manifestPath, "utf8"));
  if (!Object.entries(identity).every(([key, value]) => previous[key] === value)
      || hash(await readFile(join(source, "out", "Release", "node.exe"))) !== previous.sha256) throw new Error("Cannot stage an unverified previous build");
}
await writeFile(command, [
  "@echo off", "setlocal", `call "${vcvars}" amd64`, "if errorlevel 1 exit /b 1",
  `cd /d "${source}"`, `set "GYP_MSVS_OVERRIDE_PATH=${vsPath}"`, "set GYP_MSVS_VERSION=2022",
  `python configure ${configureArgs.join(" ")}`, "if errorlevel 1 exit /b 1",
  `msbuild node.sln /m:2 /t:node /p:Configuration=Release /p:Platform=x64 /p:PlatformToolset=${toolset} /p:UseMultiToolTask=true /p:EnforceProcessCountAcrossBuilds=true /p:MultiProcMaxCount=2 /clp:Verbosity=minimal /nologo`,
  "exit /b %errorlevel%", "",
].join("\r\n"));
if (!stageOnly) {
  say(`Building with ${installation.displayName}; detailed log: ${logPath}`);
  const log = createWriteStream(logPath);
  await new Promise((done, reject) => {
  const child = spawn(process.env.ComSpec || "cmd.exe", ["/d", "/c", command], { cwd: source, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
  child.once("error", reject);
  child.once("close", code => { log.end(); code === 0 ? done() : reject(new Error(`Node build failed (${code}); inspect ${logPath}`)); });
  });
}
const binary = join(source, "out", "Release", "node.exe");
const version = (await exec(binary, ["--version"], { windowsHide: true })).stdout.trim();
if (version !== `v${config.version}`) throw new Error(`Built version mismatch: ${version}`);
await mkdir(output, { recursive: true });
await copyFile(binary, join(output, "node.exe"));
await copyFile(join(source, "LICENSE"), join(output, "LICENSE"));
// npm ships in the verified source archive; commands use this bundled copy,
// never the user's global npm installation.
await cp(join(source, "deps", "npm"), join(output, "node_modules", "npm"), { recursive: true });
for (const name of ["npm", "npx"]) {
  await writeFile(join(output, `${name}.cmd`), `@echo off\r\n"%~dp0node.exe" "%~dp0node_modules\\npm\\bin\\${name}-cli.js" %*\r\n`);
}
const files = [];
async function recordFiles(directory, prefix = "") {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
    if (entry.name === "BUILD-MANIFEST.json") continue;
    if (entry.isSymbolicLink()) throw new Error("Unexpected link in staged Node runtime");
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) await recordFiles(join(directory, entry.name), path);
    else files.push({ path, sha256: hash(await readFile(join(directory, entry.name))) });
  }
}
await recordFiles(output);
await writeFile(manifestPath, JSON.stringify({ ...identity, sha256: hash(await readFile(binary)), files, visualStudio: installation.installationVersion, pythonVersion, toolset, configureArgs, platform: "win32-x64", builtAt: new Date().toISOString() }, null, 2) + "\n");
say(`Built ${version}; AppContainer runtime available at ${output}`);
