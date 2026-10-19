# GitHub 上传与发布检查清单

## 1. 第一次推送前

### 1.1 仓库状态

- 确认当前目录是 Tao 仓库根目录。
- 确认当前目录已经 `git init`。
- 确认 `vendor/pi` 下没有 `.git`，也没有 `.gitmodules`。
- 确认没有把 `vendor/pi` 作为 submodule 添加。

### 1.2 忽略项

`git status` 中不应出现：

```text
node_modules/
vendor/pi/node_modules/
dist/
src-tauri/target/
src-tauri/gen/schemas/
src-tauri/resources/
.tao-release-cache/
.tao/
.cargo/
.idea/
```

`vendor/pi` 内部另有一份自己的 `.gitignore`，应保留并遵守。

### 1.3 敏感信息扫描

至少搜索并确认不存在：

```text
.env
.env.*
*.pem
*.key
auth.json
models.json
tao.json
API Key
Access Token
Secret
```

如果发现，先删除或加入 `.gitignore`，不要只删除提交历史中的可见位置。

## 2. 必须提交的内容

- `src/`
- `src-tauri/src/`
- `src-tauri/Cargo.toml`
- `src-tauri/Cargo.lock`
- `src-tauri/build.rs`
- `src-tauri/tauri.conf.json`
- `src-tauri/capabilities/`
- `src-tauri/icons/`
- `src-tauri/runtime/tao-runtime.mjs`
- `scripts/`
- `public/`
- `index.html`
- `vite.config.ts`
- `tsconfig.json`
- `tsconfig.node.json`
- `package.json`
- `package-lock.json`
- `README.md`
- `LICENSE`、`NOTICE`、`THIRD_PARTY_NOTICES.md`、`CONTRIBUTING.md`
- `docs/`
- `vendor/pi` 源码，不含 `vendor/pi/node_modules`
- `.vscode/extensions.json`

## 3. 绝不能提交的内容

- `node_modules/`
- `vendor/pi/node_modules/`
- `dist/`
- `src-tauri/target/`
- `src-tauri/gen/schemas/`
- `src-tauri/resources/`
- `.tao-release-cache/`
- `.tao/`
- `.cargo/`
- `.env`、`.env.*`
- `auth.json`
- `models.json`
- `tao.json`
- API Key、Session、日志等用户数据

## 4. Pi 固定快照规则

- `vendor/pi` 是固定快照，不是上游镜像。
- 不跟踪 Pi 最新代码，不允许使用者另行拉取 Pi。
- 后续修改 Pi 时直接本仓库提交，并同时更新相关文档和发布验证。

## 5. 干净克隆验证

推送后，应在干净环境按以下方式验证一次：

```powershell
git clone <仓库地址> tao-clean
Set-Location tao-clean

powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup-dev.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\tao.ps1 check
npm.cmd run tauri dev
```

只有这套流程跑通，才能认为“别人拉取下来可以使用”。

## 6. 发布前检查

- Tao 原创部分采用 PolyForm Noncommercial 1.0.0，第三方仍保留原许可；新增或变更依赖时复核其声明与其他分发义务，包括编译进前端/原生程序的依赖。
- `scripts\tao.ps1 check` 通过。
- `npm.cmd run tao:prepare` 和 `npm.cmd run tao:verify` 通过。
- 确认资源根目录的 `LICENSE`、`NOTICE`、`THIRD_PARTY_NOTICES.md`，以及 `pi/LICENSE` 和 `node/LICENSE` 均已生成。`tao:verify` 对照资源清单校验内容 SHA-256；MSI 文件表检查要求这些声明位于对应安装位置，不能由依赖目录里的同名文件代替。
- 确认 `src-tauri/resources` 没有被提交。
- 执行：

```powershell
npm.cmd run tao:release
```

- 检查生成结果：

```text
src-tauri/target/x86_64-pc-windows-msvc/release/bundle/
```

- 确认 MSI 不包含机密配置或本地工作区数据。
- 核对 `.tao-release-cache/release-report.json` 中的版本、MSI 路径、大小和 SHA-256。
- 在没有开发环境的干净 Windows x64 电脑安装该 MSI，确认 Runtime 进入 `ready`，再验收模型、问答、工具、权限、会话重开及删除。
- 完成安装验收后，上传**这次生成的 MSI**并在发布说明中附 SHA-256；不要上传 `target`、`resources` 或本地用户数据。
