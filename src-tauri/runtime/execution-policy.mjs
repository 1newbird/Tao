import { join } from "node:path";

const BASE_ENV = new Set(["PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "LANG", "LC_ALL", "TERM"]);
const UNSAFE_ENV = /^(?:NODE_OPTIONS|NODE_PATH|BASH_ENV|ENV|SHELLOPTS|LD_.*|DYLD_.*|DOCKER_.*|TAO_HOME|TAO_PI_ROOT|TAO_NODE_PATH|TAO_TOOL_INPUT_JSON|TAO_SANDBOX_CHILD|TAO_SANDBOX_WORKSPACE|PI_.*)$/i;

export function executionConfiguration(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("执行策略必须是配置对象");
  const result = { backend: "local", image: "tao-runtime:0.1.0", fileScope: "any", workspaceAccess: "read_write", network: "allow", allowedHosts: [], allowedEnv: [], ...value };
  if (value.network === undefined || value.network === "inherit") result.network = result.backend !== "local" ? "deny" : "allow";
  if (!["local", "docker", "windows"].includes(result.backend) || !["any", "workspace"].includes(result.fileScope)
    || !["read_write", "read_only"].includes(result.workspaceAccess) || !["allow", "deny"].includes(result.network)) throw new Error("执行策略无效");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,199}$/.test(result.image)) throw new Error("容器镜像名称无效");
  for (const key of ["allowedHosts", "allowedEnv"]) if (!Array.isArray(result[key]) || result[key].length > 64 || result[key].some((item) => typeof item !== "string")) throw new Error("执行策略名单无效");
  result.allowedHosts = [...new Set(result.allowedHosts.map((host) => host.trim().toLowerCase()))];
  if (result.allowedHosts.some((host) => host.length > 253 || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host))) throw new Error("允许的域名必须填写准确主机名");
  result.allowedEnv = [...new Set(result.allowedEnv)];
  if (result.allowedEnv.some((name) => !/^[A-Za-z_][A-Za-z0-9_]{0,79}$/.test(name) || BASE_ENV.has(name.toUpperCase()) || UNSAFE_ENV.test(name))) throw new Error("凭据变量名单包含保留变量或无效名称");
  if (result.backend !== "local") result.fileScope = "workspace";
  return result;
}

export function intersectExecution(parent, child) {
  const upper = executionConfiguration(parent), own = executionConfiguration(child);
  const hosts = upper.allowedHosts.length && own.allowedHosts.length ? own.allowedHosts.filter((host) => upper.allowedHosts.includes(host)) : upper.allowedHosts.length ? upper.allowedHosts : own.allowedHosts;
  return executionConfiguration({ ...own,
    ...(upper.backend !== "local" ? { backend: upper.backend, image: upper.image } : {}),
    fileScope: upper.fileScope === "workspace" || own.fileScope === "workspace" ? "workspace" : "any",
    workspaceAccess: upper.workspaceAccess === "read_only" || own.workspaceAccess === "read_only" ? "read_only" : "read_write",
    network: upper.network === "deny" || own.network === "deny" || (upper.allowedHosts.length && own.allowedHosts.length && !hosts.length) ? "deny" : "allow",
    allowedHosts: hosts, allowedEnv: own.allowedEnv.filter((name) => upper.allowedEnv.includes(name)),
  });
}

export function toolEnvironment(configuration, environment = process.env, container = false) {
  const policy = executionConfiguration(configuration);
  const allowed = new Set(policy.allowedEnv);
  return Object.fromEntries(Object.entries(environment).filter(([name, value]) => typeof value === "string"
    && (allowed.has(name) || (!container && BASE_ENV.has(name.toUpperCase())))));
}

export function assertCredentialReferences(raw, configuration) {
  const allowed = executionConfiguration(configuration).allowedEnv;
  for (const [, name] of String(raw).matchAll(/\{\{env:([A-Za-z_][A-Za-z0-9_]*)\}\}/g)) {
    if (!allowed.includes(name)) throw new Error(`组合尚未授权工具凭据变量：${name}`);
  }
}

export function restrictedExecution(configuration) {
  const policy = executionConfiguration(configuration);
  return policy.backend !== "local" || policy.fileScope === "workspace" || policy.workspaceAccess === "read_only" || policy.network === "deny" || policy.allowedHosts.length > 0;
}
export function sandboxToolInput(cwd, input, configuration) {
  if (executionConfiguration(configuration).backend !== "docker" || !input) return input;
  const result = { ...input };
  for (const key of ["path", "file_path", "directory", "dir"]) {
    if (typeof result[key] === "string" && /^\/workspace(?:\/|$)/.test(result[key])) result[key] = join(cwd, result[key].replace(/^\/workspace\/?/, ""));
  }
  return result;
}
