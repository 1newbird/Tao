import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { AgentCoordinator, DEFAULT_DELEGATION, delegationOptions, restrictChildConfiguration, recoverInterruptedTeams, teamView, listTeamRuns, readTeamRecord } from "../src-tauri/runtime/multi-agent.mjs";

const config = (patch = {}) => ({ toolMode: "custom", enabledTools: ["read", "write"], customTools: [], toolPermissions: {}, delegation: { ...DEFAULT_DELEGATION, enabled: true, allowedProfileIds: ["worker"] }, ...patch });
const worker = (configuration = config({ systemPrompt: "original" })) => ({ profileId: "worker", name: "执行者", revision: 1, configuration });
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { resolve, promise }; };

async function fixture(run, overrides = {}) {
  const directory = await mkdtemp(join(process.cwd(), ".multi-agent-test-"));
  const team = new AgentCoordinator({ directory, conversationId: "root", requestId: "request", configuration: config(), profiles: [worker()], adapter: { run: async (_entry, { ready, signal }) => { ready(); signal.throwIfAborted(); return "result"; } }, ...overrides });
  try { await run(team, directory); } finally { await team.close().catch(() => {}); await rm(directory, { recursive: true, force: true }); }
}

const spawn = (team, name = "任务") => team.spawn({ profileId: "worker", taskName: name, description: "检查证据并交付结果" });
const boardTask = (team, key, patch = {}) => team.createBoardTask(team.record.rootAgentId, { taskName: key, description: `shared ${key}`, dependsOn: [], requestKey: key, ...patch });
const assignBoard = (team, item, patch = {}) => team.assignTask(team.record.rootAgentId, { taskId: item.taskId, expectedVersion: team.taskSnapshot(item.taskId).task.version, profileId: "worker", requestKey: `assign-${item.taskId}`, ...patch });
const retryBoard = (team, taskId, key, patch = {}) => team.retryTask(team.record.rootAgentId, { taskId, expectedVersion: team.taskSnapshot(taskId).task.version, profileId: "worker", reason: "已核查现有操作，执行修正后的任务", acknowledgeSideEffects: true, requestKey: key, ...patch });
const reviewTask = (team, taskId, decision) => { const { task } = team.taskSnapshot(taskId); return team.review(taskId, decision, { expectedVersion: task.version, attemptId: task.attemptId }); };

const uiCommand = (team, agentId, action, key, patch = {}) => {
  const { task, attempt } = team.snapshot(agentId);
  return { agentId, taskId: task.id, attemptId: attempt.id, expectedVersion: task.version, action, requestKey: key, ...patch };
};

test("Member views allowlist safe output, page events and never open another execution", () => fixture(async (team, directory) => {
  const gate = deferred();
  let executions = 0;
  team.adapter.run = async (_entry, { ready }) => { executions++; ready(); return gate.promise; };
  const child = spawn(team);
  await new Promise((resolve) => setImmediate(resolve));
  team.recordVisible(child.agentId, child.taskId, child.attemptId, { id: "text-1", kind: "assistant", text: "result api_key=PRIVATE_SECRET" });
  team.recordVisible(child.agentId, child.taskId, child.attemptId, { id: "tool-1", kind: "tool", text: "read", status: "running" });
  team.recordVisible(child.agentId, child.taskId, child.attemptId, { id: "tool-1", kind: "tool", text: "read", status: "completed" });
  assert.throws(() => team.recordVisible(child.agentId, child.taskId, child.attemptId, { id: "bad", kind: "thinking", text: "HIDDEN" }), /不可见/);
  const record = readTeamRecord(directory, "root", team.record.runId);
  assert.equal(listTeamRuns(directory, "root").runs.length, 1);
  const view = teamView(record, { agentId: child.agentId, eventLimit: 1 });
  assert.equal(view.hasEarlierEvents, true);
  assert.equal(view.events.length, 1);
  assert.equal(view.events[0].status, "completed");
  const json = JSON.stringify(teamView(record, { agentId: child.agentId }));
  assert(!json.includes("PRIVATE_SECRET") && !json.includes("systemPrompt") && !json.includes("configuration") && !json.includes("HIDDEN"));
  assert.equal(executions, 1);
  assert.throws(() => readTeamRecord(directory, "../root", team.record.runId), /ID 无效/);
  assert.throws(() => readTeamRecord(directory, "root", "../escape"), /ID 无效/);
  assert.throws(() => teamView(record, { agentId: "foreign" }), /不属于/);
  assert.throws(() => teamView(record, { eventLimit: 1001 }), /记录数量/);
  gate.resolve("result"); await team.wait();
}));

test("Human supplements are durable, deduplicated, task scoped and do not change authority", () => fixture(async (team) => {
  const gate = deferred();
  team.adapter.run = async (_entry, { ready }) => { ready(); return gate.promise; };
  const child = spawn(team);
  await new Promise((resolve) => setImmediate(resolve));
  const configuration = JSON.stringify(team.entry(child.agentId).agent.snapshot.configuration);
  const input = uiCommand(team, child.agentId, "message", "user-msg", { body: "Check the second file" });
  const [first, duplicate] = await Promise.all([team.userControl(input), team.userControl(input)]);
  assert.equal(first.messageId, duplicate.messageId);
  assert.equal(team.record.messages.filter((message) => message.to === child.agentId).length, 1);
  const mail = team.peekMessages(child.agentId, child.attemptId);
  assert.equal(mail[0].from, "user"); assert.equal(mail[0].targetAttemptId, child.attemptId);
  assert.equal(team.peekMessages(team.record.rootAgentId).length, 1);
  assert.equal(configuration, JSON.stringify(team.entry(child.agentId).agent.snapshot.configuration));
  await assert.rejects(team.userControl({ ...input, requestKey: "foreign-attempt", attemptId: "old" }), /尝试已变化/);
  await assert.rejects(team.userControl({ ...input, requestKey: "stale-version", expectedVersion: 0 }), /版本已变化/);
  await assert.rejects(team.userControl({ ...input, body: "different" }), /请求键/);
  gate.resolve("done"); await team.running.get(child.agentId)?.promise;
  assert.equal(team.record.messages.find((message) => message.id === first.messageId).delivery, "undelivered");
  const followup = await team.userControl(uiCommand(team, child.agentId, "followup", "human-next", { taskName: "next", body: "new requirements" }));
  await new Promise((resolve) => setImmediate(resolve));
  await team.running.get(child.agentId)?.promise;
  assert.notEqual(followup.taskId, child.taskId);
  assert.equal(team.record.agents.length, 1);
  assert.equal(team.record.messages.filter((message) => message.id === first.messageId && message.delivery === "delivered").length, 0);
}));

test("Human stop scopes and stale views cannot control a different attempt", () => fixture(async (team) => {
  team.adapter.run = async (_entry, { ready, signal }) => { ready(); await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true })); signal.throwIfAborted(); };
  const child = spawn(team); const peer = spawn(team);
  await new Promise((resolve) => setImmediate(resolve));
  const input = uiCommand(team, child.agentId, "cancel_task", "human-stop");
  team.recordVisible(child.agentId, child.taskId, child.attemptId, { id: "unfinished-tool", kind: "tool", text: "read", status: "running" });
  const [a, b] = await Promise.all([team.userControl(input), team.userControl(input)]);
  assert.equal(a.state, "cancelled"); assert.equal(b.state, "cancelled");
  assert.equal(team.snapshot(peer.agentId).task.state, "running");
  assert.equal(team.entry(child.agentId).agent.retired, undefined);
  assert.equal(teamView(team.record).events.find((event) => event.id === "unfinished-tool").status, "stopped");
  await team.userControl(uiCommand(team, peer.agentId, "cancel_agent", "human-retire"));
  assert.equal(team.entry(peer.agentId).agent.retired, true);
  await team.close();
  await assert.rejects(team.userControl(uiCommand(team, child.agentId, "followup", "closed", { taskName: "no", body: "no" })), /已经结束/);
  assert.equal((await team.userControl(input)).duplicate, true);
}));

test("Mailbox and command capacity never block human stop scopes or deduplicated receipts", () => fixture(async (team) => {
  team.adapter.run = async (_entry, { ready, signal }) => { ready(); await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true })); signal.throwIfAborted(); };
  const first = spawn(team); const second = spawn(team); const third = spawn(team);
  await new Promise((resolve) => setImmediate(resolve));
  for (let index = 0; index < 63; index++) await team.userControl(uiCommand(team, first.agentId, "message", `fill-${index}`, { body: "supplement" }));
  assert.equal(team.record.messages.length, 126);
  await assert.rejects(team.userControl(uiCommand(team, first.agentId, "message", "over-capacity", { body: "no room" })), /达到上限/);
  const stopTask = uiCommand(team, first.agentId, "cancel_task", "stop-at-capacity");
  await team.userControl(stopTask);
  assert.equal(team.snapshot(first.agentId).task.state, "cancelled");
  while (team.record.commands.length < 257) team.record.commands.push({ requestKey: `filler-${team.record.commands.length}` });
  await team.userControl(uiCommand(team, second.agentId, "cancel_agent", "retire-at-capacity"));
  assert.equal(team.entry(second.agentId).agent.retired, true);
  const size = team.record.messages.length;
  let stops = 0;
  const stopRun = { action: "stop_run", requestKey: "stop-full-team" };
  const callback = async () => { stops++; await team.close("human stop"); };
  await Promise.all([team.userControl(stopRun, callback), team.userControl(stopRun, callback)]);
  assert.equal(stops, 1);
  assert.equal(team.snapshot(third.agentId).task.state, "cancelled");
  assert.equal(team.record.messages.length, size);
  assert.equal((await team.userControl(stopTask)).duplicate, true);
  assert.equal((await team.userControl(stopRun, callback)).duplicate, true);
}));

test("Cancelling an unassigned board task does not expire ordinary member mail", () => fixture(async (team) => {
  const gate = deferred(); team.adapter.run = async (_entry, { ready }) => { ready(); return gate.promise; };
  const child = spawn(team);
  team.send(team.record.rootAgentId, { recipient: child.agentId, body: "keep", requestKey: "keep" });
  const task = boardTask(team, "unassigned");
  await team.cancelTask(team.record.rootAgentId, { taskId: task.taskId, expectedVersion: task.version, requestKey: "cancel-unassigned" });
  assert.equal(team.record.messages[0].delivery, "queued");
  gate.resolve("done"); await team.wait();
}));

test("Parent completion racing human cancellation cannot leave mail queued in a closed run", () => fixture(async (team) => {
  const cleanup = deferred();
  team.adapter.run = async (_entry, { ready, signal }) => {
    ready(); await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    await cleanup.promise; signal.throwIfAborted();
  };
  const child = spawn(team);
  await new Promise((resolve) => setImmediate(resolve));
  const control = team.userControl(uiCommand(team, child.agentId, "cancel_agent", "racing-cancel"));
  await new Promise((resolve) => setImmediate(resolve));
  const closing = team.close("parent completed");
  cleanup.resolve();
  await Promise.all([control, closing]);
  assert.equal(team.record.closed, true);
  assert(team.record.messages.every((message) => message.delivery !== "queued"));
}));

test("Shared tasks require explicit dependencies and receipts expose the stored dependency contract", () => fixture(async (team) => {
  const root = team.record.rootAgentId;
  const input = { taskName: "遗漏依赖", description: "依赖必须作为参数填写", requestKey: "missing-dependencies" };
  for (const dependsOn of [undefined, null, "previous-task"]) {
    assert.throws(() => team.createBoardTask(root, { ...input, dependsOn }), /显式填写 dependsOn/);
  }
  assert.equal(team.record.tasks.length, 0);
  assert.equal(team.record.commands.length, 0);
  const prerequisite = boardTask(team, "explicit-empty");
  const dependent = boardTask(team, "explicit-edge", { dependsOn: [prerequisite.taskId] });
  assert.deepEqual(prerequisite.dependsOn, []);
  assert.deepEqual(dependent.dependsOn, [prerequisite.taskId]);
  assert.deepEqual(dependent.eligibleProfileIds, ["worker"]);
  assert.equal(dependent.state, "blocked");
  const duplicate = boardTask(team, "explicit-edge", { dependsOn: [prerequisite.taskId] });
  assert.deepEqual(duplicate.dependsOn, dependent.dependsOn);
  dependent.dependsOn.length = 0;
  assert.equal(team.taskSnapshot(dependent.taskId).task.dependsOn.length, 1);
  assert.equal(duplicate.dependsOn.length, 1);
}));

test("Agent / Task / Attempt identities, submission, review and durable records", () => fixture(async (team) => {
  const first = spawn(team);
  assert.notEqual(first.agentId, first.taskId);
  assert.notEqual(first.taskId, first.attemptId);
  const result = await team.wait([first.agentId]);
  assert.equal(result.members[0].task.state, "submitted");
  assert.equal(result.members[0].attempt.result, "result");
  assert.equal(result.members[0].agent.snapshot.configuration, undefined);
  reviewTask(team, first.taskId, "accepted");
  assert.equal(team.status().members[0].task.state, "accepted");
  assert.equal(team.status().members[0].attempt.state, "submitted");
  assert.throws(() => team.review(first.taskId, "accepted"), /只能验收/);
  assert.equal(JSON.parse(await readFile(team.path, "utf8")).tasks[0].state, "accepted");
}));

test("Spawn returns before execution; bounded concurrent workers and queued cancellation", () => fixture(async (team) => {
  const gates = [deferred(), deferred()];
  let count = 0;
  team.options.maxConcurrent = 2;
  team.adapter.run = async (_entry, { ready }) => { const index = count++; ready(); return gates[index].promise; };
  const a = spawn(team, "A"); const b = spawn(team, "B"); const c = spawn(team, "C");
  assert.equal(count, 0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(count, 2);
  assert.equal(team.status([c.agentId]).members[0].task.state, "queued");
  await team.cancel(c.agentId);
  gates[0].resolve("A result"); gates[1].resolve("B result");
  assert.equal((await team.wait([a.agentId, b.agentId])).timedOut, false);
  assert.equal(count, 2);
}));

test("Wait any cursor, timeout and abort do not consume or terminate a worker", () => fixture(async (team) => {
  const gate = deferred();
  team.adapter.run = async (_entry, { ready }) => { ready(); return gate.promise; };
  const a = spawn(team);
  const timeout = await team.wait([a.agentId], { timeoutMs: 5 });
  assert.equal(timeout.timedOut, true);
  const abort = new AbortController();
  const waiting = team.wait([a.agentId], { signal: abort.signal });
  abort.abort(new Error("stop wait"));
  await assert.rejects(waiting, /stop wait/);
  assert.equal(team.listeners.size, 0);
  gate.resolve("done");
  const result = await team.wait([a.agentId], { mode: "any" });
  assert.equal(result.timedOut, false);
  assert.equal((await team.wait([a.agentId], { mode: "any", afterSequence: result.sequence, timeoutMs: 5 })).timedOut, true);
}));

test("Cancellation during preparation waits for cleanup and fences late success", () => fixture(async (team) => {
  const cleanup = deferred();
  let ready = false;
  team.adapter.run = async (_entry, { signal }) => {
    await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    await cleanup.promise;
    ready = true;
    return "late success";
  };
  const a = spawn(team);
  await new Promise((resolve) => setImmediate(resolve));
  const stopped = team.cancel(a.agentId);
  assert.equal(team.status().members[0].attempt.state, "cancelling");
  assert.equal(ready, false);
  cleanup.resolve();
  const result = await stopped;
  assert.equal(result.attempt.state, "cancelled");
  assert.equal(result.attempt.result, undefined);
}));

test("Root close cancels running and queued work and releases resources", () => fixture(async (team) => {
  team.options.maxConcurrent = 1;
  team.adapter.run = async (_entry, { signal, ready }) => { ready(); await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true })); return "late"; };
  spawn(team, "running"); spawn(team, "queued");
  await new Promise((resolve) => setImmediate(resolve));
  await team.close("root cancelled");
  assert.equal(team.running.size, 0);
  assert(team.status().members.every((member) => member.attempt.state === "cancelled" && member.agent.state === "closed"));
  assert.throws(() => spawn(team), /已经结束/);
}));

test("Failures release the concurrency slot and preserve a bounded error", () => fixture(async (team) => {
  team.options.maxConcurrent = 1;
  let calls = 0;
  team.adapter.run = async (_entry, { ready }) => { ready(); if (++calls === 1) throw new Error("failed"); return "next"; };
  const a = spawn(team); const b = spawn(team);
  const result = await team.wait([a.agentId, b.agentId]);
  assert.deepEqual(result.members.map((member) => member.attempt.state), ["failed", "submitted"]);
}));

test("Task time limit aborts execution and releases its slot after cleanup", () => fixture(async (team) => {
  team.options.timeoutMs = 1000;
  team.adapter.run = async (_entry, { signal, ready }) => { ready(); await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true })); signal.throwIfAborted(); };
  const child = spawn(team);
  const result = await team.wait([child.agentId], { timeoutMs: 2000 });
  assert.equal(result.members[0].attempt.state, "failed");
  assert.match(result.members[0].attempt.error, /时长限制/);
}));

test("Permission wait is visible; turn-budget failure is not reported as success", () => fixture(async (team) => {
  const gate = deferred();
  team.adapter.run = async ({ agent }, { ready, signal, fail }) => { ready(); team.waiting(agent.id, true); await gate.promise; fail("round limit"); signal.throwIfAborted(); };
  const a = spawn(team);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(team.status().members[0].task.state, "waiting_permission");
  gate.resolve();
  const result = await team.wait([a.agentId]);
  assert.equal(result.members[0].attempt.state, "failed");
  assert.match(result.members[0].attempt.error, /round limit/);
}));

test("Task ownership, profile allowlist, count and input limits fail closed", () => fixture(async (team) => {
  team.options.maxTasks = 1;
  assert.throws(() => team.spawn({ profileId: "foreign", taskName: "x", description: "x" }), /未获准/);
  assert.throws(() => team.spawn({ profileId: "worker", taskName: "x", description: "" }), /说明/);
  spawn(team);
  assert.throws(() => spawn(team), /数量上限/);
  assert.throws(() => team.status(["another-tree-agent"]), /不属于/);
  await assert.rejects(team.cancel("another-tree-agent"), /不属于/);
  await assert.rejects(team.wait(["another-tree-agent"]), /不属于/);
  assert.throws(() => team.review("another-task", "accepted"), /不属于/);
}));

test("Child capabilities are an intersection, including actual custom-tool definitions", () => {
  const tool = { id: "tool", name: "lookup", enabled: true, permissionMode: "ask", command: "original" };
  const parent = config({ enabledTools: ["read"], skillsEnabled: false, extensionsEnabled: true, customTools: [tool], toolPermissions: { read: { mode: "ask", pathScope: "workspace" } } });
  const child = config({ enabledTools: ["read", "write"], skillsEnabled: true, extensionsEnabled: true, customTools: [{ ...tool, permissionMode: "allow" }], toolPermissions: { read: { mode: "allow", pathScope: "any" } } });
  const result = restrictChildConfiguration(parent, child);
  assert.deepEqual(result.enabledTools, ["read"]);
  assert.equal(result.customTools[0].permissionMode, "ask");
  assert.deepEqual(result.toolPermissions.read, { mode: "ask", pathScope: "workspace" });
  assert.equal(result.skillsEnabled, false);
  assert.equal(result.extensionsEnabled, false);
  assert.equal(result.delegation.enabled, false);
  child.customTools[0].command = "changed executable";
  assert.equal(restrictChildConfiguration(parent, child).customTools.length, 0);
  parent.toolPermissions.read.mode = "deny";
  assert.equal(restrictChildConfiguration(parent, child).toolPermissions.read.mode, "deny");
  assert.equal(restrictChildConfiguration(config(), config({ toolPermissions: { write: { mode: "allow", pathScope: "any" } } })).toolPermissions.write.mode, "inherit");
});

test("Captured profiles do not change after a caller edits the source", () => fixture(async (team) => {
  team.adapter.run = async ({ agent }) => agent.snapshot.configuration.systemPrompt;
  const a = spawn(team);
  team.profiles[0].configuration.systemPrompt = "new";
  assert.equal((await team.wait([a.agentId])).members[0].attempt.result, "original");
}));

test("Interrupted records recover without replay; one corrupt file does not block others", () => fixture(async (team, directory) => {
  const record = JSON.parse(await readFile(team.path, "utf8"));
  record.tasks.push({ id: "t", state: "running" }); record.attempts.push({ id: "a", state: "running" });
  record.closed = true; // A crash can happen while root cancellation is settling.
  await writeFile(team.path, JSON.stringify(record));
  await writeFile(join(directory, "root", "corrupt.json"), "{");
  const warnings = recoverInterruptedTeams(directory);
  assert.equal(warnings.length, 1);
  const recovered = JSON.parse(await readFile(team.path, "utf8"));
  assert.equal(recovered.tasks[0].state, "interrupted");
  assert.equal(recovered.attempts[0].state, "interrupted");
  assert.equal(recovered.closed, true);
  assert.equal(await readFile(join(directory, "root", "corrupt.json"), "utf8"), "{");
}));

test("Persistence failure blocks dispatch instead of running unrecorded work", () => fixture(async (team) => {
  let calls = 0;
  team.adapter.run = async () => { calls++; return "bad"; };
  await rm(team.path);
  await mkdir(team.path);
  assert.throws(() => spawn(team), /状态保存失败/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 0);
  assert.throws(() => team.status(), /状态保存失败/);
}));

test("Delegation settings are validated and old configurations default to disabled", () => {
  assert.equal(delegationOptions().enabled, false);
  assert.throws(() => delegationOptions({ maxConcurrent: 0 }), /超出/);
  assert.throws(() => delegationOptions({ maxTasks: 1.5 }), /超出/);
  assert.throws(() => delegationOptions({ allowedProfileIds: ["../other"] }), /列表无效/);
});

const flush = () => new Promise((resolve) => setImmediate(resolve));
async function gateOrAbort(gate, signal) {
  let abort;
  try {
    await Promise.race([gate.promise, new Promise((resolve) => { abort = resolve; signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) resolve(); })]);
    signal.throwIfAborted();
  } finally { signal.removeEventListener("abort", abort); }
}

test("Directed mail persists real source, deduplicates and is private to the recipient", () => fixture(async (team) => {
  const gate = deferred();
  let runs = 0;
  team.adapter.run = async (_entry, { ready, signal }) => { runs++; ready(); await gateOrAbort(gate, signal); return "done"; };
  const a = spawn(team, "A"); const b = spawn(team, "B");
  await flush();
  const input = { recipient: b.agentId, body: "Found evidence", requestKey: "finding-1" };
  const sent = team.send(a.agentId, input, a.attemptId);
  const duplicate = team.send(a.agentId, input, a.attemptId);
  assert.equal(duplicate.messageId, sent.messageId);
  assert.equal(duplicate.duplicate, true);
  assert.throws(() => team.send(a.agentId, { ...input, body: "different" }, a.attemptId), /不同消息/);
  const queued = team.peekMessages(b.agentId, b.attemptId);
  assert.equal(queued[0].from, a.agentId);
  assert.equal(queued[0].fromTaskId, a.taskId);
  assert.equal(queued[0].toTaskId, b.taskId);
  assert.equal(team.peekMessages(a.agentId, a.attemptId).length, 0);
  assert.throws(() => team.markDelivered(a.agentId, [sent.messageId], a.attemptId), /当前邮箱/);
  assert.equal(JSON.parse(await readFile(team.path, "utf8")).messages[0].delivery, "queued");
  team.markDelivered(b.agentId, [sent.messageId], b.attemptId);
  assert.equal(team.peekMessages(b.agentId, b.attemptId).length, 0);
  assert.equal(team.readMessages(b.agentId, b.attemptId, { includeDelivered: true }).messages[0].delivery, "delivered");
  assert.equal(runs, 2);
  gate.resolve();
}));

test("Mail queued before member preparation is available at its first safe boundary", () => fixture(async (team) => {
  const seen = [];
  team.adapter.run = async ({ agent, attempt }, { ready }) => { ready(); seen.push(...team.readMessages(agent.id, attempt.id).messages); return "ready"; };
  const a = spawn(team);
  team.send(team.record.rootAgentId, { recipient: a.agentId, body: "initial constraint", requestKey: "before-preparation" });
  await team.wait([a.agentId]);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].toTaskId, a.taskId);
  assert.equal(seen[0].body, "initial constraint");
}));

test("Inbox pagination cannot skip messages when task events advance the global sequence", () => fixture(async (team) => {
  const pages = [];
  team.adapter.run = async ({ agent, attempt }, { ready }) => {
    ready();
    let cursor = 0;
    do {
      const page = team.readMessages(agent.id, attempt.id, { afterSequence: cursor, limit: 8 });
      pages.push(page);
      cursor = page.sequence;
    } while (pages.at(-1).hasMore);
    return "read all";
  };
  const a = spawn(team);
  for (let index = 0; index < 24; index++) team.send(team.record.rootAgentId, { recipient: a.agentId, body: `message ${index}`, requestKey: `page-${index}` });
  await team.wait([a.agentId]);
  assert.deepEqual(pages.map((page) => page.messages.length), [8, 8, 8]);
  assert.equal(new Set(pages.flatMap((page) => page.messages.map((message) => message.id))).size, 24);
  assert(pages[0].stateSequence > pages[0].sequence);
}));

test("Mailbox rejects foreign actors, stale attempts, forged replies and oversized messages", () => fixture(async (team) => {
  const gate = deferred();
  team.adapter.run = async (_entry, { ready, signal }) => { ready(); await gateOrAbort(gate, signal); return "done"; };
  const a = spawn(team); const b = spawn(team);
  await flush();
  const input = { recipient: b.agentId, body: "hello", requestKey: "key" };
  assert.throws(() => team.send("foreign", input, "fake"), /不属于/);
  assert.throws(() => team.send(a.agentId, input, "old-attempt"), /执行尝试/);
  assert.throws(() => team.send(a.agentId, { ...input, recipient: "foreign" }, a.attemptId), /不属于/);
  assert.throws(() => team.send(a.agentId, { ...input, recipient: a.agentId }, a.attemptId), /自己/);
  assert.throws(() => team.send(a.agentId, { ...input, replyTo: "forged" }, a.attemptId), /通信双方/);
  assert.throws(() => team.send(a.agentId, { ...input, body: "x".repeat(4001) }, a.attemptId), /4000/);
  const roster = team.roster(a.agentId, a.attemptId);
  assert.equal(roster.members[1].agentId, b.agentId);
  assert(!JSON.stringify(roster).includes("configuration"));
  gate.resolve();
}));

test("Idle mail does not wake a member; explicit followup creates a separate task", () => fixture(async (team) => {
  let runs = 0;
  const seenMail = [];
  team.adapter.run = async ({ agent, attempt }, { ready }) => { runs++; ready(); seenMail.push(team.readMessages(agent.id, attempt.id).messages); return `run ${runs}`; };
  const a = spawn(team);
  await team.wait([a.agentId]);
  team.send(team.record.rootAgentId, { recipient: a.agentId, body: "advice for later", requestKey: "advice" });
  await flush();
  assert.equal(runs, 1);
  const input = { agentId: a.agentId, taskName: "Followup", description: "verify the result", requestKey: "follow-1" };
  const next = team.followup(team.record.rootAgentId, input);
  const duplicate = team.followup(team.record.rootAgentId, input);
  assert.equal(next.agentId, a.agentId);
  assert.notEqual(next.taskId, a.taskId);
  assert.notEqual(next.attemptId, a.attemptId);
  assert.equal(next.taskId, duplicate.taskId);
  assert.throws(() => team.followup(team.record.rootAgentId, { ...input, description: "different" }), /不同任务操作/);
  await team.wait([a.agentId]);
  assert.equal(runs, 2);
  assert.equal(seenMail[1][0].toTaskId, a.taskId); // Original association is retained.
  assert.equal(team.status().tasks.length, 2);
}));

test("Queued followups are serial per member; old callbacks and review cannot alter the next task", () => fixture(async (team) => {
  const gates = [deferred(), deferred()];
  let runs = 0; let oldContext;
  team.adapter.run = async (_entry, context) => { const index = runs++; if (!index) oldContext = context; context.ready(); await gateOrAbort(gates[index], context.signal); return `result ${index}`; };
  const a = spawn(team);
  const next = team.followup(team.record.rootAgentId, { agentId: a.agentId, taskName: "second", description: "second task", requestKey: "second" });
  await flush();
  assert.equal(runs, 1);
  assert.equal(team.taskSnapshot(next.taskId).attempt.state, "queued");
  const waiting = team.wait([a.agentId]);
  gates[0].resolve();
  await flush();
  assert.equal(runs, 2);
  assert.equal(team.taskSnapshot(next.taskId).attempt.state, "running");
  reviewTask(team, a.taskId, "accepted");
  oldContext.reportUsage({ totalTokens: 999999 }, 100);
  oldContext.fail("late failure");
  team.waiting(a.agentId, true, a.attemptId);
  assert.equal(team.taskSnapshot(next.taskId).attempt.state, "running");
  assert.equal(team.taskSnapshot(next.taskId).attempt.usage, undefined);
  gates[1].resolve();
  const result = await waiting;
  assert(result.tasks.every((entry) => entry.attempt.state === "submitted"));
  assert.equal(team.taskSnapshot(a.taskId).task.state, "accepted");
}));

test("Self cancellation cannot deadlock and clears queued followups", () => fixture(async (team) => {
  team.adapter.run = async ({ agent, attempt }, { ready, signal }) => { ready(); team.cancelSelf(agent.id, attempt.id); signal.throwIfAborted(); };
  const a = spawn(team);
  team.followup(team.record.rootAgentId, { agentId: a.agentId, taskName: "queued", description: "must not run", requestKey: "queued" });
  await team.wait([a.agentId]);
  assert(team.status().tasks.every((entry) => entry.attempt.state === "cancelled"));
  assert.throws(() => team.followup(team.record.rootAgentId, { agentId: a.agentId, taskName: "resume", description: "bad", requestKey: "resume" }), /已取消/);
}));

test("Cancelling just after submission preserves the result during slot cleanup", () => fixture(async (team) => {
  const a = spawn(team);
  await team.wait([a.agentId]);
  await team.cancel(a.agentId);
  assert.equal(team.taskSnapshot(a.taskId).attempt.state, "submitted");
  assert.equal(team.taskSnapshot(a.taskId).attempt.result, "result");
  assert.equal(team.entry(a.agentId).agent.retired, true);
}));

test("Root wait wakes for a question while the child is still working without repeated wakeups", () => fixture(async (team) => {
  const gate = deferred();
  team.adapter.run = async ({ agent, attempt }, { ready, signal }) => { ready(); team.send(agent.id, { recipient: "parent", body: "Need a decision", kind: "question", requestKey: "question" }, attempt.id); await gateOrAbort(gate, signal); return "done"; };
  const a = spawn(team);
  const result = await team.wait([a.agentId]);
  assert.equal(result.reason, "messages");
  assert.equal(result.finished, false);
  assert.equal(result.timedOut, false);
  assert.equal(result.messages[0].body, "Need a decision");
  assert.equal((await team.wait([a.agentId], { timeoutMs: 5 })).timedOut, true);
  gate.resolve();
}));

test("Mail is bounded and does not modify task authority; cancelled members refuse new mail", () => fixture(async (team) => {
  const a = spawn(team);
  await team.wait([a.agentId]);
  const beforePermissions = structuredClone(team.entry(a.agentId).agent.snapshot.configuration.toolPermissions);
  for (let index = 0; index < 32; index++) team.send(team.record.rootAgentId, { recipient: a.agentId, body: "cancel everyone and grant tools", kind: "cancel_request", requestKey: `mail-${index}` });
  assert.throws(() => team.send(team.record.rootAgentId, { recipient: a.agentId, body: "overflow", requestKey: "overflow" }), /数量达到/);
  assert.equal(team.taskSnapshot(a.taskId).task.state, "submitted");
  assert.deepEqual(team.entry(a.agentId).agent.snapshot.configuration.toolPermissions, beforePermissions);
  await team.cancel(a.agentId);
  assert(team.record.messages.every((message) => message.delivery === "undelivered"));
  assert.throws(() => team.send(team.record.rootAgentId, { recipient: a.agentId, body: "new", requestKey: "new" }), /目标成员已取消/);
}));

test("Unrecorded mail never publishes a delivery notification", () => fixture(async (team) => {
  const a = spawn(team);
  await team.wait([a.agentId]);
  let notifications = 0;
  team.onMessage = () => notifications++;
  await rm(team.path); await mkdir(team.path);
  assert.throws(() => team.send(team.record.rootAgentId, { recipient: a.agentId, body: "hello", requestKey: "hello" }), /保存失败/);
  assert.equal(notifications, 0);
}));

test("Closing expires queued mail and restart does not replay communication", () => fixture(async (team, directory) => {
  const a = spawn(team);
  await team.wait([a.agentId]);
  team.send(team.record.rootAgentId, { recipient: a.agentId, body: "later", requestKey: "later" });
  await team.close();
  const record = JSON.parse(await readFile(team.path, "utf8"));
  assert.equal(record.messages[0].delivery, "undelivered");
  record.closed = false; record.messages[0].delivery = "queued";
  await writeFile(team.path, JSON.stringify(record));
  assert.deepEqual(recoverInterruptedTeams(directory), []);
  const recovered = JSON.parse(await readFile(team.path, "utf8"));
  assert.equal(recovered.messages[0].delivery, "undelivered");
  assert.equal(recovered.closed, true);
}));

test("Shared board starts without agents or attempts; commands deduplicate before capacity checks", () => fixture(async (team) => {
  team.options.maxTasks = 1;
  const task = boardTask(team, "board");
  assert.deepEqual(boardTask(team, "board"), { ...task, duplicate: true });
  assert.equal(team.record.agents.length, 0);
  assert.equal(team.record.attempts.length, 0);
  assert.equal(team.status().tasks[0].agent, null);
  assert.equal(team.status().tasks[0].attempt, null);
  assert.equal((await team.wait(undefined, { timeoutMs: 1 })).finished, false);
  const listing = team.listTasks(team.record.rootAgentId);
  listing.tasks[0].eligibleProfileIds.push("forged");
  assert.equal(team.record.tasks[0].eligibleProfileIds.length, 1);
  assert.throws(() => boardTask(team, "board", { description: "changed" }), /不同任务操作/);
  assert.throws(() => boardTask(team, "another"), /数量上限/);
  const assigned = assignBoard(team, task);
  assert.equal(assignBoard(team, task, { expectedVersion: task.version }).attemptId, assigned.attemptId);
  await team.wait();
  assert.equal(team.taskSnapshot(task.taskId).task.state, "submitted");
}));

test("Dependencies unlock only after acceptance; invalid graph edges fail without mutations", () => fixture(async (team) => {
  const root = team.record.rootAgentId;
  const a = boardTask(team, "prerequisite");
  const b = boardTask(team, "dependent", { dependsOn: [a.taskId] });
  assert.equal(b.state, "blocked");
  assert.throws(() => boardTask(team, "foreign", { dependsOn: ["foreign-task"] }), /不属于/);
  assert.throws(() => boardTask(team, "duplicate-edge", { dependsOn: [a.taskId, a.taskId] }), /依赖/);
  assert.throws(() => boardTask(team, "bad-profile", { eligibleProfileIds: ["foreign"] }), /获准/);
  assert.equal(team.record.tasks.length, 2);
  assignBoard(team, a);
  await team.wait(undefined, { mode: "any" });
  assert.throws(() => assignBoard(team, b), /不可分配/);
  reviewTask(team, a.taskId, "rejected");
  assert.equal(team.taskSnapshot(b.taskId).task.state, "blocked");
  await retryBoard(team, a.taskId, "repair");
  await team.wait(undefined, { mode: "any", afterSequence: team.record.sequence });
  reviewTask(team, a.taskId, "accepted");
  assert.equal(team.taskSnapshot(b.taskId).task.state, "pending");
  assert.throws(() => team.assignTask(root, { taskId: b.taskId, expectedVersion: b.version, profileId: "worker", requestKey: "stale" }), /版本/);
  assignBoard(team, b);
  await team.wait();
  assert.equal(team.taskSnapshot(b.taskId).task.state, "submitted");
}));

test("Two active members competing for the same version produce exactly one claim and serial execution", () => fixture(async (team) => {
  const gate = deferred();
  let active = 0; let peak = 0; const executions = [];
  team.adapter.run = async ({ agent, task }, { ready, signal }) => {
    active++; peak = Math.max(peak, active); executions.push({ agentId: agent.id, taskId: task.id }); ready();
    try { if (!task.shared) await gateOrAbort(gate, signal); return "done"; } finally { active--; }
  };
  const task = boardTask(team, "claim-race");
  const a = spawn(team, "A"); const b = spawn(team, "B");
  await flush();
  const claims = await Promise.allSettled([a, b].map(async (member) => team.claimTask(member.agentId, { taskId: task.taskId, expectedVersion: task.version }, member.attemptId)));
  assert.equal(claims.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(team.record.attempts.filter((attempt) => attempt.taskId === task.taskId).length, 1);
  assert.equal(executions.length, 2);
  const winner = claims.find((result) => result.status === "fulfilled").value;
  const another = boardTask(team, "no-hoarding");
  const member = [a, b].find((item) => item.agentId === winner.agentId);
  assert.throws(() => team.claimTask(member.agentId, { taskId: another.taskId, expectedVersion: another.version }, member.attemptId), /最多预领/);
  assert.throws(() => team.claimTask(member.agentId, { taskId: another.taskId, expectedVersion: another.version }, "stale-attempt"), /执行尝试/);
  gate.resolve();
  await team.wait([a.agentId, b.agentId]);
  assert.equal(executions.length, 3);
  assert.equal(peak, 2);
  assert.equal(team.taskSnapshot(task.taskId).task.state, "submitted");
}));

test("Child board view excludes private tasks/results and cannot grant itself another profile", () => fixture(async (team) => {
  const gate = deferred();
  team.adapter.run = async (_entry, { ready, signal }) => { ready(); await gateOrAbort(gate, signal); return "private result"; };
  team.options.allowedProfileIds.push("other");
  team.profiles.push({ ...worker(), profileId: "other" });
  const shared = boardTask(team, "restricted", { eligibleProfileIds: ["other"] });
  const a = spawn(team, "private-task");
  await flush();
  const listing = team.listTasks(a.agentId, a.attemptId);
  assert.equal(listing.tasks.length, 1);
  assert.equal(listing.tasks[0].claimable, false);
  assert(!JSON.stringify(listing).includes("private-task"));
  assert.throws(() => team.claimTask(a.agentId, { taskId: shared.taskId, expectedVersion: shared.version }, a.attemptId), /获准/);
  assert.throws(() => team.createBoardTask(a.agentId, { taskName: "forged", description: "forged", requestKey: "forged" }), /执行尝试|主代理/);
  assert.throws(() => team.assignTask(a.agentId, { taskId: shared.taskId, expectedVersion: shared.version, profileId: "other", requestKey: "forged" }), /执行尝试|主代理/);
  assert.throws(() => team.claimTask(team.record.rootAgentId, { taskId: shared.taskId, expectedVersion: shared.version }), /assign_task/);
  gate.resolve();
}));

test("Root cancels only the chosen task, awaits cleanup and can reassign its next generation", () => fixture(async (team) => {
  const cleanup = deferred(); let runs = 0; let oldCallbacks;
  team.adapter.run = async ({ task }, context) => {
    context.ready(); runs++;
    if (task.title !== "running") return "other work";
    if (runs === 1) {
      oldCallbacks = context;
      await new Promise((resolve) => context.signal.addEventListener("abort", resolve, { once: true }));
      await cleanup.promise;
      return "late old result";
    }
    return "new generation";
  };
  const a = spawn(team, "running");
  const next = team.followup(team.record.rootAgentId, { agentId: a.agentId, taskName: "other", description: "other", requestKey: "other" });
  await flush();
  const cancelling = team.cancelTask(team.record.rootAgentId, { taskId: a.taskId, expectedVersion: team.taskSnapshot(a.taskId).task.version, requestKey: "stop-task" });
  await assert.rejects(retryBoard(team, a.taskId, "too-early"), /先 cancel_task/);
  assert.equal(runs, 1);
  cleanup.resolve();
  await cancelling;
  const before = team.taskSnapshot(a.taskId);
  assert.equal(before.task.state, "cancelled");
  assert.equal(before.agent.retired, undefined);
  const retried = await retryBoard(team, a.taskId, "retry-task");
  oldCallbacks.ready(); oldCallbacks.fail("late failure"); oldCallbacks.reportUsage({ totalTokens: 9999 }, 99);
  await team.wait();
  const result = team.taskSnapshot(a.taskId);
  assert.equal(retried.generation, 2);
  assert.equal(result.attempt.result, "new generation");
  assert.equal(result.attempt.usage, undefined);
  assert.equal(team.taskSnapshot(next.taskId).task.state, "submitted");
  assert.equal(team.record.attempts.find((attempt) => attempt.id === a.attemptId).state, "cancelled");
  assert.equal(team.record.attempts.find((attempt) => attempt.id === a.attemptId).result, undefined);
}));

test("Retry requires explicit side-effect acknowledgement, fresh version and bounded generations", () => fixture(async (team) => {
  team.adapter.run = async (_entry, { ready }) => { ready(); throw new Error("failed after external operation"); };
  const task = boardTask(team, "retry-budget");
  assignBoard(team, task);
  await team.wait();
  await assert.rejects(retryBoard(team, task.taskId, "no-ack", { acknowledgeSideEffects: false }), /副作用/);
  await assert.rejects(retryBoard(team, task.taskId, "stale-version", { expectedVersion: 1 }), /版本/);
  const inputVersion = team.taskSnapshot(task.taskId).task.version;
  const second = await retryBoard(team, task.taskId, "second", { expectedVersion: inputVersion });
  const duplicate = await retryBoard(team, task.taskId, "second", { expectedVersion: inputVersion });
  assert.equal(duplicate.attemptId, second.attemptId);
  assert.equal(duplicate.duplicate, true);
  await team.wait();
  await retryBoard(team, task.taskId, "third");
  await team.wait();
  await assert.rejects(retryBoard(team, task.taskId, "fourth"), /三次/);
  assert.deepEqual(team.record.attempts.map((attempt) => attempt.generation), [1, 2, 3]);
  assert(team.record.attempts.every((attempt) => attempt.lease.generation === attempt.generation && attempt.lease.attemptId === attempt.id && attempt.lease.releasedAt));
  const saved = JSON.parse(await readFile(team.path, "utf8"));
  assert.equal(saved.attempts.length, 3);
  assert.equal(saved.attempts[1].acknowledgeSideEffects, true);
}));

test("Accepted or unreviewed submissions cannot be silently retried", () => fixture(async (team) => {
  const a = spawn(team);
  await team.wait();
  await assert.rejects(retryBoard(team, a.taskId, "submitted"), /仅失败/);
  reviewTask(team, a.taskId, "accepted");
  await assert.rejects(retryBoard(team, a.taskId, "accepted"), /仅失败/);
  assert.equal(team.record.attempts.length, 1);
}));

test("Unassigned and blocked tasks can be cancelled; restart interrupts their reservations without dispatch", () => fixture(async (team, directory) => {
  const a = boardTask(team, "unassigned");
  const b = boardTask(team, "blocked", { dependsOn: [a.taskId] });
  await team.cancelTask(team.record.rootAgentId, { taskId: b.taskId, expectedVersion: b.version, requestKey: "cancel-blocked" });
  assert.equal(team.taskSnapshot(b.taskId).task.state, "cancelled");
  const warnings = recoverInterruptedTeams(directory);
  assert.deepEqual(warnings, []);
  const saved = JSON.parse(await readFile(team.path, "utf8"));
  assert.equal(saved.tasks.find((task) => task.id === a.taskId).state, "interrupted");
  assert.equal(saved.tasks.find((task) => task.id === b.taskId).state, "cancelled");
  assert.equal(saved.attempts.length, 0);
  await team.close();
  assert(team.record.tasks.every((task) => task.state === "cancelled"));
}));

test("A failed claim write cannot dispatch an unrecorded board attempt", () => fixture(async (team, directory) => {
  const gate = deferred(); let calls = 0;
  team.adapter.run = async (_entry, { ready, signal }) => { calls++; ready(); await gateOrAbort(gate, signal); return "done"; };
  const task = boardTask(team, "durable-claim");
  const a = spawn(team);
  await flush();
  team.path = join(directory, "missing", "record.json");
  assert.throws(() => team.claimTask(a.agentId, { taskId: task.taskId, expectedVersion: task.version }, a.attemptId), /保存失败/);
  await flush();
  assert.equal(calls, 1);
  assert(team.fatal);
  gate.resolve();
}));

test("Review binds both the current task version and execution attempt", () => fixture(async (team) => {
  const a = spawn(team);
  await team.wait();
  const old = team.taskSnapshot(a.taskId);
  reviewTask(team, a.taskId, "rejected");
  await retryBoard(team, a.taskId, "replace-review");
  await team.wait();
  const current = team.taskSnapshot(a.taskId);
  assert.throws(() => team.review(a.taskId, "accepted", { expectedVersion: old.task.version, attemptId: old.attempt.id }), /版本/);
  assert.throws(() => team.review(a.taskId, "accepted", { expectedVersion: current.task.version, attemptId: old.attempt.id }), /执行尝试/);
  assert.throws(() => team.review(a.taskId, "accepted"), /版本/);
  assert.equal(team.taskSnapshot(a.taskId).task.state, "submitted");
  reviewTask(team, a.taskId, "accepted");
}));

test("Recovery also checks unfinished board tasks when a closed record has no actors", () => fixture(async (team, directory) => {
  const task = boardTask(team, "closing-crash");
  const saved = JSON.parse(await readFile(team.path, "utf8"));
  saved.closed = true;
  await writeFile(team.path, JSON.stringify(saved));
  recoverInterruptedTeams(directory);
  const recovered = JSON.parse(await readFile(team.path, "utf8"));
  assert.equal(recovered.tasks[0].state, "interrupted");
  assert(recovered.tasks[0].version > task.version);
}));

test("Parallel retries during terminal cleanup cannot allocate two generations", () => fixture(async (team) => {
  let firstRetry; let competingRetry;
  const a = spawn(team);
  team.onChange = ({ task }) => {
    if (task.id === a.taskId && task.state === "submitted" && !firstRetry) {
      reviewTask(team, task.id, "rejected");
      firstRetry = retryBoard(team, task.id, "race-first");
      competingRetry = retryBoard(team, task.id, "race-second");
      void competingRetry.catch(() => {});
    }
  };
  await flush();
  await firstRetry;
  await assert.rejects(competingRetry, /重新分配/);
  await team.wait();
  assert.equal(team.record.attempts.filter((attempt) => attempt.taskId === a.taskId).length, 2);
}));

test("Waiting for a member includes board tasks it claims after the wait began", () => fixture(async (team) => {
  const gates = [deferred(), deferred()]; let runs = 0;
  team.adapter.run = async (_entry, { ready, signal }) => { const index = runs++; ready(); await gateOrAbort(gates[index], signal); return "done"; };
  const board = boardTask(team, "claimed-while-waiting");
  const a = spawn(team);
  await flush();
  let finished = false;
  const waiting = team.wait([a.agentId]).then((result) => { finished = true; return result; });
  team.claimTask(a.agentId, { taskId: board.taskId, expectedVersion: board.version }, a.attemptId);
  gates[0].resolve();
  await flush();
  assert.equal(runs, 2);
  assert.equal(finished, false);
  gates[1].resolve();
  assert.equal((await waiting).finished, true);
}));
