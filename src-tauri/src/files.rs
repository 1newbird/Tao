use crate::models::{FileChange, WorkspaceEntry, WorkspaceFile, WorkspaceListing};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use tauri::{AppHandle, Manager};

const MAX_DIRECTORY_ENTRIES: usize = 600;
const MAX_PREVIEW_BYTES: u64 = 2 * 1024 * 1024;
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

pub fn list_workspace(
    app: &AppHandle,
    workspace_path: &str,
    relative_path: &str,
) -> Result<WorkspaceListing, String> {
    let root = workspace_root(app, workspace_path)?;
    let directory = resolve_existing_path(&root, relative_path)?;
    if !directory.is_dir() {
        return Err("只能列出目录".to_string());
    }

    let mut entries = Vec::new();
    for entry in fs::read_dir(&directory).map_err(|error| format!("无法读取目录：{error}"))? {
        let entry = entry.map_err(|error| format!("无法读取目录项：{error}"))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name == ".git" {
            continue;
        }
        let file_type = entry
            .file_type()
            .map_err(|error| format!("无法读取文件类型：{error}"))?;
        let kind = if file_type.is_dir() {
            "directory"
        } else if file_type.is_file() {
            "file"
        } else {
            continue;
        };
        let canonical = entry
            .path()
            .canonicalize()
            .map_err(|error| format!("无法解析路径：{error}"))?;
        if !canonical.starts_with(&root) {
            continue;
        }
        let metadata = entry
            .metadata()
            .map_err(|error| format!("无法读取文件信息：{error}"))?;
        entries.push(WorkspaceEntry {
            name,
            relative_path: relative_to_root(&root, &canonical)?,
            kind: kind.to_string(),
            size: if kind == "file" { Some(metadata.len()) } else { None },
        });
        if entries.len() >= MAX_DIRECTORY_ENTRIES {
            break;
        }
    }

    entries.sort_by(|left, right| {
        let left_rank = if left.kind == "directory" { 0 } else { 1 };
        let right_rank = if right.kind == "directory" { 0 } else { 1 };
        left_rank
            .cmp(&right_rank)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });

    let (is_git_repo, changes) = git_changes(&root);
    Ok(WorkspaceListing {
        root_path: root.to_string_lossy().into_owned(),
        relative_path: relative_to_root(&root, &directory)?,
        entries,
        changes,
        is_git_repo,
    })
}

pub fn read_workspace_file(
    app: &AppHandle,
    workspace_path: &str,
    relative_path: &str,
) -> Result<WorkspaceFile, String> {
    let root = workspace_root(app, workspace_path)?;
    let file = resolve_existing_path(&root, relative_path)?;
    if !file.is_file() {
        return Err("只能预览文件".to_string());
    }
    if !is_markdown_file(&file) {
        return Err("当前阶段只支持 Markdown 和 MDX 文件预览".to_string());
    }
    let metadata = fs::metadata(&file).map_err(|error| format!("无法读取文件信息：{error}"))?;
    if metadata.len() > MAX_PREVIEW_BYTES {
        return Err("文件过大，当前预览限制为 2 MB".to_string());
    }
    let content = fs::read_to_string(&file).map_err(|error| format!("无法读取文件：{error}"))?;
    Ok(WorkspaceFile {
        path: relative_to_root(&root, &file)?,
        content,
        language: file
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| if value.eq_ignore_ascii_case("mdx") { "mdx" } else { "markdown" })
            .unwrap_or("markdown")
            .to_string(),
        size: metadata.len(),
    })
}

pub fn read_workspace_diff(
    app: &AppHandle,
    workspace_path: &str,
    relative_path: &str,
) -> Result<WorkspaceFile, String> {
    let root = workspace_root(app, workspace_path)?;
    let safe_path = clean_relative_path(relative_path)?;
    let path_text = relative_path_string(&safe_path);
    if path_text.is_empty() {
        return Err("请选择要查看 Diff 的文件".to_string());
    }
    if !is_git_repository(&root) {
        return Err("当前工作区不是 Git 仓库，暂无 Diff".to_string());
    }

    let unstaged = run_git(&root, &["diff", "--no-color", "--", &path_text])?;
    let staged = run_git(&root, &["diff", "--cached", "--no-color", "--", &path_text])?;
    let content = match (staged.trim().is_empty(), unstaged.trim().is_empty()) {
        (true, true) => "当前文件暂无 Git Diff。未跟踪文件可以直接打开 Markdown 预览。".to_string(),
        (false, true) => staged,
        (true, false) => unstaged,
        (false, false) => format!("{staged}\n{unstaged}"),
    };

    Ok(WorkspaceFile {
        path: path_text,
        size: content.len() as u64,
        language: "diff".to_string(),
        content,
    })
}

fn workspace_root(app: &AppHandle, workspace_path: &str) -> Result<PathBuf, String> {
    let configured = workspace_path.trim();
    let root = if configured.is_empty() {
        if cfg!(debug_assertions) {
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..")
        } else {
            app.path()
                .home_dir()
                .map_err(|error| format!("无法定位默认工作区：{error}"))?
        }
    } else {
        PathBuf::from(configured)
    };
    if !root.is_dir() {
        return Err(format!("工作区目录不存在：{}", root.display()));
    }
    root.canonicalize()
        .map_err(|error| format!("无法解析工作区目录：{error}"))
}

fn resolve_existing_path(root: &Path, relative_path: &str) -> Result<PathBuf, String> {
    let relative = clean_relative_path(relative_path)?;
    let target = root.join(relative);
    let canonical = target
        .canonicalize()
        .map_err(|error| format!("无法解析路径：{error}"))?;
    if !canonical.starts_with(root) {
        return Err("只能访问当前工作区内的文件".to_string());
    }
    Ok(canonical)
}

fn clean_relative_path(value: &str) -> Result<PathBuf, String> {
    let normalized = value.trim().replace('\\', "/");
    if normalized.is_empty() {
        return Ok(PathBuf::new());
    }
    let candidate = PathBuf::from(&normalized);
    if candidate.is_absolute() {
        return Err("只能使用工作区内的相对路径".to_string());
    }
    let mut result = PathBuf::new();
    for component in candidate.components() {
        match component {
            Component::Normal(value) => result.push(value),
            Component::CurDir => {}
            _ => return Err("路径不能跳出当前工作区".to_string()),
        }
    }
    Ok(result)
}

fn relative_to_root(root: &Path, path: &Path) -> Result<String, String> {
    let relative = path
        .strip_prefix(root)
        .map_err(|_| "路径不在当前工作区内".to_string())?;
    Ok(relative_path_string(relative))
}

fn relative_path_string(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn is_markdown_file(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|value| value.to_str()).map(str::to_ascii_lowercase).as_deref(),
        Some("md" | "markdown" | "mdx")
    )
}

fn git_changes(root: &Path) -> (bool, Vec<FileChange>) {
    if !is_git_repository(root) {
        return (false, Vec::new());
    }
    let Ok(output) = run_git(root, &["status", "--short", "--untracked-files=all"]) else {
        return (true, Vec::new());
    };
    let changes = output
        .lines()
        .filter_map(parse_git_status_line)
        .take(300)
        .collect();
    (true, changes)
}

fn is_git_repository(root: &Path) -> bool {
    git_command(root)
        .args(["rev-parse", "--is-inside-work-tree"])
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

fn run_git(root: &Path, args: &[&str]) -> Result<String, String> {
    let output = git_command(root)
        .args(args)
        .output()
        .map_err(|error| format!("无法执行 Git：{error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() { "Git 命令执行失败".to_string() } else { stderr });
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn git_command(root: &Path) -> Command {
    let mut command = Command::new("git");
    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW);
    command.arg("-C").arg(root);
    command
}

fn parse_git_status_line(line: &str) -> Option<FileChange> {
    if line.len() < 4 {
        return None;
    }
    let state = &line[..2];
    let raw_path = line[3..].trim();
    let path = raw_path
        .rsplit_once(" -> ")
        .map(|(_, next)| next)
        .unwrap_or(raw_path)
        .trim_matches('"')
        .replace('\\', "/");
    if path.is_empty() {
        return None;
    }
    let status = if state == "??" {
        "untracked"
    } else if state.contains('D') {
        "deleted"
    } else if state.contains('A') {
        "added"
    } else if state.contains('R') {
        "renamed"
    } else {
        "modified"
    };
    Some(FileChange {
        path,
        status: status.to_string(),
    })
}
