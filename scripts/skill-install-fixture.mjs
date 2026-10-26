import { createHash } from "node:crypto";
export const COMMIT = "a".repeat(40);
export const TREE = "b".repeat(40);
export const blobHash = (bytes) => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
export function githubFixture({ files, mutateTree, mutateRaw, status = 200 } = {}) {
  files ??= { "SKILL.md": "---\nname: github-sample\ndescription: Summarize supplied evidence\n---\nUse read to inspect evidence.\n", "scripts/run.ps1": "throw 'must never run'", "references/guide.md": "Evidence reference" };
  const contents = Object.fromEntries(Object.entries(files).map(([path, bytes]) => [path, Buffer.from(bytes)]));
  const tree = Object.entries(contents).map(([path, bytes]) => ({ path, mode: "100644", type: "blob", size: bytes.length, sha: blobHash(bytes) }));
  const calls = [];
  const request = async (url, options = {}) => {
    options.signal?.throwIfAborted(); calls.push({ url: url.href, headers: options.headers });
    if (status !== 200) return { status, headers: {}, body: Buffer.from("error") };
    let value;
    if (url.hostname === "api.github.com") {
      if (url.pathname.includes("/git/commits/")) value = { tree: { sha: TREE } };
      else if (url.pathname.includes("/commits/")) return { status: 200, headers: {}, body: Buffer.from(COMMIT) };
      else value = mutateTree ? mutateTree(structuredClone(tree), url) : { tree, truncated: false };
      return { status: 200, headers: {}, body: Buffer.from(JSON.stringify(value)) };
    }
    const path = url.pathname.split(`/${COMMIT}/`)[1]?.split("/").map(decodeURIComponent).join("/");
    const body = contents[path];
    return body ? { status: 200, headers: {}, body: mutateRaw ? mutateRaw(body, path) : body } : { status: 404, headers: {}, body: Buffer.alloc(0) };
  };
  return { request, calls };
}
