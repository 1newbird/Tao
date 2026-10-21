import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, copyFile, writeFile, readFile, readdir, symlink, lstat, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer, connect } from 'node:net';
import { resolve, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

if (process.platform !== 'win32') throw new Error('This research suite needs a native Windows host.');
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const laboratory = join(project, '.tao-release-cache', 'windows-native-lab');
await mkdir(laboratory, { recursive: true });
const root = await mkdtemp(join(laboratory, 'run-'));
const bin = join(root, 'bin'), workspace = join(root, 'workspace'), other = join(root, 'other-project'), outside = join(root, 'private');
for (const folder of [bin, workspace, other, outside, join(root, 'state'), join(root, 'temp')]) await mkdir(folder);
const helper = join(bin, 'tao-native-sandbox-probe.exe');
await copyFile(join(project, '.tao-release-cache', 'windows-native-target', 'debug', 'tao-native-sandbox-probe.exe'), helper);
const node = join(bin,'node.exe');
await copyFile(join(project,'src-tauri','resources','node','node.exe'),node);
const toolNodeVersion=(await promisify(execFile)(node,['--version'],{windowsHide:true,timeout:5000})).stdout.trim();
await writeFile(join(workspace, 'input.txt'), 'fixture 720\n');
await writeFile(join(other, 'other.txt'), 'OTHER_PROJECT_MUST_STAY_PRIVATE');
await writeFile(join(outside, 'private.txt'), 'PRIVATE_FIXTURE_MUST_STAY_PRIVATE');
const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows';
const shell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const pending = new Set();
const identities = new Set();
const identitySids = new Set();
const results = [];
const notes = [];
const runFile = join(root, 'report.json');
const scope = { smoke:process.argv.includes('--smoke'), selection:process.argv.find(arg=>arg.startsWith('--case='))?.slice(7)||null, compatibility:process.argv.includes('--compatibility') };
let server;
function request(args, options = {}) {
  const id = randomUUID();
  const temp = join(root, 'temp', id);
  const environment = { SystemRoot: systemRoot, WINDIR: systemRoot, ComSpec: join(systemRoot, 'System32', 'cmd.exe'),
    PATH: `${bin};${process.env.PATH || process.env.Path || ''}`, TEMP: temp, TMP: temp, HOME: temp, USERPROFILE: temp, LOCALAPPDATA: temp };
  return { id, program: node, args, cwd: workspace, read: [bin, workspace], write: [temp],
    environment, timeoutMs: 20000, compatibility:scope.compatibility, ...options };
}
async function start(req) {
  for (const path of req.write) if (!existsSync(path)) await mkdir(path, { recursive: true });
  const child = spawn(helper, [], { windowsHide: true, stdio: ['pipe','pipe','pipe'] });
  pending.add(child);
  let output = '', error = '', result, issue, readyResolve, readyReject;
  const started = new Promise((res, rej) => { readyResolve = res; readyReject = rej; });
  void started.catch(() => {});
  const watchdog = setTimeout(() => { child.kill(); issue = new Error('Native helper exceeded test deadline'); }, req.timeoutMs + 15000);
  child.stdin.on('error', () => {});
  child.stderr.setEncoding('utf8').on('data', value => { error += value; });
  child.stdout.setEncoding('utf8').on('data', value => {
    output += value;
    while (output.includes('\n')) {
      const index = output.indexOf('\n');
      const line = output.slice(0,index); output = output.slice(index+1);
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (event.type === 'started') { identities.add(event.profile); identitySids.add(event.sid); readyResolve(event); }
        else if (event.type === 'result') result = event;
        else if (event.type === 'error') issue = new Error(event.error);
      } catch (e) { issue = e; }
    }
  });
  const done = new Promise((res, rej) => {
    child.on('error', rej);
    child.on('close', code => {
      clearTimeout(watchdog); pending.delete(child); child.stdin.destroy();
      if (issue || !result || code) { const failure = issue || new Error(`helper exit ${code}: ${error.slice(0,2000)}`); readyReject(failure); rej(failure); }
      else res({ ...result, helperStderr: error });
    });
  });
  void done.catch(() => {});
  child.stdin.write(JSON.stringify(req)+'\n');
  return { child, started, done };
}
async function execute(req) { return (await start(req)).done; }
const js = (source, options) => execute(request(['-e', source], options));
function good(result) { assert.equal(result.exitCode, 0, result.stderr || result.stdout); assert.equal(result.cancelled, false); return result; }
async function test(name, action) {
  const selection=process.argv.find(arg=>arg.startsWith('--case='))?.slice(7);
  if(selection && !name.includes(selection)) return;
  const began = Date.now();
  try { const evidence = await action(); results.push({ name, status:'passed', milliseconds:Date.now()-began, evidence }); console.log(`PASS ${name}`); }
  catch (error) { results.push({ name, status:'failed', milliseconds:Date.now()-began, error:String(error.stack || error) }); console.log(`FAIL ${name}: ${error.message}`); }
  await writeFile(runFile,JSON.stringify({kind:'research-not-product',platform:process.platform,node:process.version,root,scope,realWindows10Validated:false,results,notes,complete:false},null,2));
}
async function until(action, ms = 7000) { const start = Date.now(); while (!(await action())) { if (Date.now()-start > ms) throw new Error('Timed out waiting for native probe evidence'); await new Promise(r => setTimeout(r,40)); } }
function alive(pid) { try { process.kill(pid,0); return true; } catch (e) { if (e.code === 'ESRCH') return false; throw e; } }
const deniedCode = (text) => { const e = JSON.parse(text); assert(['EACCES','EPERM'].includes(e.code), text); return e.code; };
function readDenied(path) { return `try { require('fs').readFileSync(${JSON.stringify(path)}); console.log(JSON.stringify({code:'UNEXPECTED_ACCESS'})); } catch(e) { console.log(JSON.stringify({code:e.code})); }`; }
let fatal;
try {
  await test('node-workspace-read', async () => {
    const response = good(await js("process.stdout.write(require('fs').readFileSync('input.txt','utf8'))"));
    assert.equal(response.stdout, 'fixture 720\n'); return { stdout:response.stdout, stderr:response.stderr };
  });
  if (process.argv.includes('--smoke')) {
    if (results.some(r => r.status === 'failed')) throw new Error('Basic AppContainer launch failed; inspect the report before extending the suite.');
  } else {
    await test('write-allowed-and-readonly-denied', async () => {
      const write = good(await js("require('fs').writeFileSync('allowed.txt','native wrote'); console.log('written')", { write:[workspace, join(root,'temp','write-case')] }));
      assert.equal(await readFile(join(workspace,'allowed.txt'),'utf8'),'native wrote');
      const deny = good(await js("try { require('fs').writeFileSync('forbidden.txt','bad'); console.log(JSON.stringify({code:'UNEXPECTED_WRITE'})); } catch(e) { console.log(JSON.stringify({code:e.code})); }"));
      return { allowed:write.stdout.trim(), denied:deniedCode(deny.stdout) };
    });
    await test('outside-and-other-project-denied', async () => {
      const a = good(await js(readDenied(join(outside,'private.txt'))));
      const b = good(await js(readDenied(join(other,'other.txt'))));
      return { outside:deniedCode(a.stdout), otherProject:deniedCode(b.stdout) };
    });
    await test('argv-stdin-unicode-and-clean-environment', async () => {
      const values = ['','a b','a"b','D:\\path with spaces\\','中文✓','line\nnext'];
      const req = request(['-e', "let s='';process.stdin.setEncoding('utf8').on('data',x=>s+=x).on('end',()=>console.log(JSON.stringify({args:process.argv.slice(1),input:s,secret:process.env.TAO_NATIVE_PRIVATE})))", ...values], { input:'输入✓\nsecond line' });
      const previous = process.env.TAO_NATIVE_PRIVATE; process.env.TAO_NATIVE_PRIVATE = 'private-fixture';
      try { const parsed=JSON.parse(good(await execute(req)).stdout); assert.deepEqual(parsed,{args:values,input:req.input}); return { structuredArguments:true, stdin:true, privateEnvAbsent:true }; }
      finally { if (previous === undefined) delete process.env.TAO_NATIVE_PRIVATE; else process.env.TAO_NATIVE_PRIVATE=previous; }
    });
    await test('child-inherits-appcontainer-token', async () => {
      const response=good(await js(`const c=require('child_process').spawn(${JSON.stringify(helper)},['--inspect-token'],{windowsHide:true,stdio:'inherit'});c.on('error',e=>{console.error(e.message);process.exitCode=1});c.on('exit',code=>process.exitCode=code)`));
      assert.equal(JSON.parse(response.stdout).isAppContainer,true); return JSON.parse(response.stdout);
    });
    await test('powershell-command', async () => {
      const powershell=good(await execute(request(['-NoLogo','-NoProfile','-NonInteractive','-Command',"Write-Output 'native-shell-ok'"], { program:shell })));
      assert(powershell.stdout.includes('native-shell-ok'),powershell.stdout);
      return { powershell:powershell.stdout.trim() };
    });
    await test('node-child-pipe-and-null-stdio', async () => {
      const source = "const cp=require('child_process');const out=cp.execFileSync(process.execPath,['-e',`process.stdout.write('子进程✓')`],{windowsHide:true});const ignored=cp.spawnSync(process.execPath,['-e','process.exit(0)'],{stdio:'ignore',windowsHide:true});if(ignored.error||ignored.status!==0)throw ignored.error||new Error('null stdio failed');process.stdout.write(out)";
      const response=good(await js(source)); assert.equal(response.stdout,'子进程✓'); return {pipes:true, nullStdio:true, unicode:true};
    });
    await test('readonly-cannot-rewrite-file-dacl', async () => {
      const response=good(await execute(request(['--acl-write-probe',join(workspace,'input.txt')],{program:helper})));
      assert.equal(JSON.parse(response.stdout).writeDac,false,response.stdout); return JSON.parse(response.stdout);
    });
    await test('git-command', async () => {
      const git=good(await execute(request(['--version'], { program:'C:\\Program Files\\Git\\cmd\\git.exe' })));
      assert(git.stdout.includes('git version'),git.stdout); return { git:git.stdout.trim() };
    });
    await test('git-worktree-status-and-diff', async () => {
      const git='C:\\Program Files\\Git\\cmd\\git.exe';
      good(await execute(request(['init','--quiet'],{program:git,write:[workspace,join(root,'temp','git')]})));
      const status=good(await execute(request(['-c','safe.directory=*','status','--short'],{program:git})));
      assert(status.stdout.includes('input.txt'),status.stdout);
      await writeFile(join(workspace,'git-diff.txt'),'different\n');
      const diff=await execute(request(['-c','safe.directory=*','diff','--no-index','--','input.txt','git-diff.txt'],{program:git}));
      assert.equal(diff.exitCode,1,diff.stderr); assert.equal(diff.cancelled,false); assert(diff.stdout.includes('diff --git'),diff.stdout);
      return {status:status.stdout,diff:diff.stdout};
    });
    await test('native-null-device-compatibility', async () => {
      const host=await promisify(execFile)(helper,['--null-probe'],{windowsHide:true,timeout:5000});
      assert.equal(JSON.parse(host.stdout).nullDevice,true,host.stdout);
      const response=good(await execute(request(['--null-probe'],{program:helper})));
      assert.equal(JSON.parse(response.stdout).nullDevice,true,response.stdout);
      return { nullDevice:true };
    });
    await test('node-native-realpath-compatibility', async () => {
      const response=good(await js("console.log(require('fs').realpathSync.native('input.txt'))"));
      assert(response.stdout.includes('input.txt')); return { nativeRealpath:true };
    });
    await test('network-denied-at-os-boundary', async () => {
      let connections=0;
      server=createServer(socket => { connections++; socket.on('error',()=>{}); socket.end('host-fixture'); });
      await new Promise((res,rej) => { server.once('error',rej); server.listen(0,'127.0.0.1',res); });
      const port=server.address().port;
      await new Promise((res,rej) => { const socket=connect(port,'127.0.0.1'); socket.on('error',rej); socket.on('connect',()=>{socket.destroy();res();}); });
      const code=`const net=require('net');const s=net.connect(${port},'127.0.0.1');s.setTimeout(2000);s.on('connect',()=>{console.log(JSON.stringify({code:'UNEXPECTED_NETWORK'}));s.destroy()});s.on('timeout',()=>{console.log(JSON.stringify({code:'TIMEOUT'}));s.destroy()});s.on('error',e=>console.log(JSON.stringify({code:e.code,errno:e.errno})))`;
      const countBefore=connections;
      const response=good(await js(code)); const outcome=JSON.parse(response.stdout); assert(['EACCES','EPERM','ETIMEDOUT','TIMEOUT'].includes(outcome.code),response.stdout);
      assert.equal(connections,countBefore,'Sandbox unexpectedly reached the controlled host listener');
      const control=await promisify(execFile)(helper,['--network-probe',String(port),'anonymous'],{windowsHide:true,timeout:5000});
      assert.equal(JSON.parse(control.stdout).connected,true,control.stdout);
      await until(()=>connections>countBefore);
      const afterControl=connections;
      const impersonated=good(await execute(request(['--network-probe',String(port),'anonymous'],{program:helper})));
      const adversarial=JSON.parse(impersonated.stdout);
      assert(adversarial.impersonationDenied || adversarial.connected===false,impersonated.stdout);
      assert.equal(connections,afterControl,'Anonymous sandbox token reached the controlled host listener');
      return { hostControlConnects:true, child:outcome, anonymousToken:adversarial };
    });
    await test('concurrent-readonly-and-writable-identities', async () => {
      const readOnly = await start(request(['-e', "setTimeout(()=>{try {require('fs').writeFileSync('ro-escape.txt','bad');console.log(JSON.stringify({code:'UNEXPECTED_WRITE'}))}catch(e){console.log(JSON.stringify({code:e.code}))}},600)"]));
      const roIdentity=await readOnly.started;
      const writable = await start(request(['-e',"require('fs').writeFileSync('rw-concurrent.txt','good');setTimeout(()=>console.log('written'),900)"],{write:[workspace,join(root,'temp','parallel')]}));
      const rwIdentity=await writable.started;
      assert.notEqual(roIdentity.sid,rwIdentity.sid);
      const [ro,rw]=await Promise.all([readOnly.done,writable.done]); good(ro);good(rw);
      assert(!existsSync(join(workspace,'ro-escape.txt')));
      assert.equal(await readFile(join(workspace,'rw-concurrent.txt'),'utf8'),'good');
      return { uniqueSids:true, readOnlyDenied:deniedCode(ro.stdout), writable:rw.stdout.trim() };
    });
    await test('concurrent-project-read-grants-remain-separate', async () => {
      const a=await start(request(['-e',`setTimeout(()=>{${readDenied(join(other,'other.txt'))}},600)`]));
      const b=await start(request(['-e',`setTimeout(()=>{${readDenied(join(workspace,'input.txt'))}},800)`],{cwd:other,read:[bin,other]}));
      const [ai,bi]=await Promise.all([a.started,b.started]); assert.notEqual(ai.sid,bi.sid);
      const [ar,br]=await Promise.all([a.done,b.done]); good(ar);good(br);
      return { a:deniedCode(ar.stdout), b:deniedCode(br.stdout), uniqueSids:true };
    });
    await test('junction-created-during-execution-does-not-expose-private-file', async () => {
      const link=join(workspace,'linked');
      const active=await start(request(['-e',`setTimeout(()=>{${readDenied(join(link,'private.txt'))}},700)`]));
      await active.started;
      try { await symlink(outside,link,'junction'); const response=good(await active.done); return { code:deniedCode(response.stdout) }; }
      finally { if (existsSync(link)) { const stat=await lstat(link); assert(stat.isSymbolicLink()); await unlink(link); } }
    });
    for (const method of ['cancel','controller-eof','kill-helper','foreground-exit']) {
      await test(`process-tree-${method}`, async () => {
        const marker=join(workspace,`late-${method}.txt`), pidFile=join(workspace,`pid-${method}.txt`);
        const descendant=`setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(marker)},'must-not-happen'),3200);setInterval(()=>{},1000)`;
        const foreground=`const fs=require('fs'),cp=require('child_process');const child=cp.spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'inherit',windowsHide:true});child.on('error',e=>{console.error(e);process.exit(1)});if(child.pid){fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid));child.unref();}${method==='foreground-exit' ? "console.log('foreground done')" : 'setInterval(()=>{},1000)'};`;
        const spec=request(['-e',foreground],{write:[workspace,join(root,'temp',method)]});
        const active=await start(spec);
        await active.started;
        await Promise.race([until(()=>existsSync(pidFile)),active.done.then(result=>{if(!existsSync(pidFile))throw new Error(`Descendant did not start: ${result.stderr || result.stdout}`);})]);
        const pid=Number(await readFile(pidFile,'utf8'));
        if (method==='cancel') active.child.stdin.write('cancel\n');
        if (method==='controller-eof') active.child.stdin.end();
        if (method==='kill-helper') { active.child.kill(); await active.done.catch(()=>{}); }
        else { const result=await active.done; if(method==='foreground-exit') good(result); else assert(result.cancelled); }
        await until(()=>!alive(pid)); assert(!existsSync(marker));
        return { descendantPid:pid, stopped:true, lateMarker:relative(root,marker),
          ...(method==='kill-helper' ? { recoveryJournalPresent:existsSync(join(root,'state',`${spec.id}.json`)) } : {}) };
      });
    }
  }
} catch (error) { fatal=String(error.stack||error); }
finally {
  for (const child of pending) child.stdin.end();
  await new Promise(r=>setTimeout(r,200));
  for (const child of pending) child.kill();
  if (server) await new Promise(r=>server.close(r));
  try {
    const cleanup=await promisify(execFile)(helper,['--cleanup'],{windowsHide:true,timeout:15000});
    assert(JSON.parse(cleanup.stdout).cleanup); assert.equal((await readdir(join(root,'state'))).length,0);
    const profiles=[...identities];
    // Verify Windows no longer lists the identities; do not enumerate unrelated profiles.
    const registry=join(systemRoot,'System32','reg.exe');
    for(const name of profiles) {
      const records=await promisify(execFile)(registry,['query','HKCU\\Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\AppContainer\\Mappings','/s','/f',name,'/d','/e'],{windowsHide:true,timeout:10000}).catch(error=>({stdout:error.stdout||''}));
      assert(!records.stdout.toLowerCase().includes(name.toLowerCase()),`profile left: ${name}`);
    }
    notes.push('Owned AppContainer journals cleaned; recorded profiles absent from current-user mappings.');
    const literalRoot=root.replaceAll("'","''");
    const auditScript=`$ErrorActionPreference='Stop';$taoRoot='${literalRoot}';$taoRows=@(Get-Item -LiteralPath $taoRoot)+@(Get-ChildItem -LiteralPath $taoRoot -Recurse -Force | Where-Object { -not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) });$taoAudit=@($taoRows | ForEach-Object { [pscustomobject]@{path=$_.FullName;sddl=(Get-Acl -LiteralPath $_.FullName).GetSecurityDescriptorSddlForm([System.Security.AccessControl.AccessControlSections]::Access)} });ConvertTo-Json -InputObject $taoAudit -Compress`;
    const audited=await promisify(execFile)(shell,['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',auditScript],{windowsHide:true,timeout:15000,maxBuffer:4*1024*1024});
    for(const item of JSON.parse(audited.stdout)) for(const sid of identitySids) assert(!item.sddl.includes(`${sid})`),`owned ACL left on ${item.path}`);
    notes.push('Generated tree ACL audit found no recorded experiment SID grants.');
  } catch(error) { fatal=[fatal,`CLEANUP FAILED: ${error.stack||error}`].filter(Boolean).join('\n'); }
  const failed=results.filter(r=>r.status==='failed').length;
  await writeFile(runFile,JSON.stringify({kind:'research-not-product',platform:process.platform,controllerNode:process.version,toolNode:toolNodeVersion,root,scope,
    realWindows10Validated:false,complete:true,results,notes,fatal:fatal||null},null,2));
  console.log(JSON.stringify({report:runFile,passed:results.length-failed,failed,fatal:fatal||null}));
  await unlink(node).catch(error=>console.error(`Temporary Node copy cleanup failed: ${error.message}`));
  if(failed||fatal) process.exitCode=1;
}
