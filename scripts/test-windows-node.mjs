import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, cp, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { configureWindowsSandbox, windowsSandboxStatus } from "../src-tauri/runtime/windows-sandbox.mjs";
import { createExecutor } from "../src-tauri/runtime/execution.mjs";

const base = resolve(".tao-release-cache/windows-executor-lab");
await mkdir(base, { recursive: true });
const root = await mkdtemp(join(base, "node-run-"));
const workspace = join(root, "workspace"), home = join(root, "tao-home"), outside = join(root, "outside");
for (const directory of [workspace, home, outside]) await mkdir(directory);
configureWindowsSandbox(home);
const executor = createExecutor({ backend: "windows" }, workspace);
const checks = [];
const test = async (name, action) => {
  try { await action(); checks.push({ name, status: "passed" }); console.log(`PASS ${name}`); }
  catch (error) { checks.push({ name, status: "failed", error: String(error.stack || error) }); console.error(`FAIL ${name}: ${error.message}`); }
};
const node = (code, options = {}) => executor.execute("node", ["-e", code], { signal: AbortSignal.timeout(30000), ...options });
try {
  await test("verified private Node and crypto", async () => {
    const status = await windowsSandboxStatus(workspace);
    assert(status.available, status.error); assert(status.nodeAppContainerPatch);
    const response = await node("const c=require('crypto'),a=require('assert/strict');a.equal(c.createHash('sha256').update('abc').digest('hex'),'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');const {privateKey,publicKey}=c.generateKeyPairSync('rsa',{modulusLength:2048});a(c.verify('sha256',Buffer.from('fixture'),publicKey,c.sign('sha256',Buffer.from('fixture'),privateKey)));console.log(process.version)");
    assert.equal(response.stdout.trim(), "v22.23.3");
  });
  await test("synchronous subprocess pipe stdin stdout stderr and exit", async () => {
    const response = await node(`const cp=require('child_process'),a=require('assert/strict');const out=cp.execFileSync(process.execPath,['-e',"process.stdin.on('data',b=>process.stdout.write(b))"],{input:'子进程✓',windowsHide:true});a.equal(out.toString(),'子进程✓');const failure=cp.spawnSync(process.execPath,['-e',"console.log('out');console.error('err');process.exit(7)"],{encoding:'utf8',windowsHide:true});a.equal(failure.status,7);a.match(failure.stdout,/out/);a.match(failure.stderr,/err/);console.log('sync-pipes-ok')`);
    assert(response.stdout.includes("sync-pipes-ok"));
  });
  await test("asynchronous spawn and exec pipes", async () => {
    const response = await node(`const cp=require('child_process'),a=require('assert/strict');const child=cp.spawn(process.execPath,['-e',"process.stdin.on('data',b=>{process.stdout.write(b);process.stderr.write('error-stream')})"],{windowsHide:true});let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);child.on('error',e=>{throw e});child.on('close',code=>{a.equal(code,0);a.equal(out,'async✓');a.equal(err,'error-stream');cp.exec('echo exec-ok',{windowsHide:true},(error,stdout)=>{if(error)throw error;a.match(stdout,/exec-ok/);console.log('async-pipes-ok')})});child.stdin.end('async✓')`);
    assert(response.stdout.includes("async-pipes-ok"));
  });
  await writeFile(join(workspace, "ipc-child.cjs"), "process.on('message',message=>{process.send({reply:message});process.disconnect()});");
  await test("fork IPC remains inside sandbox", async () => {
    const response = await node("const a=require('assert/strict');const c=require('child_process').fork('./ipc-child.cjs',[],{silent:true,windowsHide:true});c.on('error',e=>{throw e});c.on('message',m=>{a.deepEqual(m,{reply:'消息✓'});console.log('ipc-ok')});c.send('消息✓');");
    assert(response.stdout.includes("ipc-ok"));
  });
  await mkdir(join(workspace, "node_modules", "@esbuild"), { recursive: true });
  await cp(resolve("node_modules/esbuild"), join(workspace, "node_modules", "esbuild"), { recursive: true });
  await cp(resolve("node_modules/@esbuild/win32-x64"), join(workspace, "node_modules", "@esbuild", "win32-x64"), { recursive: true });
  await cp(resolve("node_modules/typescript"), join(workspace, "node_modules", "typescript"), { recursive: true });
  await mkdir(join(workspace, "node_modules", ".bin"), { recursive: true });
  for (const name of ["tsc", "tsc.cmd", "tsc.ps1"]) await cp(resolve("node_modules", ".bin", name), join(workspace, "node_modules", ".bin", name));
  await writeFile(join(workspace, "package.json"), JSON.stringify({ name: "tao-sandbox-fixture", private: true, scripts: { test: "node --test fixture.test.cjs", build: "node node_modules/typescript/bin/tsc -p tsconfig.json", bundle: "node build.cjs" } }));
  await writeFile(join(workspace, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2020", module: "CommonJS", outDir: "out", types: [] }, files: ["entry.ts"] }));
  await writeFile(join(workspace, "fixture.test.cjs"), "const test=require('node:test'),a=require('node:assert/strict');test('order fixture',()=>a.equal([100,200,300,120].reduce((a,b)=>a+b,0),720));");
  await writeFile(join(workspace, "entry.ts"), "const total: number = 720; console.log(total); export { total };\n");
  await writeFile(join(workspace, "build.cjs"), "require('esbuild').buildSync({entryPoints:['entry.ts'],bundle:true,platform:'node',format:'cjs',outfile:'bundle.cjs'});console.log('esbuild-ok');");
  await test("bundled npm version and offline test runner", async () => {
    assert(/\d+\.\d+\.\d+/.test((await executor.command("npm.cmd --version")).stdout));
    const response = await executor.command("npm.cmd test");
    assert(response.stdout.includes("order fixture")); assert(/pass 1/.test(response.stdout));
  });
  await test("npm build with real TypeScript compiler", async () => {
    const response = await executor.command("npm.cmd run build");
    assert.equal(response.exitCode, 0);
    assert(existsSync(join(workspace, "out", "entry.js")));
    assert((await node("console.log(require('./out/entry.js').total)")).stdout.includes("720"));
  });
  await test("esbuild native child transform", async () => {
    const response = await node("const esbuild=require('esbuild'),fs=require('fs');const result=esbuild.transformSync(fs.readFileSync('entry.ts','utf8'),{loader:'ts',format:'cjs'});fs.writeFileSync('transformed.cjs',result.code);console.log('transform-ok')");
    assert(response.stdout.includes("transform-ok"));
    assert((await node("console.log(require('./transformed.cjs').total)")).stdout.includes("720"));
  });
  await test("esbuild full bundle ancestor directory compatibility", async () => {
    const response = await executor.command("npm.cmd run bundle");
    assert(response.stdout.includes("esbuild-ok"));
    assert(existsSync(join(workspace, "bundle.cjs")));
    assert((await node("console.log(require('./bundle.cjs').total)")).stdout.includes("720"));
  });
  await test("real Vite production build with TypeScript configuration", async () => {
    for(const name of ["vite","fdir","picomatch","postcss","rollup","tinyglobby","nanoid","picocolors","source-map-js","@rollup/rollup-win32-x64-msvc"]) {
      await cp(resolve("node_modules",name),join(workspace,"node_modules",name),{recursive:true});
    }
    await writeFile(join(workspace,"vite.config.ts"),"import {defineConfig} from 'vite'; export default defineConfig({build:{outDir:'web-dist'}});\n");
    await writeFile(join(workspace,"index.html"),'<html><body><h1>fixture</h1><script type="module" src="/entry.ts"></script></body></html>');
    const response=await executor.command("node node_modules/vite/bin/vite.js build");
    assert.equal(response.exitCode,0);assert(existsSync(join(workspace,"web-dist","index.html")));
    const assets=await readdir(join(workspace,"web-dist","assets"));
    assert((await readFile(join(workspace,"web-dist","assets",assets.find(name=>name.endsWith('.js'))),"utf8")).includes("720"));
  });
  await test("npx offline invokes local TypeScript", async () => {
    const response = await executor.command("npx.cmd --offline --no-install tsc --version");
    assert(response.stdout.includes("Version 5."));
  });
  await test("nested child cannot bypass read only or outside boundary", async () => {
    const ro = createExecutor({ backend: "windows", workspaceAccess: "read_only" }, workspace);
    await writeFile(join(outside, "private.txt"), "PRIVATE");
    const child = `const fs=require('fs'),a=require('assert/strict');for(const p of ['forbidden.txt',${JSON.stringify(join(outside, "private.txt"))}]){let denied=false;try{fs.writeFileSync(p,'bad')}catch(e){denied=/EACCES|EPERM/.test(e.code)}a(denied,p)}console.log('child-boundary-ok')`;
    const response = await ro.execute("node", ["-e", `process.stdout.write(require('child_process').execFileSync(process.execPath,['-e',${JSON.stringify(child)}]))`]);
    assert(response.stdout.includes("child-boundary-ok")); assert(!existsSync(join(workspace, "forbidden.txt")));
    assert.equal(await readFile(join(outside, "private.txt"), "utf8"), "PRIVATE");
  });
  await test("cancel piped grandchild reaps process tree", async () => {
    const controller = new AbortController(); let ready = false, observed = "";
    const descendant = "console.log('grandchild-ready');setTimeout(()=>require('fs').writeFileSync('late-child.txt','bad'),3000);setInterval(()=>{},1000)";
    const response = executor.execute("node", ["-e", `const c=require('child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}]);c.stdout.on('data',b=>process.stdout.write(b));c.on('error',e=>{throw e})`], { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]), onData: data => { observed += data.toString(); if (!ready && observed.includes("grandchild-ready")) { ready = true; controller.abort(); } } });
    await assert.rejects(response, /取消|超时/); assert(ready);
    await new Promise(done => setTimeout(done, 3200)); assert(!existsSync(join(workspace, "late-child.txt")));
  });
  assert.equal((await readdir(join(home, "native-sandbox", "state"))).length, 0);
  const report = { scope: "Windows AppContainer patched Node actual tools and external build compatibility", root, passed: checks.filter(check => check.status === "passed").length, failed: checks.filter(check => check.status === "failed").length, checks, windows10Validated: false, internetInstallValidated: false };
  await writeFile(join(root, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  if (report.failed) process.exitCode = 1;
} catch (error) {
  await writeFile(join(root, "report.json"), JSON.stringify({ scope: "Windows AppContainer patched Node actual tools", root, passed: checks.filter(check => check.status === "passed").length, checks, fatal: String(error.stack || error), windows10Validated: false }, null, 2));
  console.error(`FAILED; fixtures retained: ${root}`); throw error;
}
