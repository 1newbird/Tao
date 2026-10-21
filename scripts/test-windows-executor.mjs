import assert from "node:assert/strict";
import { mkdtemp,mkdir,writeFile,readFile,readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve,join } from "node:path";
import { createServer,connect } from "node:net";
import { configureWindowsSandbox,windowsSandboxStatus,windowsPath } from "../src-tauri/runtime/windows-sandbox.mjs";
import { createExecutor } from "../src-tauri/runtime/execution.mjs";
const base=resolve('.tao-release-cache/windows-executor-lab');await mkdir(base,{recursive:true});
const root=await mkdtemp(join(base,'run-')), workspace=join(root,'workspace'),home=join(root,'tao-home'),outside=join(root,'outside');
for(const path of [workspace,home,outside])await mkdir(path);
configureWindowsSandbox(home);
await writeFile(join(workspace,'input.txt'),'原生 fixture 720\n');await writeFile(join(outside,'private.txt'),'PRIVATE');
const executor=createExecutor({backend:'windows'},workspace);
if(process.argv.includes('--expect-unavailable')) {
  assert.equal((await windowsSandboxStatus(workspace)).available,false);
  await assert.rejects(()=>executor.execute(process.execPath,['-e',"require('fs').writeFileSync('must-not-run.txt','bad')"]),/不可用|未回退/);
  assert(!existsSync(join(workspace,'must-not-run.txt')));
  console.log('PASS uninitialized native backend refuses execution; no local fallback');
  process.exit(0);
}
const operation=(name,path,extra={})=>executor.execute('node',[],{workerRequest:{operation:name,path,...extra}});
let passed=0;
const checks=[];
async function test(name,fn){await fn();passed++;checks.push({name,status:'passed'});console.log(`PASS ${name}`);}
try{
  await test('prepared native status',async()=>{const status=await windowsSandboxStatus(workspace);assert(status.available,JSON.stringify(status));assert(status.preview);});
  await test('worker read and write',async()=>{
    assert.equal(Buffer.from(JSON.parse((await operation('read',join(workspace,'input.txt'))).stdout),'base64').toString(),'原生 fixture 720\n');
    await operation('write',join(workspace,'result.txt'),{content:'after\n'});assert.equal(await readFile(join(workspace,'result.txt'),'utf8'),'after\n');
  });
  await test('native worker grep and find',async()=>{
    assert(JSON.parse((await operation('grep',workspace,{input:{pattern:'720',glob:'*.txt'}})).stdout).includes('720'));
    assert(JSON.parse((await operation('find',workspace,{input:{pattern:'*.txt'}})).stdout).includes('input.txt'));
  });
  await test('extended workspace supports relative and absolute tool paths',async()=>{
    const extended=createExecutor({backend:'windows'},`\\\\?\\${workspace}`);
    for(const file of ['input.txt','.\\input.txt',join(workspace,'input.txt'),`\\\\?\\${join(workspace,'input.txt')}`]) {
      const result=await operation('read',extended.containerPath(file));
      assert.equal(Buffer.from(JSON.parse(result.stdout),'base64').toString(),'原生 fixture 720\n');
    }
    assert(JSON.parse((await operation('readdir',extended.containerPath('.'))).stdout).includes('input.txt'));
    assert.throws(()=>extended.containerPath(`\\\\?\\${join(outside,'private.txt')}`),/超出工作区/);
  });
  await test('worker refuses outside file',async()=>{
    await assert.rejects(()=>operation('read',join(outside,'private.txt')));
    assert.equal(windowsPath('\\\\?\\D:\\example'),'D:\\example');
    await assert.rejects(()=>executor.execute('\\\\invalid-host\\share\\tool.exe',[]),/本机磁盘/);
  });
  await test('structured process and streaming unicode',async()=>{
    const chunks=[];const result=await executor.execute(process.execPath,['-e',"process.stdout.write('过程✓');setTimeout(()=>process.stdout.write('完成'),50)"],{onData:data=>chunks.push(data)});
    assert.equal(result.stdout,'过程✓完成');assert.equal(Buffer.concat(chunks).toString(),'过程✓完成');
  });
  await test('PowerShell command starts at projected workspace root',async()=>{
    const chunks=[];const result=await executor.command("Write-Output 'native-powershell-ok'; node -e \"console.log(require('fs').realpathSync.native(process.cwd()))\"",{onData:data=>chunks.push(data)});
    assert(result.stdout.includes('native-powershell-ok'));assert(result.stdout.toLowerCase().includes(workspace.toLowerCase()),result.stdout);
    assert.match(result.mappedCwd,/^[E-Z]:\\$/);assert.equal(result.workspace,workspace);
    assert(Buffer.concat(chunks).toString().includes('命令结束即释放'));assert(!existsSync(result.mappedCwd),'temporary drive leaked');
  });
  await test('workspace with spaces unicode and quote',async()=>{
    const unusual=join(root,"workspace 空格'测试");await mkdir(unusual);await writeFile(join(unusual,'input.txt'),'unicode-path-ok');
    const nested=createExecutor({backend:'windows'},unusual);
    const result=await nested.command("node -e \"process.stdout.write(require('fs').readFileSync('input.txt','utf8'))\"");assert.equal(result.stdout,'unicode-path-ok');
  });
  await test('OS enforces read only',async()=>{
    const ro=createExecutor({backend:'windows',workspaceAccess:'read_only'},workspace);
    await assert.rejects(()=>ro.execute(process.execPath,['-e',"require('fs').writeFileSync('forbidden.txt','bad')"]),/EPERM|EACCES/);assert(!existsSync(join(workspace,'forbidden.txt')));
  });
  await test('concurrent read only stays read only',async()=>{
    const ro=createExecutor({backend:'windows',workspaceAccess:'read_only'},workspace);
    const [a,b]=await Promise.all([ro.execute(process.execPath,['-e',"setTimeout(()=>{try{require('fs').writeFileSync('ro-concurrent.txt','bad');process.exitCode=9}catch(e){console.log(e.code)}},150)"]),executor.execute(process.execPath,['-e',"require('fs').writeFileSync('rw-concurrent.txt','good');setTimeout(()=>console.log('done'),350)"])]);
    assert(/EPERM|EACCES/.test(a.stdout));assert(b.stdout.includes('done'));assert(!existsSync(join(workspace,'ro-concurrent.txt')));
  });
  await test('environment credentials require allowlist',async()=>{
    const old=process.env.TAO_NATIVE_FIXTURE_KEY;process.env.TAO_NATIVE_FIXTURE_KEY='fixture-value';
    try{const code="console.log(process.env.TAO_NATIVE_FIXTURE_KEY||'absent')";
      assert((await executor.execute(process.execPath,['-e',code])).stdout.includes('absent'));
      assert((await createExecutor({backend:'windows',allowedEnv:['TAO_NATIVE_FIXTURE_KEY']},workspace).execute(process.execPath,['-e',code])).stdout.includes('fixture-value'));
    }finally{if(old===undefined)delete process.env.TAO_NATIVE_FIXTURE_KEY;else process.env.TAO_NATIVE_FIXTURE_KEY=old;}
  });
  await test('native command cannot reach host listener',async()=>{
    let connections=0;const server=createServer(socket=>{connections++;socket.on('error',()=>{});socket.end();});
    await new Promise(done=>server.listen(0,'127.0.0.1',done));const port=server.address().port;
    try{
      await new Promise((done,reject)=>{const c=connect(port,'127.0.0.1');c.on('error',reject);c.on('connect',()=>{c.destroy();done();});});
      const before=connections;
      const code=`const s=require('net').connect(${port},'127.0.0.1');s.setTimeout(1200);s.on('connect',()=>{console.log('UNEXPECTED');s.destroy()});s.on('error',e=>console.log(e.code));s.on('timeout',()=>{console.log('TIMEOUT');s.destroy()});`;
      const result=await executor.execute(process.execPath,['-e',code]);assert(!result.stdout.includes('UNEXPECTED'));assert.equal(connections,before);
    }finally{await new Promise(done=>server.close(done));}
  });
  await test('cancel execution reaps job',async()=>{
    const controller=new AbortController();let ready=false;
    const promise=executor.execute(process.execPath,['-e',"console.log('started');setTimeout(()=>require('fs').writeFileSync('late.txt','bad'),2000);setInterval(()=>{},1000)"],{signal:controller.signal,onData:()=>{ready=true;controller.abort();}});
    await assert.rejects(()=>promise,/取消|超时/);assert(ready);await new Promise(done=>setTimeout(done,2100));assert(!existsSync(join(workspace,'late.txt')));
  });
  await test('cleanup journals empty',async()=>{assert.equal((await readdir(join(home,'native-sandbox','state'))).length,0);});
  const report={scope:'Tao native executor core; Node pipe and external build compatibility are tested separately',passed,root,controllerNode:process.version,toolNode:(await windowsSandboxStatus(workspace)).nodeVersion,windows10Validated:false,checks};
  await writeFile(join(root,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}catch(error){console.error(`FAILED after ${passed} passes; fixtures retained: ${root}`);throw error;}
