import { existsSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const taoHome = resolve(process.env.USERPROFILE ?? process.cwd(), ".tao");
const piRoot = resolve(process.cwd(), "vendor", "pi");

if (process.env.TAO_PI_WORKSPACE_VERIFY_LOADED !== "1") {
  const preflight = join(piRoot, "node_modules", "tsx", "dist", "preflight.cjs");
  const loader = pathToFileURL(join(piRoot, "node_modules", "tsx", "dist", "loader.mjs")).href;
  if (!existsSync(preflight) || !existsSync(join(piRoot, "node_modules", "tsx", "dist", "loader.mjs"))) {
    console.error(`VERIFY_FAILED: 缺少 Pi tsx runtime。请在 ${piRoot} 中执行 npm.cmd install --ignore-scripts`);
    process.exit(1);
  }
  const result = spawnSync("node.exe", [
    "--require", preflight,
    "--import", loader,
    process.argv[1],
  ], {
    cwd: process.cwd(),
    stdio: "inherit",
    env: {
      ...process.env,
      TAO_PI_WORKSPACE_VERIFY_LOADED: "1",
      PI_CODING_AGENT_DIR: taoHome,
      TSX_TSCONFIG_PATH: join(piRoot, "tsconfig.json"),
    },
  });
  process.exit(result.status ?? 1);
}

function fail(message) {
  console.error(`VERIFY_FAILED: ${message}`);
  process.exitCode = 1;
}

async function findReadableTextFile(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const filePath = join(directory, entry.name);
    const extension = entry.name.split(".").pop()?.toLowerCase();
    if (["json", "md", "txt", "ts", "tsx", "js", "mjs", "rs", "css"].includes(extension ?? "")) {
      return filePath;
    }
  }
  return null;
}

const workspace = resolve(process.argv[2] ?? process.cwd());
if (!existsSync(workspace) || !statSync(workspace).isDirectory()) {
  fail("已配置的工作区目录不存在或不是目录。");
} else {
  const sdk = await import(pathToFileURL(join(piRoot, "packages", "coding-agent", "src", "index.ts")).href);
  const controller = new AbortController();
  const ls = sdk.createLsTool(workspace);
  const directoryResult = await ls.execute("verify-ls", { path: ".", limit: 50 }, controller.signal);
  const directoryText = directoryResult.content
    .filter((item) => item.type === "text")
    .map((item) => item.text ?? "")
    .join("");
  const entryCount = directoryText.trim() ? directoryText.trim().split(/\r?\n/).length : 0;

  const readableFile = await findReadableTextFile(workspace);
  if (!readableFile) {
    fail("工作区顶层没有可用于读取验证的普通文本文件。");
  } else {
    const read = sdk.createReadTool(workspace);
    const fileResult = await read.execute("verify-read", { path: readableFile, limit: 20 }, controller.signal);
    const contentLength = fileResult.content.reduce(
      (total, item) => total + (item.type === "text" ? (item.text ?? "").length : 0),
      0,
    );
    if (contentLength === 0) {
      fail("Pi read 工具没有返回文件内容。");
    }
    console.log(JSON.stringify({
      workspaceAccessible: true,
      directoryListingSucceeded: true,
      directoryEntryCount: entryCount,
      fileReadSucceeded: true,
      fileContentLength: contentLength,
    }));
  }
}
