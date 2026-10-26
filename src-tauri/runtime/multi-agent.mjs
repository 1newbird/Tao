import { randomUUID } from "node:crypto";
import { intersectExecution } from "./execution-policy.mjs";
import { intersectWeb, WEB_TOOL_NAMES } from "./web-tools.mjs";
import { intersectSkills } from "./skills.mjs";
import { intersectMcp, MCP_TOOL_NAMES } from "./mcp-tools.mjs";
import { mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, rmSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, relative, isAbsolute } from "node:path";
import { DOCS_TOOL_NAME } from "./prompt-policy.mjs";

const safeId = (value) => typeof value === "string" && /^[\w-]{1,160}$/.test(value);
export const visibleText = (value, max = 32000) => String(value ?? "").replace(/(Bearer\s+)[^\s"']+/gi, "$1[已隐藏]").replace(/((?:api[_-]?key|access[_-]?token|password|secret)\s*[=:]\s*["']?)[^\s"',;}]+/gi, "$1[已隐藏]").slice(0, max);

function teamFolder(directory, conversationId) {
  if (!safeId(conversationId)) throw new Error("主会话 ID 无效");
  const base = realpathSync(directory);
  const folder = realpathSync(join(base, conversationId));
  const diff = relative(base, folder);
  if (diff.startsWith("..") || isAbsolute(diff)) throw new Error("协作记录目录越界");
  return folder;
}

export function readTeamRecord(directory, conversationId, runId) {
  if (!safeId(runId)) throw new Error("协作轮次 ID 无效");
  const folder = teamFolder(directory, conversationId);
  const path = realpathSync(join(folder, `${runId}.json`));
  if (relative(folder, path) !== `${runId}.json` || statSync(path).size > 64 * 1024 * 1024) throw new Error("协作记录路径或大小无效");
  const record = JSON.parse(readFileSync(path, "utf8"));
  if (record.schemaVersion !== 1 || record.conversationId !== conversationId || record.runId !== runId || !Array.isArray(record.agents) || !Array.isArray(record.tasks) || !Array.isArray(record.attempts)) throw new Error("协作记录归属或格式无效");
  return record;
}

export function listTeamRuns(directory, conversationId) {
  let folder;
  try { folder = teamFolder(directory, conversationId); } catch (error) { if (error.code === "ENOENT") return { runs: [], warnings: [] }; throw error; }
  const warnings = [];
  const names = readdirSync(folder).filter((name) => /^[\w-]+\.json$/.test(name));
  if (names.length > 50) warnings.push("当前显示最近 50 轮协作历史");
  const files = names.map((name) => ({ name, time: statSync(join(folder, name)).mtimeMs })).sort((a, b) => b.time - a.time).slice(0, 50);
  const runs = files.flatMap(({ name }) => {
    try { const record = readTeamRecord(directory, conversationId, name.slice(0, -5)); return [{ runId: record.runId, createdAt: record.createdAt, closed: record.closed, members: record.agents.length, tasks: record.tasks.length }]; }
    catch { warnings.push(`记录 ${name} 无法读取`); return []; }
  });
  return { runs, warnings };
}

/** Explicit allowlist: never serialize configuration, reasoning, tool args/results or Session JSONL. */
export function teamView(record, { agentId, eventLimit = 100 } = {}) {
  if (!Number.isInteger(eventLimit) || eventLimit < 1 || eventLimit > 1000) throw new Error("记录数量须在 1–1000 之间");
  if (agentId && !record.agents.some((agent) => agent.id === agentId)) throw new Error("成员不属于该轮协作");
  const events = (record.viewEvents ?? []).filter((event) => !agentId || event.agentId === agentId);
  return {
    runId: record.runId, conversationId: record.conversationId, rootAgentId: record.rootAgentId, createdAt: record.createdAt, closed: record.closed, closeReason: visibleText(record.closeReason, 500), sequence: record.sequence,
    agents: record.agents.map((agent) => ({ id: agent.id, taskId: agent.taskId, state: agent.state, retired: Boolean(agent.retired), name: visibleText(agent.snapshot?.name, 120), profileId: agent.snapshot?.profileId, revision: agent.snapshot?.revision })),
    tasks: record.tasks.map((task) => ({ id: task.id, title: visibleText(task.title, 120), description: agentId && (task.assignedAgentId === agentId || record.attempts.some((attempt) => attempt.taskId === task.id && attempt.agentId === agentId)) ? visibleText(task.description, 16000) : "", state: task.state, version: task.version, assignedAgentId: task.assignedAgentId, attemptId: task.attemptId, dependsOn: task.dependsOn ?? [], reviewedAt: task.reviewedAt })),
    attempts: record.attempts.filter((attempt) => !agentId || attempt.agentId === agentId).map((attempt) => ({ id: attempt.id, taskId: attempt.taskId, agentId: attempt.agentId, generation: attempt.generation, state: attempt.state, startedAt: attempt.startedAt, endedAt: attempt.endedAt, result: visibleText(attempt.result), error: visibleText(attempt.error, 500), resultTruncated: attempt.resultTruncated, retryReason: visibleText(attempt.retryReason, 1000), modelTurns: attempt.modelTurns, usage: Object.fromEntries(Object.entries(attempt.usage ?? {}).filter(([, value]) => typeof value === "number" && Number.isFinite(value))) })),
    messages: (record.messages ?? []).filter((message) => !agentId || message.from === agentId || message.to === agentId).map((message) => ({ id: message.id, from: message.from, to: message.to, kind: message.kind, body: visibleText(message.body, 4000), delivery: message.delivery, deliveryReason: visibleText(message.deliveryReason, 300), createdAt: message.createdAt, deliveredAt: message.deliveredAt, fromTaskId: message.fromTaskId, toTaskId: message.toTaskId, targetAttemptId: message.targetAttemptId, replyTo: message.replyTo })),
    events: events.slice(-eventLimit).map((event) => ({ id: event.id, agentId: event.agentId, taskId: event.taskId, attemptId: event.attemptId, kind: event.kind, text: visibleText(event.text), status: event.status, createdAt: event.createdAt })),
    hasEarlierEvents: events.length > eventLimit, droppedEvents: record.droppedEvents ?? 0,
  };
}

export function userCommandFingerprint(command) {
  return JSON.stringify([command.action, command.agentId ?? null, command.taskId ?? null, command.attemptId ?? null, command.expectedVersion ?? null, command.body ?? null, command.taskName ?? null]);
}

export const CHILD_COORDINATION_TOOLS = ["list_agents", "send_message", "read_agent_messages", "cancel_agent", "list_tasks", "claim_task"];
export const COORDINATION_TOOLS = ["spawn_agent", "get_agent_status", "wait_agent", "cancel_agent", "review_agent_task", "list_agents", "send_message", "read_agent_messages", "followup_task", "create_task", "list_tasks", "claim_task", "assign_task", "retry_agent_task", "cancel_task"];
const MESSAGE_KINDS = ["finding", "question", "suggestion", "reply", "cancel_request", "notice"];
const BUILTINS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const TERMINAL = new Set(["submitted", "failed", "cancelled", "interrupted"]);
const TASK_TERMINAL = new Set([...TERMINAL, "accepted", "rejected"]);
export const DEFAULT_DELEGATION = Object.freeze({ enabled: false, allowedProfileIds: [], maxConcurrent: 3, maxTasks: 8, timeoutMs: 600_000, maxTurns: 32 });

export function delegationOptions(value = {}) {
  const result = { ...DEFAULT_DELEGATION, ...value };
  for (const [key, min, max] of [["maxConcurrent", 1, 4], ["maxTasks", 1, 32], ["timeoutMs", 1000, 1_200_000], ["maxTurns", 1, 100]]) {
    if (!Number.isInteger(result[key]) || result[key] < min || result[key] > max) throw new Error(`委派配置 ${key} 超出允许范围`);
  }
  if (typeof result.enabled !== "boolean" || !Array.isArray(result.allowedProfileIds) || result.allowedProfileIds.length > 100 || result.allowedProfileIds.some((id) => typeof id !== "string" || !/^[\w-]{1,100}$/.test(id))) throw new Error("委派组合列表无效");
  return structuredClone(result);
}

function availableBuiltins(profile) {
  return profile.toolMode === "custom" ? BUILTINS.filter((name) => profile.enabledTools?.includes(name)) : ["read", "bash", "edit", "write"];
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]));
  return value;
}

function toolDefinition(tool) {
  const { permissionMode, enabled, ...definition } = tool;
  return JSON.stringify(canonical(definition));
}

function stricterMode(a, b) {
  if (a === "deny" || b === "deny") return "deny";
  if (a === "ask" || b === "ask") return "ask";
  // A child's explicit allow cannot turn the parent's inherited policy into allow.
  return a === "allow" && b === "allow" ? "allow" : "inherit";
}

export function restrictChildConfiguration(parent, child) {
  const result = structuredClone(child);
  result.execution = intersectExecution(parent.execution, child.execution);
  result.web = intersectWeb(parent.web, child.web);
  result.mcpServers = intersectMcp(parent, child);
  result.toolMode = "custom";
  result.enabledTools = availableBuiltins(child).filter((name) => availableBuiltins(parent).includes(name));
  result.customTools = (child.customTools ?? []).filter((tool) => tool.enabled).flatMap((tool) => {
    const upper = (parent.customTools ?? []).find((candidate) => candidate.enabled && candidate.id === tool.id && candidate.name === tool.name && toolDefinition(candidate) === toolDefinition(tool));
    const upperMode = upper?.permissionMode ?? "ask";
    const ownMode = tool.permissionMode ?? "ask";
    return upper ? [{ ...tool, permissionMode: upperMode === "deny" || ownMode === "deny" ? "deny" : upperMode === "ask" || ownMode === "ask" ? "ask" : "allow" }] : [];
  });
  result.toolPermissions = {};
  for (const name of [...BUILTINS, ...WEB_TOOL_NAMES, ...MCP_TOOL_NAMES, ...COORDINATION_TOOLS, DOCS_TOOL_NAME, ...result.customTools.map((tool) => tool.name)]) {
    const upper = parent.toolPermissions?.[name];
    const own = child.toolPermissions?.[name];
    result.toolPermissions[name] = {
      mode: stricterMode(upper?.mode ?? "inherit", own?.mode ?? "inherit"),
      pathScope: upper?.pathScope === "workspace" || own?.pathScope === "workspace" ? "workspace" : "any",
    };
  }
  result.skillsEnabled = Boolean(parent.skillsEnabled && child.skillsEnabled);
  // Global skill installation is an explicit main-session application action.
  result.skillInstallEnabled = false;
  result.enabledSkills = intersectSkills(parent, child);
  // Arbitrary extensions can register tools outside this intersection. Until
  // their capabilities are declared, delegated sessions do not load extensions.
  result.extensionsEnabled = false;
  result.delegation = { ...DEFAULT_DELEGATION, allowedProfileIds: [] };
  return result;
}

export function writeTeamRecord(path, record) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = openSync(temporary, "wx");
    writeFileSync(fd, `${JSON.stringify(record)}\n`, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    // Windows readers/virus scanners can briefly hold the destination without
    // delete sharing. Keep the atomic rename and bounded synchronous ownership;
    // never remove the old record to work around a sharing violation.
    for (let retry = 0; ; retry++) {
      try { renameSync(temporary, path); break; }
      catch (error) {
        if (process.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(error.code) || retry >= 5) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (retry + 1));
      }
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(temporary, { force: true });
  }
}

export function recoverInterruptedTeams(directory) {
  const warnings = [];
  let folders;
  try { folders = readdirSync(directory, { withFileTypes: true }); } catch (error) { if (error.code === "ENOENT") return warnings; throw error; }
  for (const folder of folders) {
    if (!folder.isDirectory() || !/^[\w-]{1,160}$/.test(folder.name)) continue;
    for (const file of readdirSync(join(directory, folder.name), { withFileTypes: true })) {
      if (!file.isFile() || !/^[\w-]+\.json$/.test(file.name)) continue;
      const path = join(directory, folder.name, file.name);
      try {
        const record = JSON.parse(readFileSync(path, "utf8"));
        if (record.schemaVersion !== 1 || !Array.isArray(record.tasks) || !Array.isArray(record.attempts) || !Array.isArray(record.agents)) throw new Error("记录格式无效");
        if (record.closed && record.tasks.every((task) => TASK_TERMINAL.has(task.state)) && record.attempts.every((attempt) => TERMINAL.has(attempt.state)) && record.agents.every((agent) => agent.state === "closed")) continue;
        for (const attempt of record.attempts) if (!TERMINAL.has(attempt.state)) { attempt.state = "interrupted"; attempt.error = "Runtime 已退出；未自动重试，已有操作不会回滚"; attempt.endedAt = Date.now(); if (attempt.lease) attempt.lease.releasedAt = Date.now(); }
        for (const task of record.tasks) if (!TASK_TERMINAL.has(task.state)) { task.state = "interrupted"; task.version += 1; task.sequence = record.sequence = (record.sequence ?? 0) + 1; }
        for (const agent of record.agents) agent.state = "closed";
        for (const event of record.viewEvents ?? []) if (event.status === "running") event.status = "stopped";
        for (const message of record.messages ?? []) if (message.delivery === "queued") { message.delivery = "undelivered"; message.deliveryReason = "Runtime 已退出"; }
        record.closed = true;
        record.closeReason = "Runtime 重启";
        writeTeamRecord(path, record);
      } catch {
        // Keep the damaged record for diagnosis; one file must not block boot.
        warnings.push(`无法恢复多智能体记录：${folder.name}/${file.name}`);
      }
    }
  }
  return warnings;
}

/** One root request owns a coordinator. No global actor IDs or cross-tree lookup. */
export class AgentCoordinator {
  constructor({ directory, conversationId, requestId, configuration, profiles, environment = {}, adapter, onChange = () => {}, onMessage = () => {} }) {
    this.options = delegationOptions(configuration.delegation);
    if (!this.options.enabled) throw new Error("当前组合未启用子代理");
    this.configuration = structuredClone(configuration);
    this.profiles = structuredClone(profiles ?? []);
    this.adapter = adapter;
    this.onChange = onChange;
    this.onMessage = onMessage;
    this.running = new Map();
    this.retrying = new Set();
    this.userCommands = new Map();
    this.listeners = new Set();
    this.fatal = null;
    if (typeof conversationId !== "string" || !/^[\w-]{1,160}$/.test(conversationId)) throw new Error("主会话 ID 无效");
    const runId = randomUUID();
    const folder = join(directory, conversationId);
    mkdirSync(folder, { recursive: true });
    this.path = join(folder, `${runId}.json`);
    this.record = { schemaVersion: 1, runId, conversationId, requestId, environment: structuredClone(environment), rootAgentId: `agent-${randomUUID()}`, createdAt: Date.now(), closed: false, sequence: 0, agents: [], tasks: [], attempts: [], messages: [], commands: [] };
    this.save();
  }

  save() {
    try { writeTeamRecord(this.path, this.record); }
    catch (error) {
      this.fatal = new Error(`多智能体状态保存失败：${error.message}`);
      for (const entry of this.running.values()) entry.controller.abort(this.fatal);
      for (const listener of this.listeners) listener();
      throw this.fatal;
    }
    for (const listener of this.listeners) listener();
  }

  assertOpen() {
    if (this.fatal) throw this.fatal;
    if (this.record.closed) throw new Error("本轮任务树已经结束");
  }

  entry(agentId) {
    const agent = this.record.agents.find((item) => item.id === agentId);
    if (!agent) throw new Error("子代理不属于当前任务树");
    if (!agent.taskId) return { agent, task: null, attempt: null };
    return { ...this.taskEntry(agent.taskId), agent };
  }

  taskEntry(taskId) {
    const task = this.record.tasks.find((item) => item.id === taskId);
    if (!task) throw new Error("任务不属于当前任务树");
    const agent = this.record.agents.find((item) => item.id === task.assignedAgentId);
    const attempt = this.record.attempts.find((item) => item.id === task.attemptId);
    return { agent: agent ?? null, task, attempt: attempt ?? null };
  }

  snapshot(agentId, internal = false) {
    const entry = this.entry(agentId);
    return this.publicSnapshot(entry, internal);
  }

  taskSnapshot(taskId, internal = false) {
    return this.publicSnapshot(this.taskEntry(taskId), internal);
  }

  publicSnapshot(entry, internal = false) {
    const result = structuredClone(entry);
    if (!internal) {
      if (result.agent) {
        const { profileId, name, revision } = result.agent.snapshot;
        result.agent.snapshot = { profileId, name, revision };
      }
      if (result.task) delete result.task.description;
      if (result.attempt?.result?.length > 8000) { result.attempt.result = result.attempt.result.slice(0, 8000); result.attempt.resultTruncated = true; }
    }
    return result;
  }

  status(agentIds) {
    if (this.fatal) throw this.fatal;
    const ids = agentIds ?? this.record.agents.map((agent) => agent.id);
    if (!Array.isArray(ids) || ids.length > 32) throw new Error("子代理列表无效");
    return { runId: this.record.runId, rootAgentId: this.record.rootAgentId, sequence: this.record.sequence, closed: this.record.closed, members: ids.map((id) => this.snapshot(id)), tasks: this.record.tasks.filter((task) => !agentIds || ids.includes(task.assignedAgentId)).map((task) => this.taskSnapshot(task.id)) };
  }

  changeTask(taskId, state, fields = {}) {
    const { agent, task, attempt } = this.taskEntry(taskId);
    const expiredMessages = [];
    if (attempt) {
      attempt.state = state;
      Object.assign(attempt, fields);
      attempt.sequence = this.record.sequence + 1;
      if (TERMINAL.has(state) && attempt.lease) attempt.lease.releasedAt = Date.now();
    }
    task.sequence = ++this.record.sequence;
    task.version += 1;
    task.state = state;
    if (TERMINAL.has(state)) {
      for (const message of this.record.messages) if (attempt && message.delivery === "queued" && message.targetAttemptId === attempt.id) {
        message.delivery = "undelivered";
        message.deliveryReason = "目标执行尝试已经结束，未转交后续任务";
        expiredMessages.push(message);
      }
      for (const event of this.record.viewEvents ?? []) if (attempt && event.attemptId === attempt.id && event.status === "running") event.status = state === "submitted" ? "completed" : state === "failed" ? "error" : "stopped";
    }
    if (agent?.taskId === taskId) agent.state = TERMINAL.has(state) ? agent.retired ? "cancelled" : "idle" : state;
    this.save();
    this.onChange(this.taskSnapshot(taskId));
    for (const message of expiredMessages) this.onMessage(this.publicMessage(message));
  }

  validateTask(taskName, description) {
    if (typeof taskName !== "string" || !taskName.trim() || taskName.length > 120 || typeof description !== "string" || !description.trim() || description.length > 16_000) throw new Error("子任务需要名称（最多 120 字符）及说明（最多 16000 字符）");
    if (this.record.tasks.length >= this.options.maxTasks) throw new Error("已达到本轮子任务数量上限");
  }

  createTask(agent, taskName, description) {
    const taskId = `task-${randomUUID()}`;
    const attemptId = `attempt-${randomUUID()}`;
    this.record.tasks.push({ id: taskId, version: 1, title: taskName.trim(), description: description.trim(), assignedAgentId: agent.id, attemptId, state: "queued", createdAt: Date.now() });
    this.record.attempts.push({ id: attemptId, taskId, agentId: agent.id, generation: 1, state: "queued" });
    if (!agent.taskId || (!this.running.has(agent.id) && TERMINAL.has(this.entry(agent.id).attempt?.state))) agent.taskId = taskId;
    this.changeTask(taskId, "queued");
    queueMicrotask(() => this.drain());
    return { agentId: agent.id, taskId, attemptId, state: "queued" };
  }

  spawn({ profileId, taskName, description }) {
    this.assertOpen();
    this.validateTask(taskName, description);
    const agent = this.newAgent(profileId);
    return this.createTask(agent, taskName, description);
  }

  newAgent(profileId) {
    if (this.record.agents.length >= 32) throw new Error("已达到本轮成员数量上限 32");
    if (!this.options.allowedProfileIds.includes(profileId)) throw new Error("该组合未获准用于子代理");
    const profile = this.profiles.find((item) => item.profileId === profileId);
    if (!profile) throw new Error("获准的子代理组合不存在，请重新选择组合");
    const snapshot = { ...structuredClone(profile), configuration: restrictChildConfiguration(this.configuration, profile.configuration) };
    const agentId = `agent-${randomUUID()}`;
    const environment = this.record.environment;
    const model = { provider: snapshot.defaultModel?.provider || environment.provider, model: snapshot.defaultModel?.model || environment.model, thinkingLevel: snapshot.defaultModel?.thinkingLevel || environment.thinkingLevel };
    const agent = { id: agentId, parentId: this.record.rootAgentId, taskId: null, state: "queued", snapshot, model, cwd: environment.workspacePath };
    this.record.agents.push(agent);
    return agent;
  }

  assertActor(actorId, attemptId) {
    this.assertOpen();
    if (actorId === this.record.rootAgentId) return null;
    const entry = this.entry(actorId);
    const running = this.running.get(actorId);
    if (!attemptId || entry.attempt?.id !== attemptId || running?.taskId !== entry.task?.id || running.controller.signal.aborted || TERMINAL.has(entry.attempt.state) || entry.agent.retired) throw new Error("成员执行尝试已结束或不属于当前任务");
    return entry;
  }

  roster(actorId, attemptId) {
    this.assertActor(actorId, attemptId);
    return { self: actorId, parent: this.record.rootAgentId, members: this.record.agents.map((agent) => ({ agentId: agent.id, taskId: agent.taskId, taskName: this.entry(agent.id).task?.title ?? "空闲成员", state: agent.state, profileName: agent.snapshot.name, queuedTasks: this.record.tasks.filter((task) => task.assignedAgentId === agent.id && task.state === "queued").length })) };
  }

  followup(actorId, { agentId, taskName, description, requestKey }) {
    this.assertActor(actorId);
    if (actorId !== this.record.rootAgentId) throw new Error("只有主代理可以追加任务");
    const fingerprint = JSON.stringify(["followup", agentId, taskName, description]);
    const duplicate = this.commandDuplicate(requestKey, fingerprint);
    if (duplicate) return duplicate;
    const { agent } = this.entry(agentId);
    if (agent.retired) throw new Error("已取消的成员不能接续任务，请创建新成员");
    this.validateTask(taskName, description);
    const result = this.createTask(agent, taskName, description);
    return this.recordCommand(requestKey, fingerprint, result);
  }

  validateRequestKey(key) {
    if (typeof key !== "string" || !/^[A-Za-z0-9_.:-]{1,100}$/.test(key)) throw new Error("请求键需为 1–100 个字母、数字或 . _ : -");
  }

  assertRoot(actorId) {
    this.assertActor(actorId);
    if (actorId !== this.record.rootAgentId) throw new Error("只有主代理可以管理任务板");
  }

  commandDuplicate(requestKey, fingerprint) {
    this.validateRequestKey(requestKey);
    const previous = this.record.commands.find((command) => command.requestKey === requestKey);
    if (!previous) return null;
    if (previous.fingerprint !== fingerprint) throw new Error("同一请求键不能用于不同任务操作");
    return { ...structuredClone(previous.result), duplicate: true };
  }

  recordCommand(requestKey, fingerprint, result) {
    this.record.commands.push({ requestKey, fingerprint, result: structuredClone(result) });
    this.save();
    return result;
  }

  dependenciesReady(task) {
    return (task.dependsOn ?? []).every((id) => this.taskEntry(id).task.state === "accepted");
  }

  createBoardTask(actorId, { taskName, description, eligibleProfileIds = this.options.allowedProfileIds, dependsOn, requestKey }) {
    this.assertRoot(actorId);
    if (!Array.isArray(dependsOn)) throw new Error("创建任务必须显式填写 dependsOn；没有前置依赖时填写 []，说明文字不会建立依赖");
    const fingerprint = JSON.stringify(["create", taskName, description, eligibleProfileIds, dependsOn]);
    const duplicate = this.commandDuplicate(requestKey, fingerprint);
    if (duplicate) return duplicate;
    this.validateTask(taskName, description);
    if (!Array.isArray(eligibleProfileIds) || !eligibleProfileIds.length || eligibleProfileIds.length > 100 || new Set(eligibleProfileIds).size !== eligibleProfileIds.length || eligibleProfileIds.some((id) => !this.options.allowedProfileIds.includes(id) || !this.profiles.some((profile) => profile.profileId === id))) throw new Error("任务执行组合必须来自本轮获准组合且不能重复");
    if (!Array.isArray(dependsOn) || dependsOn.length > 32 || new Set(dependsOn).size !== dependsOn.length) throw new Error("任务依赖无效或重复");
    // Only existing tasks can be referenced; immutable edges cannot form cycles.
    for (const id of dependsOn) this.taskEntry(id);
    const task = { id: `task-${randomUUID()}`, version: 1, title: taskName.trim(), description: description.trim(), shared: true, eligibleProfileIds: [...eligibleProfileIds], dependsOn: [...dependsOn], assignedAgentId: null, attemptId: null, createdAt: Date.now() };
    task.state = this.dependenciesReady(task) ? "pending" : "blocked";
    task.sequence = ++this.record.sequence;
    this.record.tasks.push(task);
    const result = { taskId: task.id, version: task.version, state: task.state, dependsOn: [...task.dependsOn], eligibleProfileIds: [...task.eligibleProfileIds] };
    this.recordCommand(requestKey, fingerprint, result);
    this.onChange(this.taskSnapshot(task.id));
    return result;
  }

  listTasks(actorId, attemptId) {
    const actor = this.assertActor(actorId, attemptId);
    return { sequence: this.record.sequence, tasks: this.record.tasks.filter((task) => task.shared).map((task) => ({
      taskId: task.id, version: task.version, title: task.title, description: task.description,
      state: task.state, assignedAgentId: task.assignedAgentId, eligibleProfileIds: [...task.eligibleProfileIds],
      dependsOn: [...task.dependsOn], generation: this.taskEntry(task.id).attempt?.generation ?? 0,
      claimable: task.state === "pending" && this.dependenciesReady(task) && (!actor || task.eligibleProfileIds.includes(actor.agent.snapshot.profileId)),
    })) };
  }

  checkVersion(task, expectedVersion) {
    if (!Number.isInteger(expectedVersion) || task.version !== expectedVersion) throw new Error("任务版本已变化，请重新读取任务板或状态");
  }

  resolveAssignee(task, { agentId, profileId }) {
    if (Boolean(agentId) === Boolean(profileId)) throw new Error("必须指定 agentId 或 profileId 其中一个");
    const agent = agentId ? this.entry(agentId).agent : null;
    const targetProfile = agent?.snapshot.profileId ?? profileId;
    if (!(task.eligibleProfileIds ?? [this.taskEntry(task.id).agent?.snapshot.profileId]).includes(targetProfile)) throw new Error("该成员组合不在任务获准执行范围");
    if (agent?.retired) throw new Error("已取消的成员不能接续任务，请创建新成员");
    return agent ?? this.newAgent(profileId);
  }

  attachTask(task, agent) {
    const generation = this.record.attempts.filter((attempt) => attempt.taskId === task.id).length + 1;
    if (generation > 3 || this.record.attempts.length >= this.options.maxTasks * 3) throw new Error("已达到执行尝试上限（每任务最多三次）");
    const previousAgent = this.record.agents.find((item) => item.id === task.assignedAgentId);
    if (previousAgent && previousAgent.id !== agent.id && previousAgent.taskId === task.id) {
      previousAgent.taskId = this.record.tasks.findLast((item) => item.id !== task.id && item.assignedAgentId === previousAgent.id)?.id ?? null;
    }
    const attemptId = `attempt-${randomUUID()}`;
    task.assignedAgentId = agent.id;
    task.attemptId = attemptId;
    delete task.reviewedAt;
    this.record.attempts.push({ id: attemptId, taskId: task.id, agentId: agent.id, generation, state: "queued" });
    if (!agent.taskId || (!this.running.has(agent.id) && TASK_TERMINAL.has(this.entry(agent.id).task?.state))) agent.taskId = task.id;
    this.changeTask(task.id, "queued");
    queueMicrotask(() => this.drain());
    return { agentId: agent.id, taskId: task.id, attemptId, generation, version: task.version, state: task.state };
  }

  claimTask(actorId, { taskId, expectedVersion }, attemptId) {
    const actor = this.assertActor(actorId, attemptId);
    if (!actor) throw new Error("主代理请使用 assign_task 分配任务");
    const { task } = this.taskEntry(taskId);
    this.checkVersion(task, expectedVersion);
    if (!task.shared || task.state !== "pending" || !this.dependenciesReady(task) || this.retrying.has(task.id)) throw new Error("任务尚不可认领或已经有负责人");
    if (!task.eligibleProfileIds.includes(actor.agent.snapshot.profileId)) throw new Error("该成员组合不在任务获准执行范围");
    if (this.record.tasks.some((item) => item.shared && item.assignedAgentId === actorId && item.state === "queued")) throw new Error("每位成员最多预领一个后续任务，请先完成当前任务");
    // No await between version comparison, ownership update and durable write.
    return this.attachTask(task, actor.agent);
  }

  assignTask(actorId, { taskId, expectedVersion, agentId, profileId, requestKey }) {
    this.assertRoot(actorId);
    const fingerprint = JSON.stringify(["assign", taskId, expectedVersion, agentId ?? null, profileId ?? null]);
    const duplicate = this.commandDuplicate(requestKey, fingerprint);
    if (duplicate) return duplicate;
    const { task } = this.taskEntry(taskId);
    this.checkVersion(task, expectedVersion);
    if (!task.shared || task.state !== "pending" || !this.dependenciesReady(task) || this.retrying.has(task.id)) throw new Error("任务尚不可分配或已经有负责人");
    const agent = this.resolveAssignee(task, { agentId, profileId });
    return this.recordCommand(requestKey, fingerprint, this.attachTask(task, agent));
  }

  async retryTask(actorId, { taskId, expectedVersion, agentId, profileId, acknowledgeSideEffects, reason, requestKey }) {
    this.assertRoot(actorId);
    const fingerprint = JSON.stringify(["retry", taskId, expectedVersion, agentId ?? null, profileId ?? null, acknowledgeSideEffects, reason]);
    const duplicate = this.commandDuplicate(requestKey, fingerprint);
    if (duplicate) return duplicate;
    const { task, attempt } = this.taskEntry(taskId);
    this.checkVersion(task, expectedVersion);
    if (!["failed", "rejected", "cancelled", "interrupted"].includes(task.state) || (attempt && !TERMINAL.has(attempt.state))) throw new Error("仅失败、拒绝、取消或中断任务可重试；运行中请先 cancel_task 并等待停止");
    if (acknowledgeSideEffects !== true || typeof reason !== "string" || !reason.trim() || reason.length > 1000) throw new Error("重试必须说明原因并确认已有文件和外部操作不会回滚，避免重复副作用");
    if (this.retrying.has(taskId)) throw new Error("任务正在重新分配");
    if (this.record.attempts.filter((item) => item.taskId === taskId).length >= 3) throw new Error("已达到执行尝试上限（每任务最多三次）");
    this.retrying.add(taskId);
    try {
      const oldExecution = this.running.get(attempt?.agentId);
      if (oldExecution?.taskId === taskId) await oldExecution.promise;
      this.assertRoot(actorId);
      this.checkVersion(task, expectedVersion);
      if (!this.dependenciesReady(task)) throw new Error("前置任务尚未验收，不能重试执行");
      const agent = this.resolveAssignee(task, { agentId, profileId });
      const result = this.attachTask(task, agent);
      const nextAttempt = this.taskEntry(taskId).attempt;
      nextAttempt.retryReason = reason.trim();
      nextAttempt.acknowledgeSideEffects = true;
      return this.recordCommand(requestKey, fingerprint, result);
    } finally { this.retrying.delete(taskId); }
  }

  async cancelTask(actorId, { taskId, expectedVersion, requestKey }) {
    this.assertRoot(actorId);
    const fingerprint = JSON.stringify(["cancel", taskId, expectedVersion]);
    const duplicate = this.commandDuplicate(requestKey, fingerprint);
    if (duplicate) return duplicate;
    const { task, attempt } = this.taskEntry(taskId);
    this.checkVersion(task, expectedVersion);
    if (TASK_TERMINAL.has(task.state) || this.retrying.has(taskId)) throw new Error("任务已经结束或正在重新分配");
    const execution = this.running.get(attempt?.agentId);
    if (execution?.taskId === taskId) {
      execution.controller.abort(new Error("主代理取消了任务"));
      this.changeTask(taskId, "cancelling");
      await execution.promise;
      this.assertRoot(actorId);
    } else this.changeTask(taskId, "cancelled", { endedAt: Date.now(), error: "主代理取消了任务" });
    return this.recordCommand(requestKey, fingerprint, { taskId, version: task.version, state: task.state });
  }

  send(actorId, { recipient, body, kind = "finding", requestKey, replyTo }, attemptId) {
    const sender = this.assertActor(actorId, attemptId);
    this.validateRequestKey(requestKey);
    const to = recipient === "parent" ? this.record.rootAgentId : recipient;
    if (to === actorId) throw new Error("请勿向自己发送协作消息");
    const target = to === this.record.rootAgentId ? null : this.entry(to);
    if (typeof body !== "string" || !body.trim() || body.length > 4000 || !MESSAGE_KINDS.includes(kind)) throw new Error("消息类型无效或正文超过 4000 字符");
    if (replyTo && !this.record.messages.some((message) => message.id === replyTo && message.to === actorId && message.from === to)) throw new Error("回复消息不属于当前通信双方");
    const fingerprint = JSON.stringify([to, body, kind, replyTo ?? null]);
    const previous = this.record.messages.find((message) => message.from === actorId && message.fromAttemptId === (attemptId ?? null) && message.requestKey === requestKey);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new Error("同一请求键不能用于不同消息");
      return this.messageReceipt(previous, true);
    }
    if (target?.agent.retired) throw new Error("目标成员已取消，无法接收新消息");
    if (this.record.messages.length >= 128 || this.record.messages.filter((message) => message.from === actorId).length >= 32 || this.record.messages.filter((message) => message.to === to && message.delivery === "queued").length >= 32) throw new Error("消息数量达到本轮或目标邮箱上限");
    const message = { id: `message-${randomUUID()}`, sequence: ++this.record.sequence, from: actorId, to, fromTaskId: sender?.task?.id ?? null, fromAttemptId: attemptId ?? null, toTaskId: target?.task?.id ?? null, kind, body: body.trim(), requestKey, fingerprint, ...(replyTo ? { replyTo } : {}), createdAt: Date.now(), delivery: "queued" };
    this.record.messages.push(message);
    this.save(); // Publishing and wakeups happen only after a successful write.
    this.onMessage(this.publicMessage(message));
    return this.messageReceipt(message);
  }

  messageReceipt(message, duplicate = false) { return { messageId: message.id, sequence: message.sequence, recipient: message.to, delivery: message.delivery, duplicate }; }

  publicMessage(message) { const { fingerprint, requestKey, ...publicValue } = message; return structuredClone(publicValue); }

  recordVisible(agentId, taskId, attemptId, { id, kind, text, status = "completed" }) {
    const attempt = this.record.attempts.find((item) => item.id === attemptId && item.agentId === agentId && item.taskId === taskId);
    if (!attempt || TERMINAL.has(attempt.state) || this.record.closed) return;
    if (!["assistant", "tool"].includes(kind)) throw new Error("不可见的执行记录类型");
    const events = this.record.viewEvents ??= [];
    const previous = events.find((event) => event.id === id && event.attemptId === attemptId);
    const value = { id, agentId, taskId, attemptId, kind, text: visibleText(text), status, createdAt: previous?.createdAt ?? Date.now() };
    if (previous) Object.assign(previous, value); else events.push(value);
    let size = events.reduce((sum, event) => sum + event.text.length, 0);
    while (events.length > 1200 || (size > 1_000_000 && events.length > 1)) { size -= events.shift().text.length; this.record.droppedEvents = (this.record.droppedEvents ?? 0) + 1; }
    this.save();
  }

  userNotice(body, target = this.record.rootAgentId, scope = {}) {
    const message = { id: `message-${randomUUID()}`, sequence: ++this.record.sequence, from: "user", to: target, kind: "notice", body, createdAt: Date.now(), delivery: this.record.closed ? "undelivered" : "queued", ...(this.record.closed ? { deliveryReason: "本轮协作已经结束" } : {}), ...scope };
    this.record.messages.push(message);
    return message;
  }

  async userControl(command, stopRun) {
    const fingerprint = userCommandFingerprint(command);
    const duplicate = this.commandDuplicate(command.requestKey, fingerprint);
    if (duplicate) return duplicate;
    if (this.userCommands.has(command.requestKey)) {
      const pending = this.userCommands.get(command.requestKey);
      if (pending.fingerprint !== fingerprint) throw new Error("同一请求键不能用于不同操作");
      return pending.promise;
    }
    this.assertOpen();
    if (!["message", "followup", "cancel_task", "cancel_agent", "stop_run"].includes(command.action)) throw new Error("未知成员控制操作");
    const stopping = ["cancel_task", "cancel_agent", "stop_run"].includes(command.action);
    if (!stopping && (this.record.commands.length > 256 || this.record.messages.length > 124)) throw new Error("本轮操作或消息数量达到上限");
    let entry;
    if (command.action !== "stop_run") {
      entry = this.entry(command.agentId);
      if (!entry.task || entry.task.id !== command.taskId || entry.attempt?.id !== command.attemptId || entry.agent.retired) throw new Error("目标任务或执行尝试已变化，请刷新详情");
      this.checkVersion(entry.task, command.expectedVersion);
    }
    if (["message", "followup"].includes(command.action) && (typeof command.body !== "string" || !command.body.trim() || command.body.length > 4000)) throw new Error("请填写说明（最多 4000 字符）");
    if (command.action === "message" && !["queued", "preparing", "running", "waiting_permission"].includes(entry.task.state)) throw new Error("当前任务已经结束，请使用追加任务");
    // Defer execution until the request key has acquired its in-process owner.
    const promise = Promise.resolve().then(async () => {
      this.assertOpen();
      if (entry) {
        const current = this.entry(command.agentId);
        if (current.task?.id !== command.taskId || current.attempt?.id !== command.attemptId || current.agent.retired) throw new Error("目标执行尝试已变化，请刷新详情");
        this.checkVersion(current.task, command.expectedVersion);
        if (command.action === "message" && !["queued", "preparing", "running", "waiting_permission"].includes(current.task.state)) throw new Error("当前任务已经结束，请使用追加任务");
      }
      let result = { action: command.action };
      const messages = [];
      if (command.action === "message") {
        const message = this.userNotice(command.body.trim(), command.agentId, { toTaskId: entry.task.id, targetAttemptId: entry.attempt.id });
        messages.push(message);
        result = { ...result, messageId: message.id, delivery: "queued" };
      } else if (command.action === "followup") {
        if (this.record.tasks.some((task) => task.assignedAgentId === command.agentId && task.state === "queued")) throw new Error("该成员已有排队任务，请完成后再追加");
        result = { ...result, ...this.followup(this.record.rootAgentId, { agentId: command.agentId, taskName: command.taskName, description: command.body, requestKey: `ui-${command.requestKey}` }) };
      } else if (command.action === "cancel_task") {
        result = { ...result, ...await this.cancelTask(this.record.rootAgentId, { taskId: entry.task.id, expectedVersion: entry.task.version, requestKey: `ui-${command.requestKey}` }) };
      } else if (command.action === "cancel_agent") {
        await this.cancel(command.agentId);
      }
      const label = { message: "补充说明", followup: "追加任务", cancel_task: "停止当前任务", cancel_agent: "停止成员及排队任务", stop_run: "停止整轮协作" }[command.action];
      // A full mailbox must never prevent cancellation. The durable command and
      // task state remain the receipt when a notification cannot fit.
      if (this.record.messages.length < 128) messages.push(this.userNotice(`[用户操作] ${entry?.agent.snapshot.name ?? "主会话"}：${label}${command.body ? `\n${command.body.trim()}` : ""}。请核对任务状态；此通知不改变工具权限。`));
      this.recordCommand(command.requestKey, fingerprint, result);
      for (const message of messages) this.onMessage(this.publicMessage(message));
      if (command.action === "stop_run") await stopRun();
      return result;
    });
    this.userCommands.set(command.requestKey, { fingerprint, promise });
    try { return await promise; } finally { this.userCommands.delete(command.requestKey); }
  }

  peekMessages(actorId, attemptId, { afterSequence = 0, includeDelivered = false, limit = 16 } = {}) {
    this.assertActor(actorId, attemptId);
    if (!Number.isInteger(afterSequence) || afterSequence < 0 || !Number.isInteger(limit) || limit < 1 || limit > 32) throw new Error("邮箱游标或数量无效");
    return this.record.messages.filter((message) => message.to === actorId && (!message.targetAttemptId || message.targetAttemptId === attemptId) && message.sequence > afterSequence && (message.delivery === "queued" || (includeDelivered && message.delivery === "delivered"))).slice(0, limit).map((message) => this.publicMessage(message));
  }

  markDelivered(actorId, messageIds, attemptId, via = "context") {
    this.assertActor(actorId, attemptId);
    const selected = messageIds.map((id) => {
      const message = this.record.messages.find((item) => item.id === id && item.to === actorId);
      if (!message) throw new Error("消息不属于当前邮箱");
      return message;
    });
    const changed = selected.filter((message) => message.delivery === "queued");
    for (const message of changed) { message.delivery = "delivered"; message.deliveredAt = Date.now(); message.deliveredVia = via; }
    if (changed.length) {
      this.record.sequence += 1;
      this.save();
      for (const message of changed) this.onMessage(this.publicMessage(message));
    }
  }

  readMessages(actorId, attemptId, options) {
    const messages = this.peekMessages(actorId, attemptId, options);
    this.markDelivered(actorId, messages.map((message) => message.id), attemptId, "tool");
    // Mail pagination uses the last returned message, not the global task/event
    // sequence; otherwise a partial page could skip the remaining older mail.
    const sequence = messages.at(-1)?.sequence ?? options?.afterSequence ?? 0;
    const hasMore = this.peekMessages(actorId, attemptId, { ...options, afterSequence: sequence, limit: 1 }).length > 0;
    return { messages: messages.map((message) => this.publicMessage(this.record.messages.find((item) => item.id === message.id))), sequence, stateSequence: this.record.sequence, hasMore };
  }

  drain() {
    if (this.record.closed || this.fatal) return;
    for (const task of this.record.tasks) {
      if (this.running.size >= this.options.maxConcurrent) break;
      const agent = this.record.agents.find((item) => item.id === task.assignedAgentId);
      if (task.state !== "queued" || !agent || this.running.has(agent.id) || agent.retired) continue;
      agent.taskId = task.id;
      const controller = new AbortController();
      const execution = { controller, promise: null, failure: null, taskId: task.id, attemptId: task.attemptId };
      // Reserve synchronously, before any await, so two spawns cannot overbook.
      this.running.set(agent.id, execution);
      execution.promise = Promise.resolve().then(() => this.execute(agent.id, execution)).catch((error) => {
        this.fatal ??= error;
        for (const entry of this.running.values()) entry.controller.abort(error);
        for (const listener of this.listeners) listener();
      }).finally(() => { this.running.delete(agent.id); this.drain(); });
    }
  }

  async execute(agentId, execution) {
    const { controller } = execution;
    const taskId = execution.taskId;
    const current = () => this.running.get(agentId) === execution && this.entry(agentId).task?.id === taskId && this.taskEntry(taskId).attempt?.id === execution.attemptId && !TERMINAL.has(this.taskEntry(taskId).attempt.state);
    let timer;
    try {
      controller.signal.throwIfAborted();
      const startedAt = Date.now();
      const attempt = this.taskEntry(taskId).attempt;
      this.changeTask(taskId, "preparing", { startedAt, lease: { ownerAgentId: agentId, attemptId: attempt.id, generation: attempt.generation, expiresAt: startedAt + this.options.timeoutMs } });
      timer = setTimeout(() => {
        if (controller.signal.aborted) return;
        execution.failure = "子任务超过时长限制";
        controller.abort(new Error(execution.failure));
      }, this.options.timeoutMs);
      const result = await this.adapter.run(this.taskSnapshot(taskId, true), {
        signal: controller.signal,
        ready: () => { if (current() && !controller.signal.aborted) this.changeTask(taskId, "running"); },
        fail: (reason) => { if (current()) { execution.failure = reason; controller.abort(new Error(reason)); } },
        reportUsage: (usage, modelTurns) => {
          if (!current()) return;
          const { attempt } = this.taskEntry(taskId);
          attempt.usage = { ...usage };
          attempt.modelTurns = modelTurns;
          this.save();
        },
      });
      controller.signal.throwIfAborted();
      const text = typeof result === "object" && result ? String(result.text) : String(result);
      this.changeTask(taskId, "submitted", { result: text.slice(0, 32_000), resultTruncated: text.length > 32_000, ...(result?.usage ? { usage: result.usage } : {}), endedAt: Date.now() });
    } catch (error) {
      if (this.fatal) throw this.fatal;
      this.changeTask(taskId, controller.signal.aborted && !execution.failure ? "cancelled" : "failed", { error: String(execution.failure ?? error.message ?? error).slice(0, 500), endedAt: Date.now() });
    } finally {
      clearTimeout(timer);
    }
  }

  waiting(agentId, waiting, attemptId) {
    const entry = this.running.get(agentId);
    if (entry && (!attemptId || entry.attemptId === attemptId) && !TERMINAL.has(this.taskEntry(entry.taskId).attempt.state) && !entry.controller.signal.aborted && !this.fatal) this.changeTask(entry.taskId, waiting ? "waiting_permission" : "running");
  }

  requestCancellation(agentId) {
    const { agent } = this.entry(agentId);
    agent.retired = true;
    const execution = this.running.get(agentId);
    if (execution && !TERMINAL.has(this.taskEntry(execution.taskId).attempt.state)) {
      execution.controller.abort(new Error("子任务已取消"));
      this.changeTask(execution.taskId, "cancelling");
    } else agent.state = "cancelled";
    for (const task of this.record.tasks) if (task.assignedAgentId === agentId && task.state === "queued") this.changeTask(task.id, "cancelled", { endedAt: Date.now(), error: "成员已停止，排队任务已取消" });
    const undelivered = this.record.messages.filter((message) => message.to === agentId && message.delivery === "queued");
    for (const message of undelivered) { message.delivery = "undelivered"; message.deliveryReason = "目标成员已取消"; }
    this.save();
    for (const message of undelivered) this.onMessage(this.publicMessage(message));
    return execution;
  }

  cancelSelf(actorId, attemptId) {
    this.assertActor(actorId, attemptId);
    if (actorId === this.record.rootAgentId) throw new Error("请使用主会话停止操作");
    this.requestCancellation(actorId);
    return { agentId: actorId, cancelRequested: true }; // Never wait on our own execution promise.
  }

  async cancel(agentId) {
    this.assertOpen();
    const execution = this.requestCancellation(agentId);
    if (execution) await execution.promise;
    if (this.fatal) throw this.fatal;
    return this.snapshot(agentId);
  }

  review(taskId, decision, { expectedVersion, attemptId } = {}) {
    this.assertOpen();
    const task = this.record.tasks.find((item) => item.id === taskId);
    if (!task) throw new Error("任务不属于当前任务树");
    if (!["accepted", "rejected"].includes(decision) || task.state !== "submitted") throw new Error("只能验收已提交的结果，决定须为 accepted 或 rejected");
    this.checkVersion(task, expectedVersion);
    if (!attemptId || attemptId !== task.attemptId) throw new Error("验收执行尝试已变化，请读取当前结果");
    task.state = decision;
    task.reviewedAt = Date.now();
    task.version += 1;
    task.sequence = ++this.record.sequence;
    this.save();
    this.onChange(this.taskSnapshot(task.id));
    for (const blocked of this.record.tasks) if (blocked.state === "blocked" && this.dependenciesReady(blocked)) this.changeTask(blocked.id, "pending");
    return this.taskSnapshot(task.id);
  }

  async wait(agentIds, { mode = "all", timeoutMs = 30_000, afterSequence = 0, signal } = {}) {
    this.assertOpen();
    if (!["any", "all"].includes(mode) || !Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 60_000 || !Number.isInteger(afterSequence) || afterSequence < 0) throw new Error("等待参数无效");
    const ids = agentIds ?? this.record.agents.map((agent) => agent.id);
    this.status(ids); // Validate ownership before installing a listener.
    // A member can claim a new board task while the parent is waiting. Include
    // that queue on each wakeup instead of reporting only its previous task done.
    const selectedTasks = () => this.record.tasks.filter((task) => !agentIds || ids.includes(task.assignedAgentId));
    const hasMessages = () => this.record.messages.some((message) => message.to === this.record.rootAgentId && message.delivery === "queued");
    const finished = () => {
      const tasks = selectedTasks();
      return tasks.length === 0 || (mode === "all"
        ? tasks.every((task) => TASK_TERMINAL.has(task.state))
        : tasks.some((task) => TASK_TERMINAL.has(task.state) && task.sequence > afterSequence));
    };
    if (!finished() && !hasMessages() && timeoutMs) await new Promise((resolveWait, reject) => {
      const cleanup = () => { clearTimeout(timer); this.listeners.delete(check); signal?.removeEventListener("abort", abort); };
      const check = () => { if (this.fatal) { cleanup(); reject(this.fatal); } else if (this.record.closed || finished() || hasMessages()) { cleanup(); resolveWait(); } };
      const abort = () => { cleanup(); reject(signal.reason ?? new Error("等待已取消")); };
      const timer = setTimeout(() => { cleanup(); resolveWait(); }, timeoutMs);
      this.listeners.add(check);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort(); else check();
    });
    signal?.throwIfAborted();
    const messages = this.record.closed ? [] : this.readMessages(this.record.rootAgentId).messages;
    return { ...this.status(agentIds), messages, finished: finished(), timedOut: !finished() && messages.length === 0, reason: messages.length ? "messages" : finished() ? "tasks" : "timeout" };
  }

  async close(reason = "父请求结束") {
    if (this.closing) return this.closing;
    // Stop accepting work before awaiting cancellation, including queued tasks.
    this.record.closed = true;
    this.record.closeReason = reason;
    for (const execution of this.running.values()) execution.controller.abort(new Error(reason));
    for (const listener of this.listeners) listener();
    this.closing = (async () => {
      let writeFailure;
      try {
        for (const task of this.record.tasks) if (["queued", "pending", "blocked"].includes(task.state)) this.changeTask(task.id, "cancelled", { error: reason, endedAt: Date.now() });
      } catch (error) { writeFailure = error; }
      // Even when storage fails, wait for the already aborted adapters to clean
      // up their tools and sessions. Do not mistake a write error for a stop ack.
      await Promise.allSettled([...this.running.values()].map((entry) => entry.promise));
      for (const agent of this.record.agents) agent.state = "closed";
      const undelivered = this.record.messages.filter((message) => message.delivery === "queued");
      for (const message of undelivered) { message.delivery = "undelivered"; message.deliveryReason = reason; }
      if (this.fatal) throw this.fatal;
      if (writeFailure) throw writeFailure;
      this.save();
      for (const message of undelivered) this.onMessage(this.publicMessage(message));
    })();
    return this.closing;
  }
}
