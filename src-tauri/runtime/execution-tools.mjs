import { createExecutor } from "./execution.mjs";
import { AsyncLocalStorage } from "node:async_hooks";
import { sandboxToolInput } from "./execution-policy.mjs";

export function executionToolDefinitions(createDefinitions, profile, cwd, resolveShell) {
  const executor = createExecutor(profile.execution, cwd);
  const signals = new AsyncLocalStorage();
  // Native command tools also use the common process lifecycle and clean env.
  if (executor.policy.backend === "local") {
    return [createDefinitions(cwd, { bash: { operations: { exec: async (command, _cwd, options) => {
      const shell = resolveShell();
      const result = await executor.execute(shell.shell, shell.commandTransport === "stdin" ? shell.args : [...shell.args, command], {
        input: shell.commandTransport === "stdin" ? command : undefined,
        signal: options.timeout ? AbortSignal.any([options.signal ?? new AbortController().signal, AbortSignal.timeout(options.timeout * 1000)]) : options.signal,
        allowFailure: true, onData: options.onData,
      });
      return { exitCode: result.exitCode };
    } } } }).bash];
  }
  const operation = async (name, path, extra = {}, signal) => {
    const result = await executor.execute("node", [], {
      signal: signal ?? signals.getStore(), workerRequest: { operation: name, path: executor.containerPath(path), ...extra },
    });
    return JSON.parse(result.stdout);
  };
  const fileOptions = {
    bash: { operations: { exec: async (command, _cwd, options) => {
      const response = await executor.command(command, {
        signal: options.timeout ? AbortSignal.any([options.signal ?? new AbortController().signal, AbortSignal.timeout(options.timeout * 1000)]) : options.signal,
        allowFailure: true, onData: options.onData,
      });
      return { exitCode: response.exitCode };
    } } },
    read: { operations: { readFile: async (path) => Buffer.from(await operation("read", path), "base64"), access: (path) => operation("access", path), detectImageMimeType: (path) => operation("mime", path) } },
    write: { operations: { writeFile: (path, content) => operation("write", path, { content }), mkdir: (path) => operation("mkdir", path) } },
    edit: { operations: { readFile: async (path) => Buffer.from(await operation("read", path), "base64"), writeFile: (path, content) => operation("write", path, { content }), access: (path) => operation("access", path) } },
    ls: { operations: { exists: (path) => operation("exists", path), stat: async (path) => { const result = await operation("stat", path); return { isDirectory: () => result.directory }; }, readdir: (path) => operation("readdir", path) } },
  };
  const sandboxed = createDefinitions(cwd, fileOptions);
  const result = Object.entries(sandboxed).map(([name, definition]) => {
    if(name === "bash" && executor.policy.backend === "windows") return {...definition,description:"Run a Windows PowerShell command in the native AppContainer sandbox. Commands are always offline; file access follows this workspace's policy. Use the provided node, npm.cmd and npx.cmd. The current directory is a temporary drive root mapped to the workspace, as shown in the output. It is released when the command ends; use relative paths or the original workspace path in later tool calls. Keep project configuration and dependencies in the workspace; hardcoded host paths can still be denied.",promptSnippet:"Run commands with Windows PowerShell in the native sandbox"};
    if (["grep", "find"].includes(name)) return { ...definition,
      description: `${name === "grep" ? "Search workspace file contents using JavaScript regex or literal matching" : "Find workspace files by glob"}. Sandbox search skips .git, node_modules and symlinks; does not load .gitignore; at most 10000 files and 1 MB per file.`,
      promptSnippet: name === "grep" ? "Search workspace file contents inside the sandbox" : "Find workspace files inside the sandbox",
      execute: async (_id, params, signal) => ({ content: [{ type: "text", text: await operation(name, params.path || cwd, { input: params }, signal) }], details: {} }),
    };
    return definition;
  });
  return result.map((definition) => ({ ...definition, execute: (id, params, signal, ...rest) => {
    const normalized = sandboxToolInput(cwd, params, profile.execution);
    return signals.run(signal, () => definition.execute(id, normalized, signal, ...rest));
  } }));
}


