import assert from "node:assert/strict";
import { inspectWebCapabilities } from "../src-tauri/runtime/capability-status.mjs";

const base = { web: { searchEnabled: true, fetchEnabled: true, provider: "brave", apiKeyEnv: "SEARCH_TEST_TOKEN" }, execution: { allowedEnv: ["SEARCH_TEST_TOKEN"] } };
const secret = "synthetic-secret-never-return";
assert.equal(inspectWebCapabilities({}).search.state, "disabled");
assert.equal(inspectWebCapabilities({}).fetch.state, "disabled");
assert.equal(inspectWebCapabilities(base, {}).search.state, "missing");
const configured = inspectWebCapabilities(base, { SEARCH_TEST_TOKEN: secret });
assert.equal(configured.search.state, "unverified");
assert.equal(configured.fetch.state, "enabled");
assert(!JSON.stringify(configured).includes(secret));
let credentialRead = false;
const credentials = new Proxy({}, { get() { credentialRead = true; throw new Error("must not read unauthorized credentials"); } });
assert.equal(inspectWebCapabilities({ ...base, execution: { allowedEnv: [] } }, credentials).search.state, "blocked");
assert.equal(credentialRead, false);
for (const execution of [{ network: "deny" }, { backend: "docker", network: "inherit" }, { backend: "windows" }]) {
  const result = inspectWebCapabilities({ ...base, execution }, credentials);
  assert.equal(result.search.state, "blocked"); assert.equal(result.fetch.state, "blocked");
}
assert.equal(inspectWebCapabilities({ ...base, toolPermissions: { web_search: { mode: "deny" } } }, credentials).search.state, "blocked");
assert.equal(inspectWebCapabilities({ ...base, execution: { allowedHosts: ["example.com"] } }, credentials).search.state, "blocked");
assert.equal(inspectWebCapabilities({ ...base, execution: { allowedHosts: ["example.com"] } }, {}).fetch.label, "已启用 · 限定网站");
const searx = (url, allowPrivateSearch = false) => ({ ...base, web: { ...base.web, provider: "searxng", searxngUrl: url, allowPrivateSearch } });
for (const url of ["", "not-a-url", "https://user:password@example.com/search", "https://example.com/search?token=secret"]) {
  const result = inspectWebCapabilities(searx(url), {});
  assert.equal(result.search.state, "missing"); assert.equal(result.fetch.state, "enabled");
  assert(!JSON.stringify(result).includes("password"));
}
assert.equal(inspectWebCapabilities(searx("http://127.0.0.1:8080/search"), {}).search.state, "blocked");
assert.equal(inspectWebCapabilities(searx("http://127.0.0.1:8080/search", true), {}).search.state, "unverified");
assert.equal(inspectWebCapabilities(searx("http://169.254.169.254/search", true), {}).search.state, "blocked");
assert.equal(inspectWebCapabilities(searx("https://example.com/search"), credentials).search.state, "unverified");
assert.equal(credentialRead, false);
const snapshot = structuredClone(base);
base.web.searchEnabled = false;
assert.equal(inspectWebCapabilities(snapshot, {}).search.state, "missing");
assert.equal(inspectWebCapabilities(base, {}).search.state, "disabled");
console.log("通过：联网状态区分启用、配置、凭据、域名、工具权限与后端默认网络；配置检查无联网、无凭据泄露，快照独立。");
