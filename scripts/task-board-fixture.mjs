// Local deterministic model fixture; exercises only public Runtime tools.
const text = (content) => typeof content === "string" ? content : (content ?? []).filter((item) => item.type === "text").map((item) => item.text).join("");
const tool = (name, input = {}) => ({ name, input });

export function taskBoardDecision(messages) {
  const users = messages.filter((message) => message.role === "user").map((message) => text(message.content));
  const taskIndex = messages.findLastIndex((message) => message.role === "user" && text(message.content).startsWith("[Tao 成员身份]"));
  const taskText = taskIndex >= 0 ? text(messages[taskIndex].content) : "";
  const root = users.some((value) => value.startsWith("TAO_BOARD_ROOT"));
  if (!root && !taskText.includes("TAO_BOARD_")) return null;
  const history = root ? messages : messages.slice(taskIndex + 1);
  const calls = history.flatMap((message) => message.tool_calls ?? []).map((call) => ({ name: call.function.name, input: JSON.parse(call.function.arguments) }));
  const results = history.filter((message) => message.role === "tool").map((message) => { try { return JSON.parse(text(message.content)); } catch { return {}; } });
  if (!root) {
    if (taskText.includes("TAO_BOARD_SCOUT")) {
      const listing = results.find((result) => result.tasks);
      if (!listing) return tool("list_tasks");
      if (!calls.some((call) => call.name === "claim_task")) {
        const task = listing.tasks.find((item) => item.title === "共享前置任务");
        return tool("claim_task", { taskId: task.taskId, expectedVersion: task.version });
      }
      return { answer: "SCOUT_CLAIMED" };
    }
    if (taskText.includes("TAO_BOARD_PREREQ")) return { answer: "BOARD_PREREQ_DONE" };
    return { answer: taskText.includes("TAO_BOARD_FIX") ? "BOARD_DEP_REPAIRED" : "BOARD_DEP_NEEDS_FIX" };
  }
  const created = results.filter((result) => result.taskId && !result.agentId && result.version === 1);
  if (!calls.some((call) => call.name === "create_task" && !Object.hasOwn(call.input, "dependsOn"))) return tool("create_task", { taskName: "不得创建的漏参任务", description: "TAO_BOARD_MISSING_DEPS", requestKey: "missing-deps" });
  if (!created.length) return tool("create_task", { taskName: "共享前置任务", description: "TAO_BOARD_PREREQ", dependsOn: [], requestKey: "create-pre" });
  const pre = created[0];
  if (created.length < 2) return tool("create_task", { taskName: "依赖与重试任务", description: "TAO_BOARD_DEP", dependsOn: [pre.taskId], requestKey: "create-dep" });
  const dependent = created[1];
  if (!calls.some((call) => call.name === "spawn_agent")) return tool("spawn_agent", { profileId: "worker-a", taskName: "任务板领取者", description: "TAO_BOARD_SCOUT" });
  const status = results.filter((result) => result.members && result.tasks).at(-1);
  const preState = status?.tasks.find((entry) => entry.task.id === pre.taskId);
  const acceptedPre = results.some((result) => result.task?.id === pre.taskId && result.task.state === "accepted");
  const wait = () => tool("wait_agent", { mode: "any", timeoutMs: 5000, afterSequence: status?.sequence ?? 0 });
  if (!acceptedPre) {
    if (preState?.task.state === "submitted") return tool("review_agent_task", { taskId: pre.taskId, decision: "accepted", expectedVersion: preState.task.version, attemptId: preState.attempt.id });
    return wait();
  }
  if (!calls.some((call) => call.name === "assign_task")) {
    const listing = results.filter((result) => result.tasks && !result.members).at(-1);
    const task = listing?.tasks.find((item) => item.taskId === dependent.taskId);
    if (task?.state !== "pending") return tool("list_tasks");
    return tool("assign_task", { taskId: task.taskId, expectedVersion: task.version, profileId: "worker-b", requestKey: "assign-dep" });
  }
  const depState = status?.tasks.find((entry) => entry.task.id === dependent.taskId);
  const rejected = results.find((result) => result.task?.id === dependent.taskId && result.task.state === "rejected");
  if (!rejected) {
    if (depState?.task.state === "submitted") return tool("review_agent_task", { taskId: dependent.taskId, decision: "rejected", expectedVersion: depState.task.version, attemptId: depState.attempt.id });
    return wait();
  }
  if (calls.filter((call) => call.name === "retry_agent_task").length < 2) return tool("retry_agent_task", { taskId: dependent.taskId, expectedVersion: rejected.task.version, profileId: "worker-a", reason: "TAO_BOARD_FIX 已核查未发生外部写入，修正交付", acknowledgeSideEffects: true, requestKey: "retry-dep" });
  if (!results.some((result) => result.task?.id === dependent.taskId && result.task.state === "accepted")) {
    if (depState?.task.state === "submitted" && depState.attempt.generation === 2) return tool("review_agent_task", { taskId: dependent.taskId, decision: "accepted", expectedVersion: depState.task.version, attemptId: depState.attempt.id });
    return wait();
  }
  return { answer: "共享任务认领、依赖验收与重试已完成。" };
}
