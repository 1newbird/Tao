// Local UI preview only: renders the actual frontend with in-memory fixtures.
// No filesystem commands, credentials, Runtime process or model calls are exposed.
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const server = await createServer({
  root,
  server: { host: "127.0.0.1", port: 1432, strictPort: true },
  plugins: [{
    name: "tao-ui-preview-fixture",
    configureServer(vite) {
      vite.middlewares.use((request, response, next) => {
        if (request.url?.split("?")[0] !== "/__ui_preview") return next();
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.end('<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Tao UI 预览（模拟数据）</title></head><body><div id="root"></div><script type="module">import "/@vite/client"; import RefreshRuntime from "/@react-refresh"; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => (type) => type; window.__vite_plugin_react_preamble_installed__ = true; await import("/scripts/ui-preview-fixture.ts"); await import("/src/main.tsx");</script></body></html>');
      });
    },
  }],
});
await server.listen();
console.log("Tao UI 预览：http://127.0.0.1:1432/__ui_preview（内存模拟数据，不读写真实用户配置）");
