# 第三方代码与许可说明

Tao 原创部分使用根目录 `LICENSE` 中的 PolyForm Noncommercial License 1.0.0，版权通知见 `NOTICE`。该许可不覆盖或变更以下第三方代码原有的授权。

## 智能体运行层来源

- 来源：<https://github.com/earendil-works/pi>
- 仓库位置：`vendor/pi/`，原始代码使用 MIT 许可证。
- 原版权：Copyright (c) 2025 Mario Zechner。
- 完整原许可：`vendor/pi/LICENSE`；安装资源中的对应位置为 `pi/LICENSE`。

源码快照和派生文件保留原版权与许可。Tao 新增的原创部分遵循 Tao 许可，不把第三方原始代码重新授权为非商业代码。

## Node.js 与附带组件

- 来源：<https://nodejs.org/>
- Windows x64 运行时基于固定的 Node.js 22.23.3 官方源码构建，浮动合入 libuv 的 AppContainer 命名管道修复；属于 Tao 随包提供的定制构建，不是 Node 官方发行二进制。
- 补丁来源：<https://github.com/libuv/libuv/commit/2cadaa401670>，保留 libuv contributors 的 MIT 授权；源码片段与构建说明位于 `native/node-runtime/`。
- 安装资源中的 `node/LICENSE` 原样复制自所用官方源码，包含 Node.js 及附带第三方组件的许可通知。npm 及依赖保留其包内原声明。
- `node/BUILD-MANIFEST.json` 记录源码、补丁和运行时资源校验值与编译参数；`scripts/build-sandbox-node.mjs` 提供构建步骤。

## 其他依赖

Tao 使用 Tauri、React、TypeScript 及其他 Rust/npm 依赖。具体版本记录在 `package-lock.json`、`src-tauri/Cargo.lock` 和 `vendor/pi/package-lock.json`；许可与版权以各依赖自身文件为准。

发布准备保留运行依赖包内自带的 LICENSE、NOTICE 等文件。新增、升级、移除或裁剪依赖时，需要核对对应许可义务，包括编译进前端或原生程序的依赖；锁文件和本说明不替代这些组件要求提供的完整许可、版权或源码材料。依赖许可材料的完整清单继续作为发布审核事项维护。

## 安装资源中的声明

以下文件由发布准备脚本复制，并由资源验证与 MSI 文件表检查要求存在：

```text
LICENSE
NOTICE
THIRD_PARTY_NOTICES.md
pi/LICENSE
node/LICENSE
```

资源清单记录这些文件的 SHA-256，资源验证会检查内容是否完整。上述自动检查覆盖这些列出的文件，不代表对全部依赖的法律审查。
