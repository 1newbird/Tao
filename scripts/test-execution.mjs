import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { executionConfiguration, intersectExecution, toolEnvironment, assertCredentialReferences } from "../src-tauri/runtime/execution-policy.mjs";
import { createExecutor, runProcess, sandboxStatus, dockerArguments } from "../src-tauri/runtime/execution.mjs";
import { compactionConfiguration, compactionSettings, compactionInstructions } from "../src-tauri/runtime/compaction-policy.mjs";
import { applyToolPolicy } from "../src-tauri/runtime/policy.mjs";

const root = await mkdtemp(join(resolve(process.cwd()), ".execution-test-"));
const workspace = join(root, "workspace");
const outside = join(root, "outside");
try {
  await mkdir(workspace); await mkdir(outside);
  await writeFile(join(workspace, "fixture.txt"), "first\nneedle 720\nthird\n");
  await writeFile(join(outside, "private.txt"), "HOST_PRIVATE_MUST_NOT_BE_READ");
  assert.equal(executionConfiguration({ backend: "docker" }).network, "deny");
  assert.equal(executionConfiguration({ backend: "windows" }).network, "deny");
  const nativeLimited=intersectExecution({backend:"windows",workspaceAccess:"read_only"},{backend:"local"});
  assert.equal(nativeLimited.backend,"windows");assert.equal(nativeLimited.workspaceAccess,"read_only");assert.equal(nativeLimited.network,"deny");
  assert.equal(executionConfiguration().network, "allow");
  assert.throws(() => executionConfiguration([]));
  assert.throws(() => executionConfiguration(null));
  const limited = intersectExecution({ backend: "docker", workspaceAccess: "read_only", allowedHosts: ["example.com"], allowedEnv: ["SERVICE_TOKEN"] }, { backend: "local", network: "allow", allowedHosts: ["other.example"], allowedEnv: ["SERVICE_TOKEN", "MODEL_KEY"] });
  assert.equal(limited.backend, "docker"); assert.equal(limited.workspaceAccess, "read_only"); assert.equal(limited.network, "deny");
  assert.deepEqual(limited.allowedEnv, ["SERVICE_TOKEN"]);
  assert.deepEqual(toolEnvironment({ allowedEnv: ["SERVICE_TOKEN"] }, { PATH: "fixture-path", OPENAI_API_KEY: "private", SERVICE_TOKEN: "allowed", NODE_OPTIONS: "bad" }, true), { SERVICE_TOKEN: "allowed" });
  assert.throws(() => executionConfiguration({ allowedEnv: ["NODE_OPTIONS"] }));
  assert.throws(() => executionConfiguration({ allowedEnv: ["TAO_SANDBOX_CHILD"] }));
  assert.throws(() => executionConfiguration({ allowedEnv: ["TAO_SANDBOX_WORKSPACE"] }));
  assert.throws(() => executionConfiguration({ allowedHosts: ["-invalid.example"] }));
  assert.throws(() => assertCredentialReferences('{{env:MODEL_KEY}}', { allowedEnv: [] }));
  assert.doesNotThrow(() => assertCredentialReferences('{{env:SERVICE_TOKEN}}', { allowedEnv: ["SERVICE_TOKEN"] }));
  const readOnly = { execution: { workspaceAccess: "read_only" }, toolPermissions: { write: { mode: "allow" }, bash: { mode: "allow" } } };
  assert.equal(applyToolPolicy(workspace, "write", {}, { decision: "allow" }, readOnly).enforcedDeny, true);
  assert.equal(applyToolPolicy(workspace, "bash", {}, { decision: "allow" }, readOnly).enforcedDeny, true);
  assert.equal(applyToolPolicy(workspace, "read", { path: "../outside/private.txt" }, { decision: "allow" }, { execution: { fileScope: "workspace" } }).enforcedDeny, true);
  const local = createExecutor({}, workspace);
  if (process.platform === "win32") {
    for (const backend of ["windows", "docker"]) {
      const executor = createExecutor({ backend }, `\\\\?\\${workspace}`);
      const expected = backend === "windows" ? join(workspace, "fixture.txt") : "/workspace/fixture.txt";
      for (const input of ["fixture.txt", ".\\fixture.txt", join(workspace, "fixture.txt"), `\\\\?\\${join(workspace, "fixture.txt")}`]) {
        assert.equal(executor.containerPath(input), expected);
      }
      assert.equal(executor.containerPath(`\\\\?\\${workspace}`), backend === "windows" ? workspace : "/workspace");
      assert.throws(() => executor.containerPath(`\\\\?\\${join(outside, "private.txt")}`), /超出工作区/);
      assert.throws(() => executor.containerPath("../outside/private.txt"), /超出工作区/);
    }
  }
  const previous = process.env.TAO_TEST_PRIVATE;
  process.env.TAO_TEST_PRIVATE = "must-not-inherit";
  try {
    const response = await local.execute(process.execPath, ["-e", "process.stdout.write(String(process.env.TAO_TEST_PRIVATE))"]);
    assert.equal(response.stdout, "undefined");
  } finally { if (previous === undefined) delete process.env.TAO_TEST_PRIVATE; else process.env.TAO_TEST_PRIVATE = previous; }
  await assert.rejects(() => createExecutor({ network: "deny" }, workspace).command("echo must-not-execute"), /本机进程/);
  const args = dockerArguments({ name: "tao-test", host: "npipe:////./pipe/docker_engine", image: "sha256:fixture", cwd: workspace, policy: executionConfiguration({ backend: "docker" }), program: "node", args: ["-e", "test"], env: {} });
  for (const option of ["--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--pull=never", "--user=1000:1000"]) assert(args.includes(option));
  assert(args.includes("none")); assert(!args.includes("--privileged"));
  const settings = { compaction: { enabled: true, reserveTokens: 4000, keepRecentTokens: 1000 } };
  assert.equal(compactionSettings(settings, {}).compaction.reserveTokens, 4000);
  assert.equal(compactionSettings(settings, { mode: "disabled" }).compaction.enabled, false);
  assert.equal(compactionSettings(settings, { mode: "automatic", reserveTokens: 2048, keepRecentTokens: 1024 }, { contextWindow: 8192 }).compaction.reserveTokens, 2048);
  assert.throws(() => compactionSettings(settings, { mode: "automatic" }, { contextWindow: 8192 }));
  assert.throws(() => compactionConfiguration({ reserveTokens: NaN }));
  assert(compactionInstructions({ mode: "automatic", instructions: "KEEP_ACTUAL_EVIDENCE" }).includes("KEEP_ACTUAL_EVIDENCE"));
  console.log("通过：执行边界、父子权限交集、环境隔离、受限本机拒绝、Docker 参数和压缩策略。");

  if (process.argv.includes("--docker")) {
    const status = await sandboxStatus();
    assert.equal(status.available, true, status.error);
    const sandbox = createExecutor({ backend: "docker" }, workspace);
    const run = (program, args, options) => sandbox.execute(program, args, options);
    const result = await run("node", ["-e", "const fs=require('fs');fs.writeFileSync('/workspace/result.txt','sandbox wrote');process.stdout.write(fs.readFileSync('/workspace/fixture.txt','utf8'))"]);
    assert(result.stdout.includes("needle 720"));
    assert.equal(await readFile(join(workspace, "result.txt"), "utf8"), "sandbox wrote");
    await assert.rejects(() => run("node", [], { workerRequest: { operation: "read", path: "/etc/passwd" } }), /超出工作区/);
    await assert.rejects(() => createExecutor({ backend: "docker", workspaceAccess: "read_only" }, workspace).execute("node", ["-e", "require('fs').writeFileSync('/workspace/forbidden.txt','bad')"]), /EROFS|read-only/);
    assert(!existsSync(join(workspace, "forbidden.txt")));
    const deniedNetwork = await run("node", ["-e", "fetch('https://example.com',{signal:AbortSignal.timeout(1500)}).then(()=>{process.exitCode=9},()=>console.log('network blocked'))"]);
    assert(deniedNetwork.stdout.includes("network blocked"));
    const privateEnv = process.env.TAO_TEST_PRIVATE;
    const allowedEnv = process.env.SERVICE_TOKEN;
    process.env.TAO_TEST_PRIVATE = "private-fixture"; process.env.SERVICE_TOKEN = "allowed-fixture";
    try {
      const env = await createExecutor({ backend: "docker", allowedEnv: ["SERVICE_TOKEN"] }, workspace).execute("node", ["-e", "console.log(JSON.stringify({private:process.env.TAO_TEST_PRIVATE,allowed:process.env.SERVICE_TOKEN,home:process.env.HOME}))"]);
      assert.deepEqual(JSON.parse(env.stdout), { allowed: "allowed-fixture", home: "/tmp" });
    } finally {
      for (const [key, value] of [["TAO_TEST_PRIVATE", privateEnv], ["SERVICE_TOKEN", allowedEnv]]) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    // Real Windows junctions must not expose a path outside the mounted tree.
    await symlink(outside, join(workspace, "linked"), process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(() => run("node", ["-e", "process.stdout.write(require('fs').readFileSync('/workspace/linked/private.txt','utf8'))"]));
    const controller = new AbortController();
    let started;
    const observed = new Promise((done) => { started = done; });
    const cancelled = run("node", ["-e", "console.log('started');setTimeout(()=>require('fs').writeFileSync('/workspace/late.txt','bad'),3000);setTimeout(()=>{},20000)"], { signal: controller.signal, onData: (data) => { if (data.toString().includes("started")) started(); } });
    void cancelled.catch(() => {});
    await Promise.race([observed, new Promise((_, reject) => setTimeout(() => reject(new Error("沙盒取消用例未启动")), 20000).unref())]);
    controller.abort();
    await assert.rejects(() => cancelled, /取消|超时/);
    assert(!existsSync(join(workspace, "late.txt")));
    const missing = createExecutor({ backend: "docker", image: "tao-test-image-does-not-exist:never" }, workspace);
    await assert.rejects(() => missing.command("touch should-not-exist"), /未回退/);
    assert(!existsSync(join(workspace, "should-not-exist")));
    console.log("通过：真实 Docker 读写、工作区只读、越界文件拒绝、断网、凭据变量隔离、Windows 目录链接、取消清理和缺镜像不回退。");
  }
} finally {
  const safeRoot = resolve(root);
  if (!safeRoot.startsWith(`${resolve(process.cwd())}\\.execution-test-`) && !safeRoot.startsWith(`${resolve(process.cwd())}/.execution-test-`)) throw new Error("测试清理路径无效");
  await rm(safeRoot, { recursive: true, force: true });
}
