import assert from "node:assert/strict";
import { catalogWithEditor, defaultDelegation, editorConfiguration, emptyConfiguration, exportProfile, mergeCatalog, safeSnapshot } from "../src/agent-profiles.ts";

const tool = { id: "lookup", name: "lookup", label: "查询", description: "test", kind: "http", enabled: true, permissionMode: "ask", command: "", executable: "", arguments: "[]", timeoutMs: 1000, allowedHosts: ["example.com"], method: "GET", url: "https://example.com/?q={{input}}", headers: '{"Authorization":"Bearer {{env:TOOL_KEY}}"}', bodyTemplate: "", inputSchema: '{"type":"object"}' };
assert.equal(emptyConfiguration().delegation.enabled, true);
assert.equal(defaultDelegation().enabled, false, "旧的缺省委派配置不应自动开启");
const catalog = { schemaVersion: 1, revision: 1, defaultProfileId: "a", profiles: [
  { id: "a", name: "A", description: "", revision: 1, configuration: { ...emptyConfiguration(), systemPrompt: "A" }, customToolIds: ["lookup"] },
  { id: "b", name: "B", description: "", revision: 1, configuration: { ...emptyConfiguration(), systemPrompt: "B" }, customToolIds: [] },
], tools: [tool], workspaceDefaults: [{ workspacePath: "D:/project", profileId: "a" }] };
const a = editorConfiguration(catalog, "a");
const b = editorConfiguration(catalog, "b");
assert.equal(a.customTools[0].enabled, true);
assert.equal(b.customTools[0].enabled, false);
a.systemPrompt = "A changed";
a.customTools[0].url = "https://example.com/updated";
const edited = catalogWithEditor(catalog, "a", a);
assert.equal(edited.profiles[1].configuration.systemPrompt, "B");
assert.equal(edited.profiles[0].configuration.customTools.length, 0);
assert.equal(catalog.tools[0].url, tool.url);
const exported = exportProfile(catalog, "a");
assert.equal(exported.workspaceDefaults.length, 0);
assert.equal(exported.tools[0].url, tool.url);
assert(exported.tools[0].headers.includes("{{env:TOOL_KEY}}"));
const merged = mergeCatalog(catalog, exported);
assert.equal(merged.profiles.length, 3);
assert.equal(merged.tools.length, 1);
assert.equal(merged.profiles[2].id, "a_import");
const secretTool = { ...tool, headers: '{"Authorization":"Bearer private-key","X-API-Key":"private-key"}', bodyTemplate: '{"password":"private-key"}' };
const snapshot = { profileId: "a", name: "A", revision: 1, configuration: { ...a, customTools: [secretTool] } };
assert(!JSON.stringify(safeSnapshot(snapshot)).includes("private-key"));
assert(snapshot.configuration.customTools[0].headers.includes("private-key"));
const mixedCredentialTool = { ...tool, headers: '{"Authorization":"Bearer private-key {{env:TOOL_KEY}}","Cookie":"session=private-key; extra={{env:EXTRA}}","X-API-Key":"{{env:TOOL_KEY}}"}' };
const mixedExport = exportProfile({ ...catalog, tools: [mixedCredentialTool] }, "a");
assert(!mixedExport.tools[0].headers.includes("private-key"));
assert(mixedExport.tools[0].headers.includes("{{env:TOOL_KEY}}"));
assert(mixedCredentialTool.headers.includes("private-key"));
const teamCatalog = structuredClone(catalog);
teamCatalog.profiles[0].configuration.delegation = { ...defaultDelegation(), enabled: true, allowedProfileIds: ["a", "b"] };
const exportedTeam = exportProfile(teamCatalog, "a");
assert.equal(exportedTeam.profiles.length, 2);
const mergedTeam = mergeCatalog(teamCatalog, exportedTeam);
assert.deepEqual(mergedTeam.profiles[2].configuration.delegation.allowedProfileIds, ["a_import", "b_import"]);
assert.deepEqual(teamCatalog.profiles[0].configuration.delegation.allowedProfileIds, ["a", "b"]);
console.log("通过：组合编辑隔离、工具引用、导入合并、模板占位符和导出脱敏。");
