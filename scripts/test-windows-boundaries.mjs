import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, writeFile, readFile, link, unlink, readdir, symlink, rmdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { configureWindowsSandbox, windowsSandboxHelper } from "../src-tauri/runtime/windows-sandbox.mjs";
import { createExecutor } from "../src-tauri/runtime/execution.mjs";

const exec=promisify(execFile),base=resolve(".tao-release-cache/windows-executor-lab");
await mkdir(base,{recursive:true});
const root=await mkdtemp(join(base,"boundary-run-")),home=join(root,"home"),outside=join(root,"outside");
await mkdir(home);await mkdir(outside);
const secret=join(outside,"private.txt");await writeFile(secret,"PRIVATE_OUTSIDE_FIXTURE");
configureWindowsSandbox(home);
const checks=[],shell=join(process.env.SystemRoot,"System32/WindowsPowerShell/v1.0/powershell.exe");
const acl=async path=>(await exec(shell,["-NoProfile","-NonInteractive","-Command","[IO.File]::GetAccessControl($env:TAO_ACL_FIXTURE).GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)"],{windowsHide:true,env:{...process.env,TAO_ACL_FIXTURE:path}})).stdout.trim();
const before=await acl(secret);
const test=async(name,action)=>{try{await action();checks.push({name,status:"passed"});console.log(`PASS ${name}`);}catch(error){checks.push({name,status:"failed",error:String(error.stack||error)});console.error(`FAIL ${name}: ${error.message}`);}};
await test("pre-existing hardlink cannot expose an outside file or receive its ACL grant",async()=>{
  const project=join(root,"hardlink-project");await mkdir(project);await link(secret,join(project,"linked.txt"));
  try {
    await assert.rejects(createExecutor({backend:"windows",workspaceAccess:"read_only"},project).execute("node",["-e","console.log(require('fs').readFileSync('linked.txt','utf8'))"]),/hard.?link|硬链接/i);
    assert.equal(await acl(secret),before);
  } finally {await unlink(join(project,"linked.txt"));}
});
await test("runtime-created directory junction cannot read/write outside or redirect cleanup",async()=>{
  const project=join(root,"junction-project");await mkdir(project);
  const code=`const fs=require('fs'),a=require('assert/strict');try{fs.symlinkSync(${JSON.stringify(outside)},'escape','junction')}catch(e){a(['EPERM','EACCES'].includes(e.code));console.log('CREATION_DENIED');process.exit(0)}a.throws(()=>fs.readFileSync('escape/private.txt'));a.throws(()=>fs.writeFileSync('escape/private.txt','BAD'));console.log('JUNCTION_DENIED')`;
  try {
    const result=await createExecutor({backend:"windows"},project).execute("node",["-e",code]);
    assert.match(result.stdout,/JUNCTION_DENIED|CREATION_DENIED/);
    assert.equal(await readFile(secret,"utf8"),"PRIVATE_OUTSIDE_FIXTURE");assert.equal(await acl(secret),before);
    assert.equal((await readdir(join(home,"native-sandbox/state"))).length,0);
  } finally {await unlink(join(project,"escape")).catch(error=>{if(error.code!=="ENOENT")throw error;});}
});
await test("host replacement of an active child directory cannot redirect access or cleanup",async()=>{
  const project=join(root,"replacement-project"),child=join(project,"child");await mkdir(project);await mkdir(child);
  const code=`const fs=require('fs'),a=require('assert/strict');console.log('SWAP_READY');const t=setInterval(()=>{if(!fs.existsSync('go'))return;clearInterval(t);a.throws(()=>fs.readFileSync('child/private.txt'));a.throws(()=>fs.writeFileSync('child/private.txt','BAD'));console.log('REPLACEMENT_DENIED')},30)`;
  let replacement;
  const result=createExecutor({backend:"windows"},project).execute("node",["-e",code],{signal:AbortSignal.timeout(20000),onData:data=>{
    if(data.toString().includes('SWAP_READY'))replacement=(async()=>{await rmdir(child);await symlink(outside,child,'junction');await writeFile(join(project,'go'),'go');})();
  }});
  try {const output=await result;await replacement;assert.match(output.stdout,/REPLACEMENT_DENIED/);assert.equal(await acl(secret),before);assert.equal(await readFile(secret,'utf8'),'PRIVATE_OUTSIDE_FIXTURE');assert.equal((await readdir(join(home,'native-sandbox/state'))).length,0);}
  finally {await replacement;await unlink(child).catch(error=>{if(error.code!=='ENOENT')throw error;});}
});
await exec(windowsSandboxHelper(),["--cleanup","--state-root",join(home,"native-sandbox")],{windowsHide:true,timeout:15000});
const report={root,checks,passed:checks.filter(row=>row.status==="passed").length,failed:checks.filter(row=>row.status==="failed").length,windows10Validated:false};
await writeFile(join(root,"report.json"),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
if(report.failed)process.exitCode=1;
