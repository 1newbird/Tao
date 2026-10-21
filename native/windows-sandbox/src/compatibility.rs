//! Experimental, narrowly scoped host compatibility grants. No account or WFP changes.
//! Only this named capability is changed; package SIDs still isolate each execution's files.
use super::*;
#[cfg(feature="product")]
use windows_sys::Win32::System::Registry::*;

#[cfg(not(feature = "product"))]
const NAME: &str = "Tao.NativeProbe.Compatibility.v1";
#[cfg(feature = "product")]
const NAME: &str = "Tao.WindowsSandbox.Compatibility.v1";
const DIRECTORY_QUERY_TRAVERSE: u32 = 3;
const SYMBOLIC_LINK_QUERY: u32 = 1;

#[link(name = "kernel32")]
extern "system" { fn GetLogicalDrives() -> u32; }

pub struct Capability { pointers: *mut PSID, count: u32 }
impl Capability {
    pub fn derive() -> Result<Self> { unsafe {
        let mut groups = null_mut(); let mut group_count = 0;
        let mut pointers = null_mut(); let mut count = 0;
        if DeriveCapabilitySidsFromName(wide(NAME).as_ptr(), &mut groups, &mut group_count, &mut pointers, &mut count) == 0 {
            return Err(failure("derive compatibility capability"));
        }
        for i in 0..group_count as usize { LocalFree(*groups.add(i)); }
        LocalFree(groups.cast());
        let result = Self { pointers, count };
        if count != 1 { return Err("unexpected compatibility capability SID count".into()); }
        Ok(result)
    } }
    pub fn sid(&self) -> PSID { unsafe { *self.pointers } }
}
impl Drop for Capability { fn drop(&mut self) { unsafe {
    for i in 0..self.count as usize { LocalFree(*self.pointers.add(i)); }
    LocalFree(self.pointers.cast());
} } }

#[derive(Clone)]
struct Target { name: String, kind: &'static str, rights: u32 }
fn targets() -> Result<Vec<Target>> {
    let mut result = vec![Target { name: r"\GLOBAL??".into(), kind: "directory", rights: READ_CONTROL | DIRECTORY_QUERY_TRAVERSE }];
    let drives = unsafe { GetLogicalDrives() };
    if drives == 0 { return Err(failure("enumerate logical drives")); }
    for drive in 0..26 { if drives & (1 << drive) != 0 {
        // Session aliases / mapped network drives are not global devices and
        // must not turn a ready backend into an administrator setup request.
        let name=format!(r"\GLOBAL??\{}:",char::from(b'A'+drive));
        match nt::open(&name,READ_CONTROL | SYMBOLIC_LINK_QUERY,false) {
            Ok(_)=>{},Err(status) if nt::missing(status)=>continue,
            Err(status)=>return Err(format!("query global drive: NTSTATUS {status:#x}")),
        }
        result.push(Target { name: format!(r"\GLOBAL??\{}:", char::from(b'A' + drive)), kind: "link", rights: READ_CONTROL | SYMBOLIC_LINK_QUERY });
        result.push(Target { name: format!("{}:\\",char::from(b'A'+drive)), kind: "root-metadata", rights: FILE_READ_ATTRIBUTES | FILE_READ_EA | READ_CONTROL | SYNCHRONIZE });
    } }
    result.push(Target { name: r"\GLOBAL??\MountPointManager".into(), kind: "link", rights: READ_CONTROL | SYMBOLIC_LINK_QUERY });
    result.push(Target { name: r"\\.\MountPointManager".into(), kind: "device", rights: FILE_GENERIC_READ });
    result.push(Target { name: r"\\.\NUL".into(), kind: "device", rights: FILE_GENERIC_READ | FILE_GENERIC_WRITE });
    let args: Vec<_> = std::env::args_os().collect();
    if let Some(index)=args.iter().position(|arg|arg=="--metadata-path") {
        let original=PathBuf::from(args.get(index+1).ok_or("missing metadata directory")?);
        no_reparse_ancestors(&original)?;
        let path=fs::canonicalize(original).map_err(|e|e.to_string())?;
        let text=path.to_string_lossy();
        if text.starts_with(r"\\?\UNC\") || !text.as_bytes().get(4).is_some_and(|value|value.is_ascii_alphabetic()) {
            return Err("compatibility metadata must use a local drive path".into());
        }
        for parent in path.ancestors().filter(|parent|parent.parent().is_some()) {
            result.push(Target {name:parent.to_string_lossy().into_owned(),kind:"root-metadata",rights:FILE_READ_ATTRIBUTES | FILE_READ_EA | READ_CONTROL | SYNCHRONIZE});
        }
    }
    #[cfg(feature="product")]
    for path in registered_metadata()? {
        if Path::new(&path).exists() { result.push(Target {name:path,kind:"root-metadata",rights:FILE_READ_ATTRIBUTES | FILE_READ_EA | READ_CONTROL | SYNCHRONIZE}); }
    }
    let mut seen=std::collections::BTreeSet::new();
    result.retain(|target|seen.insert(target.name.to_ascii_lowercase()));
    Ok(result)
}

#[cfg(feature="product")]
const REGISTRY_PATH: &str = r"SOFTWARE\Tao\WindowsSandbox\CompatibilityV1";
#[cfg(feature="product")]
fn registered_metadata() -> Result<Vec<String>> { unsafe {
    let mut size=0;
    let status=RegGetValueW(HKEY_LOCAL_MACHINE,wide(REGISTRY_PATH).as_ptr(),wide("MetadataPaths").as_ptr(),RRF_RT_REG_MULTI_SZ,null_mut(),null_mut(),&mut size);
    if status==ERROR_FILE_NOT_FOUND || status==ERROR_PATH_NOT_FOUND { return Ok(Vec::new()); }
    if status!=0 || size>1024*1024 { return Err(format!("read initialization registry: Windows {status}")); }
    let mut value=vec![0u16;(size as usize).div_ceil(2)];
    let status=RegGetValueW(HKEY_LOCAL_MACHINE,wide(REGISTRY_PATH).as_ptr(),wide("MetadataPaths").as_ptr(),RRF_RT_REG_MULTI_SZ,null_mut(),value.as_mut_ptr().cast(),&mut size);
    if status!=0 { return Err(format!("read initialization registry: Windows {status}")); }
    Ok(value.split(|c|*c==0).filter(|item|!item.is_empty()).map(String::from_utf16_lossy).collect())
} }
#[cfg(feature="product")]
fn save_metadata(paths: &[String]) -> Result<()> { unsafe {
    let mut key=null_mut();
    let status=RegCreateKeyExW(HKEY_LOCAL_MACHINE,wide(REGISTRY_PATH).as_ptr(),0,null(),0,KEY_SET_VALUE,null(),&mut key,null_mut());
    if status!=0 { return Err(format!("open initialization registry: Windows {status}")); }
    let mut value: Vec<u16>=paths.iter().flat_map(wide).collect(); value.push(0); if paths.is_empty() {value.push(0);}
    let status=RegSetValueExW(key,wide("MetadataPaths").as_ptr(),0,REG_MULTI_SZ,value.as_ptr().cast(),(value.len()*2) as u32);
    let flush=RegFlushKey(key); RegCloseKey(key);
    if status!=0 || flush!=0 { return Err(format!("save initialization registry: Windows {status}/{flush}")); }
    Ok(())
} }

pub fn has_metadata_access(path: &Path) -> Result<bool> {
    let capability=Capability::derive()?;
    let handle=Target {name:path.to_string_lossy().into_owned(),kind:"root-metadata",rights:0}.open(false)?;
    contains(dacl(&descriptor(handle.0)?)?,capability.sid(),FILE_READ_ATTRIBUTES | FILE_READ_EA | READ_CONTROL | SYNCHRONIZE)
}
impl Target {
    fn open(&self, modify: bool) -> Result<Handle> { unsafe {
        let access = READ_CONTROL | if modify { WRITE_DAC } else { 0 };
        if self.kind == "root-metadata" {
            return nt::open_path(Path::new(&self.name),access | FILE_READ_ATTRIBUTES).map(|(handle,_)|handle);
        }
        if self.kind == "device" {
            return Handle::new(CreateFileW(wide(&self.name).as_ptr(), access, FILE_SHARE_READ | FILE_SHARE_WRITE,
                null(), OPEN_EXISTING, if self.kind=="root-metadata" {FILE_FLAG_BACKUP_SEMANTICS} else {FILE_ATTRIBUTE_NORMAL}, null_mut()), &format!("open {}",self.name));
        }
        nt::open(&self.name,access,self.kind=="directory").map_err(|status|format!("open {}: NTSTATUS {status:#x}",self.name))
    } }
}

// Shared file handles survive concurrency and are released by the kernel after
// a crash. Setup/removal acquires an exclusive handle before changing grants.
fn usage_path() -> Result<PathBuf> { unsafe {
    use windows_sys::Win32::UI::Shell::{SHGetKnownFolderPath,FOLDERID_ProgramData};
    let mut pointer=null_mut();
    if SHGetKnownFolderPath(&FOLDERID_ProgramData,0,null_mut(),&mut pointer)<0 {return Err("find protected sandbox lease directory".into());}
    let mut length=0;while *pointer.add(length)!=0 {length+=1;}
    let directory=PathBuf::from(String::from_utf16_lossy(std::slice::from_raw_parts(pointer,length)));
    windows_sys::Win32::System::Com::CoTaskMemFree(pointer.cast());
    Ok(directory.join(format!("{NAME}.lock")))
} }
fn usage_lease(exclusive: bool, create: bool) -> Result<Handle> { unsafe {
    let path=usage_path()?;
    let mut descriptor=null_mut();
    if ConvertStringSecurityDescriptorToSecurityDescriptorW(wide("O:BAG:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;GR;;;AU)").as_ptr(),1,&mut descriptor,null_mut())==0 {return Err(failure("prepare sandbox lease ACL"));}
    let _descriptor=Local(descriptor);
    let attributes=SECURITY_ATTRIBUTES {nLength:size_of::<SECURITY_ATTRIBUTES>() as u32,lpSecurityDescriptor:descriptor,bInheritHandle:0};
    // Metadata-only handles do not participate in the filesystem's shared-read
    // accounting. Request actual data read access to enforce the exclusion.
    let access=GENERIC_READ | if exclusive {DELETE}else{0};
    let handle=Handle::new(CreateFileW(wide(&path).as_ptr(),access,if exclusive {0}else{FILE_SHARE_READ},
        &attributes,if create {OPEN_ALWAYS}else{OPEN_EXISTING},FILE_FLAG_OPEN_REPARSE_POINT,null_mut()),
        "sandbox initialization lease unavailable (initialization required, or native tools are active)")?;
    let mut info: BY_HANDLE_FILE_INFORMATION=zeroed();
    if GetFileInformationByHandle(handle.0,&mut info)==0 || info.dwFileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY)!=0 || info.nNumberOfLinks!=1 {
        return Err("invalid sandbox initialization lease file".into());
    }
    let mut owner=null_mut();let mut sd=null_mut();
    let status=GetSecurityInfo(handle.0,SE_FILE_OBJECT,OWNER_SECURITY_INFORMATION,&mut owner,null_mut(),null_mut(),null_mut(),&mut sd);
    let _sd=Local(sd);
    if status!=0 || (IsWellKnownSid(owner,WinBuiltinAdministratorsSid)==0 && IsWellKnownSid(owner,WinLocalSystemSid)==0) {
        return Err("sandbox initialization lease must be owned by Administrators or SYSTEM".into());
    }
    Ok(handle)
} }
pub fn execution_lease() -> Result<Handle> { usage_lease(false,false) }

fn descriptor(handle: HANDLE) -> Result<Vec<usize>> { unsafe {
    let mut required = 0;
    GetKernelObjectSecurity(handle, DACL_SECURITY_INFORMATION, null_mut(), 0, &mut required);
    if required == 0 || required > 1024*1024 { return Err(failure("size compatibility descriptor")); }
    let mut result = vec![0usize; (required as usize).div_ceil(size_of::<usize>())];
    if GetKernelObjectSecurity(handle, DACL_SECURITY_INFORMATION, result.as_mut_ptr().cast(), required, &mut required) == 0 {
        return Err(failure("read compatibility descriptor"));
    }
    Ok(result)
} }
fn dacl(descriptor: &[usize]) -> Result<*mut ACL> { unsafe {
    let mut present = 0; let mut defaulted = 0; let mut acl = null_mut();
    if GetSecurityDescriptorDacl(descriptor.as_ptr().cast_mut().cast(), &mut present, &mut acl, &mut defaulted) == 0 {
        return Err(failure("read compatibility DACL"));
    }
    if present == 0 || acl.is_null() { return Err("refuse to change a missing/null compatibility DACL".into()); }
    Ok(acl)
} }
fn contains(acl: *mut ACL, sid: PSID, expected: u32) -> Result<bool> { unsafe {
    let mut found = false;
    for index in 0..(*acl).AceCount as u32 {
        let mut raw = null_mut();
        if GetAce(acl, index, &mut raw) == 0 { return Err(failure("read compatibility ACE")); }
        let header = &*(raw as *const ACE_HEADER);
        if header.AceType != 0 { continue; } // ACCESS_ALLOWED_ACE_TYPE (winnt.h)
        let ace = &*(raw as *const ACCESS_ALLOWED_ACE);
        if EqualSid((&ace.SidStart as *const u32).cast_mut().cast(), sid) != 0 {
            if found || ace.Mask != expected || header.AceFlags != 0 { return Err("owned compatibility SID has an unexpected ACL entry; manual inspection required".into()); }
            found = true;
        }
    }
    Ok(found)
} }
fn update(target: &Target, capability: &Capability, remove: bool) -> Result<bool> { unsafe {
    let _lock = AclLock::acquire()?;
    let handle = target.open(true)?;
    let current = descriptor(handle.0)?; let old_acl = dacl(&current)?;
    let present = contains(old_acl, capability.sid(), target.rights)?;
    if present != remove { return Ok(false); }
    let entry = EXPLICIT_ACCESS_W { grfAccessPermissions: target.rights,
        grfAccessMode: if remove { REVOKE_ACCESS } else { GRANT_ACCESS }, grfInheritance: 0,
        Trustee: TRUSTEE_W { pMultipleTrustee: null_mut(), MultipleTrusteeOperation: NO_MULTIPLE_TRUSTEE,
            TrusteeForm: TRUSTEE_IS_SID, TrusteeType: TRUSTEE_IS_UNKNOWN, ptstrName: capability.sid().cast() } };
    let mut new_acl = null_mut();
    let status = SetEntriesInAclW(1, &entry, old_acl, &mut new_acl);
    if status != 0 { return Err(format!("merge compatibility ACL: Windows {status}")); }
    let _allocation = Local(new_acl.cast());
    let mut replacement: SECURITY_DESCRIPTOR = zeroed();
    if InitializeSecurityDescriptor((&mut replacement as *mut SECURITY_DESCRIPTOR).cast(), 1) == 0 // SECURITY_DESCRIPTOR_REVISION
        || SetSecurityDescriptorDacl((&mut replacement as *mut SECURITY_DESCRIPTOR).cast(), 1, new_acl, 0) == 0 {
        return Err(failure("prepare compatibility descriptor"));
    }
    preserve_dacl_control(current.as_ptr().cast_mut().cast(),(&mut replacement as *mut SECURITY_DESCRIPTOR).cast())?;
    if SetKernelObjectSecurity(handle.0, DACL_SECURITY_INFORMATION, (&mut replacement as *mut SECURITY_DESCRIPTOR).cast()) == 0 {
        return Err(failure(&format!("write compatibility ACL {}",target.name)));
    }
    let after = descriptor(handle.0)?;
    if contains(dacl(&after)?,capability.sid(),target.rights)? == remove { return Err("compatibility ACL verification failed".into()); }
    Ok(true)
} }
fn elevated() -> Result<bool> { unsafe {
    let mut raw = null_mut();
    if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut raw) == 0 { return Err(failure("open setup token")); }
    let token = Handle(raw); let mut flag: TOKEN_ELEVATION = zeroed(); let mut size = 0;
    if GetTokenInformation(token.0, TokenElevation, (&mut flag as *mut TOKEN_ELEVATION).cast(), size_of::<TOKEN_ELEVATION>() as u32, &mut size) == 0 {
        return Err(failure("inspect setup token"));
    }
    Ok(flag.TokenIsElevated != 0)
} }
pub fn command(operation: &str) -> Result<()> {
    if operation=="--compat-cleanup" && std::env::args().any(|arg|arg=="--if-initialized") && !usage_path()?.exists() {
        #[cfg(feature="product")]
        if registered_metadata()?.is_empty() {emit(json!({"cleanup":true,"initialized":false,"changed":[]}));return Ok(());}
    }
    let capability = Capability::derive()?;
    let targets = targets()?;
    if operation == "--compat-status" {
        let rows: Vec<_> = targets.iter().map(|target| {
            let result = target.open(false).and_then(|handle| descriptor(handle.0)).and_then(|sd| contains(dacl(&sd)?,capability.sid(),target.rights));
            match result { Ok(ready) => json!({"object":target.name,"ready":ready,"rights":target.rights}),
                Err(error) => json!({"object":target.name,"ready":false,"error":error}) }
        }).collect();
        let lease=execution_lease();
        emit(json!({"compatibility":"experimental","capability":NAME,"sid":sid_string(capability.sid())?,
            "ready":lease.is_ok() && rows.iter().all(|row|row["ready"]==true),"leaseError":lease.err(),"objects":rows}));
        return Ok(());
    }
    if !elevated()? { return Err("compatibility initialization requires an administrator UAC token; no system objects were changed".into()); }
    let remove = operation == "--compat-cleanup";
    if !remove && operation != "--compat-prepare" { return Err("unknown compatibility command".into()); }
    let usage=usage_lease(true,true)?;
    let _setup_lock=AclLock::acquire()?;
    #[cfg(feature="product")]
    if !remove { save_metadata(&targets.iter().filter(|target|target.kind=="root-metadata").map(|target|target.name.clone()).collect::<Vec<_>>())?; }
    let mut changed = Vec::new();
    for target in &targets {
        match update(target,&capability,remove) {
            Ok(true) => changed.push(target.clone()), Ok(false) => {}, Err(error) => {
                if !remove {
                    let mut rollback_errors = Vec::new();
                    for previous in changed.iter().rev() { if let Err(issue)=update(previous,&capability,true) { rollback_errors.push(issue); } }
                    return Err(format!("{error}; rollback errors: {rollback_errors:?}"));
                }
                return Err(format!("{error}; cleanup remains retryable"));
            }
        }
    }
    #[cfg(feature="product")]
    if remove {
        // Missing removable volumes cannot be cleaned now; retain their journal.
        let deferred: Vec<_>=registered_metadata()?.into_iter().filter(|path|!Path::new(path).components().take(2).collect::<PathBuf>().exists()).collect();
        save_metadata(&deferred)?;
        if !deferred.is_empty() {return Err(format!("reconnect missing metadata paths and retry removal: {deferred:?}"));}
    }
    if remove { unsafe {
        let disposition=FILE_DISPOSITION_INFO {DeleteFile:true};
        if SetFileInformationByHandle(usage.0,FileDispositionInfo,(&disposition as *const FILE_DISPOSITION_INFO).cast(),size_of::<FILE_DISPOSITION_INFO>() as u32)==0 {return Err(failure("remove sandbox initialization lease"));}
    } }
    emit(json!({"compatibility":"experimental","operation":operation,"capability":NAME,"sid":sid_string(capability.sid())?,
        "changed":changed.iter().map(|target|&target.name).collect::<Vec<_>>(),"allApplicationPackagesModified":false,
        "filesystemRootMetadataOnly":true,"rootListingOrWriteGranted":false,"networkRulesModified":false}));
    Ok(())
}

#[cfg(feature = "product")]
pub fn ensure_ready() -> Result<()> {
    let capability = Capability::derive()?;
    for target in targets()? {
        let handle = target.open(false)?;
        if !contains(dacl(&descriptor(handle.0)?)?,capability.sid(),target.rights)? {
            return Err(format!("Windows native sandbox requires compatibility initialization ({})",target.name));
        }
    }
    Ok(())
}
