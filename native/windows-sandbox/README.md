# Tao Windows 原生执行器（预览）

此组件已接入开发源码的 `windows` 执行后端，尚未发布新安装包。面向 Windows 10/11 x64；当前实测为 Windows 11 23H2，Windows 10 待验收。

## 构建与使用

`npm.cmd run tauri dev` 会自动编译辅助组件。需要单独编译或从命令行准备时，在仓库根目录执行：

```powershell
npm.cmd run tao:node
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-windows-sandbox.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup-windows-sandbox.ps1 -Prepare -WorkspacePath 'D:\MyProject'
```

辅助组件构建需要现有 Rust/MSVC 工具链，按 `Cargo.lock` 获取依赖；已缓存依赖时可加 `-Offline`。辅助组件使用静态 CRT，不要求安装用户另装 VC 运行库；发布验证检查 helper 与 Node 的 PE 导入表并拒绝动态 VC 运行库依赖。私有 Node 首次构建还需要 Python 3，详见 [构建说明](../node-runtime/README.md)。构建目录为项目 D 盘缓存，辅助组件复制到 `src-tauri/resources/native/tao-windows-sandbox.exe`；`-Release` 编译发布辅助组件，**不生成 MSI**。正式资源准备脚本会自动构建或校验这些资源。

界面入口为“定制 → 执行与沙盒 → Windows 原生（预览）”。选择具体工作区，点击管理员初始化后保存组合。旧组合默认本机运行；已有会话需空闲时应用新组合。

移除兼容授权：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup-windows-sandbox.ps1 -Remove
```

## 安全边界与初始化

- 每次执行使用新的 AppContainer package SID，不声明网络能力；共享的 `Tao.WindowsSandbox.Compatibility.v1` **只用于路径元数据和必要设备兼容，不授予工作区内容权限**。
- 文件工具在隔离内处理所选工作区；命令实际使用 Windows PowerShell，始终断网。模型请求与获准的 HTTP 工具在宿主处理。
- 管理员准备范围：NT DOS 名称查询，磁盘 / 工作区祖先的非继承元数据读取，MountPointManager 读取，NUL 读写。无目录列举、文件内容、根目录写入、All Application Packages 放权、本地账户、服务或 WFP 规则。部分设备重启后重置，需要重新准备。
- 管理员保护的 `HKLM\SOFTWARE\Tao\WindowsSandbox\CompatibilityV1` 保存元数据目录记录。初始化中断后可再次准备或移除；只合并 / 撤销匹配的专用 SID 条目，并保留其他 ACL 和继承控制字段。
- 唯一身份得到工作区、受控 Node/npm 缓存及本次临时目录的必要权限。授权前检查原路径及祖先，拒绝链接重定向；ACL 读取与更新使用不跟随 reparse point 的已验证句柄，根目录在扫描/授权前固定以防改名或删除。私有运行时逐文件校验，并按完整资源清单哈希缓存；祖先只加入逐次身份的非继承元数据权限。只保留必要环境及显式授权凭据，HOME 和临时路径不指向真实用户配置。
- 挂起启动后先加入 kill-on-close Job Object，再恢复执行；显式标准句柄名单，无控制台启动，最多 32 个进程，单进程和整个 Job 的提交内存上限均为 1 GB，执行最多 120 秒。没有配置 CPU 速率或团队总预算。
- 清理意图先落盘同步再创建 profile；跨会话命名互斥量保护 ACL 合并和执行租约。关闭控制器输入、取消和前台退出回收后代；下次执行前重放遗留日志，跳过活动执行。
- 命令通过临时 DOS 盘符将工作区映射为根目录，避免构建工具向宿主祖先目录寻找配置。盘符在**当前 Windows 登录会话可见**，并非磁盘虚拟化；只给本次 package SID 查询映射的权限，文件仍由原 ACL 约束。保留工作区目录句柄，防止执行中被改名或替换。文件 worker 和普通结构化程序调用仍使用原路径。
- 从 Z: 到 E: 查询空闲盘符并原子创建，遇到已占用名称跳过，不覆盖已有映射。只创建非持久 NT 链接，不执行 SUBST / 磁盘挂载或广播磁盘变更；最后句柄关闭时回收，helper 崩溃也由系统关闭句柄。无可用盘符时明确失败，不解除隔离。兼容检测忽略不存在对应全局设备的会话盘符，不要求为临时盘符管理员初始化。

不将普通 AppContainer 描述为磁盘虚拟化：系统向这类应用公开的公共资源仍可能可读。受限组合禁止任意 Extension，防止宿主扩展绕过工具执行边界。

## 已知限制

- 随包兼容 Node 已修复子进程管道；npm 本地测试、TypeScript 编译、npx、esbuild 完整打包与带 TypeScript 配置的 Vite 生产构建已通过。命令输出会提示临时盘符和原工作区的对应关系；后续文件调用使用原路径或相对路径，不保存临时盘符。硬编码宿主绝对路径、从工作区外加载配置/依赖、其他未修复 Node 或常驻服务仍可能失败；不承诺任意 Windows 程序兼容。
- 当前只接受本机磁盘路径，拒绝 UNC / 设备命名空间；比较受保护目录前统一 Windows 扩展路径。授权树超过 10000 条目或含已有 reparse point / junction 时拒绝；工作区不能包含 Tao 执行器、Node 或状态目录。项目仍共用文件，取消不回滚已经完成的写入。
- 并发与网络验证范围见记录；跨 Windows 用户、真实桌面关机重启、长时间压力和 Windows 10 真机尚未验收。
- 不可用、未初始化、权限不足或策略不支持均报错，不自动切换本机或 Docker。

## 验证

```powershell
node scripts/test-windows-executor.mjs
node scripts/test-windows-node.mjs
node scripts/test-windows-workspace-drive.mjs
node scripts/verify-runtime-tool-flow.mjs --windows
```

这些测试使用临时合成数据和本地模拟模型，须先为测试目录的祖先准备兼容授权；本批记录使用 `.tao-release-cache/windows-executor-lab`。它们不使用用户 API Key。

底层完整矩阵与初轮实验复用 `src/runner.rs`，实验 crate 不启用 `product` feature，使用独立实验能力 SID 和受限实验根目录。历史失败报告保留；最新构建矩阵为 12/12，新增并发投影、只读/越界、异常清理与根目录链接替换回归为 5/5，不增加工作区外列目录权限。以上三个测试命令顺序运行，最后一项比较整个登录会话盘符清单，不能同时启动其他原生命令测试。

详细证据：[构建兼容与清理](../../docs/验证/2026-10-21-原生沙盒构建兼容与清理.md)、[Node 与路径修复](../../docs/验证/2026-10-20-原生Node兼容与相对路径.md)、[初始接入记录](../../docs/验证/2026-10-20-Windows原生后端接入.md)。
