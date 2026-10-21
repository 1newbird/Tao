import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, mkdir, mkdtemp, rename, rm, lstat, copyFile } from "node:fs/promises";
import { dirname, join, relative, resolve, isAbsolute, sep } from "node:path";
import { fileURLToPath } from "node:url";

const packaged = fileURLToPath(new URL("../node/", import.meta.url));
const development = fileURLToPath(new URL("../../.tao-release-cache/node-native-build/runtime/", import.meta.url));
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
let sourcePromise;

export function sandboxNodeSource() {
  sourcePromise ??= (async () => {
    const folder = existsSync(join(packaged, "BUILD-MANIFEST.json")) ? packaged : development;
    if (!existsSync(join(folder, "BUILD-MANIFEST.json"))) throw new Error("缺少兼容 Node 运行时，请先执行 node scripts/build-sandbox-node.mjs");
    const manifest = JSON.parse(await readFile(join(folder, "BUILD-MANIFEST.json"), "utf8"));
    if (manifest.nodeVersion !== "22.23.3" || manifest.sourceSha256 !== "bd97093e1a1e9243338950c174a693a64d4e0926a9c6ce259962bc58d5e96909"
        || manifest.upstreamPatch !== "https://github.com/libuv/libuv/commit/2cadaa401670"
        || manifest.patchSha256 !== "01408d9a604e32abba4c900b7727d2895e8473097ad67866e79a7daa189ef5ff"
        || !Array.isArray(manifest.files) || !manifest.files.length) {
      throw new Error("兼容 Node 构建清单无效，请重新构建运行时");
    }
    const names = new Set();
    for (const file of manifest.files) {
      const part = relative(folder, resolve(folder, file.path));
      if (!part || isAbsolute(part) || part === ".." || part.startsWith(`..${sep}`) || names.has(part.toLowerCase()) || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error("Node 资源清单路径或校验值无效");
      names.add(part.toLowerCase());
    }
    for (const required of ["node.exe", "npm.cmd", "npx.cmd", join("node_modules", "npm", "bin", "npm-cli.js")]) if (!names.has(required.toLowerCase())) throw new Error(`Node 资源缺失：${required}`);
    if (manifest.files.find(file => file.path === "node.exe")?.sha256 !== manifest.sha256) throw new Error("Node 可执行文件校验记录不一致");
    for (const file of manifest.files) if (digest(await readFile(join(folder, file.path))) !== file.sha256) throw new Error(`Node 源资源校验失败：${file.path}`);
    return { folder, manifest, cacheKey: digest(JSON.stringify(manifest.files)) };
  })();
  return sourcePromise.catch(error => { sourcePromise = undefined; throw error; });
}

export async function cacheSandboxNode(home) {
  const source = await sandboxNodeSource();
  const base = join(home, "native-runtime");
  await mkdir(base, { recursive: true });
  const destination = join(base, source.cacheKey);
  const valid = async () => {
    try {
      if ((await lstat(destination)).isSymbolicLink()) return false;
      for (const file of source.manifest.files) {
        if ((await lstat(join(destination, file.path))).isSymbolicLink() || digest(await readFile(join(destination, file.path))) !== file.sha256) return false;
      }
      return true;
    } catch { return false; }
  };
  if (existsSync(destination)) {
    if (!await valid()) throw new Error("沙盒 Node 缓存损坏，请关闭活动任务后清理对应 native-runtime 缓存");
    return join(destination, "node.exe");
  }
  const stage = await mkdtemp(join(base, `.stage-${randomUUID()}-`));
  try {
    for (const file of source.manifest.files) {
      const target = join(stage, file.path);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(join(source.folder, file.path), target);
      if (digest(await readFile(target)) !== file.sha256) throw new Error(`复制 Node 资源后校验失败：${file.path}`);
    }
    try { await rename(stage, destination); } catch (error) { if (!await valid()) throw error; }
    return join(destination, "node.exe");
  } finally {
    // The staging path is generated here under the private Tao data directory.
    // It is never shared with a sandbox process before the atomic rename.
    await rm(stage, { recursive: true, force: true });
  }
}
