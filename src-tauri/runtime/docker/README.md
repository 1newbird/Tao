# Tao 基础工具镜像

当前版本 `tao-runtime:0.1.0`，面向 Windows x64 上的 Docker Linux/amd64 后端。Windows 原生沙盒和本机后端不使用此镜像。镜像只运行工具，模型、联网检索和远程 MCP 仍由宿主 Runtime 管理。

## 内容与边界

- 固定摘要的 Node 22 / Debian Bookworm slim 基础镜像，包含 npm。
- Python 3、pip、venv，Git、ripgrep、curl、jq、zip/unzip、CA 证书及 build-essential。
- 默认 UID/GID 1000，保留系统和软件包的版权文件；安装包版本清单位于 `/opt/tao/os-packages.tsv`。
- 不包含浏览器、OCR、Office、数据库服务或项目依赖。Linux 容器不能直接复用 Windows 原生依赖二进制。

## 准备与使用

安装 Docker Desktop 并启用 Linux 容器后，在 Tao 的“定制 → 执行与沙盒”选择 Docker，点击“准备 Tao 基础镜像”。构建配方随 Tao 发布资源提供，安装用户无需源码、Git 或宿主 Node。首次准备需要访问基础镜像仓库与 Debian 软件源，下载和磁盘开销取决于本机缓存。

源码开发可运行 `node scripts/prepare-docker-image.mjs` 或 `powershell -File scripts/setup-sandbox.ps1`。后者的 `-Image` 参数仍可显式拉取其他镜像。

准备流程先构建随机临时标签，再用断网、非 root、只读根目录、资源上限的容器检查 Node、Python venv、Git 等工具与 C 编译。通过后更新版本标签并返回实际 image ID；失败保留旧标签，仅清理本次临时容器和临时标签。发布资源验证只检查配方完整性，不能代替真实 Docker 验收。

每次底层操作仍使用独立临时容器，结束后清理；工作区为绑定挂载，文件修改会持久保存，镜像与 Docker 构建缓存保留供复用。工具执行不自动构建或拉取镜像。旧组合显式配置的镜像保持原值，新配置默认推荐 Tao 镜像。

## 项目依赖

系统根目录只读，不能在任务中临时 apt 安装程序。Python 项目可在挂载工作区建立 `.venv`；Node 项目在 Linux 容器内安装依赖。需要复用下载缓存时，将 npm/pip 缓存明确配置到工作区中的项目目录，并纳入项目忽略规则。`/tmp` 为有限空间的临时目录且禁止执行新二进制；编译产物需要在工作区执行。依赖安装仍需满足组合联网策略，准备镜像不会自动开放任务联网。

## 维护与发布

修改工具清单或基础镜像时更新 `image.json` 的版本、平台和摘要，并同步前端、Rust 和 Runtime 默认值；运行镜像验收及执行回归。基础镜像摘要固定，Debian 软件包从其官方软件源安装，因此重新构建不承诺逐字节相同。每次准备返回不可变 image ID，执行器也按检查到的 ID 运行；需要严格回退时在组合中选择已保留的 image ID 或明确的旧版本标签。

Docker 镜像目前在用户本机构建，没有推送到公共镜像仓库。未来镜像分发需增加固定 digest、漏洞与许可审核、更新/回退策略；不要把本地构建标签宣传为可直接远程拉取的镜像。自定义浏览器/文档镜像和会话容器复用另行设计。
