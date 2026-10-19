import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const directory = await mkdtemp(join(process.cwd(), ".ui-render-test-"));
try {
  await writeFile(join(directory, "stream-blocks.mjs"), ts.transpileModule(await readFile("src/stream-blocks.ts", "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext } }).outputText);
  const { updateOutputBlocks, outputAnswer } = await import(pathToFileURL(join(directory, "stream-blocks.mjs")));
  let blocks = [];
  const event = (activityId, text, action, complete = false) => { blocks = updateOutputBlocks(blocks, { activityId, text, action, event: complete ? "text_block_end" : "text_block_delta" }); };
  event("request-text-1:0", "same text", "pending");
  event("request-text-1:1", "same text", "answer");
  event("request-text-1:0", "same text", "commentary", true);
  assert.equal(outputAnswer(blocks), "same text", "按 ID 归类工作说明不得删除另一个同内容正文块");
  event("request-text-2:0", "next", "answer");
  event("request-text-2:0", " part", "answer");
  event("request-text-2:0", "next part", "answer", true);
  event("request-text-2:0", "next part", "answer", true);
  assert.equal(outputAnswer(blocks), "same text\n\nnext part", "分块增量、消息间距和重复终态必须保持正确");
  const layoutSource = await readFile("src/panel-layout.ts", "utf8");
  await writeFile(join(directory, "panel-layout.mjs"), ts.transpileModule(layoutSource, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext } }).outputText);
  const { resolvePanelLayout } = await import(pathToFileURL(join(directory, "panel-layout.mjs")));
  for (const width of [600, 760, 900, 1000, 1280, 1920]) for (const sidebarOpen of [false, true]) for (const runtimeOpen of [false, true]) for (const sidebarWidth of [200, 252, 460]) for (const runtimeWidth of [360, 520, 860]) {
    const layout = resolvePanelLayout({ width, sidebarOpen, runtimeOpen, sidebarWidth, runtimeWidth });
    const handles = (layout.sidebarOpen ? 10 : 0) + (runtimeOpen ? 10 : 0);
    assert(width - layout.sidebarWidth - layout.runtimeWidth - handles >= 420, "面板占用不得挤掉会话的最小可用宽度");
    assert(!layout.sidebarOpen || (layout.sidebarWidth >= 200 && layout.sidebarWidth <= layout.sidebarMax), "左侧栏宽度和拖动上限不一致");
    assert(layout.runtimeWidth <= layout.runtimeMax && layout.runtimeMin <= layout.runtimeMax, "右侧栏拖动范围不合法");
  }
  const source = (await readFile("src/MarkdownContent.tsx", "utf8")).replace(/^import ["'][^"']+\.css["'];?\s*$/gm, "");
  const compiled = ts.transpileModule(source, { fileName: "MarkdownContent.tsx", compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } });
  await writeFile(join(directory, "MarkdownContent.mjs"), compiled.outputText);
  const { MarkdownContent } = await import(pathToFileURL(join(directory, "MarkdownContent.mjs")));
  const render = (content, variant = "chat") => renderToStaticMarkup(createElement(MarkdownContent, { content, variant, messageId: "test", onCopy() {} }));
  const report = "# 核对结果\n\n| 项目 | 数量 |\n| :--- | ---: |\n| **有效订单** | 4 |\n| 金额 | 720 |\n\n---\n\n1. 核算\n   - 订单\n     - 证据\n\n- [x] 已验收\n- [ ] 待复核\n\n> 引用说明\n\n```json\n{\"amount\":720}\n```";
  for (const variant of ["chat", "workspace"]) {
    const html = render(report, variant);
    assert(html.includes("<table>") && html.includes("<thead>") && html.includes("<tbody>"), `${variant}: 缺少真实表格`);
    assert(html.includes("text-align:right") && html.includes("<strong>有效订单</strong>"), `${variant}: 表格对齐或单元格格式失效`);
    assert(html.includes("<hr") && html.includes("<blockquote>") && (html.match(/<ul>/g) ?? []).length >= 2, `${variant}: 分隔线、引用或嵌套列表失效`);
    assert(html.includes('type="checkbox"') && html.includes("disabled"), `${variant}: 任务列表失效`);
    assert(html.includes("复制代码") && html.includes("language-json") && html.includes("amount"), `${variant}: 代码块失效`);
  }
  const unsafe = render('[不安全](javascript:alert%281%29)\n\n<script>window.bad=1</script>\n\n<img src="https://example.com/track" onerror="bad()">\n\n![图片说明](https://example.com/image.png)');
  assert(!unsafe.includes('href="javascript:') && !unsafe.includes("<script") && !unsafe.includes("<img"), "Markdown 不得执行 HTML 或自动加载图片资源");
  assert(unsafe.includes("图片说明"), "图片引用应保留可见说明");
  assert(render('[链接](https://example.com/docs) 与 `inline_code`').includes('rel="noreferrer"'), "外部链接属性丢失");
  for (const partial of ["| 列一 | 列二 |\n| --", "```json\n{\"open\":", "- 父项\n  - **未闭合", "[链接](https://example.com"]) assert.doesNotThrow(() => render(partial));
  assert(!render("```text\n| 不是表格 |\n| --- |\n```").includes("<table>"), "代码块中的管道不得误判为表格");
  console.log("通过：面板宽度约束（216 种组合）、Markdown、表格、复制、链接/HTML边界及流式文本块分流与终态去重。");
} finally { await rm(directory, { recursive: true, force: true }); }
