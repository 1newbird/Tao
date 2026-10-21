function text(content) { return typeof content === "string" ? content : (content ?? []).filter(item => item.type === "text").map(item => item.text).join(""); }
export function windowsTeamDecision(messages) {
  const users = messages.filter(message => message.role === "user").map(message => text(message.content));
  const root = users.some(value => value.startsWith("WINDOWS_NATIVE_TEAM_ROOT"));
  const member = users.findLast(value => value.startsWith("[Tao 成员身份]") && value.includes("WINDOWS_NATIVE_PATH_CHILD"));
  if (!root && !member) return null;
  const invoked = messages.flatMap(message => message.tool_calls ?? []).map(call => ({ name: call.function.name, input: JSON.parse(call.function.arguments) }));
  const returned = messages.filter(message => message.role === "tool").map(message => { try { return JSON.parse(text(message.content)); } catch { return {}; } });
  const tool = (name, input = {}) => ({ name, input });
  if (root) {
    const spawned = returned.filter(result => result.agentId && result.taskId);
    if (spawned.length < 2) return tool("spawn_agent", { profileId: `native-worker-${spawned.length ? "b" : "a"}`, taskName: `原生成员 ${spawned.length + 1}`, description: `WINDOWS_NATIVE_PATH_CHILD_${spawned.length ? "B" : "A"}` });
    if (!returned.filter(result => typeof result.finished === "boolean").at(-1)?.finished) return tool("wait_agent", { agentIds: spawned.map(result => result.agentId), mode: "all", timeoutMs: 5000 });
    return { answer: "Windows 原生成员文件与管道流程已完成。" };
  }
  if (!invoked.some(call => call.name === "read")) return tool("read", { path: "./native-team.txt" });
  if (!invoked.some(call => call.name === "ls")) return tool("ls", { path: "." });
  if (!invoked.some(call => call.name === "bash")) return tool("bash", { command: 'node -e "console.log(require(\'child_process\').execFileSync(process.execPath,[\'-p\',\'720\']).toString().trim())"' });
  const roster = returned.find(result => result.self && Array.isArray(result.members));
  if (!roster) return tool("list_agents");
  const peer = roster.members.find(item => item.agentId !== roster.self);
  if (!peer) return tool("list_agents");
  if (!invoked.some(call => call.name === "send_message")) return tool("send_message", { recipient: peer.agentId, body: "NATIVE_FILE_READ_720", kind: "finding", requestKey: "native-evidence" });
  return { answer: "NATIVE_MEMBER_DONE_720" };
}
