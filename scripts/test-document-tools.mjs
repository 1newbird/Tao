import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { extractDocument, documentReadDefinition, readDocumentBytes } from "../src-tauri/runtime/document-tools.mjs";
import { docxFixture, pdfFixture, unicodePdfFixture } from "./document-fixtures.mjs";
const require = createRequire(new URL("../src-tauri/runtime/package.json", import.meta.url));
const { zipSync, strToU8 } = require("fflate");
const base = { name: "read", description: "Read files", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }, execute: async () => ({ text: "plain text delegated" }) };

test("PDF page ranges, page markers, continuation and text-free pages", async () => {
  const bytes = pdfFixture(["Page ONE", "Page TWO", ""]);
  const first = await extractDocument(bytes, "pdf", { pageCount: 1 });
  assert.equal(first.totalPages, 3); assert.equal(first.nextPage, 2);
  assert.match(first.text, /第 1 页.*\nPage ONE/); assert.doesNotMatch(first.text, /TWO/);
  const last = await extractDocument(bytes, "pdf", { startPage: 2 });
  assert.match(last.text, /TWO/); assert.match(last.text, /尚未执行 OCR/); assert.equal(last.nextPage, null);
  await assert.rejects(extractDocument(bytes, "pdf", { startPage: 4 }), /超出范围/);
});

test("DOCX ordered paragraphs, tables, entities, tabs and ignored external relationships", async () => {
  const bytes = docxFixture('<w:p><w:r><w:t>中文 &amp; English</w:t><w:tab/><w:t>后半段</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>表格一</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>表格二</w:t></w:r></w:p></w:tc></w:tr></w:tbl>', { "word/_rels/document.xml.rels": strToU8('<external Target="http://127.0.0.1:1/private"/>') });
  const result = await extractDocument(bytes, "docx");
  assert.match(result.text, /中文 & English\t后半段/); assert(result.text.indexOf("表格一") < result.text.indexOf("表格二"));
  assert.doesNotMatch(result.text, /http/);
});

test("Unicode PDF mappings and UTF-16 DOCX preserve Chinese text", async () => {
  assert.match((await extractDocument(unicodePdfFixture(), "pdf")).text, /中文/);
  const xml = '\ufeff<?xml version="1.0" encoding="UTF-16"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>中文编码</w:t></w:r></w:p></w:body></w:document>';
  const bytes = zipSync({ "word/document.xml": Buffer.from(xml, "utf16le") });
  assert.equal((await extractDocument(bytes, "docx")).text, "中文编码");
});

test("corrupt formats, XML entities, missing body, zip size limits and validation fail clearly", async () => {
  await assert.rejects(extractDocument(Buffer.from("not pdf"), "pdf"), /不是有效 PDF/);
  await assert.rejects(extractDocument(Buffer.from("broken"), "docx"), /解析失败/);
  await assert.rejects(extractDocument(zipSync({ "file": strToU8("x") }), "docx"), /缺少/);
  await assert.rejects(extractDocument(docxFixture("<w:p>"), "docx"), /解析失败/);
  const dtd = zipSync({ "word/document.xml": strToU8('<!DOCTYPE a [<!ENTITY test SYSTEM "file:///private">]><a>&test;</a>') });
  await assert.rejects(extractDocument(dtd, "docx"), /DTD/);
  await assert.rejects(extractDocument(docxFixture(""), "docx"), /没有可提取/);
  const oversized = zipSync({ "word/document.xml": new Uint8Array(8 * 1024 * 1024 + 1) });
  await assert.rejects(extractDocument(oversized, "docx"), /8 MB/);
  await assert.rejects(extractDocument(Buffer.alloc(20 * 1024 * 1024 + 1), "pdf"), /20 MB/);
  await assert.rejects(extractDocument(pdfFixture(), "pdf", { pageCount: 21 }), /pageCount/);
});

test("read wrapper preserves text tools, policy and backend reads; long paragraphs remain resumable", async () => {
  const root = await mkdtemp(join(tmpdir(), "tao-documents-"));
  try {
    const workspace = join(root, "workspace"); await mkdir(workspace);
    const outside = join(root, "outside.docx"); await writeFile(outside, docxFixture());
    await writeFile(join(workspace, "report.DOCX"), docxFixture(`<w:p><w:r><w:t>${"a".repeat(30000)}TAIL</w:t></w:r></w:p>`));
    const tool = documentReadDefinition(base, { cwd: workspace, profile: { execution: { fileScope: "workspace", network: "deny" } } });
    assert.deepEqual(await tool.execute("id", { path: "a.txt" }), { text: "plain text delegated" });
    await assert.rejects(tool.execute("id", { path: outside }), /工作区/);
    const first = await tool.execute("id", { path: "report.DOCX" });
    assert(first.details.document.nextOffset > 1); assert(first.content[0].text.length < 25000);
    const last = await tool.execute("id", { path: "report.DOCX", offset: first.details.document.nextOffset });
    assert.match(last.content[0].text, /TAIL/); assert.equal(last.details.document.nextOffset, null);
    const denied = documentReadDefinition(base, { cwd: workspace, profile: { toolPermissions: { read: { mode: "deny" } } } });
    await assert.rejects(denied.execute("id", { path: "report.DOCX" }), /禁止/);
    let called = 0;
    const sandbox = documentReadDefinition(base, { cwd: workspace, readBytes: async (_path, signal) => { called++; signal?.throwIfAborted(); return docxFixture(); } });
    assert.match((await sandbox.execute("id", { path: "report.DOCX" })).content[0].text, /文档测试/);
    assert.equal(called, 1);
    await assert.rejects(readDocumentBytes(workspace), /普通文件/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("cancel before/during parsing terminates the owned worker", async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(extractDocument(pdfFixture(), "pdf", {}, controller.signal));
  const running = new AbortController();
  const promise = extractDocument(pdfFixture(Array(100).fill("Test")), "pdf", {}, running.signal);
  running.abort(); await assert.rejects(promise, /取消/);
});
