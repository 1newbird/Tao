// Parses supplied bytes only. No document URLs, embedded programs or external relationships are opened.
import { parentPort, workerData } from "node:worker_threads";
import { unzipSync } from "fflate";
import { SaxesParser } from "saxes";
import { fileURLToPath } from "node:url";

const MAX_XML = 8 * 1024 * 1024;
const MAX_TEXT = 1_000_000;
const WORD_NAMESPACES = new Set([
  "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
  "http://purl.oclc.org/ooxml/wordprocessingml/main",
]);

function docx(bytes) {
  let found = false, entries = 0;
  const files = unzipSync(bytes, { filter: (entry) => {
    if (++entries > 10000) throw new Error("DOCX 压缩包条目过多");
    if (entry.name !== "word/document.xml") return false;
    if (found) throw new Error("DOCX 含重复正文条目");
    found = true;
    if (entry.originalSize > MAX_XML) throw new Error("DOCX 正文 XML 超过 8 MB 上限");
    return true;
  } });
  const document = files["word/document.xml"];
  if (!document) throw new Error("DOCX 缺少 word/document.xml；旧版 DOC 或加密文件不受支持");
  if (document.length > MAX_XML) throw new Error("DOCX 正文 XML 超过 8 MB 上限");
  const encoding = document[0] === 0xff && document[1] === 0xfe ? "utf-16le"
    : document[0] === 0xfe && document[1] === 0xff ? "utf-16be" : "utf-8";
  const xml = new TextDecoder(encoding, { fatal: true }).decode(document);
  let output = "", textDepth = 0, bodyDepth = 0, depth = 0;
  let validRoot = false;
  const append = (text) => {
    output += text;
    if (output.length > MAX_TEXT) throw new Error("DOCX 正文超过 100 万字符上限，请拆分文档");
  };
  const parser = new SaxesParser({ xmlns: true });
  parser.on("doctype", () => { throw new Error("DOCX 不支持 DTD 或自定义实体"); });
  parser.on("opentag", (tag) => {
    if (++depth > 256) throw new Error("DOCX XML 嵌套层数超过上限");
    const word = WORD_NAMESPACES.has(tag.uri);
    if (depth === 1) validRoot = word && tag.local === "document";
    if (word && tag.local === "body") bodyDepth = depth;
    if (!bodyDepth || !word) return;
    if (tag.local === "t") textDepth = depth;
    if (tag.local === "tab") append("\t");
    if (["br", "cr"].includes(tag.local)) append("\n");
  });
  parser.on("text", (text) => { if (textDepth && bodyDepth) append(text); });
  parser.on("cdata", (text) => { if (textDepth && bodyDepth) append(text); });
  parser.on("closetag", (tag) => {
    if (bodyDepth && WORD_NAMESPACES.has(tag.uri)) {
      if (tag.local === "p") append("\n");
      if (tag.local === "tc") append("\t");
      if (tag.local === "tr") append("\n");
    }
    if (depth === textDepth) textDepth = 0;
    if (depth === bodyDepth) bodyDepth = 0;
    depth--;
  });
  parser.write(xml).close();
  if (!validRoot) throw new Error("DOCX 正文 XML 类型无效");
  if (!output.trim()) throw new Error("DOCX 没有可提取的正文文字；图片文字需要 OCR");
  return { text: output.trim(), note: "DOCX 正文文本（含表格单元格文字）；不含页眉页脚、批注、脚注、图片、排版或分页信息。" };
}

async function pdf(bytes, startPage, pageCount) {
  if (!new TextDecoder().decode(bytes.subarray(0, 1024)).includes("%PDF-")) throw new Error("文件不是有效 PDF");
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const assets = new URL("./node_modules/pdfjs-dist/", import.meta.url);
  const task = getDocument({ data: bytes, isEvalSupported: false, useSystemFonts: false,
    disableFontFace: true, useWorkerFetch: false, isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false, enableXfa: false, verbosity: 0,
    cMapUrl: fileURLToPath(new URL("cmaps/", assets)) + "/", cMapPacked: true,
    standardFontDataUrl: fileURLToPath(new URL("standard_fonts/", assets)) + "/",
    wasmUrl: fileURLToPath(new URL("wasm/", assets)) + "/",
  });
  try {
    const document = await task.promise;
    if (startPage > document.numPages) throw new Error(`PDF 共 ${document.numPages} 页，startPage 超出范围`);
    const endPage = Math.min(document.numPages, startPage + pageCount - 1);
    const parts = [];
    let length = 0;
    for (let pageNumber = startPage; pageNumber <= endPage; pageNumber++) {
      const page = await document.getPage(pageNumber);
      const reader = page.streamTextContent().getReader();
      let text = "";
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          for (const item of value.items) {
            if (typeof item.str !== "string") continue;
            text += item.str + (item.hasEOL ? "\n" : " ");
            length += item.str.length + 1;
            if (length > MAX_TEXT) throw new Error("所选 PDF 页的文字超过 100 万字符，请减少 pageCount");
          }
        }
      } finally { await reader.cancel().catch(() => {}); page.cleanup(); }
      parts.push(`[第 ${pageNumber} 页]\n${text.trim() || "[本页无可提取文字，可能为空白页或扫描图片；尚未执行 OCR]"}`);
    }
    return { text: parts.join("\n\n"), totalPages: document.numPages, startPage, endPage,
      nextPage: endPage < document.numPages ? endPage + 1 : null,
      note: "PDF 文字层提取；阅读顺序可能与视觉排版不同，不含图片解读或 OCR。" };
  } catch (error) {
    if (error.name === "PasswordException") throw new Error("PDF 已加密，需要先提供解密后的文件");
    throw error;
  } finally { await task.destroy(); }
}

try {
  const { bytes, format, startPage, pageCount } = workerData;
  parentPort.postMessage({ result: format === "pdf" ? await pdf(bytes, startPage, pageCount) : docx(bytes) });
} catch (error) {
  parentPort.postMessage({ error: `文档解析失败：${String(error.message ?? error).slice(0, 500)}` });
}
