import { existsSync, lstatSync, readdirSync, readFileSync, mkdirSync, mkdtempSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { join, resolve, relative, dirname } from "node:path";

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_SKILL_BYTES = 128 * 1024;

export function selectedSkills(skills, profile) {
  if (!profile?.skillsEnabled) return [];
  return skills.filter((skill) => profile.enabledSkills == null || profile.enabledSkills.includes(skill.name));
}

export function intersectSkills(parent, child) {
  if (!parent.skillsEnabled || !child.skillsEnabled) return [];
  if (parent.enabledSkills == null) return child.enabledSkills == null ? null : [...child.enabledSkills];
  if (child.enabledSkills == null) return [...parent.enabledSkills];
  return child.enabledSkills.filter((name) => parent.enabledSkills.includes(name));
}

// Discovery is bounded and never follows links. Metadata parsing remains in the SDK.
export function skillCatalog(root, loadSkills) {
  root = resolve(root);
  const paths = [];
  const diagnostics = [];
  let entriesSeen = 0;
  const warn = (path, message) => diagnostics.push({ type: "warning", path, message });
  function visit(path, depth = 0) {
    if (++entriesSeen > 2000 || depth > 8) throw new Error("Skills 目录超过扫描上限（2000 项、8 层）");
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) { warn(path, "跳过符号链接或目录联接，请导入实际文件"); return; }
    if (stat.isFile()) {
      if (stat.size > MAX_SKILL_BYTES) warn(path, "技能说明超过 128 KiB，未加载");
      else paths.push(path);
      return;
    }
    if (!stat.isDirectory()) return;
    if (existsSync(join(path, "SKILL.md"))) { visit(join(path, "SKILL.md"), depth + 1); return; }
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      if (entry.isDirectory() || entry.isSymbolicLink() || (depth === 0 && entry.name.endsWith(".md"))) visit(join(path, entry.name), depth + 1);
    }
  }
  try { if (existsSync(root)) visit(root); } catch (error) { warn(root, error.message); }
  const result = loadSkills({ cwd: root, agentDir: root, skillPaths: paths, includeDefaults: false });
  diagnostics.push(...result.diagnostics);
  const skills = result.skills.filter((skill) => {
    const valid = typeof skill.name === "string" && NAME.test(skill.name) && skill.name.length <= 64 && typeof skill.description === "string" && skill.description.length <= 1024;
    if (!valid) warn(skill.filePath, "名称或描述不符合技能格式，未加载");
    return valid;
  });
  return { directory: root, skills, diagnostics };
}

export function importSkill(root, source, loadSkills, { provenance } = {}) {
  root = resolve(root);
  source = resolve(source);
  if (lstatSync(source).isSymbolicLink() || !lstatSync(source).isDirectory()) throw new Error("请选择实际的技能目录");
  if (!existsSync(join(source, "SKILL.md"))) throw new Error("所选目录的根目录必须包含 SKILL.md");
  const files = [];
  let bytes = 0;
  let count = 0;
  function collect(path, depth = 0) {
    if (++count > 2000 || depth > 8) throw new Error("技能目录超过导入上限（2000 项、8 层）");
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error("技能导入不支持符号链接或目录联接");
    if (stat.isDirectory()) {
      for (const name of readdirSync(path)) {
        if ([".git", "node_modules"].includes(name)) continue;
        collect(join(path, name), depth + 1);
      }
    } else if (stat.isFile()) {
      if (stat.size > 4 * 1024 * 1024 || (relative(source, path) === "SKILL.md" && stat.size > MAX_SKILL_BYTES)) throw new Error("技能文件过大（说明 128 KiB，其余单文件 4 MiB）");
      bytes += stat.size;
      if (bytes > 32 * 1024 * 1024) throw new Error("技能总大小超过 32 MiB");
      const content = readFileSync(path);
      if (content.length !== stat.size) throw new Error("导入期间文件发生变化，请重试");
      files.push({ path: relative(source, path), content });
    } else throw new Error("技能包含不支持的文件类型");
  }
  collect(source);
  const parsed = skillCatalog(source, loadSkills);
  if (parsed.skills.length !== 1 || parsed.diagnostics.length) throw new Error(`技能格式无效：${parsed.diagnostics.map((item) => item.message).join("；") || "缺少有效说明"}`);
  const skill = parsed.skills[0];
  if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(skill.name)) throw new Error("技能名称为系统保留名称");
  const existing = skillCatalog(root, loadSkills);
  if (existing.skills.some((item) => item.name === skill.name)) throw new Error(`已存在同名技能：${skill.name}，导入不会覆盖`);
  mkdirSync(root, { recursive: true });
  if (lstatSync(root).isSymbolicLink()) throw new Error("Skills 目录不能是符号链接或目录联接");
  const destination = join(root, skill.name);
  if (existsSync(destination)) throw new Error(`目标目录已存在：${skill.name}，导入不会覆盖`);
  const staging = mkdtempSync(join(root, ".import-"));
  try {
    for (const file of files) {
      const target = join(staging, file.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, file.content, { flag: "wx" });
    }
    // Validate the copied bytes as well, rather than trusting a changing source.
    const copied = skillCatalog(staging, loadSkills);
    if (copied.skills.length !== 1 || copied.skills[0].name !== skill.name || copied.diagnostics.length) throw new Error("导入期间技能说明发生变化，请重试");
    if (provenance) writeFileSync(join(staging, ".tao-source.json"), `${JSON.stringify(provenance, null, 2)}\n`, { flag: "wx" });
    if (existsSync(destination)) throw new Error("目标目录已存在，导入不会覆盖");
    renameSync(staging, destination);
    return { name: skill.name, directory: destination, files: files.length };
  } finally {
    if (dirname(staging) === root && relative(root, staging).startsWith(".import-")) rmSync(staging, { recursive: true, force: true });
  }
}
