import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { runProcess } from "./execution.mjs";
import { toolEnvironment } from "./execution-policy.mjs";

export const dockerImage = JSON.parse(readFileSync(new URL("./docker/image.json", import.meta.url), "utf8"));
let preparation;

export function prepareDockerImage() {
  // Build a staged tag, verify it, then switch the stable tag. Existing image IDs remain usable.
  return preparation ??= buildImage().finally(() => { preparation = undefined; });
}

async function buildImage() {
  const env = toolEnvironment({});
  const run = (args, timeout = 15_000) => runProcess("docker", args, { env, signal: AbortSignal.timeout(timeout) });
  const host = JSON.parse((await run(["context", "inspect", "--format", "{{json .Endpoints.docker.Host}}"])).stdout);
  if (!/^(npipe:|unix:)/.test(host)) throw new Error("镜像准备只支持本机 Docker 服务");
  const args = ["--host", host];
  if ((await run([...args, "info", "--format", "{{.OSType}}"])).stdout.trim() !== "linux") throw new Error("请先启动 Docker Desktop 的 Linux 容器后端");
  const staging = `tao-runtime-build:${randomUUID()}`;
  const container = `tao-image-check-${randomUUID()}`;
  try {
    await run([...args, "build", "--platform", dockerImage.platform, "--build-arg", `BASE_IMAGE=${dockerImage.base}`, "--build-arg", `TAO_IMAGE_VERSION=${dockerImage.version}`, "--tag", staging, fileURLToPath(new URL("./docker", import.meta.url))], 15 * 60_000);
    const verified = await run([...args, "run", "--rm", "--name", container, "--network=none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--user=1000:1000", "--memory=1g", "--cpus=2", "--pids-limit=64", "--tmpfs", "/tmp:rw,nosuid,nodev,size=64m,mode=1777", staging], 120_000);
    const report = JSON.parse(verified.stdout.trim());
    if (report.ok !== true || report.uid !== 1000) throw new Error("镜像工具验收失败");
    const imageId = (await run([...args, "image", "inspect", staging, "--format", "{{.Id}}"])).stdout.trim();
    await run([...args, "tag", imageId, dockerImage.image]);
    return { image: dockerImage.image, imageId, base: dockerImage.base, versions: report.versions, message: "镜像已构建，离线工具验收通过。保存组合后使用。" };
  } finally {
    // Only clean up the exact objects owned by this preparation, never user images or volumes.
    await run([...args, "rm", "--force", container]).catch(() => {});
    await run([...args, "image", "rm", staging]).catch(() => {});
  }
}
