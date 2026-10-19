# Tao Windows x64 打包发布

## 1. 当前支持的发布格式

当前正式支持：

- Windows x64 MSI 安装包。

当前可以尝试但不作为默认发布格式：

- Windows x64 NSIS 安装包。

当前不提供：

- 便携版 ZIP；
- 单文件绿色版；
- macOS 安装包；
- Linux 安装包；
- ARM64 安装包。

不能把 Release 目录中的裸 `tao.exe` 当成正式发布物。Tao 运行需要安装包中的前端和内置运行资源，正式分发应使用 MSI。

## 2. 发布前置条件

打包脚本当前只接受 Windows x64。首次在新电脑打包时，先按[开发环境手册](./03a-从零开始配置开发环境.md)运行 `scripts\setup-dev.ps1`，然后确认仓库包含：

- Windows x64；
- Node.js/npm；
- Rust stable 和 MSVC 工具链；
- Visual Studio/Build Tools；
- Tao 根目录依赖；
- `vendor/pi` 源码和 `vendor/pi/node_modules`；
- 首次准备时可以访问 Node.js 和 NuGet 下载地址的网络。

模型服务的网络不是打包时必须的，但安装后使用模型需要能够访问对应网关或 API。

## 3. 一键生成 MSI

在 Tao 根目录执行：

```powershell
cd <Tao 项目根目录>
npm.cmd run tao:release
```

也可以在发布时传入版本号。推荐使用 npm 的参数分隔符 `--`：

```powershell
npm.cmd run tao:release -- 2.1
```

脚本会把 `2.1` 规范化为 `2.1.0`，同步更新 Tao、Tauri、Rust 包以及对应锁文件的版本，然后继续执行发布流程。也支持：

```powershell
npm.cmd run tao:release -- --version 2.1.0
npm.cmd run tao:release:nsis -- 2.1
```

不传版本号时，使用项目当前版本。版本参数一旦写入源码文件，就会保留到下一次修改；它不是只修改 MSI 文件名。

该命令依次执行：

1. 下载或复用 WiX 3.14.1 官方 NuGet 包，校验 SHA-512，放入项目的 `src-tauri/target/.tauri/` 缓存；
2. 下载或复用 Node.js 22.19.0 Windows x64 压缩包，首次下载时校验官方 SHA-256；
3. 从空的 `src-tauri/resources` 重新准备 Tao Runtime、Pi 源码、模型数据、运行依赖和 Node；
4. 使用内置 Node 分别按普通 Windows 路径和 `\\?\` 扩展路径启动发布资源，等待 Runtime 真正输出 `ready` 并确认 `ping` 响应；
5. 构建前端和 Rust x86_64 Release；
6. 生成 MSI，并检查 MSI 文件表中 Node、Runtime、Pi 入口、tsx loader 和模型数据；
7. 输出安装包大小、SHA-256 和 `.tao-release-cache/release-report.json`。

Tauri 的 `beforeBuildCommand` 也执行第 3、4 步。因此直接执行 `npm.cmd run tauri build` 时，不会静默生成缺少 Runtime 资源的安装包。

## 4. 分步命令

只准备发布资源，不生成安装包：

```powershell
npm.cmd run tao:prepare
```

只验证已准备的资源是否能够进入 `ready`：

```powershell
npm.cmd run tao:verify
```

若打包电脑上已有安装目录，也可以从仓库根目录直接验证该目录内的资源。脚本使用独立的临时 Tao 数据目录，不修改现有会话：

```powershell
node scripts/verify-tauri-release.mjs --resource-root 'D:\software_setup\tao'
```

对已提取的 MSI 资源进一步跑完整 SDK/工具/协作模拟链路（使用包内 Node，隔离测试数据与本机模拟网关，不调用真实模型）：

```powershell
& '<提取目录>\PFiles\Tao\node\node.exe' scripts/verify-runtime-tool-flow.mjs --resource-root '<提取目录>\PFiles\Tao'
```

该回归覆盖实际打包的依赖与运行文件；不代替 WebView2、原生窗口和真实模型的安装后验收。

准备 NSIS 并尝试生成 NSIS 安装包：

```powershell
npm.cmd run tao:release:nsis
```

NSIS 当前不作为默认方式，是因为 Pi 资源和 Node 运行时较大，压缩阶段耗时明显，曾出现全局超时风险。当前自动下载 WiX 的步骤只用于 MSI。

## 5. 发布结果位置

默认 MSI 位置：

```text
<Tao 项目根目录>\
src-tauri\target\x86_64-pc-windows-msvc\release\bundle\msi\
Tao_0.1.4_x64_en-US.msi
```

如果执行 `npm.cmd run tao:release -- 2.1`，文件名会变为：

```text
Tao_2.1.0_x64_en-US.msi
```

同一版本重复打包时，目标目录中的同名 MSI 会被构建流程覆盖。正式升级不能只手动重命名 MSI，必须通过版本参数或修改版本文件后重新构建。MSI 版本号必须是纯数字 `major.minor.patch`。

构建过程中还会生成：

```text
src-tauri\target\x86_64-pc-windows-msvc\release\
src-tauri\resources\
.tao-release-cache\
```

这些是构建或发布准备目录，不是用户数据，也不应提交到源码仓库。
其中 `src-tauri/target` 和 `.tao-release-cache` 可以很大，尤其是 Rust Debug/Release 编译缓存；它们的磁盘占用不是 MSI 的体积。

## 6. 安装包内置内容

发布资源在源码中先生成于 `src-tauri/resources`。Tauri 在 Windows 上把 resource directory 解析为主程序所在目录，因此 MSI 安装后，`tao.exe` 与下面的 `node`、`runtime`、`pi` 目录同级。Pi 的 Biome、TypeScript 编译器、Vitest、Vite 等开发依赖已从安装资源中排除；`tsx`、模型数据及运行所需原生模块保留。

```text
<Tao 安装目录>/
├─ tao.exe
├─ node/node.exe
├─ runtime/
│  ├─ tao-runtime.mjs
│  ├─ context.mjs
│  ├─ prompt-policy.mjs
│  └─ docs/                # 四个按需模型运行专题
├─ pi/
│  ├─ packages/
│  ├─ node_modules/
│  ├─ package.json
│  └─ tsconfig.json
└─ RELEASE-MANIFEST.json
```

因此正式安装版不依赖目标电脑上的：

- Node.js；
- npm；
- Rust；
- Tao 源码；
- `vendor/pi`；
- Pi `node_modules`。

## 7. 发布版目标电脑需要什么

目标电脑需要：

1. Windows 10/11 x64；内置 Node 22.19.0 的正式支持从 Windows 10 x64 起，当前安装包未在更早系统或 Windows ARM 上验收；
2. Microsoft WebView2 Runtime；当前 MSI 使用 Tauri 默认安装方式，目标电脑缺失时安装程序会联网获取 WebView2 引导程序；
3. 访问模型网关或 API 的网络；
4. 用户自己配置 Provider、模型和 API Key。

目标电脑不需要安装：

- Node.js；
- npm；
- Rust；
- Visual Studio；
- Tao 开发依赖。

如果目标电脑没有 WebView2，安装或首次运行时可能需要联网安装 WebView2 Runtime。当前安装包没有代码签名，Windows 可能显示未知发布者或 SmartScreen 提示，这不等于应用内部 Runtime 失败。

普通对话无需 Git 或 Bash。若允许模型使用 Pi 的 `bash` 工具，目标电脑还需有可用的 Bash，例如 Git for Windows 提供的 Git Bash；缺少时该工具会报错。`grep` 和 `find` 工具需要 rg/fd，Pi 会先查找本机程序，缺少时尝试联网下载，离线目标电脑应预先提供这些工具。

## 8. 版本更新要求

发布脚本会同步维护以下版本来源：

- `package.json`
- `package-lock.json`
- `src-tauri/tauri.conf.json`
- `src-tauri/Cargo.toml`
- `src-tauri/Cargo.lock`

推荐直接执行：

```powershell
npm.cmd run tao:release -- 2.1
```

版本参数无效时，脚本会在构建开始前退出。版本文件写入后如果后续发布步骤失败，源码中的版本仍会保留，需要修复原因后重新执行同一版本的发布命令。

也可以先检查再发布：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\tao.ps1 check
npm.cmd run tao:release -- 2.1
```

不要手动复制旧 MSI 作为新版本。每次发布应重新准备 resources，确保安装包内的 Runtime、Pi 和 Node 与源码版本一致。

## 9. 发布安全和隐私注意事项

- 不要把 `%USERPROFILE%\.tao\auth.json` 复制进安装资源；
- 不要把真实 API Key 写进源码、文档、测试命令或发布包；
- 发布资源来自 `vendor/pi` 和 Tao Runtime，不来自用户 `.tao`；
- 安装包可能包含 Pi 源码和依赖，发布前应确认其中没有本地密钥和个人文件；
- 当前未配置代码签名；
- 发布前要确认 `src-tauri/resources` 中没有临时测试文件；
- 发布后用户的会话和设置仍在用户目录，不应由安装包覆盖。

## 10. 当前发布验收状态

2026-10-19 本机 `0.1.4` 编译与包资源验收：

- 源码 `check`、UI 自动回归、完整 `test:agents` 通过；包含 46 项协调器、6 项上下文、12 项 Rust 测试以及实际 SDK + 本地模拟网关流程。
- 新版界面在浏览器模拟数据中验证默认/合成预览、角色替换、旧快照、成员导航与深色 900×760 分栏；修复标题区状态文字在主区域 420px 时被裁剪。
- MSI 文件表核对 18,980 个文件、40 个模型数据文件；新增上下文、策略及四个运行专题随包提供。
- MSI 行政提取后，使用其实际 Node、Runtime 和内核通过双路径 ready/ping 及完整模拟网关回归；12 个关键文件与源文件/准备资源字节一致，exe 仅相差 Tauri 的 `UNK → MSI` 类型标记。未覆盖本机现有安装或用户数据。
- [Tao_0.1.4_x64_en-US.msi](../../src-tauri/target/x86_64-pc-windows-msvc/release/bundle/msi/Tao_0.1.4_x64_en-US.msi) 为 74.9 MiB（78,549,592 字节），SHA-256 `a7fba0b0fb18caeb6da36b005feec871113a9e0e6e7b2fdd8338e5a9e8bb0620`。与 0.1.3 使用相同 UpgradeCode、不同 ProductCode。
- 用户已确认 0.1.4 试用效果正常并授权发布、push。真实模型质量、原生多窗口完整异常路径及干净 Windows 环境继续专项验收；行政提取和模拟网关不代替这些项目。
- [v0.1.4 Release](https://github.com/1newbird/Tao/releases/tag/v0.1.4) 已正式发布并标记 Latest，源码提交/标签 `69eaa56` / `v0.1.4` 已推送。GitHub 侧两个附件的大小和 SHA-256 均与本地文件一致。

2026-10-12 本机 `0.1.3` 后台窗口修复与打包验证：

- 工作区 Git 状态与 Diff、Pi 的 `grep`/`find`、工具探测和共用命令执行入口均设置 Windows 隐藏控制台窗口，保留原有 stdout/stderr 捕获；
- Tao 和 Pi 的 `npm run check` 均通过，发布资源双路径 `ready`/`ping` 通过；MSI 文件表确认修复后的 Pi 文件、Node、Runtime 和 40 个模型数据文件均已打入；
- [Tao_0.1.3_x64_en-US.msi](../../src-tauri/target/x86_64-pc-windows-msvc/release/bundle/msi/Tao_0.1.3_x64_en-US.msi) 为 74.6 MiB（78,233,996 字节），SHA-256 为 `f9d84ba910bedee3c99862eeef4513cccb6c1bb653748f33a5c9a5b5289db228`；与 `0.1.2` 使用相同 UpgradeCode、不同 ProductCode。安装后仍需在实际使用中确认黑窗消失。

2026-10-12 本机 `0.1.2` 修复与打包验证：

- 修复安装目录返回 `\\?\D:\...` 时，tsx loader URL 被手工拼成 `file://///%3F/D:/...` 的错误；传给 Node 的资源和工作目录路径均统一为普通绝对路径，文件 URL 由 URL 库生成；
- Windows 路径与特殊字符的 Rust 回归测试通过；当前 `D:\software_setup\tao` 安装目录中的内置 Node、Pi、Runtime 资源在隔离用户数据目录下，按普通路径和扩展路径启动均能进入 `ready` 并响应 `ping`；
- 新发布资源完成相同的双路径预检；前端和 Rust Release 编译通过；MSI 文件表核对 18,970 个文件、40 个模型数据文件，以及 Node、Runtime、Pi 和 tsx loader；
- `0.1.2` 的 ProductCode 与 `0.1.1` 不同，UpgradeCode 相同，满足 Windows Installer 识别同一产品升级的版本标识条件；
- [Tao_0.1.2_x64_en-US.msi](../../src-tauri/target/x86_64-pc-windows-msvc/release/bundle/msi/Tao_0.1.2_x64_en-US.msi) 为 74.6 MiB（78,217,612 字节），SHA-256 为 `ff133cdf24a4cd7cb4844d38cd924176e0e228e95a797cb19511cafa5097e4b2`。安装后的实际界面与首次发送仍需验证。

2026-10-10 本机 `0.1.1` 打包验证：

- TypeScript、Cargo 和 Rust Release 构建通过；
- 内置 Node 启动发布 Runtime，`ready` 和 `ping` 请求通过；
- MSI 构建完成，文件表核对 Node、Runtime、Pi 入口、tsx loader 和 40 个模型数据文件；
- 资源约 237.6 MiB，其中 Node 81.3 MiB、Pi 156.2 MiB、Runtime 约 0.1 MiB；
- MSI 约 74.6 MiB。裁剪开发依赖前为 116.3 MiB，减少约 41.7 MiB。
- `0.1.1` MSI 的 ProductCode 已变化，UpgradeCode 与 `0.1.0` 一致；实际覆盖安装仍需在目标电脑验收。

上述体积按 MiB（1 MiB = 1,048,576 字节）显示。实际安装包路径和 SHA-256 以发布命令输出及 `.tao-release-cache/release-report.json` 为准。

仍待完成：

- 没有 Node.js 和 Tao 源码的干净 Windows x64 电脑安装；
- 安装后的 Runtime 状态、完整问答、工具、权限、会话恢复与故障时删除会话验收；
- 安装版 `bash` 工具对 Git Bash 的依赖检查；
- NSIS 体积和耗时评估；
- 代码签名。
