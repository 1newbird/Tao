import { isIP } from "node:net";
import { executionConfiguration, assertCredentialReferences } from "./execution-policy.mjs";
import { assertHttpTarget } from "./policy.mjs";
import { webConfiguration, isPublicAddress, isPrivateSearchAddress } from "./web-tools.mjs";

const status = (state, label, detail, action) => ({ state, label, detail, action });

// Configuration inspection only: no DNS, HTTP, model calls or credential values in the result.
export function inspectWebCapabilities(profile = {}, environment = process.env) {
  let policy;
  try { policy = executionConfiguration(profile.execution); }
  catch { const invalid = status("blocked", "执行配置无效", "请检查执行与沙盒设置。", "execution"); return { search: invalid, fetch: invalid }; }
  const restriction = (tool) => policy.network === "deny"
    ? status("blocked", "联网被禁止", "当前组合的执行策略禁止工具联网。", "execution")
    : profile.toolPermissions?.[tool]?.mode === "deny"
      ? status("blocked", "工具被禁止", "当前组合禁止使用此工具。", "agent") : null;
  let search = status("disabled", "未启用", "搜索需要单独配置服务；连接模型 API 不会自动开启搜索。", "web");
  if (profile.web?.searchEnabled) {
    search = restriction("web_search");
    if (!search) {
      try {
        const web = webConfiguration(profile.web);
        const endpoint = assertHttpTarget(web.provider === "searxng" ? web.searxngUrl : "https://api.search.brave.com/res/v1/web/search", policy.allowedHosts);
        const host = endpoint.hostname.replace(/^\[|\]$/g, "");
        if ((isIP(host) && !isPublicAddress(host) && !(web.allowPrivateSearch && isPrivateSearchAddress(host))) || (host === "localhost" && !web.allowPrivateSearch)) {
          search = status("blocked", "接口地址受限", "本机或私网搜索接口需单独授权；特殊地址始终禁止。", "web");
        } else if (web.provider !== "searxng") {
          assertCredentialReferences(`{{env:${web.apiKeyEnv}}}`, profile.execution);
          search = environment[web.apiKeyEnv]?.trim()
            ? status("unverified", "已配置 · 待测试", "已检测到搜索凭据，尚未验证服务连接。", "web")
            : status("missing", "缺少搜索密钥", `请设置环境变量 ${web.apiKeyEnv} 后重启 Tao；不要将密钥填入聊天。`, "web");
        } else search = status("unverified", "已配置 · 待测试", "已填写 SearXNG 接口，尚未验证实例和上游搜索。", "web");
      } catch (error) {
        const message = error.message;
        const execution = /凭据变量|域名范围/.test(message);
        search = status(execution ? "blocked" : "missing", execution ? "配置受限" : "搜索未配置完整", message, execution ? "execution" : "web");
      }
    }
  }
  const fetch = !profile.web?.fetchEnabled
    ? status("disabled", "未启用", "网页读取可单独开启，无需搜索密钥。", "web")
    : restriction("web_fetch") ?? status("enabled", policy.allowedHosts.length ? "已启用 · 限定网站" : "已启用", policy.allowedHosts.length
      ? `仅允许名单中的公开网站：${policy.allowedHosts.join("、")}。实际可达性以读取结果为准。`
      : "可读取公开静态网页和文本。实际可达性以读取结果为准；不支持登录和动态页面。", "web");
  return { search, fetch };
}
