import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile, readFile, readdir, rename, rmdir, symlink, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { configureWindowsSandbox, windowsSandboxHelper, windowsSandboxStatus } from "../src-tauri/runtime/windows-sandbox.mjs";
import { cacheSandboxNode } from "../src-tauri/runtime/sandbox-node.mjs";
import { createExecutor } from "../src-tauri/runtime/execution.mjs";
import { toolEnvironment } from "../src-tauri/runtime/execution-policy.mjs";

const exec=promisify(execFile), base=resolve(".tao-release-cache/windows-executor-lab");
await mkdir(base,{recursive:true});
const root=await mkdtemp(join(base,"drive-run-")),home=join(root,"tao-home"),a=join(root,"project-a"),b=join(root,"project-b");
for(const path of [home,a,b])await mkdir(path);
configureWindowsSandbox(home);
const helper=windowsSandboxHelper(),state=join(home,"native-sandbox"),checks=[];
const shell=join(process.env.SystemRoot,"System32/WindowsPowerShell/v1.0/powershell.exe");
const drives=async()=>JSON.parse((await exec(shell,["-NoProfile","-NonInteractive","-Command","ConvertTo-Json -Compress @([Environment]::GetLogicalDrives())"],{windowsHide:true,timeout:5000})).stdout);
// Avoid PowerShell 5's native-argument quote rewriting obscuring boundary tests.
const command=code=>`node -e "eval(Buffer.from('${Buffer.from(code).toString('base64')}','base64').toString())"`;
const waitFor=async predicate=>{const deadline=Date.now()+20000;while(!predicate()){if(Date.now()>deadline)throw new Error("fixture timed out");await new Promise(done=>setTimeout(done,40));}};
const test=async(name,action)=>{await action();checks.push({name,status:"passed"});console.log(`PASS ${name}`);};
try {
  assert((await windowsSandboxStatus(a)).available,"native backend must be prepared");
  // This suite compares the whole logon-session drive inventory: run it without
  // other native command suites concurrently creating their own temporary drives.
  const originalDrives=await drives();
  await test("parallel aliases keep project grants separate and deny parent enumeration",async()=>{
    const secret=`private-${randomUUID()}.txt`;
    await writeFile(join(a,secret),"A");await writeFile(join(b,secret),"B");
    const run=(workspace,peer,expected)=>createExecutor({backend:"windows",workspaceAccess:"read_only"},workspace).command(command(`
      const fs=require('fs'),p=require('path'),a=require('assert/strict');
      a.equal(fs.readFileSync(${JSON.stringify(secret)},'utf8'),${JSON.stringify(expected)});
      console.log('READY');const timer=setInterval(()=>{if(!fs.existsSync('go'))return;clearInterval(timer);
        for(const target of [${JSON.stringify(dirname(workspace))},p.parse(${JSON.stringify(workspace)}).root])a.throws(()=>fs.readdirSync(target));
        a.throws(()=>fs.readFileSync(${JSON.stringify(join(peer,secret))}));
        for(let letter=69;letter<=90;letter++){const path=String.fromCharCode(letter)+':\\\\';if(path.toLowerCase()!==process.cwd().toLowerCase())a.throws(()=>fs.readFileSync(p.join(path,${JSON.stringify(secret)})));}
        a.throws(()=>fs.writeFileSync('forbidden.txt','bad'));console.log('BOUNDARY_OK');
      },50);
    `),{signal:AbortSignal.timeout(30000),onData:data=>{if(data.toString().includes("READY"))ready++;}});
    let ready=0,failure;
    const first=run(a,b,"A"),second=run(b,a,"B");
    first.catch(error=>{failure=error;});second.catch(error=>{failure=error;});
    const results=Promise.allSettled([first,second]);
    await waitFor(()=>{if(failure)throw failure;return ready===2;});
    // The host cannot swap the workspace while a command's root is pinned.
    await assert.rejects(rename(a,join(root,"swapped")),/EBUSY|EPERM|EACCES/);
    await Promise.all([writeFile(join(a,"go"),"go"),writeFile(join(b,"go"),"go")]);
    const outcomes=await results;for(const result of outcomes){if(result.status==="rejected")throw result.reason;assert(result.value.stdout.includes("BOUNDARY_OK"));assert(!existsSync(result.value.mappedCwd));}
    assert.notEqual(outcomes[0].value.mappedCwd,outcomes[1].value.mappedCwd);
    assert.deepEqual(await drives(),originalDrives);
  });
  const node=await cacheSandboxNode(home),temp=join(root,"tool-temp");await mkdir(temp);
  const request=(program,args)=>({id:randomUUID(),program,args,cwd:a,read:[a,dirname(node)],write:[a,temp],workspaceDrive:true,
    environment:{...toolEnvironment({}),HOME:temp,USERPROFILE:temp,APPDATA:temp,LOCALAPPDATA:temp,TEMP:temp,TMP:temp},timeoutMs:10000});
  await test("launch failure releases alias and owned profile",async()=>{
    const child=spawn(helper,["--state-root",state],{windowsHide:true,stdio:["pipe","pipe","pipe"]});
    const closed=once(child,"close");let output="";child.stdout.on("data",data=>output+=data);child.stdin.on("error",()=>{});
    child.stdin.write(JSON.stringify(request(join(root,"missing.exe"),[]))+"\n");
    assert.notEqual((await closed)[0],0);assert.match(output,/CreateProcess/);child.stdin.destroy();
    assert.deepEqual(await drives(),originalDrives);assert.equal((await readdir(join(state,"state"))).length,0);
  });
  await test("helper crash kills descendants and closes nonpersistent alias",async()=>{
    const late=join(a,"late-crash.txt");
    const childCode="console.log('DESCENDANT_READY');setTimeout(()=>require('fs').writeFileSync('late-crash.txt','bad'),3000);setInterval(()=>{},1000)";
    const code=`const child=require('child_process').spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:['ignore','inherit','inherit']});child.on('error',error=>{throw error});setInterval(()=>{},1000)`;
    const child=spawn(helper,["--state-root",state],{windowsHide:true,stdio:["pipe","pipe","pipe"]});
    const closed=once(child,"close");let pending="",alias,ready=false;child.stdin.on("error",()=>{});
    child.stdout.on("data",data=>{pending+=data;while(pending.includes("\n")){const end=pending.indexOf("\n"),line=pending.slice(0,end);pending=pending.slice(end+1);const event=JSON.parse(line);if(event.type==="started")alias=event.workspaceDrive;if(event.type==="data"&&Buffer.from(event.bytes).toString().includes("DESCENDANT_READY"))ready=true;}});
    child.stdin.write(JSON.stringify(request(node,["-e",code]))+"\n");
    try{await waitFor(()=>ready);}finally{child.kill();await closed;child.stdin.destroy();}
    assert(alias);await waitFor(()=>!existsSync(alias));
    await new Promise(done=>setTimeout(done,3200));assert(!existsSync(late));
    // A killed helper leaves a durable ACL journal; recovery removes only its SID.
    assert.equal((await readdir(join(state,"state"))).length,1);
    await exec(helper,["--cleanup","--state-root",state],{windowsHide:true,timeout:15000});
    assert.equal((await readdir(join(state,"state"))).length,0);assert.deepEqual(await drives(),originalDrives);
    assert.equal(await readFile(join(a,(await readdir(a)).find(name=>name.startsWith("private-"))),"utf8"),"A");
  });
  await test("graceful cancellation releases projected command tree",async()=>{
    const controller=new AbortController();let alias,ready=false;
    const code="console.log('CANCEL_READY');setTimeout(()=>require('fs').writeFileSync('late-cancel.txt','bad'),3000);setInterval(()=>{},1000)";
    const result=createExecutor({backend:"windows"},a).command(command(code),{signal:controller.signal,onData:data=>{
      const text=data.toString();if(text.startsWith("[Tao]"))alias=text.match(/[E-Z]:\\/)[0];
      if(text.includes("CANCEL_READY")){ready=true;controller.abort();}
    }});
    await assert.rejects(result,/取消|超时/);assert(ready);assert(alias);assert(!existsSync(alias));
    await new Promise(done=>setTimeout(done,3200));assert(!existsSync(join(a,"late-cancel.txt")));
    assert.equal((await readdir(join(state,"state"))).length,0);assert.deepEqual(await drives(),originalDrives);
  });
  await test("replaced workspace root cannot redirect a later grant",async()=>{
    const selected=join(root,"selected"),outside=join(root,"outside-root");
    await mkdir(selected);await mkdir(outside);await writeFile(join(outside,"private.txt"),"OUTSIDE_PRIVATE_FIXTURE");
    const executor=createExecutor({backend:"windows",workspaceAccess:"read_only"},selected);
    await rmdir(selected);await symlink(outside,selected,"junction");
    try{await assert.rejects(executor.execute("node",["-e","console.log(require('fs').readFileSync('private.txt','utf8'))"]),/reparse|链接|路径/i);}
    finally{await unlink(selected);}
    assert.equal(await readFile(join(outside,"private.txt"),"utf8"),"OUTSIDE_PRIVATE_FIXTURE");
    assert.equal((await readdir(join(state,"state"))).length,0);
  });
  const report={scope:"native workspace projection security and lifecycle",root,checks,passed:checks.length,windows10Validated:false};
  await writeFile(join(root,"report.json"),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}catch(error){await writeFile(join(root,"report.json"),JSON.stringify({root,checks,failure:String(error.stack||error)},null,2));throw error;}
