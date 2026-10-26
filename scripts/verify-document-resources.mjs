import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";
import { verifyStaticCrt } from "./pe-imports.mjs";
import { docxFixture, unicodePdfFixture } from "./document-fixtures.mjs";

export async function verifyDocumentResources(resourceRoot) {
  const canvas = join(resourceRoot, "runtime", "node_modules", "@napi-rs", "canvas-win32-x64-msvc", "skia.win32-x64-msvc.node");
  verifyStaticCrt(await readFile(canvas));
  const moduleUrl = pathToFileURL(join(resourceRoot, "runtime", "document-tools.mjs")).href;
  const script = `import {extractDocument} from ${JSON.stringify(moduleUrl)};
    const pdf=await extractDocument(Buffer.from(process.argv[1],"base64"),"pdf");
    const docx=await extractDocument(Buffer.from(process.argv[2],"base64"),"docx");
    if(!pdf.text.includes("中文")||!docx.text.includes("文档测试 & Tao"))throw new Error("发布资源文档解析失败");
    process.stdout.write("DOCUMENT_RESOURCES_OK");`;
  const result = await promisify(execFile)(join(resourceRoot, "node", "node.exe"), ["--input-type=module", "-e", script, unicodePdfFixture().toString("base64"), Buffer.from(docxFixture()).toString("base64")], {
    cwd: resourceRoot, windowsHide: true, timeout: 60000, env: { SystemRoot: process.env.SystemRoot, PATH: join(resourceRoot, "node") },
  });
  if (result.stdout !== "DOCUMENT_RESOURCES_OK") throw new Error("文档解析未返回发布验证标记");
}
