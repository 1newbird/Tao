// Runs inside the chosen OS sandbox. Windows lifetime is bounded by its Job Object.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

let raw = "";
for await (const chunk of process.stdin) {
  raw += chunk;
  if (raw.length > 3 * 1024 * 1024) throw new Error("沙盒输入超过上限");
}
const request = JSON.parse(raw);
// A separate supervisor bounds synchronous file/regex work even if the host
// application is killed before it can remove the container.
if (process.platform !== "win32" && process.env.TAO_SANDBOX_CHILD !== "1") {
  const child = spawn(process.execPath, process.execArgv, { env: { ...process.env, TAO_SANDBOX_CHILD: "1" }, stdio: ["pipe", "inherit", "inherit"], detached: true });
  child.stdin.on("error", () => {});
  child.stdin.end(raw);
  const timer = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} process.exit(124); }, 120000);
  const code = await new Promise((done, reject) => { child.on("error", reject); child.on("close", done); });
  clearTimeout(timer);
  process.exit(code ?? 1);
}
const root = fs.realpathSync.native(process.platform === "win32" ? process.cwd() : "/workspace");
function target(rawPath = root) {
  const resolved = path.resolve(root, rawPath);
  let existing = resolved;
  const suffix = [];
  while (!fs.existsSync(existing)) {
    if (path.dirname(existing) === existing) throw new Error("目标不存在");
    suffix.unshift(path.basename(existing));
    existing = path.dirname(existing);
  }
  const canonical = path.join(fs.realpathSync.native(existing), ...suffix);
  const relative = path.relative(root, canonical);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("沙盒文件路径超出工作区");
  return canonical;
}
function read(file) {
  const resolved = target(file);
  if (fs.statSync(resolved).size > 1024 * 1024) throw new Error("沙盒文件工具单次读取上限为 1 MB，可用命令分段读取");
  return fs.readFileSync(resolved);
}
function walk(start, output = []) {
  if (output.length > 10000) throw new Error("搜索范围超过 10000 个条目，请缩小目录");
  for (const item of fs.readdirSync(start, { withFileTypes: true })) {
    if ([".git", "node_modules"].includes(item.name) || item.isSymbolicLink()) continue;
    const file = target(path.join(start, item.name));
    if (item.isDirectory()) walk(file, output); else output.push(file);
  }
  return output;
}
let result;
switch (request.operation) {
  case "exec": {
    const child = spawn(request.program, request.args, { stdio: "inherit", detached: true });
    const timer = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} }, 120000);
    child.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
    await new Promise((done) => child.on("close", (code) => { clearTimeout(timer); process.exitCode = code ?? 1; done(); }));
    break;
  }
  case "read": result = read(request.path).toString("base64"); break;
  case "access": fs.accessSync(target(request.path), fs.constants.R_OK); result = true; break;
  case "mime": {
    const header = read(request.path).subarray(0, 12);
    result = header.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? "image/png" : header[0] === 255 && header[1] === 216 ? "image/jpeg"
      : header.subarray(0, 3).toString() === "GIF" ? "image/gif" : header.subarray(0, 2).toString() === "BM" ? "image/bmp"
      : header.subarray(0, 4).toString() === "RIFF" && header.subarray(8, 12).toString() === "WEBP" ? "image/webp" : null;
    break;
  }
  case "write": fs.writeFileSync(target(request.path), request.content, "utf8"); result = true; break;
  case "mkdir": fs.mkdirSync(target(request.path), { recursive: true }); result = true; break;
  case "stat": result = { directory: fs.statSync(target(request.path)).isDirectory() }; break;
  case "exists": result = fs.existsSync(target(request.path)); break;
  case "readdir": result = fs.readdirSync(target(request.path)); break;
  case "find":
  case "grep": {
    const input = request.input;
    const start = target(request.path);
    const files = fs.statSync(start).isDirectory() ? walk(start) : [start];
    const limit = Math.max(1, Math.min(1000, Number(input.limit) || 100));
    const output = [];
    const glob = (name, pattern) => path.matchesGlob(name, pattern) || (!pattern.includes("/") && path.matchesGlob(path.basename(name), pattern));
    let regex;
    if (request.operation === "grep") regex = new RegExp(input.literal ? input.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : input.pattern, input.ignoreCase ? "i" : "");
    for (const file of files) {
      const name = path.relative(fs.statSync(start).isDirectory() ? start : path.dirname(start), file);
      if (request.operation === "find") { if (glob(name, input.pattern)) output.push(name); }
      else if (!input.glob || glob(name, input.glob)) {
        const data = read(file);
        if (data.includes(0)) continue;
        const lines = data.toString("utf8").split("\n");
        for (let i = 0; i < lines.length; i++) if (regex.test(lines[i])) {
          const context = Math.min(20, Math.max(0, Number(input.context) || 0));
          output.push(lines.slice(Math.max(0, i - context), i + context + 1).map((line, offset) => `${name}:${Math.max(0, i - context) + offset + 1}: ${line}`).join("\n"));
          if (output.length >= limit) break;
        }
      }
      if (output.length >= limit) break;
    }
    result = output.join("\n").slice(0, 20000) || "未找到匹配项";
    if (output.length >= limit) result += "\n[已达到结果上限，请缩小范围]";
    break;
  }
  default: throw new Error("未知沙盒操作");
}
if (request.operation !== "exec") process.stdout.write(JSON.stringify(result));
