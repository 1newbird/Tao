# Tao

Tao 是一个面向 Windows 10/11 x64 的桌面智能体工作台，使用 Tauri 作为桌面壳，内置 Tao Runtime 和 Tao 智能体内核。

```text
Tao = Tauri 桌面产品 + Tao Runtime 装配层 + Tao 智能体内核
```

## 重要说明

- Tao 内核基于 Pi 的固定源码快照，保留在 `vendor/pi`，不是 Git submodule；原始来源和许可证保留。
- 本仓库不跟踪 Pi 上游最新代码。
- 后续如果修改 Pi 代码，直接在本仓库提交，把它视为 Tao 自己的源码。
- 使用者不需要另外安装、下载或更新 Pi。

## 环境要求

完整的环境安装与验证步骤见：

- [docs/项目手册/03a-从零开始配置开发环境.md](docs/项目手册/03a-从零开始配置开发环境.md)

核心要求：

- Windows x64
- Node.js 22.19.0 或更高版本和 npm（脚本在缺失时安装 Node 22.19.0）
- Rust stable，默认工具链为 `x86_64-pc-windows-msvc`
- Visual Studio C++ Build Tools（2022 或兼容的较新版本）及 Windows SDK
- Windows WebView2 Runtime
- PowerShell

## 快速开始

克隆项目后，推荐在 PowerShell 中从仓库根目录执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup-dev.ps1
npm.cmd run tauri dev
```

`setup-dev.ps1` 检查并补齐开发环境，优先把新安装的便携 Node、Rust 工具链和 npm 缓存放到 `D:\TaoDev`；已有合格组件直接复用。脚本完成后运行 TypeScript、Rust 和 Pi 工作区验证。`npm.cmd run tauri dev` 会读取脚本保存的工具路径，因此不要求全局修改 PATH；也可以运行 `powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\tao.ps1 dev`。无 D 盘时使用 `%LOCALAPPDATA%\TaoDev`；可通过 `-ToolsRoot` 指定其他位置。仅检查、不安装可加 `-CheckOnly`。

手动安装 Node、Rust 和项目依赖的分步说明见环境手册。注意 Pi 源码快照不跟踪生成的模型目录数据；一键脚本会从相同版本的 Pi npm 发布包取得固定数据，并校验其结构。

脚本还支持 `tao.ps1 check` 和 `tao.ps1 release`。首次安装 C++ Build Tools 可能要求管理员授权或重启；重启后重新运行准备脚本即可。完整说明见[从零开始配置开发环境](docs/项目手册/03a-从零开始配置开发环境.md)。

`npm.cmd run check` 会执行：

```text
tsc --noEmit
cargo check --manifest-path src-tauri/Cargo.toml
```

`npm.cmd run tauri dev` 会先启动 Vite 前端，再编译并启动 Rust 桌面应用。

## 智能体定制

在“定制”页新建或复制组合，设置系统提示词、工具选择、Skill 开关和工具权限后保存。工具定义放在共享工具库中，组合保存工具引用；可导出组合 JSON，再在另一台电脑导入。

对话顶部可以选择当前会话的组合，也可以将其设为项目默认。已有会话固定使用保存的配置快照；编辑组合后，需要在该会话点击“应用新版”才会更新。切换组合会保留已有上下文，需要独立上下文时新建测试会话。

自定义工具支持程序与独立参数、Shell 和 HTTP。程序参数支持 `{{字段名}}`，`{{input}}` 表示完整输入 JSON；HTTP 请求头支持 `{{env:变量名}}` 凭据引用。工具可设为询问、允许或禁止，内置文件工具可限制到工作区。这些权限规则尚未提供操作系统沙盒隔离。

组合和工具库存放于 `%USERPROFILE%\.tao\agents\catalog.json`，旧 `runtime/profile.json` 在首次使用时自动迁移并保留原文件。详细操作见[智能体组合与工具使用](docs/项目手册/10-智能体组合与工具使用.md)。

## 常用命令

| 命令 | 作用 |
|---|---|
| `npm.cmd run dev` | 只启动 Vite 前端 |
| `npm.cmd run preview:ui` | 使用内存模拟数据预览实际 UI，不连接模型或读写真实用户数据 |
| `npm.cmd run check` | TypeScript 类型检查和 Rust `cargo check` |
| `npm.cmd run test:agents` | 组合迁移、版本隔离、权限、工具执行与取消回归；模型服务使用本地模拟 |
| `npm.cmd run build` | 构建前端 |
| `npm.cmd run tauri dev` | 启动完整 Tauri 开发模式 |
| `npm.cmd run tao:prepare` | 生成发布资源，不打安装包 |
| `npm.cmd run tao:verify` | 用内置 Node 验证发布 Runtime 的 `ready` 和请求响应 |
| `npm.cmd run tao:release` | 生成 Windows x64 MSI |
| `npm.cmd run tao:release:nsis` | 单独尝试生成 NSIS 安装包 |

## 项目结构

```text
src/                         React + TypeScript 前端
src-tauri/src/               Rust/Tauri 后端命令
src-tauri/runtime/           Tao Runtime 源码
src-tauri/resources/         发布准备资源，构建时生成，不提交
scripts/                     发布与验证脚本
docs/                        设计文档和项目手册
vendor/pi/                   Pi 固定源码快照
```

## 用户数据

用户的配置、认证和会话数据位于：

```text
%USERPROFILE%\.tao
```

该目录不属于项目源码，不应提交到 Git，也不应随 MSI 公开分发。

## 发布

当前仅正式支持 Windows x64：

```powershell
npm.cmd run tao:release
```

生成结果位于：

```text
src-tauri/target/x86_64-pc-windows-msvc/release/bundle/
```

发布命令会自动准备并校验内置 Node、Pi 和 Runtime，检查 MSI 文件表，并把安装包路径、大小与 SHA-256 写入 `.tao-release-cache/release-report.json`。完整步骤见[Windows x64 打包发布手册](docs/项目手册/04-Windows-x64-打包发布.md)。

## 文档

- [项目现状态与功能清单](docs/项目手册/01-项目现状与功能清单.md)
- [架构与顶层约束](docs/项目手册/02-架构与顶层约束.md)
- [从零开始配置开发环境](docs/项目手册/03a-从零开始配置开发环境.md)
- [Pi 代码快照与修改规范](docs/项目手册/09-Pi代码快照与修改规范.md)
- [GitHub 上传与发布检查清单](docs/GitHub上传与发布检查清单.md)

## 许可证

Tao 自身代码的许可证尚未确定。`vendor/pi` 内的原始代码保留其自带许可证。

## 国内网络说明

仓库默认不提交 `.cargo/config.toml`。如果你在国内网络环境下需要加速 Cargo，可以在项目根目录本地创建 `.cargo/config.toml`，配置自己的镜像源；该目录已被 `.gitignore` 忽略。
