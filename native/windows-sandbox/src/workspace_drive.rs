//! A temporary DOS alias makes the workspace the root of ancestor discovery.
//! The alias is visible in this logon session, not private to a process. Its DACL
//! grants only this execution's package SID query access; file ACLs remain the boundary.
use super::*;

#[link(name="kernel32")]
extern "system" { fn QueryDosDeviceW(name: *const u16, target: *mut u16, length: u32) -> u32; }

pub struct WorkspaceDrive { pub cwd: String, _link: Handle }
impl WorkspaceDrive {
    pub fn create(workspace: HANDLE, sid: PSID) -> Result<Self> { unsafe {
        // Profile owns this pinned directory from before ACL grants to cleanup.
        let mut target=vec![0u16;32768];
        let length=GetFinalPathNameByHandleW(workspace,target.as_mut_ptr(),target.len() as u32,2); // VOLUME_NAME_NT
        if length==0 || length as usize>=target.len() {return Err(failure("resolve workspace device path"));}
        let target=String::from_utf16(&target[..length as usize]).map_err(|e|e.to_string())?;
        // OW applies only to the creating owner. No all-applications grant.
        let sddl=format!("D:(A;;GA;;;OW)(A;;0x00020001;;;{})",sid_string(sid)?);
        let mut descriptor=null_mut();
        if ConvertStringSecurityDescriptorToSecurityDescriptorW(wide(sddl).as_ptr(),1,&mut descriptor,null_mut())==0 {return Err(failure("workspace alias descriptor"));}
        let _descriptor=Local(descriptor);
        let devices=nt::open(r"\??",0x5,true).map_err(|status|format!("open logon devices: NTSTATUS {status:#x}"))?;
        // Microsoft recommends reverse allocation for local DOS drive letters.
        // Query both namespaces; atomic create then handles concurrent Tao launches.
        for letter in (b'E'..=b'Z').rev() {
            let name=format!("{}:",char::from(letter)); let mut buffer=[0u16;512];
            if QueryDosDeviceW(wide(&name).as_ptr(),buffer.as_mut_ptr(),buffer.len() as u32)!=0 {continue;}
            if GetLastError()!=ERROR_FILE_NOT_FOUND {return Err(failure("query occupied workspace drive"));}
            match nt::create_link(devices.0,&name,&target,descriptor) {
                Ok(link)=>return Ok(Self {cwd:format!("{name}\\"),_link:link}),
                Err(status) if status as u32==0xc0000035 => continue, // name collision; never replace
                Err(status)=>return Err(format!("create temporary workspace drive: NTSTATUS {status:#x}")),
            }
        }
        Err("no free temporary workspace drive (E: through Z:); no host fallback was used".into())
    } }
}
