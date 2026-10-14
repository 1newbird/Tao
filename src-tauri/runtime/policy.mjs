import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

export function canonicalTarget(path) {
  let ancestor = resolve(path);
  const suffix = [];
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    suffix.unshift(basename(ancestor));
    ancestor = parent;
  }
  // A new file still inherits the real location of its nearest existing parent.
  const canonical = realpathSync.native(ancestor);
  return join(canonical, ...suffix);
}

export function inWorkspace(cwd, path) {
  const target = relative(canonicalTarget(cwd), canonicalTarget(path));
  return target === "" || (!target.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && target !== ".." && !isAbsolute(target));
}

export function applyToolPolicy(cwd, name, input, audit, profile) {
  const rule = profile?.toolPermissions?.[name];
  if (audit.decision === "deny" || rule?.mode === "deny") {
    return { ...audit, decision: "deny", enforcedDeny: true, reason: rule?.mode === "deny" ? "此组合禁止使用该工具。" : audit.reason };
  }
  if (rule?.pathScope === "workspace" && ["read", "write", "edit", "grep", "find", "ls"].includes(name)) {
    const raw = input?.path ?? input?.file_path ?? input?.directory ?? input?.dir ?? ".";
    try {
      if (!inWorkspace(cwd, resolve(cwd, String(raw)))) {
        return { ...audit, decision: "deny", enforcedDeny: true, reason: "此组合仅允许该工具访问当前工作区。" };
      }
    } catch {
      return { ...audit, decision: "deny", enforcedDeny: true, reason: "无法确认目标路径的实际位置。" };
    }
  }
  const custom = profile?.customTools?.find((tool) => tool.name === name);
  if (rule?.mode === "ask" || custom?.permissionMode === "ask") {
    return { ...audit, decision: "ask", enforcedAsk: true, canRemember: true, reason: "此工具需要用户确认后执行。" };
  }
  if (rule?.mode === "allow") return { ...audit, decision: "allow", reason: "此组合已允许该工具。" };
  return audit;
}

export function assertHttpTarget(rawUrl, allowedHosts = []) {
  const url = new URL(rawUrl);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("HTTP 工具地址必须使用 http/https，不能包含登录凭据");
  if (allowedHosts.length && !allowedHosts.includes(url.hostname.toLowerCase())) throw new Error("HTTP 目标不在工具允许的域名范围内");
  return url;
}

export function resolveHeaderReferences(rawHeaders, environment = process.env) {
  const headers = JSON.parse(rawHeaders || "{}");
  if (!headers || Array.isArray(headers) || typeof headers !== "object") throw new Error("HTTP 请求头必须是 JSON 对象");
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => {
    if (typeof value !== "string") throw new Error("HTTP 请求头值必须是字符串");
    const resolved = value.replace(/\{\{env:([A-Za-z_][A-Za-z0-9_]*)\}\}/g, (_match, name) => {
      if (!environment[name]) throw new Error(`缺少工具凭据环境变量：${name}`);
      return environment[name];
    });
    return [key, resolved];
  }));
}
