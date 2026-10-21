//! Every launch owns a unique AppContainer identity and kill-on-close job.
#![cfg(windows)]

#[path = "compatibility.rs"]
mod compatibility;
#[path = "nt.rs"]
mod nt;
#[path = "workspace_drive.rs"]
mod workspace_drive;

use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{collections::BTreeMap, ffi::c_void, fs::{self, File}, io::{self, BufRead, Read, Write},
    mem::{size_of, zeroed}, os::windows::{ffi::OsStrExt, io::FromRawHandle}, path::{Path, PathBuf},
    ptr::{null, null_mut}, sync::{Arc, atomic::{AtomicBool, Ordering}}, thread, time::{Duration, Instant}};
use windows_sys::Win32::{Foundation::*, Security::{*, Authorization::*, Isolation::*},
    Storage::FileSystem::*, System::{JobObjects::*, Pipes::*, Threading::*}};

type Result<T> = std::result::Result<T, String>;
#[cfg(not(feature = "product"))]
const PROFILE_PREFIX: &str = "Tao.NativeProbe.";
#[cfg(feature = "product")]
const PROFILE_PREFIX: &str = "Tao.Tool.";
const OUTPUT_LIMIT: usize = 2 * 1024 * 1024;
fn wide(s: impl AsRef<std::ffi::OsStr>) -> Vec<u16> { s.as_ref().encode_wide().chain(Some(0)).collect() }
fn failure(label: &str) -> String { format!("{label}: {}", io::Error::last_os_error()) }
fn emit(value: serde_json::Value) { println!("{value}"); let _ = io::stdout().flush(); }

struct Handle(HANDLE);
impl Handle { fn new(h: HANDLE, label: &str) -> Result<Self> { if h.is_null() || h == INVALID_HANDLE_VALUE { Err(failure(label)) } else { Ok(Self(h)) } } }
impl Drop for Handle { fn drop(&mut self) { unsafe { CloseHandle(self.0); } } }
struct Local(*mut c_void);
impl Drop for Local { fn drop(&mut self) { unsafe { LocalFree(self.0); } } }
struct Sid(PSID);
impl Drop for Sid { fn drop(&mut self) { unsafe { FreeSid(self.0); } } }
struct AclLock(Handle);
impl AclLock {
    fn acquire() -> Result<Self> { unsafe {
        let h = Handle::new(CreateMutexW(null(), 0, wide("Global\\Tao.WindowsSandbox.Acl.v1").as_ptr()), "CreateMutex")?;
        match WaitForSingleObject(h.0, 30000) { WAIT_OBJECT_0 | WAIT_ABANDONED => Ok(Self(h)), _ => Err("ACL mutex timeout".into()) }
    } }
}
impl Drop for AclLock { fn drop(&mut self) { unsafe { ReleaseMutex(self.0.0); } } }

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    id: String, program: PathBuf, #[serde(default)] args: Vec<String>, cwd: PathBuf,
    #[serde(default)] read: Vec<PathBuf>, #[serde(default)] write: Vec<PathBuf>,
    #[serde(default)] environment: BTreeMap<String, String>, #[serde(default)] input: String,
    #[serde(default = "default_timeout")] timeout_ms: u64,
    #[serde(default)] compatibility: bool,
    #[serde(default)] workspace_drive: bool,
}
fn default_timeout() -> u64 { 30000 }
#[derive(Serialize, Deserialize)]
struct Journal { profile: String, sid: String, paths: Vec<PathBuf>, #[serde(default)] metadata_paths: Vec<PathBuf> }

#[cfg(not(feature = "product"))]
fn lab_root() -> Result<PathBuf> {
    let exe = fs::canonicalize(std::env::current_exe().map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let root = exe.parent().and_then(Path::parent).ok_or("invalid helper location")?;
    if !root.file_name().is_some_and(|n| n.to_string_lossy().starts_with("run-"))
        || !root.parent().and_then(Path::file_name).is_some_and(|n| n == "windows-native-lab") {
        return Err("Run a copied helper in its generated windows-native-lab/run-*/bin folder".into());
    }
    Ok(root.to_path_buf())
}
#[cfg(feature = "product")]
fn lab_root() -> Result<PathBuf> {
    let args: Vec<_> = std::env::args_os().collect();
    let index = args.iter().position(|arg|arg=="--state-root").ok_or("missing native sandbox state root")?;
    let path = PathBuf::from(args.get(index+1).ok_or("missing state root value")?);
    if !path.is_absolute() || path.file_name().is_none_or(|name|name!="native-sandbox") { return Err("invalid sandbox state root".into()); }
    fs::create_dir_all(&path).map_err(|e|e.to_string())?;
    no_reparse_ancestors(&path)?;
    fs::canonicalize(path).map_err(|e|e.to_string())
}
fn no_reparse_ancestors(path: &Path) -> Result<()> {
    use std::os::windows::fs::MetadataExt;
    for ancestor in path.ancestors() {
        if fs::symlink_metadata(ancestor).map_err(|e|e.to_string())?.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err("sandbox grant/state path must not contain reparse points".into());
        }
    }
    Ok(())
}
fn pin_workspace(path: &Path) -> Result<Handle> { unsafe {
    no_reparse_ancestors(path)?;
    // Pin root rename/deletion before scanning or granting ACLs. Directory share
    // modes alone do not prevent all metadata changes; ACL updates below use a
    // verified, non-following handle instead of reopening a canonicalized name.
    let handle=Handle::new(CreateFileW(wide(path).as_ptr(),FILE_READ_ATTRIBUTES,FILE_SHARE_READ | FILE_SHARE_WRITE,
        null(),OPEN_EXISTING,FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,null_mut()),"pin sandbox workspace")?;
    let mut info: BY_HANDLE_FILE_INFORMATION=zeroed();
    if GetFileInformationByHandle(handle.0,&mut info)==0 {return Err(failure("inspect pinned workspace"));}
    if info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 || info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0 {
        return Err("sandbox workspace must be a directory without reparse points".into());
    }
    Ok(handle)
} }
fn owned_path(root: &Path, path: &Path) -> Result<PathBuf> {
    // Inspect the original path: canonicalize first would hide a replaced root.
    no_reparse_ancestors(path)?;
    let target = fs::canonicalize(path).map_err(|e| format!("resolve experiment path: {e}"))?;
    let normalized=|value:&Path| {
        let text=value.to_string_lossy().replace('/',"\\");
        text.strip_prefix(r"\\?\").unwrap_or(&text).to_owned()
    };
    if !normalized(path).eq_ignore_ascii_case(&normalized(&target)) {return Err("sandbox grant requires a canonical path without reparse redirection".into());}
    #[cfg(not(feature = "product"))]
    if target == root || !target.starts_with(root) { return Err("ACL grant must stay below this experiment root".into()); }
    #[cfg(feature = "product")]
    if target.starts_with(root) || root.starts_with(&target) { return Err("sandbox state must be separate from granted directories".into()); }
    Ok(target)
}
fn no_reparse_tree(path: &Path, count: &mut usize) -> Result<()> {
    use std::os::windows::fs::MetadataExt;
    *count += 1;
    if *count > 10000 { return Err("experiment ACL tree exceeds 10000 entries".into()); }
    let metadata = fs::symlink_metadata(path).map_err(|e|e.to_string())?;
    if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 { return Err("pre-existing reparse points are not accepted for experiment ACL grants".into()); }
    if metadata.is_file() {
        let (handle,_parents)=nt::open_path(path,FILE_READ_ATTRIBUTES)?;
        inspect_acl_file(handle.0,false)?;
    }
    if metadata.is_dir() { for child in fs::read_dir(path).map_err(|e|e.to_string())? { no_reparse_tree(&child.map_err(|e|e.to_string())?.path(),count)?; } }
    Ok(())
}
fn sid_string(sid: PSID) -> Result<String> { unsafe {
    let mut p = null_mut();
    if ConvertSidToStringSidW(sid, &mut p) == 0 { return Err(failure("ConvertSidToStringSid")); }
    let _allocation = Local(p.cast());
    let mut len = 0; while *p.add(len) != 0 { len += 1; }
    Ok(String::from_utf16_lossy(std::slice::from_raw_parts(p, len)))
} }
fn preserve_dacl_control(source: PSECURITY_DESCRIPTOR, target: PSECURITY_DESCRIPTOR) -> Result<()> { unsafe {
    let mut control=0;let mut revision=0;
    let mask=SE_DACL_AUTO_INHERITED | SE_DACL_AUTO_INHERIT_REQ | SE_DACL_PROTECTED;
    if GetSecurityDescriptorControl(source,&mut control,&mut revision)==0
        || SetSecurityDescriptorControl(target,mask,control & mask)==0 { return Err(failure("preserve ACL inheritance control")); }
    Ok(())
} }
fn acl_change(path: &Path, sid: PSID, rights: u32, remove: bool) -> Result<()> {
    acl_change_kind(path,sid,rights,remove,rights==(FILE_READ_ATTRIBUTES | FILE_READ_EA | READ_CONTROL | SYNCHRONIZE))
}
fn acl_change_kind(path: &Path, sid: PSID, rights: u32, remove: bool, metadata: bool) -> Result<()> {
    let _lock = AclLock::acquire()?;
    let (handle,_parents)=nt::open_path(path,READ_CONTROL | WRITE_DAC | FILE_READ_ATTRIBUTES)?;
    acl_tree(path,&handle,sid,rights,remove,metadata,&mut 0)
}
fn inspect_acl_file(handle: HANDLE, remove: bool) -> Result<BY_HANDLE_FILE_INFORMATION> { unsafe {
    let mut info: BY_HANDLE_FILE_INFORMATION=zeroed();
    if GetFileInformationByHandle(handle,&mut info)==0 {return Err(failure("inspect ACL target"));}
    if !remove && info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {return Err("refuse ACL updates on reparse points".into());}
    if !remove && info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0 && info.nNumberOfLinks != 1 {
        return Err("sandbox grant refuses hard-linked files; use independent file copies in this workspace".into());
    }
    Ok(info)
} }
fn acl_tree(path: &Path, handle: &Handle, sid: PSID, rights: u32, remove: bool, metadata: bool, count: &mut usize) -> Result<()> {
    *count+=1;if *count>10000 {return Err("sandbox ACL tree exceeds 10000 entries".into());}
    let info=inspect_acl_file(handle.0,remove)?;
    // SetKernelObjectSecurity changes exactly this handle. SetSecurityInfo would
    // recursively follow names while propagating inherited ACEs to old children.
    acl_handle(handle.0,sid,rights,remove,metadata)?;
    if !metadata && info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0 && info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT == 0 {
        for entry in fs::read_dir(path).map_err(|e|e.to_string())? {
            let entry=entry.map_err(|e|e.to_string())?;
            let child=nt::open_child(handle.0,&entry.file_name(),READ_CONTROL | WRITE_DAC | FILE_READ_ATTRIBUTES,remove)?;
            acl_tree(&entry.path(),&child,sid,rights,remove,false,count)?;
        }
    }
    Ok(())
}
fn acl_handle(handle: HANDLE, sid: PSID, rights: u32, remove: bool, metadata: bool) -> Result<()> { unsafe {
    let mut old_acl = null_mut(); let mut descriptor = null_mut();
    let status = GetSecurityInfo(handle, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION,
        null_mut(), null_mut(), &mut old_acl, null_mut(), &mut descriptor);
    if status != 0 { return Err(format!("read ACL: Windows {status}")); }
    let _descriptor = Local(descriptor);
    // Remove our inherited ACEs too, preserving every other ACE byte-for-byte.
    let mut filtered=Vec::<usize>::new();
    if remove && !old_acl.is_null() {
        filtered.resize(((*old_acl).AclSize as usize).div_ceil(size_of::<usize>()),0);
        std::ptr::copy_nonoverlapping(old_acl.cast::<u8>(),filtered.as_mut_ptr().cast(),(*old_acl).AclSize as usize);
        let copied=filtered.as_mut_ptr().cast::<ACL>();let mut found=false;
        for index in (0..(*copied).AceCount as u32).rev() {
            let mut raw = null_mut();
            if GetAce(copied,index,&mut raw)==0 { return Err(failure("inspect cleanup ACE")); }
            if (*(raw as *const ACE_HEADER)).AceType==0 {
                let ace=&*(raw as *const ACCESS_ALLOWED_ACE);
                if EqualSid((&ace.SidStart as *const u32).cast_mut().cast(),sid)!=0 {
                    if DeleteAce(copied,index)==0 {return Err(failure("remove owned ACE"));}found=true;
                }
            }
        }
        if !found { return Ok(()); }
    }
    let access = EXPLICIT_ACCESS_W { grfAccessPermissions: rights,
        grfAccessMode: if remove { REVOKE_ACCESS } else { GRANT_ACCESS },
        grfInheritance: if remove || metadata { 0 } else { CONTAINER_INHERIT_ACE | OBJECT_INHERIT_ACE },
        Trustee: TRUSTEE_W { pMultipleTrustee: null_mut(), MultipleTrusteeOperation: NO_MULTIPLE_TRUSTEE,
            TrusteeForm: TRUSTEE_IS_SID, TrusteeType: TRUSTEE_IS_UNKNOWN, ptstrName: sid.cast() } };
    let mut new_acl = if remove {filtered.as_mut_ptr().cast()} else {null_mut()};
    let status = if remove {0} else {SetEntriesInAclW(1, &access, old_acl, &mut new_acl)};
    if status != 0 { return Err(format!("merge ACL: Windows {status}")); }
    let _new_acl = Local(if remove {null_mut()} else {new_acl.cast()});
    {
        let mut descriptor: SECURITY_DESCRIPTOR=zeroed();
        if InitializeSecurityDescriptor((&mut descriptor as *mut SECURITY_DESCRIPTOR).cast(),1)==0
            || SetSecurityDescriptorDacl((&mut descriptor as *mut SECURITY_DESCRIPTOR).cast(),1,new_acl,0)==0 {
            return Err(failure("update non-inheriting ancestor metadata ACL"));
        }
        preserve_dacl_control(_descriptor.0,(&mut descriptor as *mut SECURITY_DESCRIPTOR).cast())?;
        if SetKernelObjectSecurity(handle,DACL_SECURITY_INFORMATION,(&mut descriptor as *mut SECURITY_DESCRIPTOR).cast())==0 { return Err(failure("write sandbox handle ACL")); }
        return Ok(());
    }
} }

fn clean_journal(root: &Path, path: &Path) -> Result<()> {
    let journal: Journal = serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    if !journal.profile.starts_with(PROFILE_PREFIX) || journal.profile.len() > 100 { return Err("invalid owned profile".into()); }
    unsafe {
        let mut raw = null_mut();
        if ConvertStringSidToSidW(wide(&journal.sid).as_ptr(), &mut raw) == 0 { return Err(failure("parse journal SID")); }
        let _sid = Local(raw);
        let mut derived = null_mut();
        if DeriveAppContainerSidFromAppContainerName(wide(&journal.profile).as_ptr(), &mut derived) < 0 { return Err("derive cleanup profile SID".into()); }
        let _derived = Sid(derived);
        if EqualSid(raw,derived)==0 { return Err("journal SID does not belong to its profile".into()); }
        for target in &journal.paths {
            if target.exists() { acl_change(&owned_path(root, target)?, raw, 0, true)?; }
        }
        for target in &journal.metadata_paths {
            if !journal.paths.iter().any(|granted|granted.starts_with(target) && granted!=target) { return Err("invalid metadata ancestor in journal".into()); }
            if target.exists() { acl_change_kind(target,raw,0,true,true)?; }
        }
        let hr = DeleteAppContainerProfile(wide(&journal.profile).as_ptr());
        if hr < 0 && hr as u32 != 0x80070002 { return Err(format!("delete profile HRESULT {hr:#x}")); }
    }
    fs::remove_file(path).map_err(|e| e.to_string())
}
struct Lease(Handle);
impl Lease {
    fn acquire(id: &str) -> Result<Option<Self>> { unsafe {
        let handle = Handle::new(CreateMutexW(null(),0,wide(format!("Global\\Tao.Sandbox.Lease.{id}")).as_ptr()),"create sandbox lease")?;
        match WaitForSingleObject(handle.0,0) { WAIT_OBJECT_0|WAIT_ABANDONED => Ok(Some(Self(handle))), WAIT_TIMEOUT => Ok(None), _ => Err(failure("acquire sandbox lease")) }
    } }
}
impl Drop for Lease { fn drop(&mut self) { unsafe { ReleaseMutex(self.0.0); } } }
struct Profile { root: PathBuf, journal: PathBuf, sid: Sid, cleaned: bool, _lease: Lease, workspace: Handle }
struct PendingProfile(Option<String>);
impl Drop for PendingProfile { fn drop(&mut self) { if let Some(name)=&self.0 { unsafe { DeleteAppContainerProfile(wide(name).as_ptr()); } } } }
impl Profile {
    fn create(root: &Path, request: &Request) -> Result<Self> {
        if request.id.is_empty() || request.id.len() > 64 || !request.id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') { return Err("invalid experiment ID".into()); }
        let lease = Lease::acquire(&request.id)?.ok_or("execution ID already active")?;
        let workspace = pin_workspace(&request.cwd)?;
        let mut paths = request.read.iter().chain(&request.write).map(|p| owned_path(root, p)).collect::<Result<Vec<_>>>()?;
        paths.sort(); paths.dedup();
        for path in &paths { no_reparse_tree(path, &mut 0)?; }
        let state = root.join("state"); fs::create_dir_all(&state).map_err(|e| e.to_string())?;
        let journal = state.join(format!("{}.json", request.id));
        if journal.exists() { return Err("experiment ID already has a journal".into()); }
        let name = format!("{PROFILE_PREFIX}{}", request.id);
        let mut derived = null_mut();
        if unsafe { DeriveAppContainerSidFromAppContainerName(wide(&name).as_ptr(), &mut derived) } < 0 { return Err("derive execution identity".into()); }
        let derived = Sid(derived);
        let cwd = fs::canonicalize(&request.cwd).map_err(|e|e.to_string())?;
        // Module loaders also walk ancestors of granted runtime/temp paths.
        // Give those directories metadata only, with this execution's SID;
        // granting contents or directory listings is unnecessary.
        let mut metadata_paths: Vec<_> = if request.compatibility || cfg!(feature="product") {
            std::iter::once(&cwd).chain(paths.iter()).flat_map(|path|path.ancestors().skip(1))
                .filter(|path|path.parent().is_some() && !paths.iter().any(|granted|granted.as_path()==*path))
                .map(Path::to_path_buf).collect()
        } else {Vec::new()};
        metadata_paths.sort(); metadata_paths.dedup();
        if request.compatibility || cfg!(feature="product") { metadata_paths.retain(|path|!compatibility::has_metadata_access(path).unwrap_or(false)); }
        let record = Journal { profile: name.clone(), sid: sid_string(derived.0)?, paths, metadata_paths };
        // Durable intent precedes profile creation, including abrupt helper exit.
        let mut journal_file = fs::OpenOptions::new().write(true).create_new(true).open(&journal).map_err(|e|e.to_string())?;
        journal_file.write_all(&serde_json::to_vec(&record).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
        journal_file.sync_all().map_err(|e|e.to_string())?;
        drop(journal_file);
        let mut raw = null_mut();
        let hr = unsafe { CreateAppContainerProfile(wide(&name).as_ptr(), wide("Tao native sandbox experiment").as_ptr(),
            wide("Disposable research identity").as_ptr(), null(), 0, &mut raw) };
        if hr < 0 { let _=fs::remove_file(&journal); return Err(format!("create profile HRESULT {hr:#x}")); }
        let mut pending = PendingProfile(Some(name.clone()));
        let sid = Sid(raw);
        let profile = Self { root: root.to_path_buf(), journal, sid, cleaned: false, _lease: lease, workspace };
        pending.0 = None;
        for path in &record.metadata_paths { acl_change(path,raw,FILE_READ_ATTRIBUTES | FILE_READ_EA | READ_CONTROL | SYNCHRONIZE,false)?; }
        for path in &request.read { acl_change(&owned_path(root, path)?, raw, FILE_GENERIC_READ | FILE_GENERIC_EXECUTE, false)?; }
        for path in &request.write { acl_change(&owned_path(root, path)?, raw,
            FILE_GENERIC_READ | FILE_GENERIC_WRITE | FILE_GENERIC_EXECUTE | DELETE, false)?; }
        Ok(profile)
    }
    fn cleanup(&mut self) -> Result<()> {
        if self.cleaned { return Ok(()); }
        clean_journal(&self.root, &self.journal)?; self.cleaned = true; Ok(())
    }
}
impl Drop for Profile { fn drop(&mut self) { if let Err(e) = self.cleanup() { eprintln!("cleanup requires retry: {e}"); } } }

fn quote(arg: &str) -> String {
    let mut result = String::from("\""); let mut slashes = 0;
    for c in arg.chars() {
        if c == '\\' { slashes += 1; continue; }
        if c == '"' { result.push_str(&"\\".repeat(slashes * 2 + 1)); result.push(c); }
        else { result.push_str(&"\\".repeat(slashes)); result.push(c); }
        slashes = 0;
    }
    result.push_str(&"\\".repeat(slashes * 2)); result.push('"'); result
}
fn pipe(parent_reads: bool) -> Result<(File, Handle)> { unsafe {
    let mut r = null_mut(); let mut w = null_mut();
    let sa = SECURITY_ATTRIBUTES { nLength: size_of::<SECURITY_ATTRIBUTES>() as u32, lpSecurityDescriptor: null_mut(), bInheritHandle: 1 };
    if CreatePipe(&mut r, &mut w, &sa, 0) == 0 { return Err(failure("CreatePipe")); }
    let (parent, child) = if parent_reads { (r,w) } else { (w,r) };
    let child = Handle(child); let parent = File::from_raw_handle(parent);
    use std::os::windows::io::AsRawHandle;
    if SetHandleInformation(parent.as_raw_handle(), HANDLE_FLAG_INHERIT, 0) == 0 { return Err(failure("pipe handle inheritance")); }
    Ok((parent, child))
} }
fn capture(mut pipe: File, stopped: Arc<AtomicBool>, stream: &'static str) -> thread::JoinHandle<String> {
    thread::spawn(move || {
        let mut bytes = Vec::new(); let mut chunk = [0u8;8192];
        loop { match pipe.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(n) => { if bytes.len() + n > OUTPUT_LIMIT { stopped.store(true, Ordering::SeqCst); break; }
                #[cfg(feature = "product")]
                emit(json!({"type":"data","stream":stream,"bytes":&chunk[..n]}));
                #[cfg(not(feature = "product"))]
                let _ = stream;
                bytes.extend_from_slice(&chunk[..n]); }
        } }
        String::from_utf8_lossy(&bytes).into_owned()
    })
}
struct Attributes(Vec<usize>, bool);
impl Drop for Attributes { fn drop(&mut self) { if self.1 { unsafe { DeleteProcThreadAttributeList(self.0.as_mut_ptr().cast()); } } } }

fn run(request: Request, stopped: Arc<AtomicBool>) -> Result<serde_json::Value> {
    let root = lab_root()?;
    if request.environment.is_empty() {return Err("explicit sandbox environment required".into());}
    #[cfg(feature = "product")]
    let _compatibility_lease=compatibility::execution_lease()?;
    #[cfg(feature = "product")]
    compatibility::ensure_ready()?;
    let cwd = owned_path(&root, &request.cwd)?;
    if request.args.iter().any(|s| s.contains('\0')) || !request.program.is_absolute() { return Err("invalid argv".into()); }
    let mut profile = Profile::create(&root, &request)?;
    let workspace_drive=if request.workspace_drive {Some(workspace_drive::WorkspaceDrive::create(profile.workspace.0,profile.sid.0)?)} else {None};
    let launched = (|| unsafe {
        let job = Handle::new(CreateJobObjectW(null(), null()), "CreateJobObject")?;
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = zeroed();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_ACTIVE_PROCESS | JOB_OBJECT_LIMIT_PROCESS_MEMORY | JOB_OBJECT_LIMIT_JOB_MEMORY;
        limits.BasicLimitInformation.ActiveProcessLimit = 32; limits.ProcessMemoryLimit = 1024 * 1024 * 1024; limits.JobMemoryLimit = 1024 * 1024 * 1024;
        if SetInformationJobObject(job.0, JobObjectExtendedLimitInformation, (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(), size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32) == 0 { return Err(failure("job limits")); }
        let (out, child_out) = pipe(true)?; let (err, child_err) = pipe(true)?; let (mut input, child_input) = pipe(false)?;
        let mut bytes = 0;
        InitializeProcThreadAttributeList(null_mut(), 2, 0, &mut bytes);
        let mut attributes = Attributes(vec![0; bytes.div_ceil(size_of::<usize>())], false);
        let list = attributes.0.as_mut_ptr().cast();
        if InitializeProcThreadAttributeList(list, 2, 0, &mut bytes) == 0 { return Err(failure("initialize process attributes")); }
        attributes.1 = true;
        let compatibility = if request.compatibility || cfg!(feature="product") { Some(compatibility::Capability::derive()?) } else { None };
        let mut extras = compatibility.as_ref().map(|cap| SID_AND_ATTRIBUTES { Sid: cap.sid(), Attributes: 4 }); // SE_GROUP_ENABLED
        let capabilities = SECURITY_CAPABILITIES { AppContainerSid: profile.sid.0,
            Capabilities: extras.as_mut().map_or(null_mut(),|item|item as *mut _), CapabilityCount: u32::from(extras.is_some()), Reserved: 0 };
        if UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES as usize,
            (&capabilities as *const SECURITY_CAPABILITIES).cast(), size_of::<SECURITY_CAPABILITIES>(), null_mut(), null()) == 0 { return Err(failure("AppContainer attribute")); }
        let inherited = [child_input.0, child_out.0, child_err.0];
        if UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize, inherited.as_ptr().cast(), size_of_val(&inherited), null_mut(), null()) == 0 { return Err(failure("handle allowlist")); }
        let mut startup: STARTUPINFOEXW = zeroed(); startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
        startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES; startup.StartupInfo.hStdInput = child_input.0;
        startup.StartupInfo.hStdOutput = child_out.0; startup.StartupInfo.hStdError = child_err.0; startup.lpAttributeList = list;
        let mut environment: Vec<(String,String)> = request.environment.iter().map(|(k,v)|(k.clone(),v.clone())).collect();
        environment.retain(|(key,_)|!key.eq_ignore_ascii_case("TAO_SANDBOX_WORKSPACE"));
        environment.push(("TAO_SANDBOX_WORKSPACE".into(),workspace_drive.as_ref().map_or_else(||cwd.to_string_lossy().into_owned(),|drive|drive.cwd.clone())));
        if environment.iter().any(|(k,v)| k.contains(['\0','=']) || v.contains('\0')) { return Err("invalid environment".into()); }
        environment.sort_by_cached_key(|(k,_)| k.to_ascii_uppercase());
        let mut block: Vec<u16> = environment.iter().flat_map(|(k,v)| wide(format!("{k}={v}"))).collect(); block.push(0);
        let mut command = wide(std::iter::once(request.program.to_string_lossy().into_owned()).chain(request.args.iter().cloned()).map(|a| quote(&a)).collect::<Vec<_>>().join(" "));
        // Keep canonical extended paths for ACLs, but give programs an ordinary
        // DOS current directory. Node's JS module resolver and per-drive cwd
        // handling otherwise attempt to lstat "D:" inside the AppContainer.
        let mut process_cwd = wide(&cwd);
        if process_cwd.starts_with(&[92, 92, 63, 92]) && process_cwd.get(5) == Some(&58) && process_cwd.get(6) == Some(&92) {
            process_cwd.drain(..4);
        }
        if let Some(drive)=&workspace_drive {process_cwd=wide(&drive.cwd);}
        let mut pi: PROCESS_INFORMATION = zeroed();
        if CreateProcessW(wide(&request.program).as_ptr(), command.as_mut_ptr(), null(), null(), 1,
            CREATE_NO_WINDOW | CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT,
            block.as_ptr().cast(), process_cwd.as_ptr(), &startup.StartupInfo, &mut pi) == 0 { return Err(failure("CreateProcess AppContainer")); }
        let process = Handle(pi.hProcess); let main_thread = Handle(pi.hThread);
        if AssignProcessToJobObject(job.0, process.0) == 0 { TerminateProcess(process.0, 125); return Err(failure("assign process job")); }
        if ResumeThread(main_thread.0) == u32::MAX { TerminateJobObject(job.0, 125); return Err(failure("resume sandbox")); }
        drop(child_out); drop(child_err); drop(child_input);
        let stdout = capture(out, stopped.clone(),"stdout"); let stderr = capture(err, stopped.clone(),"stderr");
        let input_text = request.input.clone(); let writer = thread::spawn(move || { let _ = input.write_all(input_text.as_bytes()); });
        emit(json!({"type":"started", "pid":pi.dwProcessId, "sid":sid_string(profile.sid.0)?, "profile":format!("{PROFILE_PREFIX}{}", request.id),
            "workspaceDrive":workspace_drive.as_ref().map(|drive|&drive.cwd)}));
        let start = Instant::now(); let mut cancelled = false;
        loop {
            let wait = WaitForSingleObject(process.0, 25);
            if wait == WAIT_OBJECT_0 { break; }
            if wait == WAIT_FAILED { TerminateJobObject(job.0, 125); return Err(failure("wait sandbox")); }
            if stopped.load(Ordering::SeqCst) || start.elapsed() > Duration::from_millis(request.timeout_ms.clamp(100,120000)) {
                cancelled = true; TerminateJobObject(job.0, 124); WaitForSingleObject(process.0, 5000); break;
            }
        }
        let mut code = 0;
        if GetExitCodeProcess(process.0, &mut code)==0 {return Err(failure("read sandbox exit code"));}
        // Closing the job stops descendants even after normal foreground exit.
        drop(job); let _ = writer.join();
        Ok(json!({"type":"result", "exitCode":code, "cancelled":cancelled,
            "stdout":stdout.join().unwrap_or_default(), "stderr":stderr.join().unwrap_or_default()}))
    })();
    drop(workspace_drive);
    profile.cleanup()?;
    launched
}

fn inspect() -> Result<()> { unsafe {
    let mut raw = null_mut();
    if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut raw) == 0 { return Err(failure("open token")); }
    let token = Handle(raw); let mut flag: u32 = 0; let mut len = 0;
    if GetTokenInformation(token.0, TokenIsAppContainer, (&mut flag as *mut u32).cast(), 4, &mut len) == 0 { return Err(failure("inspect token")); }
    emit(json!({"isAppContainer":flag != 0})); Ok(())
} }
fn network_probe() -> Result<()> {
    use std::net::{SocketAddr, TcpStream};
    let port: u16 = std::env::args().nth(2).ok_or("missing port")?.parse().map_err(|_|"invalid port")?;
    let anonymous = std::env::args().nth(3).as_deref() == Some("anonymous");
    // Initialize Winsock under the process identity before the thread token
    // changes. The socket used by the probe itself is created after impersonation.
    let _ = std::net::UdpSocket::bind("127.0.0.1:0");
    if anonymous && unsafe { ImpersonateAnonymousToken(GetCurrentThread()) } == 0 {
        emit(json!({"anonymous":true,"impersonationDenied":true,"error":failure("anonymous token")})); return Ok(());
    }
    let result = TcpStream::connect_timeout(&SocketAddr::from(([127,0,0,1],port)), Duration::from_secs(2));
    if anonymous { unsafe { RevertToSelf(); } }
    match result { Ok(_) => emit(json!({"anonymous":anonymous,"connected":true})),
        Err(error) => emit(json!({"anonymous":anonymous,"connected":false,"osError":error.raw_os_error(),"error":error.to_string()})) }
    Ok(())
}
fn null_probe() -> Result<()> { unsafe {
    let raw=CreateFileW(wide(r"\\.\NUL").as_ptr(), GENERIC_READ | GENERIC_WRITE,
        FILE_SHARE_READ | FILE_SHARE_WRITE, null(), OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, null_mut());
    if raw==INVALID_HANDLE_VALUE { emit(json!({"nullDevice":false,"osError":GetLastError()})); }
    else { let _handle=Handle(raw); emit(json!({"nullDevice":true})); }
    Ok(())
} }
fn acl_write_probe() -> Result<()> { unsafe {
    let path = std::env::args_os().nth(2).ok_or("missing ACL probe path")?;
    let raw=CreateFileW(wide(path).as_ptr(), WRITE_DAC, FILE_SHARE_READ | FILE_SHARE_WRITE,
        null(), OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, null_mut());
    if raw==INVALID_HANDLE_VALUE { emit(json!({"writeDac":false,"osError":GetLastError()})); }
    else { let _handle=Handle(raw); emit(json!({"writeDac":true})); }
    Ok(())
} }
fn main_result() -> Result<()> {
    match std::env::args().nth(1).as_deref() {
        Some(operation @ ("--compat-status" | "--compat-prepare" | "--compat-cleanup")) => return compatibility::command(operation),
        Some("--inspect-token") => return inspect(),
        Some("--network-probe") => return network_probe(),
        Some("--null-probe") => return null_probe(),
        Some("--acl-write-probe") => return acl_write_probe(),
        Some("--cleanup") => { let root = lab_root()?; let state = root.join("state"); fs::create_dir_all(&state).map_err(|e|e.to_string())?;
            let mut skipped = 0;
            for file in fs::read_dir(state).map_err(|e|e.to_string())? {
                let file=file.map_err(|e|e.to_string())?;
                if file.path().extension().is_some_and(|x|x=="json") {
                    let id=file.path().file_stem().ok_or("invalid journal name")?.to_string_lossy().into_owned();
                    if let Some(_lease)=Lease::acquire(&id)? { clean_journal(&root, &file.path())?; } else { skipped+=1; }
                }
            }
            emit(json!({"cleanup":true,"activeSkipped":skipped})); return Ok(());
        }
        _ => {}
    }
    let mut lines = io::stdin().lock().lines();
    let line = lines.next().ok_or("missing request")?.map_err(|e|e.to_string())?;
    if line.len() > OUTPUT_LIMIT { return Err("request too large".into()); }
    let request: Request = serde_json::from_str(&line).map_err(|e|e.to_string())?;
    let stop = Arc::new(AtomicBool::new(false)); let monitor = stop.clone();
    // EOF means the controller went away. No detached work continues on its behalf.
    thread::spawn(move || { let _ = io::stdin().lock().lines().next(); monitor.store(true, Ordering::SeqCst); });
    drop(lines);
    emit(run(request, stop)?); Ok(())
}
pub fn main() { if let Err(error) = main_result() { emit(json!({"type":"error","error":error})); std::process::exit(1); } }
