// Deterministic local model decisions for the actual Runtime integration test.
// The fixture has no access to the coordinator or user data.
function text(content) { return typeof content === "string" ? content : (content ?? []).filter((item) => item.type === "text").map((item) => item.text).join(""); }
function calls(messages) { return messages.flatMap((message) => message.tool_calls ?? []).map((call) => ({ name: call.function.name, input: JSON.parse(call.function.arguments) })); }
function results(messages) { return messages.filter((message) => message.role === "tool").map((message) => { try { return JSON.parse(text(message.content)); } catch { return {}; } }); }
const tool = (name, input = {}) => ({ name, input });

export function collaborationDecision(messages) {
  const users = messages.filter((message) => message.role === "user").map((message) => text(message.content));
  const taskIndex = messages.findLastIndex((message) => message.role === "user" && text(message.content).startsWith("[Tao 成员身份]"));
  const taskText = taskIndex >= 0 ? text(messages[taskIndex].content) : "";
  const isRoot = users.some((value) => value.startsWith("TAO_COLLAB_ROOT"));
  if (!isRoot && !taskText.includes("TAO_COLLAB_")) return null;
  const history = isRoot ? messages : messages.slice(taskIndex + 1);
  const invoked = calls(history);
  const returned = results(history);
  if (isRoot && users.some((value) => value.includes("HUMAN_ROOT"))) {
    const spawned = returned.find((result) => result.agentId && result.taskId);
    if (!spawned) return tool("spawn_agent", { profileId: "worker-a", taskName: "人工介入验证", description: "TAO_COLLAB_HUMAN_CHILD" });
    if (!returned.filter((result) => typeof result.finished === "boolean").at(-1)?.finished) return tool("wait_agent", { agentIds: [spawned.agentId], mode: "all", timeoutMs: 5000 });
    return { answer: "人工介入验证完成。" };
  }
  if (!isRoot && taskText.includes("TAO_COLLAB_HUMAN_CHILD")) {
    if (JSON.stringify(messages).includes("HUMAN_UI_SUPPLEMENT")) return { answer: "HUMAN_SUPPLEMENT_SEEN" };
    return tool("read_agent_messages", { includeDelivered: true });
  }
  if (isRoot && users.some((value) => value.includes("PERMISSION_MAIL"))) {
    const spawned = returned.find((result) => result.agentId && result.taskId);
    if (!spawned) return tool("spawn_agent", { profileId: "worker-b", taskName: "确认期间接收消息", description: "TAO_COLLAB_PERMISSION_CHILD" });
    if (!invoked.some((call) => call.name === "send_message")) return tool("send_message", { recipient: spawned.agentId, body: "AFTER_PERMISSION_MAIL", kind: "notice", requestKey: "permission-mail" });
    if (!returned.some((result) => result.finished)) return tool("wait_agent", { agentIds: [spawned.agentId], mode: "all", timeoutMs: 5000 });
    return { answer: "权限与消息边界已验证。" };
  }
  if (!isRoot && taskText.includes("TAO_COLLAB_PERMISSION_CHILD")) {
    if (!invoked.some((call) => call.name === "write")) return tool("write", { path: "collaboration-confirmed.txt", content: "approved" });
    return { answer: "PERMISSION_CHILD_DONE" };
  }
  if (isRoot && users.some((value) => value.includes("SELF_CANCEL"))) {
    const spawned = returned.find((result) => result.agentId && result.taskId);
    if (!spawned) return tool("spawn_agent", { profileId: "worker-a", taskName: "成员自行停止", description: "TAO_COLLAB_SELF_CHILD" });
    if (!invoked.some((call) => call.name === "followup_task")) return tool("followup_task", { agentId: spawned.agentId, taskName: "取消后不得执行", description: "TAO_COLLAB_NEVER", requestKey: "never" });
    if (!returned.some((result) => result.finished)) return tool("wait_agent", { agentIds: [spawned.agentId], mode: "all", timeoutMs: 5000 });
    return { answer: "成员已自行停止。" };
  }
  if (!isRoot && taskText.includes("TAO_COLLAB_SELF_CHILD")) {
    if (!invoked.some((call) => call.name === "read_agent_messages")) return tool("read_agent_messages");
    return tool("cancel_agent", { agentId: /agentId=([^;]+)/.exec(taskText)[1] });
  }
  if (!isRoot && taskText.includes("TAO_COLLAB_NEVER")) return { answer: "BAD_QUEUED_EXECUTION" };
  if (isRoot) {
    const spawned = returned.filter((result) => result.agentId && result.taskId);
    if (!spawned.length) return tool("spawn_agent", { profileId: "worker-a", taskName: "通信核查 A", description: "TAO_COLLAB_A" });
    if (spawned.length === 1) return tool("spawn_agent", { profileId: "worker-b", taskName: "协作建议 B", description: "TAO_COLLAB_B" });
    const [a, b] = spawned;
    if (invoked.filter((call) => call.name === "send_message" && call.input.requestKey === "root-hint").length < 2) return tool("send_message", { recipient: a.agentId, body: "ROOT_HINT_FOR_A", kind: "notice", requestKey: "root-hint" });
    if (!invoked.some((call) => call.name === "followup_task")) return tool("followup_task", { agentId: a.agentId, taskName: "接续核实 A", description: "TAO_COLLAB_FOLLOW_A", requestKey: "follow-a" });
    const questionSeen = JSON.stringify(messages).includes("A_QUESTION_FOR_PARENT");
    if (questionSeen && !invoked.some((call) => call.name === "send_message" && call.input.requestKey === "root-answer")) return tool("send_message", { recipient: a.agentId, body: "ROOT_REPLY", kind: "reply", requestKey: "root-answer" });
    const lastWait = returned.filter((result) => typeof result.finished === "boolean").at(-1);
    if (!lastWait?.finished) return tool("wait_agent", { agentIds: [a.agentId, b.agentId], mode: "all", timeoutMs: 5000 });
    if (!invoked.some((call) => call.name === "send_message" && call.input.requestKey === "idle-mail")) return tool("send_message", { recipient: b.agentId, body: "IDLE_DO_NOT_WAKE", kind: "notice", requestKey: "idle-mail" });
    return { answer: "协作通信与接续任务已完成。" };
  }
  if (taskText.includes("TAO_COLLAB_FOLLOW_A")) {
    if (!invoked.some((call) => call.name === "read_agent_messages")) return tool("read_agent_messages", { includeDelivered: true });
    return { answer: users.some((value) => value.includes("TAO_COLLAB_A")) ? "FOLLOWUP_VERIFIED_HISTORY" : "MISSING_PRIVATE_HISTORY" };
  }
  const isA = taskText.includes("TAO_COLLAB_A");
  const roster = returned.find((result) => result.self && Array.isArray(result.members));
  const peer = roster?.members.find((member) => member.agentId !== roster.self);
  if (!peer) return tool("list_agents");
  if (!invoked.some((call) => call.name === "send_message")) return tool("send_message", { recipient: peer.agentId, body: isA ? "A_SHARED_EVIDENCE" : "B_SUGGESTION", kind: isA ? "finding" : "suggestion", requestKey: "peer-message" });
  if (!isA && !invoked.some((call) => call.name === "cancel_agent")) return tool("cancel_agent", { agentId: peer.agentId });
  if (invoked.filter((call) => call.name === "send_message").length === 1) return tool("send_message", { recipient: "parent", body: isA ? "A_QUESTION_FOR_PARENT" : "Please review A; this is only a suggestion", kind: isA ? "question" : "cancel_request", requestKey: "parent-message" });
  if (!invoked.some((call) => call.name === "read_agent_messages")) return tool("read_agent_messages", { includeDelivered: true });
  return { answer: isA ? "A_PRIVATE_INITIAL_DONE" : "B_PRIVATE_DONE" };
}
