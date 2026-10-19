import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildSystemPrompt } from "../vendor/pi/packages/coding-agent/src/core/system-prompt.ts";
import { captureInitialContext, contextTemplate, environmentContext, environmentPrompt, promptConfiguration, readContextSnapshot } from "../src-tauri/runtime/context.mjs";
import { COORDINATION_SNIPPETS, DEFAULT_WORKER_ID, createDocumentationTool, customToolSnippet, resolveDelegation } from "../src-tauri/runtime/prompt-policy.mjs";
import { restrictChildConfiguration } from "../src-tauri/runtime/multi-agent.mjs";

const tools = [{ name: "read", description: "Read a file", promptSnippet: "Read files", promptGuidelines: ["Check the source before making claims"], parameters: { type: "object", properties: { path: { type: "string" } } } }];
test("Context templates reuse the live builder and bind no actual environment or external resources", () => {
  const profile = { enabled: true, systemPromptMode: "append", systemPrompt: "CUSTOM_ROLE", conversationPrompt: "SESSION_RULE", skillsEnabled: true, extensionsEnabled: true };
  const preview = contextTemplate({ profile, tools, buildSystemPrompt });
  const configuration = promptConfiguration(profile);
  const expected = buildSystemPrompt({ cwd: "${workspacePath}", selectedTools: ["read"], toolSnippets: { read: "Read files" }, promptGuidelines: tools[0].promptGuidelines, appendSystemPrompt: configuration.appendSystemPrompt.join("\n\n") });
  assert.equal(preview.systemPrompt, `${expected}\n\n${environmentPrompt(preview.environment)}`);
  assert(preview.defaultSystemPrompt.startsWith("You are Tao"));
  assert(preview.defaultSystemPrompt.includes("Check the source before making claims"));
  assert(!preview.defaultSystemPrompt.includes("CUSTOM_ROLE"));
  assert(preview.systemPrompt.includes("${permissionMode}"));
  assert(preview.systemPrompt.indexOf("CUSTOM_ROLE") < preview.systemPrompt.indexOf("SESSION_RULE"));
  const replaced = contextTemplate({ profile: { ...profile, systemPromptMode: "replace" }, tools, buildSystemPrompt });
  assert(replaced.systemPrompt.startsWith("CUSTOM_ROLE"));
  assert(!replaced.systemPrompt.includes("You are Tao"));
  assert(replaced.systemPrompt.includes("SESSION_RULE") && replaced.systemPrompt.includes("工作过程说明"));
  assert(replaced.systemPrompt.includes("- read: Read files") && replaced.systemPrompt.includes("Check the source before making claims"), "角色替换不应移除工具指导");
  assert(replaced.systemPrompt.includes("[Tao 执行规则]") && replaced.systemPrompt.includes("[Tao 按需资料]"));
  assert(preview.defaultSystemPrompt.includes("[Tao 执行规则]") && !preview.defaultSystemPrompt.includes("SESSION_RULE"));
  assert.equal(preview.contentSizes.systemPromptCharacters, preview.systemPrompt.length);
  const disabled = contextTemplate({ profile: { ...profile, enabled: false }, tools, buildSystemPrompt });
  assert(!disabled.systemPrompt.includes("CUSTOM_ROLE") && disabled.systemPrompt.includes("You are Tao"));
});

test("Short tool indexes and role-specific collaboration rules preserve details only in tools", () => {
  const description = "COMPLETE_PRIVATE_TOOL_DESCRIPTION ".repeat(40);
  const metadata = { name: "lookup", label: "查询记录", description, promptSnippet: customToolSnippet({ name: "lookup", label: "查询记录", description }), parameters: {} };
  const coordinator = { name: "spawn_agent", description, promptSnippet: COORDINATION_SNIPPETS.spawn_agent, parameters: {} };
  const preview = contextTemplate({ profile: { delegation: { enabled: true } }, tools: [metadata, coordinator], buildSystemPrompt });
  assert(preview.systemPrompt.includes("- lookup: 查询记录") && preview.systemPrompt.includes("- spawn_agent: 委派独立子任务"));
  assert(!preview.systemPrompt.includes(description) && preview.tools[0].description === description);
  assert(COORDINATION_SNIPPETS.spawn_agent.length < 30);
  assert(customToolSnippet({ name: "custom", label: "a\n".repeat(100) }).length <= 48);
  assert(!promptConfiguration({}).appendSystemPrompt.join("\n").includes("主代理协作规则"));
  const member = promptConfiguration({}, { isChild: true }).appendSystemPrompt.join("\n");
  assert(member.includes("成员协作规则") && !member.includes("主代理协作规则"));
});

test("Default workers inherit only the selected profile and never grant recursive delegation", () => {
  const profile = { systemPrompt: "PARENT_ROLE", customTools: [], toolPermissions: { write: { mode: "deny" } }, delegation: { enabled: true, allowedProfileIds: [], maxConcurrent: 2 } };
  const resolved = resolveDelegation(profile, [{ profileId: "unapproved", configuration: {} }]);
  assert.deepEqual(resolved.profile.delegation.allowedProfileIds, [DEFAULT_WORKER_ID]);
  assert.equal(resolved.profiles.length, 1);
  assert.equal(resolved.profiles[0].configuration.systemPrompt, "PARENT_ROLE");
  assert.equal(resolved.profiles[0].configuration.toolPermissions.write.mode, "deny");
  assert.equal(resolved.profiles[0].configuration.delegation.enabled, false);
  for (const mode of ["deny", "ask"]) {
    const restricted = restrictChildConfiguration({ toolPermissions: { read_tao_doc: { mode } } }, { toolPermissions: { read_tao_doc: { mode: "allow" } } });
    assert.equal(restricted.toolPermissions.read_tao_doc.mode, mode, "平台只读手册也须遵守父子权限交集");
  }
  assert.deepEqual(profile.delegation.allowedProfileIds, []);
  assert.deepEqual(resolveDelegation({ ...profile, delegation: { enabled: false } }, resolved.profiles).profiles, []);
  const selected = [{ profileId: "selected" }];
  assert.equal(resolveDelegation({ delegation: { enabled: true, allowedProfileIds: ["selected"] } }, selected).profiles, selected);
});

test("Tool definition size measures the complete schema, not the clipped display copy", () => {
  const large = [{ name: "large", description: "d".repeat(8000), parameters: { type: "object", description: "s".repeat(20000) } }];
  const preview = contextTemplate({ tools: large, buildSystemPrompt });
  assert.equal(preview.contentSizes.toolDefinitionCharacters, JSON.stringify(large).length);
  assert(preview.contentSizes.toolDefinitionCharacters > JSON.stringify(preview.tools).length);
});

test("Built-in documentation is a bounded readonly topic lookup, never an arbitrary file reader", async () => {
  const tool = createDocumentationTool((definition) => definition);
  for (const topic of tool.parameters.properties.topic.enum) {
    const result = await tool.execute("read-doc", { topic });
    assert(result.content[0].text.startsWith("Tao 运行手册 · tao-context-v2"));
    assert(result.content[0].text.length < 5000);
  }
  for (const topic of ["../auth.json", "__proto__", "toString"]) await assert.rejects(tool.execute("read-doc", { topic }), /未知/);
  await assert.rejects(tool.execute("read-doc", { topic: "tools" }, AbortSignal.abort()));
});

test("Initial snapshots are immutable, bounded and exclude history bodies, hidden reasoning and request secrets", async () => {
  const directory = await mkdtemp(join(process.cwd(), ".context-test-"));
  try {
    const profile = { enabled: true, toolPermissions: { write: { mode: "deny", pathScope: "workspace" } } };
    const entry = {
      conversationId: "conversation-safe", requestId: "request-1", conversationStart: false, profile,
      environment: { ...environmentContext({ cwd: "D:/workspace", permissionMode: "ask", profile }), headers: "PRIVATE_HEADERS" },
      profileInfo: { profileId: "default", name: "Default", revision: 1, apiKey: "PRIVATE_PROFILE_KEY" },
      model: { id: "test", provider: "local", api: "openai-completions", apiKey: "MODEL_KEY_MUST_NOT_LEAK" },
      context: { systemPrompt: "You are Tao api_key=PRIVATE_VALUE", messages: [{ role: "user", content: "PRIVATE_USER_TEXT" }, { role: "assistant", content: [{ type: "thinking", thinking: "PRIVATE_REASONING" }, { type: "text", text: "public" }] }], tools: [...tools, { name: "custom", parameters: { type: "object", api_key: "PRIVATE_SCHEMA_KEY" } }] },
    };
    captureInitialContext(directory, entry);
    const first = await readFile(join(directory, "contexts", "conversation-safe.json"), "utf8");
    assert(!/PRIVATE_VALUE|PRIVATE_USER_TEXT|PRIVATE_REASONING|MODEL_KEY_MUST_NOT_LEAK|PRIVATE_HEADERS|PRIVATE_PROFILE_KEY|PRIVATE_SCHEMA_KEY/.test(first));
    assert(first.includes("已隐藏"));
    assert.equal(readContextSnapshot(directory, "conversation-safe").messages[1].characters, 6);
    captureInitialContext(directory, { ...entry, requestId: "request-2", context: { ...entry.context, systemPrompt: "changed" } });
    assert.equal(await readFile(join(directory, "contexts", "conversation-safe.json"), "utf8"), first);
    assert.throws(() => readContextSnapshot(directory, "../escape"), /标识无效/);
    assert.equal(readContextSnapshot(directory, "new-conversation"), null);
    await writeFile(join(directory, "contexts", "bad.json"), "broken");
    assert.throws(() => readContextSnapshot(directory, "bad"));
    const environment = environmentContext({ cwd: "D:/new", permissionMode: "full_access", profile });
    assert(environmentPrompt(environment).includes("full_access"));
    assert(environmentPrompt(environment).includes('"mode":"deny"'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
