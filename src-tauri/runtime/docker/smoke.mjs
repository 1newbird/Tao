import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, rmSync } from "node:fs";
assert.equal(process.getuid(), 1000, "Image must execute as the unprivileged Tao user");
assert.equal(Number(process.versions.node.split(".")[0]), 22);
const versions = { node: process.version };
for (const [name, args] of [
  ["npm", ["--version"]], ["python", ["--version"]], ["python3", ["-m", "pip", "--version"]],
  ["git", ["--version"]], ["rg", ["--version"]], ["jq", ["--version"]], ["curl", ["--version"]],
  ["zip", ["-v"]], ["unzip", ["-v"]], ["gcc", ["--version"]], ["make", ["--version"]],
]) versions[name] = execFileSync(name, args, { encoding: "utf8" }).trim().split("\n")[0];
execFileSync("python3", ["-m", "venv", "/tmp/tao-smoke-venv"]);
execFileSync("/tmp/tao-smoke-venv/bin/python", ["-c", "import json, ssl, sqlite3; print(json.dumps({'ok': True}))"]);
writeFileSync("/tmp/tao-smoke.c", "int main(void) { return 0; }\n");
// /tmp intentionally remains noexec. Projects execute build outputs in their mounted workspace.
execFileSync("gcc", ["-c", "/tmp/tao-smoke.c", "-o", "/tmp/tao-smoke.o"]);
writeFileSync("/tmp/tao-smoke.txt", "Tao 中文工具验收\n");
assert.match(readFileSync("/tmp/tao-smoke.txt", "utf8"), /中文/);
assert.throws(() => writeFileSync("/usr/tao-smoke-forbidden", "no"));
rmSync("/tmp/tao-smoke-venv", { recursive: true, force: true });
console.log(JSON.stringify({ ok: true, uid: process.getuid(), versions }));
