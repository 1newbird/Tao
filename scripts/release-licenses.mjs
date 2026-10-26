import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

// Relative paths are fixed here, never taken from a generated manifest.
export const releaseLicensePaths = Object.freeze([
  "LICENSE",
  "NOTICE",
  "THIRD_PARTY_NOTICES.md",
  "pi/LICENSE",
  "node/LICENSE",
  "runtime/node_modules/pdfjs-dist/LICENSE",
  "runtime/node_modules/fflate/LICENSE",
  "runtime/licenses/saxes-LICENSE",
  "runtime/node_modules/xmlchars/LICENSE",
  "runtime/node_modules/@napi-rs/canvas/LICENSE",
]);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readRequired(path) {
  const bytes = await readFile(path).catch((error) => {
    throw new Error(`许可声明无法读取：${path} (${error.code ?? error.message})`);
  });
  if (!bytes.toString("utf8").trim()) throw new Error(`许可声明为空：${path}`);
  return bytes;
}

export async function copyReleaseLicenses({ projectRoot, nodeExtractRoot, resourceRoot }) {
  const sources = [
    join(projectRoot, "LICENSE"),
    join(projectRoot, "NOTICE"),
    join(projectRoot, "THIRD_PARTY_NOTICES.md"),
    join(projectRoot, "vendor", "pi", "LICENSE"),
    join(nodeExtractRoot, "LICENSE"),
    ...releaseLicensePaths.slice(5).map((path) => join(projectRoot, "src-tauri", path)),
  ];
  // Read all sources first so a missing notice cannot silently produce a subset.
  const contents = await Promise.all(sources.map(readRequired));
  const entries = [];
  for (const [index, path] of releaseLicensePaths.entries()) {
    const target = join(resourceRoot, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents[index]);
    entries.push({ path, sha256: sha256(contents[index]) });
  }
  return entries;
}

export async function verifyReleaseLicenses(resourceRoot) {
  const manifest = JSON.parse(await readFile(join(resourceRoot, "RELEASE-MANIFEST.json"), "utf8"));
  if (!Array.isArray(manifest.licenses) || manifest.licenses.length !== releaseLicensePaths.length) {
    throw new Error("发布清单缺少完整的许可声明记录，请重新准备发布资源。");
  }
  for (const path of releaseLicensePaths) {
    const entries = manifest.licenses.filter((entry) => entry?.path === path);
    if (entries.length !== 1 || !/^[a-f0-9]{64}$/.test(entries[0].sha256)) {
      throw new Error(`发布清单许可记录无效：${path}`);
    }
    const bytes = await readRequired(join(resourceRoot, path));
    if (sha256(bytes) !== entries[0].sha256) {
      throw new Error(`许可声明与准备时的 SHA-256 不一致：${path}`);
    }
  }
  return releaseLicensePaths.length;
}
