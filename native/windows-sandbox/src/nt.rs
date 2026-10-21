//! Small object-manager API boundary shared by compatibility and workspace aliases.
use super::*;

#[repr(C)]
pub struct UnicodeString { length: u16, maximum_length: u16, buffer: *mut u16 }
#[repr(C)]
pub struct ObjectAttributes {
    length: u32, root: HANDLE, name: *mut UnicodeString, attributes: u32,
    descriptor: *mut c_void, qos: *mut c_void,
}
#[link(name = "ntdll")]
extern "system" {
    fn NtOpenFile(result: *mut HANDLE, access: u32, attributes: *const ObjectAttributes, status: *mut IoStatus, share: u32, options: u32) -> i32;
    fn NtOpenDirectoryObject(result: *mut HANDLE, access: u32, attributes: *const ObjectAttributes) -> i32;
    fn NtOpenSymbolicLinkObject(result: *mut HANDLE, access: u32, attributes: *const ObjectAttributes) -> i32;
    fn NtCreateSymbolicLinkObject(result: *mut HANDLE, access: u32, attributes: *const ObjectAttributes, target: *const UnicodeString) -> i32;
}
#[repr(C)]
struct IoStatus { status: usize, information: usize }

// Resolve one component against a pinned parent, never through a junction or
// symbolic link. Win32 OPEN_REPARSE_POINT alone protects only the final name.
pub fn open_child(parent: HANDLE, name: &std::ffi::OsStr, access: u32, cleanup: bool) -> Result<Handle> { unsafe {
    let mut buffer=wide(name);
    if buffer.len()>32767 {return Err("sandbox path component too long".into());}
    let mut name=string(&mut buffer);let mut attributes=attributes(parent,&mut name,null_mut());
    if !cleanup { attributes.attributes |= 0x1000; } // OBJ_DONT_REPARSE; cleanup opens the link itself only.
    let mut raw=null_mut();let mut status=IoStatus {status:0,information:0};
    let code=NtOpenFile(&mut raw,access | SYNCHRONIZE,&attributes,&mut status,
        FILE_SHARE_READ | FILE_SHARE_WRITE,0x00200000 | 0x20); // OPEN_REPARSE_POINT | SYNCHRONOUS_IO_NONALERT
    if code<0 {Err(format!("open sandbox component without reparse: NTSTATUS {code:#x}"))} else {Ok(Handle(raw))}
} }
pub fn open_path(path: &Path, access: u32) -> Result<(Handle,Vec<Handle>)> { unsafe {
    use std::path::{Component,Prefix};
    let mut components=path.components();
    let drive=match components.next() {Some(Component::Prefix(prefix))=>match prefix.kind() {
        Prefix::Disk(letter)|Prefix::VerbatimDisk(letter)=>letter,
        _=>return Err("sandbox ACL path must use a local drive".into())},_=>return Err("sandbox ACL path must be absolute".into())};
    if !matches!(components.next(),Some(Component::RootDir)) {return Err("sandbox ACL path must be absolute".into());}
    let mut parents=Vec::new();
    let mut handle=Handle::new(CreateFileW(wide(format!("{}:\\",drive as char)).as_ptr(),
        FILE_READ_ATTRIBUTES | READ_CONTROL | if path.parent().is_none(){access}else{0},FILE_SHARE_READ | FILE_SHARE_WRITE,
        null(),OPEN_EXISTING,FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,null_mut()),"open sandbox volume root")?;
    let names: Vec<_>=components.collect();
    for (index,component) in names.iter().enumerate() {
        let Component::Normal(name)=component else {return Err("sandbox ACL path must be canonical".into());};
        let next=open_child(handle.0,name,if index+1==names.len(){access}else{FILE_READ_ATTRIBUTES | READ_CONTROL},false)?;
        parents.push(handle);handle=next;
    }
    Ok((handle,parents))
} }

fn string(buffer: &mut [u16]) -> UnicodeString {
    UnicodeString { length: ((buffer.len()-1)*2) as u16, maximum_length: (buffer.len()*2) as u16, buffer: buffer.as_mut_ptr() }
}
fn attributes(root: HANDLE, name: &mut UnicodeString, descriptor: *mut c_void) -> ObjectAttributes {
    // No OBJ_PERMANENT / OBJ_OPENIF: closing the last handle removes our link;
    // an existing object is never opened or replaced by the creation call.
    ObjectAttributes { length: size_of::<ObjectAttributes>() as u32, root, name,
        attributes: 0x40, descriptor, qos: null_mut() }
}
pub fn open(name: &str, access: u32, directory: bool) -> std::result::Result<Handle,i32> { unsafe {
    let mut buffer=wide(name); let mut name=string(&mut buffer);
    let attributes=attributes(null_mut(),&mut name,null_mut()); let mut raw=null_mut();
    let status=if directory {NtOpenDirectoryObject(&mut raw,access,&attributes)} else {NtOpenSymbolicLinkObject(&mut raw,access,&attributes)};
    if status<0 {Err(status)} else {Ok(Handle(raw))}
} }
pub fn missing(status: i32) -> bool { matches!(status as u32,0xc0000034 | 0xc000003a) }
pub fn create_link(root: HANDLE, name: &str, target: &str, descriptor: *mut c_void) -> std::result::Result<Handle,i32> { unsafe {
    if name.encode_utf16().count()>32766 || target.encode_utf16().count()>32766 {return Err(0xc0000106u32 as i32);}
    let mut buffer=wide(name); let mut name=string(&mut buffer);
    let attributes=attributes(root,&mut name,descriptor);
    let mut destination=wide(target); let destination=string(&mut destination); let mut raw=null_mut();
    let status=NtCreateSymbolicLinkObject(&mut raw,READ_CONTROL | 1,&attributes,&destination);
    if status<0 {Err(status)} else {Ok(Handle(raw))}
} }
