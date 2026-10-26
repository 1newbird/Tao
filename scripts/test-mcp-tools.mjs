import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mcpServers, enabledMcpTools, intersectMcp, listMcpTools, callMcpTool, createMcpTools } from "../src-tauri/runtime/mcp-tools.mjs";
import { restrictChildConfiguration } from "../src-tauri/runtime/multi-agent.mjs";
import { applyToolPolicy } from "../src-tauri/runtime/policy.mjs";

const schema = { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false };
const tool = (name) => ({ name, description: `Description ${name}`, inputSchema: schema });
async function fixture(t, mode = "json") {
  const requests = [];
  let called;
  const callStarted = new Promise((resolve) => { called = resolve; });
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const message = raw ? JSON.parse(raw) : {};
    requests.push({ ...message, httpMethod: req.method, headers: req.headers });
    if (req.method === "DELETE") { res.writeHead(204).end(); return; }
    if (mode === "redirect") { res.writeHead(302, { location: "/other" }).end(); return; }
    if (mode === "http-error") { res.writeHead(401).end("SENSITIVE_SERVER_BODY"); return; }
    if (mode === "large-body") { res.writeHead(200, { "Content-Type": "application/json" }).end("x".repeat(2 * 1024 * 1024 + 1)); return; }
    if (mode === "html") { res.writeHead(200, { "Content-Type": "text/html" }).end("Login page"); return; }
    if (mode === "invalid-json") { res.writeHead(200, { "Content-Type": "application/json" }).end("{broken"); return; }
    if (!message.id) { res.writeHead(202).end(); return; }
    let result;
    if (message.method === "initialize") {
      res.setHeader("Mcp-Session-Id", "synthetic-session");
      result = { protocolVersion: mode === "version" ? "2099-01-01" : "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" }, instructions: "UNTRUSTED_SERVER_INSTRUCTIONS" };
    } else {
      assert.equal(req.headers["mcp-session-id"], "synthetic-session");
      assert.equal(req.headers["mcp-protocol-version"], "2025-11-25");
      if (message.method === "tools/list") {
        result = mode === "oversized" ? { tools: Array.from({ length: 101 }, (_, i) => tool(`t${i}`)) }
          : mode === "bad-schema" ? { tools: [{ name: "echo", inputSchema: { type: "string" } }] }
          : mode === "cycle" ? { tools: [], nextCursor: "same" }
          : message.params.cursor ? { tools: [tool("blocked")] } : { tools: [tool("echo")], nextCursor: "page-2" };
      } else if (message.method === "tools/call") {
        called();
        if (mode === "hang") return;
        result = { content: [{ type: "text", text: `${message.params.arguments.value} 中文` }, { type: "image", data: "not-forwarded", mimeType: "image/png" }], structuredContent: { ok: true, echo: message.params.arguments.value }, isError: mode === "tool-error" };
        if (mode === "long-result") { result.content[0].text = "x".repeat(50_000); result.structuredContent = { value: "y".repeat(25_000) }; }
      }
    }
    const payload = { jsonrpc: "2.0", id: mode === "wrong-id" ? 999 : message.id, result };
    if (mode === "rpc-error") { delete payload.result; payload.error = { code: -32000, message: "SENSITIVE_SERVER_BODY" }; }
    if (mode === "sse" && message.method !== "initialize") {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const text = `: heartbeat\r\n\r\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })}\r\n\r\ndata: ${JSON.stringify(payload)}\r\n\r\n`;
      // Byte fragmentation includes UTF-8 and CRLF boundaries; leave the stream open.
      const bytes = Buffer.from(text);
      for (let i = 0; i < bytes.length; i += 7) res.write(bytes.subarray(i, i + 7));
    } else { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(payload)); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const configuration = { execution: { network: "allow", allowedHosts: ["127.0.0.1"] }, mcpServers: [{ id: "test", name: "Fixture", enabled: true, url: `http://127.0.0.1:${server.address().port}/mcp`, allowPrivate: true, tokenEnv: "", allowedTools: ["echo"] }] };
  return { configuration, requests, callStarted };
}

test("legacy default, strict endpoint validation and opt-in registration", () => {
  assert.deepEqual(enabledMcpTools({}), []);
  const base = { id: "test", name: "Test", enabled: true, url: "https://example.com/mcp", tokenEnv: "", allowPrivate: false, allowedTools: [] };
  for (const url of ["file:///etc", "https://user:pass@example.com/mcp", "https://example.com/mcp?secret=x", "https://example.com/mcp#x"]) assert.throws(() => mcpServers({ mcpServers: [{ ...base, url }] }));
  assert.throws(() => mcpServers({ mcpServers: [base, base] }));
  assert.equal(createMcpTools((v) => v, { mcpServers: [base] }).length, 2);
});

test("initialize, pagination, allowlisted discovery, call and session cleanup", async (t) => {
  const { configuration, requests } = await fixture(t);
  const list = await listMcpTools(configuration, "test");
  assert.deepEqual(list.tools.map((x) => x.name), ["echo"]);
  assert.doesNotMatch(JSON.stringify(list), /UNTRUSTED_SERVER_INSTRUCTIONS/);
  assert.equal((await listMcpTools(configuration, "test", undefined, true)).tools.length, 2);
  const result = await callMcpTool(configuration, { server: "test", tool: "echo", arguments: { value: "hello" } });
  assert.equal(result.text, "hello 中文"); assert.equal(result.omittedContent, 1);
  assert.deepEqual(JSON.parse(result.structuredContent), { ok: true, echo: "hello" });
  assert.equal(requests.filter((r) => r.httpMethod === "DELETE").length, 3);
  assert.equal(requests[1].method, "notifications/initialized");
  assert.match(requests[0].headers.accept, /application\/json, text\/event-stream/);
});

test("POST SSE notifications, UTF-8 fragments and completion before stream close", async (t) => {
  const { configuration } = await fixture(t, "sse");
  const result = await callMcpTool(configuration, { server: "test", tool: "echo", arguments: { value: "测试" } });
  assert.equal(result.text, "测试 中文");
});

test("network, host, private-address, disabled and tool deny checks prevent requests", async (t) => {
  const { configuration, requests } = await fixture(t);
  for (const execution of [{ network: "deny" }, { backend: "windows", network: "inherit" }, { network: "allow", allowedHosts: ["other.example"] }]) await assert.rejects(listMcpTools({ ...configuration, execution }, "test"));
  await assert.rejects(listMcpTools({ ...configuration, mcpServers: [{ ...configuration.mcpServers[0], allowPrivate: false }] }, "test"), /未获授权/);
  await assert.rejects(listMcpTools({ ...configuration, mcpServers: [{ ...configuration.mcpServers[0], enabled: false }] }, "test"), /未启用/);
  await assert.rejects(listMcpTools({ ...configuration, toolPermissions: { mcp_list_tools: { mode: "deny" } } }, "test"), /禁止/);
  await assert.rejects(callMcpTool(configuration, { server: "test", tool: "blocked", arguments: {} }), /未.*授权/);
  assert.equal(requests.length, 0);
  for (const address of ["169.254.169.254", "0.0.0.0", "[::ffff:127.0.0.1]"]) await assert.rejects(listMcpTools({ ...configuration, execution: { network: "allow" }, mcpServers: [{ ...configuration.mcpServers[0], url: `http://${address}/mcp` }] }, "test"), /未获授权/);
  assert.equal(applyToolPolicy(process.cwd(), "mcp_call_tool", {}, { decision: "ask" }, { execution: { network: "deny" } }).enforcedDeny, true);
});

test("credential allowlist, header transmission and response/error redaction", async (t) => {
  const { configuration, requests } = await fixture(t);
  const key = "TAO_MCP_SYNTHETIC_TEST_TOKEN";
  process.env[key] = 'synthetic-"token'; t.after(() => { delete process.env[key]; });
  configuration.mcpServers[0].tokenEnv = key;
  await assert.rejects(listMcpTools(configuration, "test"), /未.*授权/);
  assert.equal(requests.length, 0);
  configuration.execution.allowedEnv = [key];
  const result = await callMcpTool(configuration, { server: "test", tool: "echo", arguments: { value: process.env[key] } });
  assert.equal(result.text, "[已隐藏] 中文");
  assert.equal(JSON.parse(result.structuredContent).echo, "[已隐藏]");
  assert.equal(requests[0].headers.authorization, `Bearer ${process.env[key]}`);
  const remote = { ...configuration, execution: { network: "allow", allowedEnv: [key] }, mcpServers: [{ ...configuration.mcpServers[0], url: "http://example.com/mcp" }] };
  await assert.rejects(listMcpTools(remote, "test"), /HTTPS/);
});

test("redirect, HTTP/RPC error, version and malformed schema are bounded failures", async (t) => {
  for (const mode of ["redirect", "http-error", "rpc-error", "version", "wrong-id", "bad-schema", "cycle", "oversized", "large-body", "html", "invalid-json"]) {
    const { configuration, requests } = await fixture(t, mode);
    await assert.rejects(listMcpTools(configuration, "test"), (error) => { assert.doesNotMatch(error.message, /SENSITIVE_SERVER_BODY/); return true; });
    assert.equal(requests.filter((r) => r.method === "tools/call").length, 0);
    assert.equal(requests.filter((r) => r.method === "initialize").length, 1);
  }
});

test("schema failure does not call tool, tool isError stays an error without retry", async (t) => {
  const { configuration, requests } = await fixture(t, "tool-error");
  await assert.rejects(callMcpTool(configuration, { server: "test", tool: "echo", arguments: {} }, undefined, () => { throw new Error("schema"); }), /Schema/);
  assert.equal(requests.filter((r) => r.method === "tools/call").length, 0);
  const result = await callMcpTool(configuration, { server: "test", tool: "echo", arguments: { value: "failure" } });
  assert.equal(result.isError, true);
  assert.equal(requests.filter((r) => r.method === "tools/call").length, 1);
  const definition = createMcpTools((tool) => tool, configuration).find((tool) => tool.name === "mcp_call_tool");
  await assert.rejects(definition.execute("id", { server: "test", tool: "echo", arguments: { value: "failure" } }), /"isError":true/);
});

test("abort sends cancellation and deletes session, without replaying side effects", async (t) => {
  const { configuration, requests, callStarted } = await fixture(t, "hang");
  const controller = new AbortController();
  const pending = callMcpTool(configuration, { server: "test", tool: "echo", arguments: { value: "cancel" } }, controller.signal);
  const rejected = assert.rejects(pending, /已取消.*可能已执行/);
  await callStarted; controller.abort(); await rejected;
  assert.equal(requests.filter((r) => r.method === "tools/call").length, 1);
  assert.ok(requests.some((r) => r.method === "notifications/cancelled"));
  assert.equal(requests.at(-1).httpMethod, "DELETE");
});

test("parent-child intersection constrains endpoint, credentials, tools and private access", async (t) => {
  const { configuration } = await fixture(t);
  const child = structuredClone(configuration);
  child.mcpServers[0].allowedTools.push("blocked");
  configuration.mcpServers[0].allowPrivate = false;
  configuration.toolPermissions = { mcp_call_tool: { mode: "deny" } };
  child.toolPermissions = { mcp_call_tool: { mode: "allow" } };
  const result = restrictChildConfiguration(configuration, child);
  assert.deepEqual(result.mcpServers[0].allowedTools, ["echo"]);
  assert.equal(result.mcpServers[0].allowPrivate, false);
  assert.equal(result.toolPermissions.mcp_call_tool.mode, "deny");
  child.mcpServers[0].url += "/different";
  assert.deepEqual(intersectMcp(configuration, child), []);
  assert.equal(configuration.mcpServers[0].allowedTools.length, 1);
});

test("large results are explicitly truncated and pre-aborted requests never connect", async (t) => {
  const { configuration, requests } = await fixture(t, "long-result");
  await assert.rejects(listMcpTools(configuration, "test", AbortSignal.abort()), /已取消/);
  assert.equal(requests.length, 0);
  const result = await callMcpTool(configuration, { server: "test", tool: "echo", arguments: { value: "test" } });
  assert.equal(result.truncated, true);
  assert.equal(result.text.length, 40_000);
  assert.equal(result.structuredContent.length, 20_000);
});
