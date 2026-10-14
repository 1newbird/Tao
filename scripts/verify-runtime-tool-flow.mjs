import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { once } from "node:events";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { pathToFileURL } from "node:url";

const root = resolve(process.cwd());
const piRoot = join(root, "vendor", "pi");
const runtimeScript = join(root, "src-tauri", "runtime", "tao-runtime.mjs");
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
    const requestId = `mock-${gatewayRequests.length + 1}`;
    gatewayRequests.push({
      userText,
      hasToolResult,
      toolResultText: toolMessages.map((message) => messageText(message.content)).join("\n"),
      systemText: messages.filter((message) => ["system", "developer"].includes(message.role)).map((message) => messageText(message.content)).join("\n"),
      tools: Array.isArray(payload.tools)
        ? payload.tools.map((tool) => tool?.function?.name).filter((name) => typeof name === "string")
        : [],
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
      await new Promise((resolveDelay) => setTimeout(resolveDelay, isSlowRequest || isTimeoutRequest ? 1_200 : 70));
      if (response.destroyed) return;
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      if (hasToolResult) {
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
      if (message.payload.category === "permission" && message.payload.event === "requested") {
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
  const request = (command) => new Promise((resolveResponse, rejectResponse) => {
    const id = `test-${++sequence}`;
    responses.set(id, { resolve: resolveResponse, reject: rejectResponse });
    child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
    setTimeout(() => {
      const pending = responses.get(id);
      if (pending) {
        responses.delete(id);
        rejectResponse(new Error(`Runtime 请求超时：${command.type}`));
      }
    }, 30_000).unref();
  });

  return {
    child,
    events,
    request,
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
  assert(alphaRequests.length === 2 && alphaRequests.every((request) => request.systemText.includes("ALPHA_PROFILE_ONLY") && !request.systemText.includes("BETA_PROFILE_ONLY") && !request.systemText.includes("GLOBAL_CHANGE_MUST_NOT_APPLY") && request.tools.join(",") === "read"), "Alpha 组合配置未隔离或被全局编辑改变");
  assert(gatewayRequests.some((request) => request.userText.includes("组合测试 Beta") && request.systemText.includes("BETA_PROFILE_ONLY") && request.tools.length === 0), "Beta 无工具组合没有独立生效");
  await rm(join(taoHome, "runtime/profile.json"));

  const processTool = { id: "echo", name: "echo_json", label: "程序参数", kind: "process", enabled: true, permissionMode: "ask", executable: "node", arguments: JSON.stringify(["-e", "process.stdout.write(process.argv[1])", "{{text}}"]), timeoutMs: 1000, inputSchema: JSON.stringify({ type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false }) };
  await runtime.request({ ...prompt("process-tool", "process-tool-1", "程序参数测试", workspaceA), permissionMode: "full_access", runtimeConfiguration: profile("Process test", [], [processTool]) });
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

  const earlyPrompt = runtime.request({ ...prompt("cancel-preparing", "cancel-preparing-1", "组合测试 不应调用模型", workspaceA), runtimeConfiguration: profile("cancel", []) }).catch(() => null);
  await runtime.request({ type: "cancel_active", conversationId: "cancel-preparing" });
  await earlyPrompt;
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
    && event.event === "preamble"
    && event.text?.includes("我先读取一下"),
  ), "没有收到 read preamble 事件。");
  const commandStatusObserved = runtime.events.some((event) =>
    event.conversationId === "conversation-list"
    && event.requestId === "request-list"
    && event.category === "tool"
    && event.event === "started"
    && event.tool === "bash"
    && event.action === "execute_command"
    && event.text?.startsWith("正在执行命令"),
  );
  const initialToolSets = gatewayRequests.slice(baselineStart).filter((request) => !request.hasToolResult).map((request) => request.tools);
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
    piContinuedAfterToolResult: true,
  }));
} finally {
  await runtime?.stop();
  await new Promise((resolveClose) => server.close(resolveClose));
  await rm(tempRoot, { recursive: true, force: true });
}
