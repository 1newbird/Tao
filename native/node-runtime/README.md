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

Development uses this verified cache. Windows native tools receive a private
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
The Node suite includes an esbuild full-bundling compatibility probe. That probe
currently fails on ancestor-directory enumeration and the suite retains its
nonzero exit code; successful child pipes and npm scripts do not hide this limit.
