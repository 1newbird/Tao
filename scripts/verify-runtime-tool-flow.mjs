import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { once } from "node:events";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { pathToFileURL } from "node:url";
import { collaborationDecision } from "./collaboration-fixture.mjs";
import { taskBoardDecision } from "./task-board-fixture.mjs";

const root = resolve(process.cwd());
const resourceArgument = process.argv.indexOf("--resource-root");
if (resourceArgument >= 0 && (!process.argv[resourceArgument + 1] || process.argv[resourceArgument + 1].startsWith("--"))) throw new Error("--resource-root 必须提供已提取的发布资源目录");
const resourceRoot = resourceArgument >= 0 ? resolve(process.argv[resourceArgument + 1]) : null;
const piRoot = resourceRoot ? join(resourceRoot, "pi") : join(root, "vendor", "pi");
const runtimeScript = resourceRoot ? join(resourceRoot, "runtime", "tao-runtime.mjs") : join(root, "src-tauri", "runtime", "tao-runtime.mjs");
const tempRoot = await mkdtemp(join(root, ".runtime-tool-flow-"));
const taoHome = join(tempRoot, "tao-home");
const workspaceA = join(tempRoot, "workspace-a");
const workspaceB = join(tempRoot, "workspace-b");

let activeGatewayRequests = 0;
let maxConcurrentGatewayRequests = 0;
const gatewayRequests = [];
const retryFailures = new Map();

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function writeSse(response, payload) {
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function toolCallChunk(toolName, argumentsJson, id) {
  return {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "tao-runtime-test",
    choices: [{
      index: 0,
      delta: {
        tool_calls: [{
          index: 0,
          id: `${id}-tool`,
          type: "function",
          function: { name: toolName, arguments: argumentsJson },
        }],
      },
      finish_reason: null,
    }],
  };
}

function terminalChunk(content, id, finishReason = "stop") {
  return {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "tao-runtime-test",
    choices: [{
      index: 0,
      delta: content ? { content } : {},
      finish_reason: finishReason,
    }],
  };
}

function messageText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

async function createGateway() {
  const server = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }

    let body = "";
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body);
    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    const userText = messageText(messages.filter((message) => message.role === "user").at(-1)?.content);
    const toolMessages = messages.filter((message) => message.role === "tool");
    const hasToolResult = toolMessages.length > 0;
    const isDirectoryRequest = /目录|list/i.test(userText);
    const isEditRequest = /编辑|edit/i.test(userText);
    const isSlowRequest = /慢速|停止测试/i.test(userText);
    const isRetryRequest = /重试测试/i.test(userText);
    const isTimeoutRequest = /超时测试/i.test(userText);
    const isProfileRequest = /组合测试/.test(userText);
    const isProcessRequest = /程序参数测试/.test(userText);
    const isScopeRequest = /权限范围测试/.test(userText);
    const isCancelProcessRequest = /程序取消测试/.test(userText);
    const isTeamRequest = userText.includes("TAO_TEAM_ROOT");
    const isTeamChild = userText.includes("TAO_CHILD_");
    const isDefaultTeam = userText.includes("TAO_DEFAULT_TEAM");
    const isDocsRequest = userText.includes("TAO_DOC_LOOKUP");
    const collaboration = taskBoardDecision(messages) ?? collaborationDecision(messages);
    const requestId = `mock-${gatewayRequests.length + 1}`;
    gatewayRequests.push({
      userText,
      hasToolResult,
      toolResultText: toolMessages.map((message) => messageText(message.content)).join("\n"),
      systemText: messages.filter((message) => ["system", "developer"].includes(message.role)).map((message) => messageText(message.content)).join("\n"),
      userMessages: messages.filter((message) => message.role === "user").map((message) => messageText(message.content)),
      tools: Array.isArray(payload.tools)
        ? payload.tools.map((tool) => tool?.function?.name).filter((name) => typeof name === "string")
        : [],
      toolDescriptions: Object.fromEntries((payload.tools ?? []).filter((tool) => tool?.function?.name).map((tool) => [tool.function.name, tool.function.description ?? ""])),
    });

    activeGatewayRequests += 1;
    maxConcurrentGatewayRequests = Math.max(maxConcurrentGatewayRequests, activeGatewayRequests);
    try {
      if (isRetryRequest) {
        const failures = retryFailures.get(userText) ?? 0;
        retryFailures.set(userText, failures + 1);
        // Pi first performs the configured provider-level retries (two attempts
        // after the initial request).  Fail all three requests so the
        // AgentSession itself emits auto_retry_start, then let its next turn
        // succeed.
        if (failures < 3) {
          response.writeHead(503, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: { message: "mock overloaded" } }));
          return;
        }
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, isTeamChild ? 180 : isSlowRequest || isTimeoutRequest ? 1_200 : 70));
      if (response.destroyed) return;
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      if (collaboration) {
        if (collaboration.name) {
          writeSse(response, toolCallChunk(collaboration.name, JSON.stringify(collaboration.input), requestId));
          writeSse(response, terminalChunk("", requestId, "tool_calls"));
        } else {
          writeSse(response, terminalChunk(collaboration.answer, requestId));
          writeSse(response, terminalChunk("", requestId));
        }
      } else if (isDefaultTeam) {
        const results = toolMessages.map((message) => { try { return JSON.parse(messageText(message.content)); } catch { return {}; } });
        const spawned = results.find((result) => result.agentId);
        const waited = results.some((result) => Array.isArray(result.members));
        if (!spawned) writeSse(response, toolCallChunk("spawn_agent", JSON.stringify({ profileId: "tao-default-worker", taskName: "默认成员核对", description: "组合测试 AUTO_WORKER_CHILD" }), requestId));
        else if (!waited) writeSse(response, toolCallChunk("wait_agent", JSON.stringify({ agentIds: [spawned.agentId], mode: "all", timeoutMs: 5000 }), requestId));
        else writeSse(response, terminalChunk("默认成员流程完成。", requestId));
        writeSse(response, terminalChunk("", requestId, waited ? "stop" : "tool_calls"));
      } else if (isDocsRequest && !hasToolResult) {
        writeSse(response, toolCallChunk("read_tao_doc", JSON.stringify({ topic: "permissions" }), requestId));
        writeSse(response, terminalChunk("", requestId, "tool_calls"));
      } else if (isTeamRequest) {
        const results = toolMessages.map((message) => { try { return JSON.parse(messageText(message.content)); } catch { return {}; } });
        const spawned = results.filter((result) => result.agentId);
        const waited = results.find((result) => Array.isArray(result.members));
        const reviews = toolMessages.filter((message) => message.name === "review_agent_task").length;
        // Some providers omit name on tool results; the payload itself remains reliable.
        const reviewed = results.filter((result) => ["accepted", "rejected"].includes(result.task?.state)).length;
        const cancelled = results.some((result) => result.attempt?.state === "cancelled");
        let name; let input;
        if (spawned.length === 0) { name = "spawn_agent"; input = { profileId: "worker-a", taskName: "核查 A", description: userText.includes("TURN_LIMIT") ? "TAO_CHILD_LOOP" : "TAO_CHILD_A" }; }
        else if (userText.includes("CANCEL_ONE")) { if (!cancelled) { name = "cancel_agent"; input = { agentId: spawned[0].agentId }; } }
        else if (userText.includes("EARLY_FINISH")) { /* Finish without waiting; the runtime must reclaim A. */ }
        else if (spawned.length === 1 && !userText.includes("TURN_LIMIT")) { name = "spawn_agent"; input = { profileId: "worker-b", taskName: "写入 B", description: `TAO_CHILD_B ${userText.includes("BLOCK_APPROVAL") ? "BLOCK_APPROVAL" : ""}` }; }
        else if (!waited) { name = "wait_agent"; input = { agentIds: spawned.map((result) => result.agentId), mode: "all", timeoutMs: 5000 }; }
        else if (results.filter((result) => Array.isArray(result.members)).length === 1) { name = "get_agent_status"; input = { agentIds: spawned.map((result) => result.agentId) }; }
        else if (!userText.includes("TURN_LIMIT") && Math.max(reviews, reviewed) < 2) { const entry = waited.members[Math.max(reviews, reviewed)]; name = "review_agent_task"; input = { taskId: entry.task.id, decision: "accepted", expectedVersion: entry.task.version, attemptId: entry.attempt.id }; }
        if (name) {
          writeSse(response, toolCallChunk(name, JSON.stringify(input), requestId));
          writeSse(response, terminalChunk("", requestId, "tool_calls"));
        } else {
          writeSse(response, terminalChunk("团队汇总完成。", requestId));
          writeSse(response, terminalChunk("", requestId));
        }
      } else if (isTeamChild) {
        const isA = userText.includes("TAO_CHILD_A") || userText.includes("TAO_CHILD_LOOP");
        if (!hasToolResult || userText.includes("TAO_CHILD_LOOP")) {
          writeSse(response, toolCallChunk(isA ? "read" : "write", JSON.stringify(isA ? { path: "fixture.txt" } : { path: userText.includes("BLOCK_APPROVAL") ? "team-blocked.txt" : "team-child.txt", content: "child wrote" }), requestId));
          writeSse(response, terminalChunk("", requestId, "tool_calls"));
        } else {
          writeSse(response, terminalChunk(isA ? "CHILD_A_PRIVATE_RESULT" : "CHILD_B_PRIVATE_RESULT", requestId));
          writeSse(response, terminalChunk("", requestId));
        }
      } else if (hasToolResult) {
        writeSse(response, terminalChunk("本地工具流程已完成。", requestId));
        writeSse(response, terminalChunk("", requestId));
      } else if (isProfileRequest) {
        writeSse(response, terminalChunk("组合测试完成。", requestId));
        writeSse(response, terminalChunk("", requestId));
      } else if (isCancelProcessRequest) {
        writeSse(response, toolCallChunk("slow_write", JSON.stringify({ text: "cancel" }), requestId));
        writeSse(response, terminalChunk("", requestId, "tool_calls"));
      } else if (isProcessRequest) {
        writeSse(response, toolCallChunk("echo_json", JSON.stringify({ text: 'quoted " & > ignored | $(fake)' }), requestId));
        writeSse(response, terminalChunk("", requestId, "tool_calls"));
      } else if (isScopeRequest) {
        writeSse(response, toolCallChunk("write", JSON.stringify({ path: "linked/new.txt", content: "must-not-write" }), requestId));
        writeSse(response, terminalChunk("", requestId, "tool_calls"));
      } else if (isEditRequest) {
        writeSse(response, terminalChunk("我先检查一下要修改的文件。\n", requestId, null));
        writeSse(response, toolCallChunk("edit", "{\"path\":\"editable.txt\",\"edits\":[{\"oldText\":\"before\\n\",\"newText\":\"after\\n\"}]}", requestId));
        writeSse(response, terminalChunk("", requestId, "tool_calls"));
      } else if (isDirectoryRequest) {
        writeSse(response, terminalChunk("我先确认一下当前目录。\n", requestId, null));
        writeSse(response, toolCallChunk("bash", "{\"command\":\"node.exe -e \\\"process.stdout.write(process.cwd())\\\"\"}", requestId));
        writeSse(response, terminalChunk("", requestId, "tool_calls"));
      } else {
        writeSse(response, terminalChunk("我先读取一下 fixture.txt。\n", requestId, null));
        writeSse(response, toolCallChunk("read", "{\"path\":\"fixture.txt\",\"limit\":20}", requestId));
        writeSse(response, terminalChunk("", requestId, "tool_calls"));
      }
      response.write("data: [DONE]\n\n");
      response.end();
    } finally {
      activeGatewayRequests -= 1;
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string", "本地模型网关未取得端口。");
  return { server, baseUrl: `http://127.0.0.1:${address.port}/v1` };
}

async function writeFixture(baseUrl) {
  await mkdir(join(taoHome, "sessions"), { recursive: true });
  await mkdir(workspaceA, { recursive: true });
  await mkdir(workspaceB, { recursive: true });
  await mkdir(join(tempRoot, "outside"));
  await symlink(join(tempRoot, "outside"), join(workspaceA, "linked"), process.platform === "win32" ? "junction" : "dir");
  await writeFile(join(workspaceA, "fixture.txt"), "TAO_PRIVATE_TOOL_RESULT_MUST_NOT_REACH_UI\n", "utf8");
  await writeFile(join(workspaceB, "fixture.txt"), "TAO_PRIVATE_TOOL_RESULT_MUST_NOT_REACH_UI\n", "utf8");
  await writeFile(join(workspaceA, "editable.txt"), "before\n", "utf8");
  await writeFile(join(taoHome, "auth.json"), JSON.stringify({
    "tao-custom": { type: "api_key", key: "runtime-test-key" },
  }), "utf8");
  await writeFile(join(taoHome, "models.json"), JSON.stringify({
    providers: {
      "tao-custom": {
        baseUrl,
        api: "openai-completions",
        models: [{
          id: "tao-runtime-test",
          name: "tao-runtime-test",
          reasoning: false,
          input: ["text"],
          contextWindow: 128000,
          maxTokens: 4096,
        }],
      },
    },
  }), "utf8");
  // Keep this test deterministic: the Runtime applies the provider timeout
  // through Pi's in-memory SettingsManager without modifying the user's file.
  await writeFile(join(taoHome, "settings.json"), JSON.stringify({
    retry: { provider: { timeoutMs: 250, maxRetries: 0, maxRetryDelayMs: 100 } },
    httpIdleTimeoutMs: 250,
  }), "utf8");
}

async function startRuntime() {
  const preflight = join(piRoot, "node_modules", "tsx", "dist", "preflight.cjs");
  const loader = pathToFileURL(join(piRoot, "node_modules", "tsx", "dist", "loader.mjs")).href;
  const child = spawn(process.execPath, [
    "--require", preflight,
    "--import", loader,
    runtimeScript,
    "--pi-root", piRoot,
    "--tao-home", taoHome,
    "--cwd", workspaceA,
  ], {
    cwd: piRoot,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: taoHome,
      TSX_TSCONFIG_PATH: join(piRoot, "tsconfig.json"),
      NO_COLOR: "1",
      FORCE_COLOR: "0",
    },
  });

  const events = [];
  const responses = new Map();
  let ready;
  let fatal;
  const stdout = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  stdout.on("line", (line) => {
    const message = JSON.parse(line);
    if (message.type === "ready") ready = message;
    if (message.type === "fatal") fatal = message.message;
    if (message.type === "event") {
      events.push(message.payload);
      if (message.payload.category === "permission" && message.payload.event === "requested" && !["team-permission-stop", "collaboration-permission"].includes(message.payload.conversationId)) {
        // This local fixture deliberately approves the requested test actions.
        child.stdin.write(`${JSON.stringify({ id: `permission-${message.payload.permissionId}`, type: "permission_response", conversationId: message.payload.conversationId, permissionId: message.payload.permissionId, decision: "allow_once" })}\n`);
      }
    }
    if (message.type === "response") {
      const pending = responses.get(message.id);
      if (pending) {
        responses.delete(message.id);
        message.success ? pending.resolve(message.data) : pending.reject(new Error(message.error));
      }
    }
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });

  const waitForReady = async () => {
    const started = Date.now();
    while (!ready && !fatal && Date.now() - started < 20_000) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
    }
    if (fatal) throw new Error(`Runtime 启动失败：${fatal}`);
    if (!ready) throw new Error(`Runtime 未在 20 秒内启动：${stderr}`);
  };

  let sequence = 0;
  const registerRequest = (command) => {
    const id = `test-${++sequence}`;
    const promise = new Promise((resolveResponse, rejectResponse) => {
      responses.set(id, { resolve: resolveResponse, reject: rejectResponse });
      setTimeout(() => {
        const pending = responses.get(id);
        if (pending) { responses.delete(id); rejectResponse(new Error(`Runtime 请求超时：${command.type}`)); }
      }, 30_000).unref();
    });
    return { promise, line: `${JSON.stringify({ ...command, id })}\n` };
  };
  const request = (command) => {
    const registered = registerRequest(command);
    child.stdin.write(registered.line);
    return registered.promise;
  };

  return {
    child,
    events,
    request,
    requestBatch(commands) {
      const registered = commands.map(registerRequest);
      child.stdin.write(registered.map((item) => item.line).join(""));
      return registered.map((item) => item.promise);
    },
    waitForReady,
    async stop() {
      child.stdin.write("{\"type\":\"shutdown\"}\n");
      await Promise.race([
        once(child, "exit"),
        new Promise((resolveDelay) => setTimeout(resolveDelay, 5_000)),
      ]);
      if (!child.killed && child.exitCode === null) child.kill();
    },
  };
}

function prompt(conversationId, requestId, message, workspacePath) {
  return {
    type: "prompt",
    conversationId,
    requestId,
    message,
    provider: "tao-custom",
    model: "tao-runtime-test",
    baseUrl: "http://runtime-test.invalid",
    api: "openai-completions",
    thinkingLevel: "off",
    workspacePath,
  };
}

const { server, baseUrl } = await createGateway();
let runtime;
try {
  await writeFixture(baseUrl);
  runtime = await startRuntime();
  await runtime.waitForReady();

  const profile = (systemPrompt, enabledTools, customTools = [], toolPermissions = {}) => ({ enabled: true, systemPromptMode: "replace", systemPrompt, conversationPrompt: "", toolMode: "custom", enabledTools, customTools, toolPermissions });
  const alpha = { ...prompt("profile-alpha", "profile-alpha-1", "组合测试 Alpha", workspaceA), runtimeConfiguration: profile("ALPHA_PROFILE_ONLY", ["read"]) };
  const beta = { ...prompt("profile-beta", "profile-beta-1", "组合测试 Beta", workspaceB), runtimeConfiguration: profile("BETA_PROFILE_ONLY", []) };
  await Promise.all([runtime.request(alpha), runtime.request(beta)]);
  await mkdir(join(taoHome, "runtime"), { recursive: true });
  await writeFile(join(taoHome, "runtime/profile.json"), JSON.stringify(profile("GLOBAL_CHANGE_MUST_NOT_APPLY", [])));
  await runtime.request({ ...alpha, requestId: "profile-alpha-2", message: "组合测试 Alpha 再次" });
  const alphaRequests = gatewayRequests.filter((request) => request.userText.includes("组合测试 Alpha"));
  assert(alphaRequests.length === 2 && alphaRequests.every((request) => request.systemText.includes("ALPHA_PROFILE_ONLY") && !request.systemText.includes("BETA_PROFILE_ONLY") && !request.systemText.includes("GLOBAL_CHANGE_MUST_NOT_APPLY") && request.tools.join(",") === "read,read_tao_doc"), "Alpha 组合配置未隔离或被全局编辑改变");
  assert(gatewayRequests.some((request) => request.userText.includes("组合测试 Beta") && request.systemText.includes("BETA_PROFILE_ONLY") && request.tools.join(",") === "read_tao_doc"), "Beta 无业务工具组合没有独立生效");
  await rm(join(taoHome, "runtime/profile.json"));

  const autoProfile = { ...profile("DEFAULT_ROOT_ROLE", ["read"], [], { read: { mode: "deny", pathScope: "workspace" } }), delegation: { enabled: true, allowedProfileIds: [], maxConcurrent: 2, maxTasks: 4, timeoutMs: 5000, maxTurns: 3 } };
  await runtime.request({ ...prompt("default-plain", "default-plain-1", "组合测试 只需直接回答", workspaceA), runtimeConfiguration: autoProfile });
  assert((await runtime.request({ type: "list_team_runs", conversationId: "default-plain" })).runs.length === 0, "普通问答不应因为默认启用协作而创建空团队");
  const autoResult = await runtime.request({ ...prompt("default-team", "default-team-1", "TAO_DEFAULT_TEAM", workspaceA), runtimeConfiguration: autoProfile });
  assert(autoResult.messages.some((message) => message.content === "默认成员流程完成。"), "未选择子组合时默认成员无法派发或等待");
  const autoRuns = await runtime.request({ type: "list_team_runs", conversationId: "default-team" });
  const autoFiles = await readdir(join(taoHome, "teams", "default-team"));
  const autoRecord = JSON.parse(await readFile(join(taoHome, "teams", "default-team", autoFiles.find((file) => file.endsWith(".json"))), "utf8"));
  assert(autoRuns.runs.length === 1 && autoRecord.agents[0].snapshot.profileId === "tao-default-worker", "默认成员归属错误");
  assert(autoRecord.agents[0].snapshot.configuration.toolPermissions.read.mode === "deny" && !autoRecord.agents[0].snapshot.configuration.delegation.enabled, "默认成员放宽了权限或允许递归");
  assert(gatewayRequests.some((request) => request.userText.includes("AUTO_WORKER_CHILD") && request.tools.includes("read_tao_doc") && !request.tools.includes("spawn_agent") && request.systemText.includes("成员协作规则")), "默认成员未获得正确的平台工具或角色规则");
  await runtime.request({ ...prompt("doc-lookup", "doc-lookup-1", "TAO_DOC_LOOKUP", workspaceA), runtimeConfiguration: profile("Docs lookup", []) });
  assert(gatewayRequests.some((request) => request.userText.includes("TAO_DOC_LOOKUP") && request.toolResultText.includes("Tao 运行手册 · tao-context-v2") && request.toolResultText.includes("授权与执行边界")), "模型无法按需查阅随包文档");
  assert(!runtime.events.some((event) => event.conversationId === "doc-lookup" && event.category === "permission" && event.event === "requested"), "只读内置文档不应请求本机文件访问权限");

  const processTool = { id: "echo", name: "echo_json", label: "程序参数", description: "CUSTOM_TOOL_DESCRIPTION_ONLY_IN_TOOLS", kind: "process", enabled: true, permissionMode: "ask", executable: "node", arguments: JSON.stringify(["-e", "process.stdout.write(process.argv[1])", "{{text}}"]), timeoutMs: 1000, inputSchema: JSON.stringify({ type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false }) };
  await runtime.request({ ...prompt("process-tool", "process-tool-1", "程序参数测试", workspaceA), permissionMode: "full_access", runtimeConfiguration: { ...profile("Process test", [], [processTool]), systemPromptMode: "append" } });
  assert(gatewayRequests.filter((request) => request.userText.includes("程序参数测试")).every((request) => request.toolDescriptions.echo_json === processTool.description && !request.systemText.includes(processTool.description)), "自定义工具描述被重复注入 system，或未通过 tools 参数传递");
  assert(gatewayRequests.some((request) => request.userText.includes("程序参数测试") && request.toolResultText === 'quoted " & > ignored | $(fake)'), `程序参数没有作为独立参数传递：${JSON.stringify(gatewayRequests.filter((request) => request.userText.includes("程序参数测试")))}`);
  assert(runtime.events.some((event) => event.conversationId === "process-tool" && event.category === "permission" && event.event === "requested"), "工具询问规则被完全放行绕过");
  const invalidInput = await runtime.request({ type: "test_custom_tool", tool: processTool, input: "{}", workspacePath: workspaceA }).then(() => "").catch((error) => String(error));
  assert(/validation|text/i.test(invalidInput), "工具测试未验证输入 Schema");
  const wrongHost = await runtime.request({ type: "test_custom_tool", tool: { ...processTool, kind: "http", url: "https://example.org/", allowedHosts: ["example.com"], headers: "" }, input: '{"text":"test"}', workspacePath: workspaceA }).then(() => "").catch((error) => String(error));
  assert(wrongHost.includes("允许的域名"), "HTTP 工具未拒绝范围外主机");
  const timedProcess = await runtime.request({ type: "test_custom_tool", tool: { ...processTool, arguments: '["-e","setTimeout(() => {}, 20000)"]' }, input: '{"text":"test"}', workspacePath: workspaceA }).then(() => "").catch((error) => String(error));
  assert(/abort|timeout|killed|取消|超时/i.test(timedProcess), "自定义程序未按超时取消");
  const delayedChild = (file) => `require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify("setTimeout(() => require('fs').writeFileSync('" + file + "', 'bad'), 1500)")}], { stdio: 'inherit' }); setTimeout(() => {}, 20000);`;
  await writeFile(join(workspaceA, "timeout-tree.cjs"), delayedChild("timed-out-child.txt"));
  const shellTimeout = await runtime.request({ type: "test_custom_tool", tool: { ...processTool, kind: "command", command: `"${process.execPath}" timeout-tree.cjs` }, input: '{"text":"test"}', workspacePath: workspaceA }).then(() => "").catch((error) => String(error));
  assert(/取消|超时/i.test(shellTimeout), "Shell 工具未按超时停止");
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 1600));
  assert(!existsSync(join(workspaceA, "timed-out-child.txt")), "Shell 超时后子进程仍执行了写操作");

  await runtime.request({ ...prompt("deny-read", "deny-read-1", "请读取 fixture.txt", workspaceA), permissionMode: "full_access", runtimeConfiguration: profile("deny", ["read"], [], { read: { mode: "deny", pathScope: "any" } }) });
  assert(gatewayRequests.some((request) => request.toolResultText.includes("此组合禁止使用该工具")), "组合禁止规则未优先执行");
  await runtime.request({ ...prompt("scope-write", "scope-write-1", "权限范围测试", workspaceA), permissionMode: "full_access", runtimeConfiguration: profile("scope", ["write"], [], { write: { mode: "allow", pathScope: "workspace" } }) });
  assert(!existsSync(join(tempRoot, "outside/new.txt")), "工作区范围限制被目录链接绕过");

  // Deliver both lines in one input chunk. Separate writes can arrive after
  // preparation has already finished, which would test a different phase.
  const preparingRequests = runtime.requestBatch([
    { ...prompt("cancel-preparing", "cancel-preparing-1", "组合测试 不应调用模型", workspaceA), runtimeConfiguration: profile("cancel", []) },
    { type: "cancel_active", conversationId: "cancel-preparing" },
  ]);
  await Promise.all(preparingRequests);
  assert(!gatewayRequests.some((request) => request.userText.includes("不应调用模型")), "准备期间取消的请求仍调用了模型");

  const slowTool = { ...processTool, name: "slow_write", permissionMode: "allow", arguments: JSON.stringify(["-e", delayedChild("cancelled-write.txt")]), timeoutMs: 30000 };
  const cancelledProcess = runtime.request({ ...prompt("cancel-process", "cancel-process-1", "程序取消测试", workspaceA), runtimeConfiguration: profile("cancel-process", [], [slowTool]) }).catch(() => null);
  const waitStarted = Date.now();
  while (!runtime.events.some((event) => event.conversationId === "cancel-process" && event.category === "tool" && event.event === "started") && Date.now() - waitStarted < 5000) await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  assert(runtime.events.some((event) => event.conversationId === "cancel-process" && event.category === "tool" && event.event === "started"), "取消测试的程序工具没有启动");
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
  await runtime.request({ type: "cancel_active", conversationId: "cancel-process" });
  await cancelledProcess;
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 1600));
  assert(!existsSync(join(workspaceA, "cancelled-write.txt")), "取消后工具进程仍执行了写操作");
  await runtime.request({ ...prompt("cancel-process", "cancel-process-2", "组合测试 取消后继续", workspaceA), runtimeConfiguration: profile("cancel-process", [], [slowTool]) });

  const sessionsBeforeTeam = (await runtime.request({ type: "get_status" })).sessionCount;
  const teamConfig = {
    ...profile("PARENT_PROFILE_ONLY", ["read", "write"], [], { read: { mode: "deny", pathScope: "any" }, write: { mode: "ask", pathScope: "workspace" } }),
    delegation: { enabled: true, allowedProfileIds: ["worker-a", "worker-b"], maxConcurrent: 2, maxTasks: 4, timeoutMs: 5000, maxTurns: 3 },
  };
  const delegationProfiles = [
    { profileId: "worker-a", name: "核查组合", revision: 3, configuration: profile("CHILD_PROFILE_A", ["read"], [], { read: { mode: "allow", pathScope: "any" } }) },
    { profileId: "worker-b", name: "写入组合", revision: 4, configuration: profile("CHILD_PROFILE_B", ["write"], [], { write: { mode: "allow", pathScope: "any" } }) },
  ];
  const teamCommand = { ...prompt("team-root", "team-root-1", "TAO_TEAM_ROOT MAIN_CONTEXT_SECRET", workspaceA), permissionMode: "full_access", runtimeConfiguration: { ...teamConfig, systemPromptMode: "append" }, delegationProfiles };
  const teamResult = await runtime.request(teamCommand);
  assert(gatewayRequests.some((request) => request.userText.includes("TAO_TEAM_ROOT MAIN_CONTEXT_SECRET") && request.toolDescriptions.spawn_agent?.startsWith("创建独立上下文的子代理") && !request.systemText.includes("创建独立上下文的子代理并立即返回")), "协作工具应独立通过 tools 传递，不重复填入 system");
  const teamTemplate = await runtime.request({ type: "preview_context", runtimeConfiguration: { ...teamConfig, systemPromptMode: "append", enabledTools: [] } });
  assert(teamTemplate.tools.some((tool) => tool.name === "spawn_agent") && !teamTemplate.systemPrompt.includes("创建独立上下文的子代理并立即返回"), "协作工具不应依赖普通工具勾选，或预览仍重复组装工具描述");
  assert(teamResult.messages.some((message) => message.content === "团队汇总完成。"), "主代理未完成子任务汇总");
  const teamFiles = await readdir(join(taoHome, "teams", "team-root"));
  const teamRecord = JSON.parse(await readFile(join(taoHome, "teams", "team-root", teamFiles.find((file) => file.endsWith(".json"))), "utf8"));
  const runList = await runtime.request({ type: "list_team_runs", conversationId: "team-root" });
  assert(runList.runs.length === 1 && runList.runs[0].runId === teamRecord.runId, "历史协作轮次列表未返回实际记录");
  const archivedView = await runtime.request({ type: "get_team_view", conversationId: "team-root", runId: teamRecord.runId, agentId: teamRecord.agents[0].id });
  assert(!archivedView.live && archivedView.closed && archivedView.events.some((event) => event.kind === "assistant"), "成员输出没有保存或历史视图错误地可执行");
  assert(!JSON.stringify(archivedView).includes("CHILD_PROFILE_A") && !JSON.stringify(archivedView).includes("runtime-test-key") && !JSON.stringify(archivedView).includes("TAO_PRIVATE_TOOL_RESULT_MUST_NOT_REACH_UI"), "成员视图暴露配置、凭据或原始工具结果");
  assert(teamRecord.closed && teamRecord.tasks.length === 2 && teamRecord.tasks.every((task) => task.state === "accepted"), "提交和验收状态未保存");
  assert(teamRecord.agents.every((agent) => agent.state === "closed"), "主请求结束后未回收子代理");
  const humanStart = gatewayRequests.length;
  const humanRoot = runtime.request({ ...teamCommand, conversationId: "human-root", requestId: "human-root-1", message: "TAO_COLLAB_ROOT HUMAN_ROOT", runtimeConfiguration: { ...teamConfig, delegation: { ...teamConfig.delegation, maxTurns: 30 } } });
  let humanView;
  const humanDeadline = Date.now() + 5000;
  while (Date.now() < humanDeadline) {
    const list = await runtime.request({ type: "list_team_runs", conversationId: "human-root" });
    if (list.runs[0]) { humanView = await runtime.request({ type: "get_team_view", conversationId: "human-root", runId: list.runs[0].runId }); if (humanView.tasks[0]?.state === "running") break; }
    await new Promise((done) => setTimeout(done, 10));
  }
  assert(humanView?.live && humanView.tasks[0]?.state === "running", "人工介入测试未进入运行中");
  const humanTask = humanView.tasks[0];
  const humanControl = { type: "control_team", conversationId: "human-root", runId: humanView.runId, agentId: humanTask.assignedAgentId, taskId: humanTask.id, attemptId: humanTask.attemptId, expectedVersion: humanTask.version, action: "message", body: "HUMAN_UI_SUPPLEMENT", requestKey: "human-live-message" };
  const humanReceipt = await runtime.request(humanControl);
  assert((await runtime.request(humanControl)).messageId === humanReceipt.messageId, "重复介入消息没有去重");
  await humanRoot;
  const humanArchived = await runtime.request({ type: "get_team_view", conversationId: "human-root", runId: humanView.runId, agentId: humanTask.assignedAgentId });
  assert(humanArchived.messages.some((message) => message.id === humanReceipt.messageId && message.from === "user" && message.delivery === "delivered"), "用户说明未在安全边界投递");
  assert(humanArchived.attempts.some((attempt) => attempt.result === "HUMAN_SUPPLEMENT_SEEN"), "真实 SDK 成员未看到补充说明");
  assert((await runtime.request(humanControl)).duplicate === true, "关闭后重试原回执未被识别");
  assert(gatewayRequests.slice(humanStart).some((request) => request.userMessages.some((text) => text.includes("用户补充说明") && text.includes("HUMAN_UI_SUPPLEMENT")) || (request.toolResultText.includes("HUMAN_UI_SUPPLEMENT") && request.toolResultText.includes('"from":"user"'))), "模型上下文或邮箱结果没有保留用户说明来源");
  assert((await runtime.request({ type: "get_status" })).sessionCount === sessionsBeforeTeam + 2, "人工介入成员查看后仍有子 Session 残留");
  await runtime.request({ type: "close_session", conversationId: "human-root" });
  assert(teamRecord.attempts.every((attempt) => attempt.state === "submitted" && attempt.result.includes("PRIVATE_RESULT")), "独立子代理未交付结果");
  const teamChildren = gatewayRequests.filter((request) => request.userText.includes("TAO_CHILD_"));
  assert(teamChildren.length >= 4 && teamChildren.every((request) => !request.systemText.includes("PARENT_PROFILE_ONLY") && request.userMessages.every((text) => !text.includes("MAIN_CONTEXT_SECRET")) && !request.tools.includes("spawn_agent")), "子代理上下文或层级限制失效");
  assert(teamChildren.some((request) => request.userText.includes("TAO_CHILD_A") && request.toolResultText.includes("禁止")), "子代理放宽了父组合禁止规则");
  assert(await readFile(join(workspaceA, "team-child.txt"), "utf8") === "child wrote", "子代理工具未使用父工作区");
  assert(runtime.events.some((event) => event.conversationId === "team-root" && event.requestId === "team-root-1" && event.category === "permission" && event.permissionTitle?.includes("写入 B")), "子代理权限请求未正确回到主会话并注明任务");
  assert(teamResult.messages.at(-1).traces.some((trace) => trace.metadata?.taskState === "accepted"), "主会话未保存真实子任务记录");
  assert(!JSON.stringify(runtime.events).includes("CHILD_A_PRIVATE_RESULT"), "子代理结果污染了主会话流式事件");

  const permissionStop = runtime.request({ ...teamCommand, conversationId: "team-permission-stop", requestId: "team-stop-1", message: "TAO_TEAM_ROOT BLOCK_APPROVAL" }).catch(() => null);
  const permissionStarted = Date.now();
  while (!runtime.events.some((event) => event.conversationId === "team-permission-stop" && event.category === "permission" && event.event === "requested") && Date.now() - permissionStarted < 8000) await new Promise((done) => setTimeout(done, 20));
  assert(runtime.events.some((event) => event.conversationId === "team-permission-stop" && event.category === "permission" && event.event === "requested"), "未进入子代理权限等待测试");
  const stopRuns = await runtime.request({ type: "list_team_runs", conversationId: "team-permission-stop" });
  const stopCommand = { type: "control_team", conversationId: "team-permission-stop", runId: stopRuns.runs[0].runId, action: "stop_run", requestKey: "human-stop-run" };
  await runtime.request(stopCommand);
  assert((await runtime.request(stopCommand)).duplicate === true, "整轮停止没有保留重复请求回执");
  await permissionStop;
  assert(!existsSync(join(workspaceA, "team-blocked.txt")), "停止后子代理仍执行了未批准的写入");
  assert(runtime.events.some((event) => event.conversationId === "team-permission-stop" && event.category === "permission" && event.event === "denied"), "停止后子代理权限请求未取消");

  await runtime.request({ ...teamCommand, conversationId: "team-early", requestId: "team-early-1", message: "TAO_TEAM_ROOT EARLY_FINISH" });
  const earlyFiles = await readdir(join(taoHome, "teams", "team-early"));
  const earlyRecord = JSON.parse(await readFile(join(taoHome, "teams", "team-early", earlyFiles.find((file) => file.endsWith(".json"))), "utf8"));
  assert(earlyRecord.closed && earlyRecord.attempts[0].state === "cancelled", "父代理提前结束后仍遗留子任务");
  const afterTeamStatus = await runtime.request({ type: "get_status" });
  assert(afterTeamStatus.sessionCount === sessionsBeforeTeam + 3, `子代理 Session 未回收：${afterTeamStatus.sessionCount}，原会话数 ${sessionsBeforeTeam}`);
  await runtime.request({ ...teamCommand, conversationId: "team-turn-limit", requestId: "team-limit-1", message: "TAO_TEAM_ROOT TURN_LIMIT", runtimeConfiguration: { ...teamConfig, delegation: { ...teamConfig.delegation, maxTurns: 1 } } });
  const limitFiles = await readdir(join(taoHome, "teams", "team-turn-limit"));
  const limitRecord = JSON.parse(await readFile(join(taoHome, "teams", "team-turn-limit", limitFiles.find((file) => file.endsWith(".json"))), "utf8"));
  assert(limitRecord.attempts[0].state === "failed" && limitRecord.attempts[0].error.includes("轮次上限"), "子代理模型轮次限制未落实");
  assert(gatewayRequests.filter((request) => request.userText.includes("TAO_CHILD_LOOP")).length === 1, "达到轮次上限后仍调用了模型");
  await runtime.request({ ...teamCommand, conversationId: "team-cancel-one", requestId: "team-cancel-one-1", message: "TAO_TEAM_ROOT CANCEL_ONE" });
  const cancelFiles = await readdir(join(taoHome, "teams", "team-cancel-one"));
  const cancelRecord = JSON.parse(await readFile(join(taoHome, "teams", "team-cancel-one", cancelFiles.find((file) => file.endsWith(".json"))), "utf8"));
  assert(cancelRecord.attempts[0].state === "cancelled", "cancel_agent 工具未等待目标停止");

  const collaborationStart = gatewayRequests.length;
  const collaborationResult = await runtime.request({ ...teamCommand, conversationId: "collaboration-root", requestId: "collaboration-1", message: "TAO_COLLAB_ROOT MAIN_PRIVATE_CONTEXT", runtimeConfiguration: { ...teamConfig, toolPermissions: {}, delegation: { ...teamConfig.delegation, maxTurns: 12 } } });
  assert(collaborationResult.messages.some((message) => message.content === "协作通信与接续任务已完成。"), "协作模型未完成消息和接续任务流程");
  const collaborationFiles = await readdir(join(taoHome, "teams", "collaboration-root"));
  const collaborationRecord = JSON.parse(await readFile(join(taoHome, "teams", "collaboration-root", collaborationFiles.find((file) => file.endsWith(".json"))), "utf8"));
  assert(collaborationRecord.tasks.length === 3 && collaborationRecord.agents.length === 2, "接续任务未复用成员身份或没有独立任务记录");
  assert(collaborationRecord.attempts.every((attempt) => attempt.state === "submitted"), `协作任务未正常提交：${JSON.stringify(collaborationRecord.attempts.map((attempt) => ({ state: attempt.state, error: attempt.error })))}`);
  assert(collaborationRecord.attempts.some((attempt) => attempt.result === "FOLLOWUP_VERIFIED_HISTORY"), "接续任务没有复用私有会话上下文");
  const aInitial = collaborationRecord.tasks.find((task) => task.description === "TAO_COLLAB_A");
  const aFollow = collaborationRecord.tasks.find((task) => task.description === "TAO_COLLAB_FOLLOW_A");
  assert(aInitial.assignedAgentId === aFollow.assignedAgentId && aInitial.attemptId !== aFollow.attemptId, "任务和执行尝试身份混淆");
  assert(collaborationRecord.messages.filter((message) => message.body === "ROOT_HINT_FOR_A").length === 1, "重试消息重复入箱");
  assert(collaborationRecord.messages.some((message) => message.kind === "cancel_request") && collaborationRecord.tasks.every((task) => task.state !== "cancelled"), "取消建议被当作控制指令执行");
  assert(collaborationRecord.messages.find((message) => message.body === "IDLE_DO_NOT_WAKE")?.delivery === "undelivered", "空闲成员被普通消息隐式唤醒");
  const collaborationRequests = gatewayRequests.slice(collaborationStart);
  assert(collaborationRequests.some((request) => request.toolResultText.includes("成员仅能停止自己")), "同级取消越权没有被拒绝");
  const childCollaborationRequests = collaborationRequests.filter((request) => request.userMessages.some((text) => text.startsWith("[Tao 成员身份]")));
  assert(childCollaborationRequests.every((request) => !request.userMessages.some((text) => text.includes("MAIN_PRIVATE_CONTEXT")) && !request.tools.includes("followup_task") && !request.tools.includes("spawn_agent")), "主上下文或管理权限泄漏给成员");
  assert(childCollaborationRequests.some((request) => request.userMessages.some((text) => text.includes("B_SUGGESTION"))) && childCollaborationRequests.some((request) => request.userMessages.some((text) => text.includes("A_SHARED_EVIDENCE"))), "同级消息未在模型安全边界进入上下文");
  assert(collaborationRequests.some((request) => request.toolResultText.includes('"reason":"messages"') || request.userMessages.some((text) => text.includes("A_QUESTION_FOR_PARENT"))), "根会话未收到成员问题");
  assert(collaborationResult.messages.at(-1).traces.filter((trace) => trace.metadata?.taskId && trace.metadata?.taskState).length === 3, "接续任务覆盖了旧任务的展示记录");
  assert(!JSON.stringify(runtime.events).includes("A_SHARED_EVIDENCE"), "协作消息正文泄漏到主会话流式事件");
  const selfCancelStart = gatewayRequests.length;
  await runtime.request({ ...teamCommand, conversationId: "collaboration-self-stop", requestId: "self-stop-1", message: "TAO_COLLAB_ROOT SELF_CANCEL", runtimeConfiguration: { ...teamConfig, delegation: { ...teamConfig.delegation, maxTurns: 6 } } });
  const selfStopFiles = await readdir(join(taoHome, "teams", "collaboration-self-stop"));
  const selfStopRecord = JSON.parse(await readFile(join(taoHome, "teams", "collaboration-self-stop", selfStopFiles.find((file) => file.endsWith(".json"))), "utf8"));
  assert(selfStopRecord.attempts.every((attempt) => attempt.state === "cancelled"), "成员自行停止没有取消当前及排队执行");
  assert(!gatewayRequests.slice(selfCancelStart).some((request) => request.userMessages.some((text) => text.startsWith("[Tao 成员身份]") && text.includes("TAO_COLLAB_NEVER"))), "自行停止后仍执行了排队任务");
  const permissionMailStart = gatewayRequests.length;
  const permissionMailResult = runtime.request({ ...teamCommand, conversationId: "collaboration-permission", requestId: "permission-mail-1", message: "TAO_COLLAB_ROOT PERMISSION_MAIL", runtimeConfiguration: { ...teamConfig, delegation: { ...teamConfig.delegation, maxTurns: 4 } } });
  // Attach a handler immediately so an early runtime failure is not unhandled.
  void permissionMailResult.catch(() => {});
  let permissionMailRecord; let permissionMailEvent;
  const mailWaitStarted = Date.now();
  while (Date.now() - mailWaitStarted < 8000) {
    permissionMailEvent = runtime.events.find((event) => event.conversationId === "collaboration-permission" && event.category === "permission" && event.event === "requested");
    const mailFiles = await readdir(join(taoHome, "teams", "collaboration-permission")).catch(() => []);
    const recordFile = mailFiles.find((file) => file.endsWith(".json"));
    if (recordFile) permissionMailRecord = JSON.parse(await readFile(join(taoHome, "teams", "collaboration-permission", recordFile), "utf8"));
    if (permissionMailEvent && permissionMailRecord?.messages.length) break;
    await new Promise((done) => setTimeout(done, 20));
  }
  assert(permissionMailEvent && permissionMailRecord?.messages[0].delivery === "queued", "权限等待时的消息被提前消费或未入箱");
  assert(!existsSync(join(workspaceA, "collaboration-confirmed.txt")), "协作消息绕过了工具权限确认");
  await runtime.request({ type: "permission_response", conversationId: "collaboration-permission", permissionId: permissionMailEvent.permissionId, decision: "allow_once" });
  await permissionMailResult;
  assert(await readFile(join(workspaceA, "collaboration-confirmed.txt"), "utf8") === "approved", "确认后的工具操作未完成");
  assert(gatewayRequests.slice(permissionMailStart).some((request) => request.userMessages.some((text) => text.includes("AFTER_PERMISSION_MAIL"))), "工具确认结束后未在下一模型边界投递消息");

  const boardStart = gatewayRequests.length;
  const boardResult = await runtime.request({ ...teamCommand, conversationId: "board-root", requestId: "board-1", message: "TAO_BOARD_ROOT PRIVATE_BOARD_ROOT_HISTORY", runtimeConfiguration: { ...teamConfig, toolPermissions: {}, delegation: { ...teamConfig.delegation, maxTurns: 8 } } });
  assert(boardResult.messages.some((message) => message.content === "共享任务认领、依赖验收与重试已完成。"), "任务板工具链未完成");
  const boardFiles = await readdir(join(taoHome, "teams", "board-root"));
  const boardRecord = JSON.parse(await readFile(join(taoHome, "teams", "board-root", boardFiles.find((file) => file.endsWith(".json"))), "utf8"));
  const sharedPre = boardRecord.tasks.find((task) => task.description === "TAO_BOARD_PREREQ");
  assert(!boardRecord.tasks.some((task) => task.description === "TAO_BOARD_MISSING_DEPS") && gatewayRequests.slice(boardStart).some((request) => request.toolResultText.includes("dependsOn")), "遗漏依赖参数未被拒绝或仍创建了任务");
  const sharedDep = boardRecord.tasks.find((task) => task.description === "TAO_BOARD_DEP");
  const scout = boardRecord.tasks.find((task) => task.description === "TAO_BOARD_SCOUT");
  assert(sharedPre.state === "accepted" && sharedDep.state === "accepted", "依赖或重试任务没有正确验收");
  assert(sharedPre.assignedAgentId === scout.assignedAgentId, "成员认领没有复用执行者身份");
  const depAttempts = boardRecord.attempts.filter((attempt) => attempt.taskId === sharedDep.id);
  assert(depAttempts.length === 2 && depAttempts[0].generation === 1 && depAttempts[1].generation === 2 && depAttempts[1].result === "BOARD_DEP_REPAIRED", "重试重复创建尝试、丢失旧结果或遗漏修正说明");
  assert(depAttempts[0].agentId !== depAttempts[1].agentId && depAttempts[0].result === "BOARD_DEP_NEEDS_FIX", "重新分配未保留独立历史与候选结果");
  assert(depAttempts[0].startedAt >= sharedPre.reviewedAt, "前置任务验收前下游已经启动");
  const boardChildren = gatewayRequests.slice(boardStart).filter((request) => request.userMessages.some((value) => value.startsWith("[Tao 成员身份]")));
  assert(boardChildren.some((request) => request.tools.includes("claim_task") && request.tools.includes("list_tasks")), "成员未获得任务板工具");
  assert(boardChildren.every((request) => !request.tools.includes("assign_task") && !request.tools.includes("retry_agent_task") && !request.tools.includes("create_task") && !request.tools.includes("cancel_task") && !request.userMessages.some((value) => value.includes("PRIVATE_BOARD_ROOT_HISTORY"))), "任务板管理权限或主历史泄漏给成员");
  assert(boardResult.messages.at(-1).traces.some((trace) => trace.metadata?.taskId === sharedDep.id && trace.metadata?.generation === 2 && trace.metadata?.dependencyCount === 1), "任务板展示缺少执行代次或依赖信息");

  const baselineStart = gatewayRequests.length;
  const [readResult, listResult] = await Promise.all([
    runtime.request(prompt("conversation-read", "request-read", "请读取 fixture.txt", workspaceA)),
    runtime.request(prompt("conversation-list", "request-list", "请列出当前目录", workspaceB)),
  ]);
  const editResult = await runtime.request(prompt("conversation-edit", "request-edit", "请编辑 editable.txt", workspaceA));
  const followUpPrompt = runtime.request(prompt("conversation-follow", "request-follow", "这是慢速回答", workspaceA));
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 80));
  await runtime.request({
    type: "follow_up",
    conversationId: "conversation-follow",
    message: "回答结束后补充一句。",
  });
  await followUpPrompt;

  const stoppedPrompt = runtime.request(prompt("conversation-stop", "request-stop", "这是停止测试", workspaceA))
    .then(() => null)
    .catch((error) => String(error));
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 80));
  await runtime.request({ type: "abort", conversationId: "conversation-stop" });
  await stoppedPrompt;

  const retryResult = await runtime.request(prompt("conversation-retry", "request-retry", "这是重试测试", workspaceA));
  const timeoutError = await runtime.request(prompt("conversation-timeout", "request-timeout", "这是超时测试", workspaceA))
    .then(() => "")
    .catch((error) => String(error));
  const status = await runtime.request({ type: "get_status" });
  const eventsJson = JSON.stringify(runtime.events);
  const editedContent = await readFile(join(workspaceA, "editable.txt"), "utf8");

  assert(readResult.messages?.some((message) => message.content === "本地工具流程已完成。"), "读取会话没有得到最终回答。");
  assert(listResult.messages?.some((message) => message.content === "本地工具流程已完成。"), "目录会话没有得到最终回答。");
  assert(editResult.messages?.some((message) => message.content === "本地工具流程已完成。"), "编辑会话没有得到最终回答。");
  assert(!readResult.messages?.some((message) => message.content.includes("我先读取一下")), "read preamble 混入了最终回答。");
  assert(!listResult.messages?.some((message) => message.content.includes("我先确认一下")), "bash preamble 混入了最终回答。");
  assert(!editResult.messages?.some((message) => message.content.includes("我先检查一下")), "edit preamble 混入了最终回答。");
  assert(retryResult.messages?.some((message) => message.content === "本地工具流程已完成。"), "重试会话没有在 Pi 自动重试后得到回答。");
  assert(/超时|timeout/i.test(timeoutError), `超时请求没有尽快返回明确错误：${timeoutError}`);
  assert(editedContent === "after\n", "Pi edit 没有在会话工作区修改文件。");
  assert(maxConcurrentGatewayRequests >= 2, "不同会话的模型请求没有并发进入网关。");
  assert(status.pid > 0, "Runtime 没有返回有效 PID。");
  assert(runtime.events.some((event) =>
    event.conversationId === "conversation-read"
    && event.requestId === "request-read"
    && event.category === "tool"
    && event.event === "started"
    && event.text === "正在读取 fixture.txt",
  ), "没有收到已路由的 read 工具状态。");
  assert(runtime.events.some((event) =>
    event.conversationId === "conversation-read"
    && event.requestId === "request-read"
    && event.category === "message"
    && event.event === "text_block_end" && event.action === "commentary"
    && event.text?.includes("我先读取一下"),
  ), "没有收到 read preamble 事件。");
  const firstContext = await runtime.request({ type: "get_context_snapshot", conversationId: "conversation-read" });
  assert(firstContext.snapshot?.conversationStart && firstContext.snapshot.systemPrompt.includes("You are Tao"), "未捕获真实首轮 SDK 上下文");
  assert(firstContext.snapshot.tools.some((tool) => tool.name === "read") && firstContext.snapshot.messageCount > 0, "上下文缺少工具定义或消息摘要");
  const firstContextJson = JSON.stringify(firstContext.snapshot);
  const requestCount = gatewayRequests.length;
  const sessionsBeforePreview = (await runtime.request({ type: "get_status" })).sessionCount;
  const template = await runtime.request({ type: "preview_context", runtimeConfiguration: { enabled: true, systemPromptMode: "append", systemPrompt: "TEMPLATE_ONLY", toolMode: "custom", enabledTools: ["read"] } });
  assert(template.systemPrompt.includes("TEMPLATE_ONLY") && template.systemPrompt.includes("${workspacePath}") && template.tools.length === 2 && template.tools.some((tool) => tool.name === "read_tao_doc"), "上下文模板未按草稿和占位符组装");
  assert(gatewayRequests.length === requestCount && (await runtime.request({ type: "get_status" })).sessionCount === sessionsBeforePreview, "预览不应调用模型或创建会话");
  await runtime.request({ ...prompt("conversation-read", "request-new-permission", "继续核对", workspaceA), permissionMode: "ask" });
  assert(gatewayRequests.at(-1).systemText.includes("权限模式：ask"), "复用 Session 后的动态权限未更新");
  assert(JSON.stringify((await runtime.request({ type: "get_context_snapshot", conversationId: "conversation-read" })).snapshot) === firstContextJson, "后续请求覆盖了首次快照");
  const initialToolSets = gatewayRequests.slice(baselineStart).filter((request) => !request.hasToolResult).map((request) => request.tools);
  const blockedSnapshotPath = join(taoHome, "contexts", "conversation-context-retry.json");
  await mkdir(blockedSnapshotPath);
  const captureFailureResult = await runtime.request({ ...prompt("conversation-context-retry", "context-retry-1", "组合测试 快照首次写入失败", workspaceA), runtimeConfiguration: profile("Capture retry", []) });
  assert(captureFailureResult.messages?.length > 0, "快照写入失败不应中断模型回答");
  assert(runtime.events.some((event) => event.conversationId === "conversation-context-retry" && event.event === "snapshot_warning"), "快照写入失败未通知界面");
  await rm(blockedSnapshotPath, { recursive: true });
  await runtime.request({ ...prompt("conversation-context-retry", "context-retry-2", "组合测试 快照重试", workspaceA), runtimeConfiguration: profile("Capture retry", []) });
  const captureRetry = await runtime.request({ type: "get_context_snapshot", conversationId: "conversation-context-retry" });
  assert(captureRetry.snapshot?.requestId === "context-retry-2" && captureRetry.snapshot.conversationStart === false && captureRetry.warning === "", "快照失败后没有重试或错误标记为初始上下文");
  const commandStatusObserved = runtime.events.some((event) =>
    event.conversationId === "conversation-list"
    && event.requestId === "request-list"
    && event.category === "tool"
    && event.event === "started"
    && event.tool === "bash"
    && event.action === "execute_command"
    && event.text?.startsWith("正在执行命令"),
  );
  assert(
    commandStatusObserved,
    `没有收到已路由的 bash 工具状态：${JSON.stringify(runtime.events.filter((event) => event.conversationId === "conversation-list"))}`,
  );
  assert(runtime.events.some((event) =>
    event.conversationId === "conversation-edit"
    && event.requestId === "request-edit"
    && event.category === "tool"
    && event.event === "started"
    && event.text === "正在修改 editable.txt",
  ), "没有收到已路由的 edit 工具状态。");
  assert(runtime.events.some((event) =>
    event.conversationId === "conversation-follow"
    && event.requestId === "request-follow"
    && event.category === "queue"
    && event.event === "updated",
  ), "follow-up 没有产生目标会话的队列事件。");
  assert(runtime.events.some((event) =>
    event.conversationId === "conversation-stop"
    && event.requestId === "request-stop"
    && event.category === "turn"
    && event.event === "aborted",
  ), "停止没有产生目标会话的已停止事件。");
  assert(runtime.events.some((event) =>
    event.conversationId === "conversation-retry"
    && event.requestId === "request-retry"
    && event.category === "retry"
    && event.event === "started",
  ), "Pi 自动重试开始事件没有到达目标会话。");
  assert(runtime.events.some((event) =>
    event.conversationId === "conversation-timeout"
    && event.requestId === "request-timeout"
    && event.category === "error"
    && event.event === "runtime"
    && /超时|timeout/i.test(event.text ?? ""),
  ), "超时请求没有产生安全的 Runtime 错误状态。");
  assert(initialToolSets.every((tools) => ["read", "bash", "edit", "write"].every((name) => tools.includes(name))), "Pi 默认工具没有完整传给模型。");
  assert(initialToolSets.every((tools) => !tools.includes("ls")), "Runtime 意外注入了非默认的 ls 工具。");
  assert(
    gatewayRequests.some((request) => request.hasToolResult && request.toolResultText.includes(workspaceB)),
    "目录会话的 bash 没有在自己的 workspacePath 中执行。",
  );
  assert(!eventsJson.includes("TAO_PRIVATE_TOOL_RESULT_MUST_NOT_REACH_UI"), "工具原始内容泄漏到了 Runtime 事件。");
  assert(runtime.events.every((event) => !("args" in event) && !("result" in event) && !("partialResult" in event)), "Runtime 事件包含原始工具字段。");
  assert(gatewayRequests.some((request) => request.hasToolResult), "Pi 没有把工具结果送回模型继续 Agent loop。");

  console.log(JSON.stringify({
    runtimePid: status.pid,
    sameRuntimeForConcurrentSessions: true,
    maxConcurrentGatewayRequests,
    readStatusObserved: true,
    commandStatusObserved: true,
    editStatusObserved: true,
    followUpRouted: true,
    stopRouted: true,
    piRetryStatusObserved: true,
    providerTimeoutErrorObserved: true,
    piDefaultToolsObserved: ["read", "bash", "edit", "write"],
    toolResultKeptOutOfRuntimeEvents: true,
    profileSnapshotsIsolated: true,
    structuredProcessArguments: true,
    schemaAndHttpScopeValidated: true,
    explicitPermissionRulesEnforced: true,
    junctionWriteBlocked: true,
    preparationCancellationVerified: true,
    activeToolCancellationVerified: true,
    multiAgentDelegationAndReviewVerified: true,
    childContextAndPermissionIsolationVerified: true,
    childPermissionCancellationVerified: true,
    childSessionsReclaimed: true,
    memberHistoryAndSafeViewVerified: true,
    humanInterventionAndDeduplicationVerified: true,
    siblingMessagingAndFollowupVerified: true,
    sharedTaskBoardAndRetryVerified: true,
    contextTemplateAndInitialSnapshotVerified: true,
    dynamicPermissionAndImmutableSnapshotVerified: true,
    contextCaptureFailureAndRetryVerified: true,
    toolDescriptionsSeparatedFromSystemVerified: true,
    coordinationToolsAutoRegisteredVerified: true,
    defaultWorkerAndLazyTeamVerified: true,
    builtinDocumentationLookupVerified: true,
    piContinuedAfterToolResult: true,
  }));
} finally {
  await runtime?.stop();
  await new Promise((resolveClose) => server.close(resolveClose));
  await rm(tempRoot, { recursive: true, force: true });
}
