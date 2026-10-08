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

不能把 Release 目录中的裸 `tao.exe` 当成正式发布物。Tao 运行需要安装包中的前端资源和 `resources` 运行时资源，正式分发应使用 MSI。

## 2. 发布前置条件

发布准备脚本当前只接受 Windows x64：

- Windows x64；
- Node.js/npm；
- Rust stable 和 MSVC 工具链；
- Visual Studio/Build Tools；
- Tao 根目录依赖；
- `vendor/pi` 源码和 `vendor/pi/node_modules`；
- 首次准备时可以访问 Node.js 下载地址的网络。

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

1. `npm run tao:prepare`；
2. 下载或复用 Node.js 22.19.0 Windows x64 压缩包；
3. 校验 Node 压缩包 SHA-256；
4. 复制 Tao Runtime；
5. 复制 Pi 源码、模型数据和 Node 依赖；
6. 执行前端构建；
7. 执行 Tauri x86_64 Release 构建；
8. 生成 MSI。

## 4. 分步命令

只准备发布资源，不生成安装包：

```powershell
npm.cmd run tao:prepare
```

准备 NSIS 并尝试生成 NSIS 安装包：

```powershell
npm.cmd run tao:release:nsis
```

NSIS 当前不作为默认方式，是因为 Pi 资源和 Node 运行时较大，压缩阶段耗时明显，曾出现全局超时风险。

## 5. 发布结果位置

默认 MSI 位置：

```text
<Tao 项目根目录>\
src-tauri\target\x86_64-pc-windows-msvc\release\bundle\msi\
Tao_0.1.0_x64_en-US.msi
```

如果执行 `npm.cmd run tao:release -- 2.1`，文件名会变为：

```text
Tao_2.1.0_x64_en-US.msi
```

同一版本重复打包时，目标目录中的同名 MSI 会被构建流程覆盖。正式升级不能只手动重命名 MSI，必须通过版本参数或修改版本文件后重新构建。

构建过程中还会生成：

```text
src-tauri\target\x86_64-pc-windows-msvc\release\
src-tauri\resources\
.tao-release-cache\
```

这些是构建或发布准备目录，不是用户数据，也不应提交到源码仓库。

## 6. 安装包内置内容

发布资源大致如下：

```text
resources/
├─ node/node.exe
├─ runtime/tao-runtime.mjs
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

1. Windows x64；
2. Microsoft WebView2 Runtime；
3. 访问模型网关或 API 的网络；
4. 用户自己配置 Provider、模型和 API Key。

目标电脑不需要安装：

- Node.js；
- npm；
- Rust；
- Visual Studio；
- Tao 开发依赖。

如果目标电脑没有 WebView2，安装或首次运行时可能需要联网安装 WebView2 Runtime。当前安装包没有代码签名，Windows 可能显示未知发布者或 SmartScreen 提示，这不等于应用内部 Runtime 失败。

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
npm.cmd run check
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

已经完成：

- 发布脚本语法检查；
- TypeScript 和 Cargo 检查；
- 发布资源准备；
- 资源内置 Node 启动 Runtime；
- MSI Release 构建。

仍待完成：

- 没有 Node.js 和 Tao 源码的干净 Windows x64 电脑安装；
- 安装后的完整问答、工具、权限和会话恢复验收；
- NSIS 体积和耗时评估；
- 代码签名。
