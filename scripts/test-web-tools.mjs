import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";
import { createServer } from "node:http";
import { once } from "node:events";
import { createWebTools, enabledWebTools, extractPage, fetchPage, intersectWeb, isPublicAddress, isPrivateSearchAddress, readPublicUrl, requestPublicUrl, searchWeb, testWebSearch, webConfiguration } from "../src-tauri/runtime/web-tools.mjs";
import { applyToolPolicy } from "../src-tauri/runtime/policy.mjs";
import { restrictChildConfiguration } from "../src-tauri/runtime/multi-agent.mjs";

const profile = { web: { searchEnabled: true, fetchEnabled: true, apiKeyEnv: "BRAVE_SEARCH_API_KEY" }, execution: { allowedEnv: ["BRAVE_SEARCH_API_KEY"] } };
const environment = { BRAVE_SEARCH_API_KEY: "fixture-secret-never-in-result" };
const response = (body, type = "text/html; charset=utf-8") => ({ status: 200, headers: { "content-type": type }, body: Buffer.from(body) });
const searxProfile = { web: { searchEnabled: true, fetchEnabled: true, provider: "searxng", searxngUrl: "https://search.example.com/sub/search" }, execution: {} };

test("SearXNG adapter normalizes results, maps filters, reports partial failures and fetches citation sources", async () => {
  let sent;
  const result = await searchWeb({ query: "中文 & + #", count: 1, freshness: "pm" }, searxProfile, undefined, { request: async (url, settings) => {
    sent = { url, settings };
    return response(JSON.stringify({ results: [{ title: "<b>研究</b>", url: "https://example.com/source", content: "A &amp; B", publishedDate: "2026-10-22" }, { url: "https://example.com/other" }], unresponsive_engines: [["engine", "internal-error-secret"]] }));
  } });
  assert.equal(sent.url.pathname, "/sub/search");
  assert.equal(sent.url.searchParams.get("q"), "中文 & + #");
  assert.equal(sent.url.searchParams.get("time_range"), "month");
  assert.equal(sent.url.searchParams.get("format"), "json");
  assert.deepEqual(sent.settings.headers, { Accept: "application/json" });
  assert.deepEqual(result.results, [{ title: "研究", url: "https://example.com/source", snippet: "A & B", publishedAt: "2026-10-22" }]);
  assert.equal(result.provider, "SearXNG"); assert.equal(result.warnings.length, 1);
  assert(!JSON.stringify(result).includes("internal-error-secret"));
  const page = await fetchPage({ url: result.results[0].url }, searxProfile, undefined, { request: async (url) => { assert.equal(url.href, result.results[0].url); return response("<main><h1>研究</h1><p>Evidence from the source</p></main>"); } });
  assert(page.content.includes("Evidence from the source")); assert.equal(page.url, result.results[0].url);
  assert.deepEqual(createWebTools((tool) => tool, searxProfile)[0].parameters.properties.freshness.enum, ["pd", "pm", "py"]);
  await assert.rejects(searchWeb({ query: "x", freshness: "pw" }, searxProfile), /不支持最近一周/);
});

test("SearXNG distinguishes empty, disabled JSON, bad schema, upstream failure, redirects and denial", async () => {
  const empty = { request: async () => response('{"results":[]}') };
  assert.equal((await testWebSearch(searxProfile, undefined, empty)).resultCount, 0);
  for (const [body, pattern] of [["<html>Login</html>", /JSON/], ["{}", /结构/], ['{"results":[],"unresponsive_engines":[["x","timeout"]]}', /上游/], ['{"results":[{"url":"file:\/\/\/secret"}]}', /来源链接/]]) {
    await assert.rejects(searchWeb({ query: "x" }, searxProfile, undefined, { request: async () => response(body) }), pattern);
  }
  for (const [status, pattern] of [[403, /search.formats/], [429, /限流/], [302, /重定向/], [500, /HTTP 500/]]) {
    await assert.rejects(searchWeb({ query: "x" }, searxProfile, undefined, { request: async () => ({ status, headers: { location: "http://127.0.0.1/secret" }, body: Buffer.from("private error") }) }), pattern);
  }
  let calls = 0; const never = { request: async () => { calls++; return response('{"results":[]}'); } };
  await assert.rejects(testWebSearch({ ...searxProfile, execution: { network: "deny" } }, undefined, never), /禁止/);
  await assert.rejects(testWebSearch({ ...searxProfile, toolPermissions: { web_search: { mode: "deny" } } }, undefined, never), /禁止/);
  await assert.rejects(searchWeb({ query: "x" }, { ...searxProfile, execution: { allowedHosts: ["other.example"] } }, undefined, never), /域名/);
  assert.equal(calls, 0);
  await assert.rejects(searchWeb({ query: "x" }, searxProfile, undefined, { request: async () => { throw new Error("ECONNREFUSED private connection details"); } }), /^Error: 无法连接 SearXNG，请检查地址、服务状态及 HTTPS 证书$/);
});

test("configured local SearXNG uses real HTTP only after opt-in; web_fetch stays public and requests cancel", async () => {
  let requests = 0;
  const server = createServer((request, res) => {
    requests++;
    if (request.url.includes("q=cancel")) return;
    res.writeHead(200, { "content-type": "application/json" }); res.end('{"results":[{"title":"source","url":"https://example.com","content":"snippet"}]}');
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}/search`;
  const local = { ...searxProfile, web: { ...searxProfile.web, searxngUrl: url, allowPrivateSearch: true } };
  try {
    await assert.rejects(searchWeb({ query: "x" }, { ...local, web: { ...local.web, allowPrivateSearch: false } }), /未获授权/);
    assert.equal(requests, 0);
    assert.equal((await searchWeb({ query: "x" }, local)).results.length, 1);
    assert.equal(requests, 1);
    await assert.rejects(fetchPage({ url }, local), /标准/);
    await assert.rejects(fetchPage({ url: "http://127.0.0.1/search" }, local), /公开/);
    await assert.rejects(searchWeb({ query: "x" }, { ...local, web: { ...local.web, searxngUrl: "http://169.254.169.254/search" } }), /未获授权/);
    const controller = new AbortController();
    const pending = searchWeb({ query: "cancel" }, local, controller.signal); controller.abort();
    await assert.rejects(pending, /取消/);
  } finally { server.closeAllConnections(); await new Promise((done) => server.close(done)); }
});

test("SearXNG configuration validates exact endpoints and never broadens child source or private access", () => {
  for (const raw of ["file:///tmp", "http://user:secret@localhost/search", "https://example.com/search?key=x", "https://example.com/#x", "bad"]) assert.throws(() => webConfiguration({ ...searxProfile.web, searxngUrl: raw }), /地址/);
  assert.equal(webConfiguration({}).provider, "brave");
  assert.throws(() => webConfiguration({ provider: "bad" }), /配置/);
  const upper = { ...searxProfile.web, allowPrivateSearch: false };
  assert.equal(intersectWeb(upper, { ...upper, allowPrivateSearch: true }).allowPrivateSearch, false);
  assert.equal(intersectWeb(upper, { ...upper, searxngUrl: "https://other.example/search" }).searchEnabled, false);
  assert.equal(intersectWeb(upper, profile.web).searchEnabled, false);
  assert.equal(intersectWeb(upper, { ...upper, apiKeyEnv: "IGNORED" }).searchEnabled, true);
  for (const address of ["127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.1", "::1", "fd00::1"]) assert(isPrivateSearchAddress(address));
  for (const address of ["0.0.0.0", "169.254.169.254", "100.64.0.1", "224.0.0.1", "::", "fe80::1", "::ffff:127.0.0.1", "2001:db8::1"]) assert(!isPrivateSearchAddress(address));
});

test("search adapter encodes queries, preserves sources, distinguishes empty and malformed results, never returns key", async () => {
  let sent;
  const request = async (url, options) => { sent = { url, options }; return response(JSON.stringify({ web: { results: [
    { title: "A &amp; B", url: "https://example.com/source", description: "<b>Finding</b>", page_age: "2026-10-20" },
    { title: "bad", url: "javascript:alert(1)" },
  ] } }), "application/json"); };
  const result = await searchWeb({ query: "中文 & # + ?", count: 3, freshness: "pw" }, profile, undefined, { request, environment });
  assert.equal(sent.url.searchParams.get("q"), "中文 & # + ?");
  assert.equal(sent.url.searchParams.get("freshness"), "pw");
  assert.equal(sent.options.headers["X-Subscription-Token"], environment.BRAVE_SEARCH_API_KEY);
  assert.deepEqual(result.results, [{ title: "A & B", url: "https://example.com/source", snippet: "Finding", publishedAt: "2026-10-20" }]);
  assert(!JSON.stringify(result).includes(environment.BRAVE_SEARCH_API_KEY));
  const empty = await searchWeb({ query: "none" }, profile, undefined, { environment, request: async () => response('{"query":{"original":"none"}}') });
  assert.deepEqual(empty.results, []);
  for (const body of ["{}", "null", "<html>", '{"web":{"results":{}}}']) await assert.rejects(searchWeb({ query: "x" }, profile, undefined, { environment, request: async () => response(body) }), /无效/);
});

test("network, credentials, hosts and tool permissions reject before sending", async () => {
  let calls = 0; const options = { environment, request: async () => { calls++; return response("ok"); } };
  await assert.rejects(searchWeb({ query: "x" }, { ...profile, execution: { network: "deny" } }, undefined, options), /禁止/);
  await assert.rejects(searchWeb({ query: "x" }, { ...profile, execution: {} }, undefined, options), /未授权/);
  await assert.rejects(searchWeb({ query: "x" }, profile, undefined, { ...options, environment: {} }), /尚未配置/);
  await assert.rejects(searchWeb({ query: "x" }, { ...profile, execution: { ...profile.execution, allowedHosts: ["example.com"] } }, undefined, options), /域名/);
  await assert.rejects(readPublicUrl("https://example.com", { network: "deny" }, undefined, options), /禁止/);
  assert.equal(calls, 0);
  assert.equal(applyToolPolicy(process.cwd(), "web_fetch", {}, { decision: "allow" }, { execution: { network: "deny" } }).enforcedDeny, true);
  assert.equal(applyToolPolicy(process.cwd(), "web_search", {}, { decision: "allow" }, { toolPermissions: { web_search: { mode: "ask" } } }).enforcedAsk, true);
});

test("page extraction, relative sources, charset, pagination and unsupported formats", async () => {
  const html = '<html><head><title>中文 &amp; 标题</title></head><body><nav>navigation</nav><main><h1>正文</h1><script>secret()</script><style>css</style><p>研究 &#x1f600;</p><a href="/source?a=1&amp;b=2">来源</a><a href="javascript:bad()">bad</a><p>' + "长文".repeat(1500) + '</p></main><footer>footer</footer></body></html>';
  const page = extractPage(html, "https://example.com/report");
  assert.equal(page.title, "中文 & 标题");
  assert(page.content.includes("研究 😀"));
  for (const removed of ["secret", "css", "navigation", "footer"]) assert(!page.content.includes(removed));
  assert.deepEqual(page.links, [{ title: "来源", url: "https://example.com/source?a=1&b=2" }]);
  const request = async () => response(html);
  const first = await fetchPage({ url: "https://example.com/report", limit: 1000 }, profile, undefined, { request });
  const next = await fetchPage({ url: first.url, offset: first.nextOffset, limit: 1000 }, profile, undefined, { request });
  assert.equal(first.content + next.content, page.content.slice(0, 2000));
  assert.equal(first.nextOffset, 1000);
  assert.equal(next.offset, 1000);
  await assert.rejects(fetchPage({ url: first.url }, profile, undefined, { request: async () => response("pdf", "application/pdf") }), /仅支持/);
  await assert.rejects(fetchPage({ url: first.url }, profile, undefined, { request: async () => response("<script>only()</script>") }), /没有可读正文/);
  await assert.rejects(fetchPage({ url: first.url, offset: 999999 }, profile, undefined, { request }), /超过正文/);
  const latin = await fetchPage({ url: first.url }, profile, undefined, { request: async () => ({ ...response("", "text/plain; charset=windows-1252"), body: Buffer.from([0x63, 0x61, 0x66, 0xe9]) }) });
  assert.equal(latin.content, "café");
  assert(extractPage('<main><p data-x="a > b">safe</p><script>hidden</script></main>', first.url).content.includes("safe"));
  assert.equal(extractPage("<main>".repeat(10000) + "body", first.url).content, "body");
});

test("redirects recheck hosts, cap hops and prevent credential forwarding", async () => {
  let calls = 0;
  const request = async () => { calls++; return { status: 302, headers: { location: "https://other.example/path" }, body: Buffer.alloc(0) }; };
  await assert.rejects(readPublicUrl("https://example.com", { allowedHosts: ["example.com"] }, undefined, { request }), /域名/);
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(readPublicUrl("https://example.com", {}, undefined, { request }), /5 次/);
  assert.equal(calls, 6);
  await assert.rejects(searchWeb({ query: "x" }, profile, undefined, { request, environment }), /重定向/);
  await assert.rejects(readPublicUrl("https://example.com", {}, undefined, { request: async () => ({ status: 302, headers: { location: "http://example.com" } }) }), /降级/);
  const success = await readPublicUrl("https://example.com", {}, undefined, { request: async (url) => url.pathname === "/" ? { status: 302, headers: { location: "/article" } } : response("text") });
  assert.equal(success.url, "https://example.com/article");
});

test("public address gate blocks private/loopback/mapped addresses and pins DNS lookup", async () => {
  for (const address of ["127.0.0.1", "10.0.0.1", "169.254.169.254", "172.20.0.1", "192.168.1.1", "100.64.0.1", "::1", "::ffff:127.0.0.1", "fc00::1", "fe80::1", "2001:db8::1", "2002:7f00:1::", "bad"]) assert.equal(isPublicAddress(address), false, address);
  for (const address of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) assert.equal(isPublicAddress(address), true, address);
  for (const url of ["http://127.1", "http://2130706433", "http://[::ffff:127.0.0.1]"]) await assert.rejects(requestPublicUrl(new URL(url)), /公开/);
  await assert.rejects(requestPublicUrl(new URL("https://example.com"), { resolve: async () => [{ address: "1.1.1.1", family: 4 }, { address: "10.1.1.1", family: 4 }] }), /公开/);
  let resolved = 0;
  const result = await requestPublicUrl(new URL("https://example.com"), {
    resolve: async () => { resolved++; return [{ address: "1.1.1.1", family: 4 }]; },
    request: (_url, options, callback) => {
      options.lookup("example.com", {}, (error, address, family) => { assert.equal(error, null); assert.equal(address, "1.1.1.1"); assert.equal(family, 4); });
      const req = new EventEmitter(); req.end = () => { const res = Readable.from([Buffer.from("ok")]); res.statusCode = 200; res.headers = {}; callback(res); }; return req;
    },
  });
  assert.equal(resolved, 1); assert.equal(result.body.toString(), "ok");
});

test("stream size, compression, HTTP failure, URL constraints and cancellation", async () => {
  const compressedRequest = (body) => (_url, _options, callback) => {
    const req = new EventEmitter(); req.end = () => { const res = Readable.from([gzipSync(body)]); res.statusCode = 200; res.headers = { "content-encoding": "gzip" }; callback(res); }; return req;
  };
  const options = { resolve: async () => [{ address: "1.1.1.1", family: 4 }] };
  assert.equal((await requestPublicUrl(new URL("https://example.com"), { ...options, request: compressedRequest("hello") })).body.toString(), "hello");
  await assert.rejects(requestPublicUrl(new URL("https://example.com"), { ...options, request: compressedRequest("a".repeat(2 * 1024 * 1024 + 1)) }), /2 MB/);
  for (const url of ["file:///secret", "https://user:secret@example.com", "https://example.com:9000"]) await assert.rejects(readPublicUrl(url, {}, undefined, {}));
  await assert.rejects(readPublicUrl("https://example.com", {}, undefined, { request: async () => ({ status: 429, headers: {}, body: Buffer.from("secret") }) }), /^Error: 网页请求失败：HTTP 429$/);
  const controller = new AbortController();
  const pending = requestPublicUrl(new URL("https://example.com"), { signal: controller.signal, resolve: () => new Promise(() => {}) });
  controller.abort(new Error("cancelled"));
  await assert.rejects(pending, /cancelled/);
  await assert.rejects(readPublicUrl("https://example.com", {}, controller.signal), /cancelled/);
});

test("web capability snapshots and child permissions never broaden the parent", () => {
  assert.deepEqual(enabledWebTools({}), []);
  assert.deepEqual(createWebTools((tool) => tool, profile).map((tool) => tool.name), ["web_search", "web_fetch"]);
  assert.equal(intersectWeb(profile.web, { ...profile.web, apiKeyEnv: "OTHER" }).searchEnabled, false);
  const child = restrictChildConfiguration({ ...profile, toolPermissions: { web_search: { mode: "ask" } } }, { ...profile, toolPermissions: { web_search: { mode: "allow" } } });
  assert.equal(child.web.searchEnabled, true);
  assert.equal(child.toolPermissions.web_search.mode, "ask");
  assert.equal(restrictChildConfiguration({}, profile).web.fetchEnabled, false);
});
