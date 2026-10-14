import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applyToolPolicy, assertHttpTarget, canonicalTarget, inWorkspace, resolveHeaderReferences } from "../src-tauri/runtime/policy.mjs";

const root = await mkdtemp(join(tmpdir(), "tao-policy-"));
try {
  const workspace = join(root, "workspace");
  const outside = join(root, "outside");
  await mkdir(workspace);
  await mkdir(outside);
  await writeFile(join(outside, "existing.txt"), "test");
  await symlink(outside, join(workspace, "linked"), process.platform === "win32" ? "junction" : "dir");
  assert.equal(inWorkspace(workspace, join(workspace, "new/sub/file.txt")), true);
  assert.equal(inWorkspace(workspace, join(workspace, "linked/new/sub/file.txt")), false);
  assert.equal(canonicalTarget(join(workspace, "linked/new.txt")), join(outside, "new.txt"));
  const audit = { decision: "allow", reason: "default" };
  const profile = { toolPermissions: { write: { mode: "allow", pathScope: "workspace" }, read: { mode: "deny" } } };
  assert.equal(applyToolPolicy(workspace, "write", { path: "linked/new.txt" }, audit, profile).enforcedDeny, true);
  assert.equal(applyToolPolicy(workspace, "read", {}, audit, profile).enforcedDeny, true);
  assert.equal(applyToolPolicy(workspace, "bash", {}, { decision: "deny" }, {}).enforcedDeny, true);
  assert.equal(applyToolPolicy(workspace, "read", {}, audit, { toolPermissions: { read: { mode: "ask" } } }).enforcedAsk, true);
  assert.throws(() => assertHttpTarget("https://example.org", ["example.com"]));
  assert.throws(() => assertHttpTarget("file:///C:/secret"));
  assert.throws(() => assertHttpTarget("https://user:password@example.com"));
  assert.equal(assertHttpTarget("https://example.com/api", ["example.com"]).hostname, "example.com");
  assert.deepEqual(resolveHeaderReferences('{"Authorization":"Bearer {{env:TOOL_KEY}}"}', { TOOL_KEY: "fixture-key" }), { Authorization: "Bearer fixture-key" });
  assert.throws(() => resolveHeaderReferences('{"Authorization":"{{env:MISSING}}"}', {}));
  console.log("通过：目录链接、新文件边界、禁止优先级、确认规则、HTTP 域名和凭据引用。");
} finally { await rm(root, { recursive: true, force: true }); }
