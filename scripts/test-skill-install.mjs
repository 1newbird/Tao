import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadSkills } from "../vendor/pi/packages/coding-agent/src/core/skills.ts";
import { createSkillInstaller, githubSource, createSkillInstallTools, enabledSkillInstallTools } from "../src-tauri/runtime/skill-install.mjs";
import { applyToolPolicy } from "../src-tauri/runtime/policy.mjs";
import { restrictChildConfiguration } from "../src-tauri/runtime/multi-agent.mjs";
import { githubFixture, COMMIT, TREE } from "./skill-install-fixture.mjs";

const source = { url: "https://github.com/example/skills" };
async function fixture(run, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "tao-skill-test-"));
  const root = join(directory, "installed");
  const network = githubFixture(options);
  const service = createSkillInstaller({ root, loadSkills, request: network.request });
  try { await run({ service, root, ...network }); } finally { rmSync(directory, { recursive: true, force: true }); }
}

test("GitHub URL forms, explicit refs and unsafe/private URL forms", () => {
  assert.deepEqual(githubSource({ url: source.url + "/tree/main/skills/pdf" }).path, "skills/pdf");
  assert.equal(githubSource({ url: source.url + "/blob/main/skills/pdf/SKILL.md" }).path, "skills/pdf");
  assert.equal(githubSource({ url: source.url + ".git", ref: "feature/docs", path: "skills/pdf" }).ref, "feature/docs");
  for (const url of ["http://github.com/a/b", "https://github.com.evil.test/a/b", "https://token@github.com/a/b", source.url + "?token=x", source.url + "/tree/main/%2e%2e/escape", source.url + "/tree/main/%2Fescape", "https://127.0.0.1/a/b"]) assert.throws(() => githubSource({ url }));
  for (const path of ["../escape", "C:/escape", "CON.txt", "a./x", "a\\b", "/absolute"]) assert.throws(() => githubSource({ ...source, path }));
});

test("inspect pins commit, install validates bytes, preserves resources/source and never executes or overwrites", () => fixture(async ({ service, root, calls }) => {
  const preview = await service.inspect(source, {}, "chat-a");
  assert.equal(preview.commit, COMMIT); assert.equal(preview.files.length, 3); assert(!existsSync(root));
  assert(preview.warnings.some((text) => text.includes("脚本")));
  await assert.rejects(service.install(preview.previewId, {}, "chat-b"), /不属于/);
  const installed = await service.install(preview.previewId, { skillsEnabled: true }, "chat-a");
  assert(installed.selectedForNewChat); assert.equal(installed.name, "github-sample");
  assert.equal(readFileSync(join(root, installed.name, "scripts/run.ps1"), "utf8"), "throw 'must never run'");
  assert.equal(JSON.parse(readFileSync(join(root, installed.name, ".tao-source.json"))).commit, COMMIT);
  assert.equal(service.list().skills[0].source.commit, COMMIT);
  assert.equal((await service.install(preview.previewId, {}, "chat-a")).duplicate, true);
  const again = await service.inspect(source); assert(again.alreadyInstalled);
  await assert.rejects(service.install(again.previewId), /存在/);
  assert(calls.filter((call) => call.url.includes("raw.githubusercontent.com")).every((call) => call.url.includes(COMMIT)));
  assert(calls.every((call) => !Object.keys(call.headers).some((name) => /authorization|cookie/i.test(name))));
}));

test("root discovery lists concrete skill paths and rejects truncated repositories", async () => {
  await fixture(async ({ service }) => {
    const result = await service.inspect(source); assert.equal(result.kind, "catalog"); assert.equal(result.candidates[0].path, "skills/sample");
  }, { files: { "skills/sample/SKILL.md": "sample" } });
  await fixture(async ({ service }) => { await assert.rejects(service.inspect(source), /范围/); }, { mutateTree: (tree) => ({ tree, truncated: true }) });
});

test("paths, aliases, symlinks, submodules and resource limits fail before installing", async () => {
  for (const entry of [
    { path: "../escape" }, { path: "NUL.txt" }, { path: "SKILL.MD" }, { path: ".tao-source.json" },
    { path: "link", mode: "120000" }, { path: "module", mode: "160000", type: "commit" },
    { path: "huge", size: 4 * 1024 * 1024 + 1 },
  ]) await fixture(async ({ service, root }) => {
    await assert.rejects(service.inspect(source)); assert(!existsSync(root));
  }, { mutateTree: (tree) => ({ tree: [...tree, { ...tree[0], ...entry }], truncated: false }) });
});

test("repository discovery can install a selected nested directory at the inspected commit", () => fixture(async ({ service, root, calls }) => {
  const catalog = await service.inspect(source);
  const preview = await service.inspect({ ...source, ref: catalog.commit, path: catalog.candidates[0].path });
  assert.equal(preview.path, "skills/nested");
  await service.install(preview.previewId);
  assert.equal(readFileSync(join(root, "nested", "references/guide.md"), "utf8"), "Nested evidence");
  assert(calls.some((call) => call.url.endsWith(`/commits/${COMMIT}`)));
}, {
  files: { "skills/nested/SKILL.md": "---\nname: nested\ndescription: Nested test\n---\nRead evidence", "skills/nested/references/guide.md": "Nested evidence" },
  mutateTree: (tree, url) => ({ truncated: false, tree: url.search ? url.pathname.endsWith(TREE) ? tree : tree.map((entry) => ({ ...entry, path: entry.path.replace("skills/nested/", "") }))
    : [{ path: url.pathname.endsWith(TREE) ? "skills" : "nested", type: "tree", mode: "040000", sha: "c".repeat(40) }] }),
}));

test("invalid skill declarations, nested skills and LFS pointers are rejected", async () => {
  const valid = "---\nname: valid\ndescription: Evidence\n---\nRead evidence";
  for (const files of [{ "SKILL.md": "no frontmatter" }, { "SKILL.md": valid, "nested/SKILL.md": valid }, { "SKILL.md": "version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 100" }]) {
    await fixture(async ({ service, root }) => { await assert.rejects(service.inspect(source)); assert(!existsSync(root)); }, { files });
  }
});

test("mid-download cancellation leaves no installation and concurrent install is not duplicated", async () => {
  const controller = new AbortController();
  await fixture(async ({ service, root }) => {
    const preview = await service.inspect(source);
    await assert.rejects(service.install(preview.previewId, {}, "settings", controller.signal));
    assert(!existsSync(root));
  }, { mutateRaw: (bytes, path) => { if (path !== "SKILL.md") controller.abort(); return bytes; } });
  await fixture(async ({ service, root }) => {
    const preview = await service.inspect(source);
    const first = service.install(preview.previewId);
    await assert.rejects(service.install(preview.previewId), /正在安装/);
    await first;
    assert.deepEqual(readdirSync(root), ["github-sample"]);
  });
});

test("network/host/explicit-deny policies and HTTP failures do not install", async () => {
  await fixture(async ({ service, calls }) => {
    for (const profile of [{ execution: { network: "deny" } }, { execution: { allowedHosts: ["github.com"] } }, { toolPermissions: { inspect_github_skill: { mode: "deny" } } }]) await assert.rejects(service.inspect(source, profile));
    assert.equal(calls.length, 0);
    const preview = await service.inspect(source);
    await assert.rejects(service.install(preview.previewId, { execution: { network: "deny" } }), /禁止/);
    await assert.rejects(service.install(preview.previewId, { toolPermissions: { install_github_skill: { mode: "deny" } } }), /禁止/);
  });
  for (const status of [301, 401, 403, 404, 429, 500]) await fixture(async ({ service, root }) => { await assert.rejects(service.inspect(source)); assert(!existsSync(root)); }, { status });
});

test("tampering, cancellation and expired previews leave no partial installation", async () => {
  await fixture(async ({ service, root }) => {
    const preview = await service.inspect(source);
    await assert.rejects(service.install(preview.previewId), /不一致/); assert(!existsSync(root));
  }, { mutateRaw: (bytes, path) => path === "SKILL.md" ? bytes : Buffer.from("changed") });
  await fixture(async ({ service, root }) => {
    const preview = await service.inspect(source);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(service.install(preview.previewId, {}, "settings", controller.signal)); assert(!existsSync(root));
  });
  const directory = mkdtempSync(join(tmpdir(), "tao-skill-expiry-"));
  try {
    let now = 1000;
    const service = createSkillInstaller({ root: directory, loadSkills, request: githubFixture().request, now: () => now });
    const preview = await service.inspect(source); now += 601000;
    await assert.rejects(service.install(preview.previewId), /过期/); assert.deepEqual(readdirSync(directory), []);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("management opt-in, main-session scope and mandatory install confirmation", () => {
  assert.deepEqual(enabledSkillInstallTools({}), []);
  assert.equal(enabledSkillInstallTools({ skillInstallEnabled: true }).length, 3);
  assert.equal(createSkillInstallTools((x) => x, {}, { skillInstallEnabled: true }, "child", true).length, 0);
  assert.equal(restrictChildConfiguration({ skillInstallEnabled: true }, { skillInstallEnabled: true }).skillInstallEnabled, false);
  const profile = { skillInstallEnabled: true, toolPermissions: { install_github_skill: { mode: "allow" } } };
  const decision = applyToolPolicy(process.cwd(), "install_github_skill", {}, { decision: "allow" }, profile);
  assert.equal(decision.decision, "ask"); assert(decision.enforcedAsk); assert.equal(decision.canRemember, false);
  assert(applyToolPolicy(process.cwd(), "install_github_skill", {}, {}, { ...profile, execution: { network: "deny" } }).enforcedDeny);
});
