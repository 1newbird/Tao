# Windows 原生沙盒实验

这是底层研究与回归入口，与开发版原生执行器共享 `native/windows-sandbox/src/runner.rs`。实验使用独立能力 SID，不能替代产品初始化。第一轮 17 项为 14 通过 / 3 失败；加入最小兼容初始化并扩展真实工具后为 **19/20**，Node 嵌套管道仍失败。Windows 10 尚无实际验收环境。

开发源码已另行接入可选原生预览，最新机制、限制与结果见 [后端接入记录](../../docs/验证/2026-10-20-Windows原生后端接入.md)。本实验不修改应用的默认组合。

完整结论见 [本机验证记录](../../docs/验证/2026-10-20-Windows原生沙盒原型.md)。

## 原理

- 每次执行建立唯一 AppContainer 身份，能力列表为空；使用 Windows 的令牌和 ACL 检查访问。
- 只对本轮生成的 `bin`、工作区和临时目录增加该身份的访问项；两个并发执行不共享身份。
- 通过 `CreateProcessW` 以挂起、无窗口方式创建进程，仅继承标准输入输出句柄；加入 kill-on-close Job Object 后恢复执行。
- 参数通过数组传入，子进程环境显式构造；控制器标准输入关闭或发出取消信号时终止进程树。
- 授权前写入清理日志，正常结束撤销本身份的授权并删除 profile；异常终止可重放清理日志。

AppContainer 不是磁盘虚拟化；普通 AppContainer 还可以访问系统已向该类应用开放的公共资源。本原型只验证测试矩阵中的边界，不宣称整个 Windows 只暴露所列目录。

## 运行

在项目根目录的 PowerShell 执行：

```powershell
# 准备实验专用最小权限，再执行扩展矩阵（当前 19/20，返回码为 1）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup-windows-native-experiment.ps1 -Prepare
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test-windows-native.ps1 -Compatibility

# 仅验证基本 Node 启动和文件读取，不能替代完整验收
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test-windows-native.ps1 -Smoke

# 中断测试后，重试清理本实验的日志和临时授权
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test-windows-native.ps1 -CleanupOnly

# 撤销实验能力的设备与祖先元数据授权
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup-windows-native-experiment.ps1 -Remove
```

前提：Windows x64、Node、Rust/MSVC 开发工具链、已缓存的 Cargo 依赖，以及已经准备的 `src-tauri/resources/node/node.exe`。包装脚本读取项目现有 `.tao-dev-config.json` 中的工具路径；Cargo 使用 `--offline`，不会自动安装缺少的工具或依赖。资源缺失时先按项目开发手册准备，可使用 `npm.cmd run tao:prepare` 准备发布资源，这不构建 MSI。

兼容性用例使用 Windows PowerShell，当前 Git 探针指向 `C:\Program Files\Git\cmd\git.exe`。在其他安装位置复现时需调整该探针；缺少 Git 或路径不符应先判为环境问题。

构建产物、隔离的合成数据和报告全部位于已忽略的 `.tao-release-cache`：

```text
.tao-release-cache/windows-native-target/
.tao-release-cache/windows-native-lab/run-*/
  bin/             # 本轮 helper 和包内 Node 的临时副本
  workspace/       # 合成工作区
  other-project/   # 用于验证项目间隔离
  private/         # 合成私有文件，不使用真实凭据
  temp/
  state/           # 清理日志
  report.json
```

结束时移除 Node 临时副本，保留小型 helper、合成数据和报告，方便排查或重试清理。不要在仍有 `state/*.json` 时直接删除实验目录；先执行 `-CleanupOnly`。

## 权限和清理

执行矩阵会创建当前用户的临时 AppContainer profile，并修改生成目录上的 ACL。另行选择 `-Prepare` 会通过 UAC 给实验专用能力准备 NT 路径查询、磁盘 / 祖先元数据和必要设备权限；这些权限没有目录列举、内容读取或根目录写入，也不授予所有 AppContainer。实验不创建本地账户或服务，不改防火墙或 Docker；用 `-Remove` 撤销专用兼容项。

清理根据日志只移除本轮 SID 的授权，保留其他授权项。包装脚本会拒绝清理仍有同目录 helper 正在运行的实验。完整测试还检查本轮 profile 映射和目录 ACL 没有残留。强制杀死 helper 的测试会留下日志，再由宿主清理；产品启动恢复尚未实现。

## 已知失败与限制

1. 未准备兼容权限时，Git 无法打开 `/dev/null`，NUL 返回错误 5，native realpath 返回 `EPERM`。最小初始化后这三项及真实 Git 操作已通过；未初始化对照仍保留失败。
2. 包内 Node 22.19.0 的嵌套子进程管道仍超时，不能仅凭 Node 启动通过就声称所有 SDK 和构建工具兼容。
3. 断网测试只覆盖受控的宿主回环 TCP 端点及匿名线程令牌尝试，未完成全部协议、公网或代理场景认证。
4. 子进程验证使用继承的标准句柄。复杂管道、分离式服务、任意本机程序、资源压力、真实项目和 Win10 均未完成验收。
5. Job 限制为最多 32 个进程、单进程 1 GB 和执行超时；未提供团队 CPU / 总内存预算。
6. 授权前拒绝已有 reparse point 的目录树，不能直接支持所有真实项目布局。执行中引入 junction 的拒绝访问用例已通过。
7. 这是受信宿主调用的实验 helper。清理意图已改为先同步落盘再创建 profile，并核对派生 SID 与执行租约；真实断电恢复和跨 Windows 用户行为仍待验收。

完整套件保留这些失败并返回非零，不通过扩大系统权限或跳过用例把候选方案标记为可发布。
