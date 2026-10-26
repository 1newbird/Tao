import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { loadSkills } from "../vendor/pi/packages/coding-agent/src/core/skills.ts";
import { skillCatalog, importSkill, selectedSkills } from "../src-tauri/runtime/skills.mjs";
import { restrictChildConfiguration } from "../src-tauri/runtime/multi-agent.mjs";

function fixture(run) {
  const root = mkdtempSync(join(process.cwd(), ".skills-test-"));
  try { run(root); } finally { rmSync(root, { recursive: true, force: true }); }
}
function skill(root, name = "sample", extra = "") {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "SKILL.md"), `---\nname: ${name}\ndescription: Summarize a document\n${extra}---\nUse the supplied evidence.\n`);
}
test("catalog uses SDK parsing, reports invalid/duplicate/oversized skills and skips linked directories", () => fixture((root) => {
  const source = join(root, "skills");
  skill(join(source, "a"), "sample", "disable-model-invocation: true\n");
  skill(join(source, "b"), "sample");
  skill(join(source, "invalid"), "Bad_Name");
  skill(join(source, "oversized"), "large");
  writeFileSync(join(source, "oversized", "SKILL.md"), "x".repeat(128 * 1024 + 1));
  symlinkSync(join(source, "a"), join(source, "linked"), "junction");
  const catalog = skillCatalog(source, loadSkills);
  assert.deepEqual(catalog.skills.map((item) => item.name), ["sample"]);
  assert.equal(catalog.skills[0].disableModelInvocation, true);
  assert(catalog.diagnostics.length >= 4);
}));
test("import copies resources without execution, never overwrites, and rejects invalid or linked content", () => fixture((root) => {
  const source = join(root, "source"); const destination = join(root, "installed");
  skill(source);
  mkdirSync(join(source, "references")); writeFileSync(join(source, "references", "guide.txt"), "evidence");
  writeFileSync(join(source, "script.sh"), "exit 99");
  const result = importSkill(destination, source, loadSkills);
  assert.equal(result.files, 3);
  assert.equal(readFileSync(join(destination, "sample", "references", "guide.txt"), "utf8"), "evidence");
  assert.throws(() => importSkill(destination, source, loadSkills), /同名|已存在/);
  skill(join(root, "invalid"), "BAD");
  assert.throws(() => importSkill(destination, join(root, "invalid"), loadSkills), /格式/);
  symlinkSync(join(source, "references"), join(source, "link"), "junction");
  assert.throws(() => importSkill(destination, source, loadSkills), /链接|联接/);
}));
test("all/none/explicit skill selection preserves legacy and parent restrictions", () => {
  const skills = [{ name: "alpha" }, { name: "beta" }];
  assert.equal(selectedSkills(skills, { skillsEnabled: true }).length, 2);
  assert.equal(selectedSkills(skills, { skillsEnabled: false }).length, 0);
  assert.equal(selectedSkills(skills, { skillsEnabled: true, enabledSkills: [] }).length, 0);
  const selected = { skillsEnabled: true, enabledSkills: ["alpha"] };
  const child = restrictChildConfiguration(selected, { skillsEnabled: true });
  assert.deepEqual(selectedSkills(skills, child), [{ name: "alpha" }]);
  assert.deepEqual(restrictChildConfiguration(selected, { skillsEnabled: true, enabledSkills: ["beta"] }).enabledSkills, []);
  assert.deepEqual(restrictChildConfiguration({}, selected).enabledSkills, []);
});
