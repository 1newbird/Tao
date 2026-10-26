# Tao Windows Node runtime

Tao bundles a private Windows x64 build of Node.js 22.23.3. Its only C runtime
source change is the runtime hunk of libuv commit
[2cadaa401670](https://github.com/libuv/libuv/commit/2cadaa401670): when the
process token is AppContainer, automatically generated child-process pipes use
the Windows `LOCAL` namespace. Filesystem and network permissions are unchanged.

This is a Tao custom build, not an official Node binary. Node and libuv retain
their original licenses. The complete Node source `LICENSE` and npm package
notices ship with the runtime.

## Build

From the project root, with Node, Python, Windows SDK, and Visual Studio C++ x64
tools available:

```powershell
node scripts/build-sandbox-node.mjs
# Reuse the verified archive without network access:
node scripts/build-sandbox-node.mjs --offline
```

The script downloads the official source to `.tao-release-cache/node-native-build`
on the workspace drive and checks the pinned SHA-256 before extraction. It uses
MSVC v143 (VS 2022) or v145 (VS 2026), two concurrent compiler jobs, full ICU,
static CRT, and OpenSSL without assembler. The latter avoids an additional NASM
installation and must be included when evaluating performance of this build.
The VS 2026 compiler consumes the VS 2022 project format; upstream build scripts
are not modified. Source-version upgrades require corresponding build and
runtime validation updates.

`runtime/BUILD-MANIFEST.json` records the source and patch hashes, toolchain,
flags, and every shipped file's SHA-256. These are fixed-input, reviewable builds;
we do not claim bit-for-bit reproducibility across different compilers or build
timestamps. System Node and global npm installations are not changed.

## Runtime and release

Native tool development uses this verified cache. The desktop Debug Runtime
host still uses the configured system Node; releases use the bundled Node.
Windows native tools receive a private
copy under the Tao data directory; Node/npm are read-only to the tool identity.
`npm.cmd` and `npx.cmd` resolve the adjacent private Node. Releases copy that same
runtime into `resources/node`, using one Node binary for Runtime and tools.
Resource preparation validates the cache before copying it; resource verification
checks hashes and the full Runtime startup in ordinary and extended paths.

Ordinary Node child pipes and the fork IPC channel are the scope of this patch.
Commands should use `node`, `npm.cmd`, and `npx.cmd` from the provided PATH.
An explicitly configured external Node binary does not receive this source fix.
Arbitrary user-created named-pipe paths, internet access, persistent services,
unlimited runtimes, and arbitrary native programs are not newly granted.

```powershell
node scripts/test-windows-node.mjs
node scripts/test-windows-executor.mjs
node scripts/verify-runtime-tool-flow.mjs --windows
```

These tests require the native helper and administrator compatibility preparation
described in `native/windows-sandbox/README.md`. No MSI is built by these commands.
The 2026-10-21 Node compatibility matrix passed 12/12, including esbuild full
bundling and a Vite production build with TypeScript configuration. Commands
temporarily map the workspace to an unused drive letter, avoiding host ancestor
enumeration without granting extra file permissions. The mapping is visible in
the current Windows logon session and is released when execution ends; it is not
a security boundary. Later calls must use the original or relative workspace
path, not a previous temporary drive letter.

The earlier failed bundling reports remain historical evidence. This result
does not grant online npm installation, dependencies outside the workspace,
persistent servers, or arbitrary program compatibility. Windows 10, cross-user,
reboot and stress validation remain pending. See the [latest compatibility
record](../../docs/验证/2026-10-21-原生沙盒构建兼容与清理.md) and [0.2.0 release
acceptance](../../docs/验证/2026-10-21-0.2.0发布验收.md). These are recorded results;
the 2026-10-22 documentation cleanup did not rerun the native suites.
