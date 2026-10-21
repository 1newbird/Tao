// UI-only admission/terminal protocol fixtures. No disk, Runtime or model calls.
import { runBlocksSubmission } from "../src/prompt-run-state";
import type { PromptRun, PromptRunUpdate } from "../src/prompt-run-state";

type PreviewConversation = { id: string; messages: any[]; promptRuns?: PromptRun[]; updatedAt?: number };
type LegacyResult = { result: Promise<unknown>; finish: () => void };
type Job<T> = { run: PromptRun; conversation: T; payload: string; finish: () => void; timer?: number; finished: boolean; lostReceipt: boolean; pendingMessages?: any[] };

export function previewRuns<T extends PreviewConversation>(options: {
  conversations: T[];
  execute: (request: any) => LegacyResult;
  emit: (update: PromptRunUpdate<T>) => void;
}) {
  const mode = new URLSearchParams(location.search).get("case") ?? "";
  const jobs = new Map<string, Job<T>>();
  let unavailableUntil = 0;
  const latest = (conversation: T) => conversation.promptRuns?.[conversation.promptRuns.length - 1];
  const update = (job: Job<T>) => structuredClone({ run: job.run, conversation: job.conversation });
  const publish = (job: Job<T>, includeConversation = false) => {
    if (Date.now() < unavailableUntil) return;
    options.emit(structuredClone({ run: job.run, ...(includeConversation ? { conversation: job.conversation } : {}) }));
  };

  function finalize(job: Job<T>, stopped: boolean, legacyFinished = false) {
    if (job.finished) return;
    job.finished = true;
    clearTimeout(job.timer);
    if (!legacyFinished) job.finish();
    queueMicrotask(() => {
      const message = job.conversation.messages[job.conversation.messages.length - 1];
      if (stopped && message?.role === "assistant") { message.content = "生成已停止，可以继续提问。"; message.status = "stopped"; }
      job.run.version++;
      job.run.updatedAt = job.run.finishedAt = Date.now();
      job.run.state = stopped ? "stopped" : "completed";
      if (mode === "save-failed" && !stopped) {
        job.pendingMessages = job.conversation.messages.splice(job.conversation.messages.length - 1);
        job.run.state = "save_failed";
        job.run.error = "执行已结束，但结果保存失败（模拟）。请重试保存，不要重新执行任务。";
      }
      if (mode !== "missed-completion") publish(job, true);
      if (mode === "late-completion" && stopped) {
        const old = update(job);
        window.setTimeout(() => options.emit(old), 2500);
      }
    });
  }

  function admit(command: string, request: any) {
    const payload = JSON.stringify({ command, request });
    const previous = jobs.get(request.requestId);
    if (previous) return previous.payload === payload ? { update: update(previous), error: null } : { update: null, error: "请求 ID 已用于不同内容" };
    const conversation = options.conversations.find((item) => item.id === request.conversationId);
    if (!conversation) return { update: null, error: "会话不存在" };
    if (latest(conversation) && runBlocksSubmission(latest(conversation)!)) return { update: null, error: "当前会话仍有任务或未保存结果" };
    if (command === "retry_message") {
      const index = conversation.messages.findIndex((message) => message.id === request.errorMessageId);
      if (index < 0) return { update: null, error: "失败消息不存在" };
      conversation.messages.splice(index, 1);
    } else {
      conversation.messages.push({ id: crypto.randomUUID(), role: "user", content: request.text, createdAt: Date.now() });
    }
    const now = Date.now();
    const run: PromptRun = { requestId: request.requestId, conversationId: conversation.id, sequence: (latest(conversation)?.sequence ?? 0) + 1,
      version: 1, state: "starting", startedAt: now, updatedAt: now, finishedAt: null, error: null };
    (conversation.promptRuns ??= []).push(run);
    // Clone the receipt now; the fast case deliberately delivers it last.
    const receipt = structuredClone({ update: { run, conversation }, error: null });
    const execution = options.execute(request);
    const job: Job<T> = { run, conversation, payload, finish: execution.finish, finished: false, lostReceipt: false };
    jobs.set(run.requestId, job);
    void execution.result.then(() => finalize(job, false, true));
    run.state = "running";
    run.version++;
    publish(job);
    if (mode === "fast") finalize(job, false);
    else job.timer = window.setTimeout(() => finalize(job, false), new URLSearchParams(location.search).get("scenario") === "scroll" ? 65000 : mode === "cancel" || mode === "late-completion" ? 30000 : mode === "restore" ? 8000 : 1600);
    return receipt;
  }

  async function handle(command: string, args: any): Promise<unknown> {
    if (command === "send_message" || command === "retry_message") {
      if (mode === "rejected") return { update: null, error: "模拟：请求未被接收，输入已保留。" };
      if (mode === "uncertain" && !jobs.size) unavailableUntil = Date.now() + 6000;
      const receipt = admit(command, args.request);
      const job = jobs.get(args.request.requestId);
      if (mode === "uncertain" && Date.now() < unavailableUntil) throw new Error("模拟：暂时无法确认提交");
      if (mode === "lost-receipt" && job && !job.lostReceipt) { job.lostReceipt = true; throw new Error("模拟：启动回执丢失"); }
      if (mode === "fast") await new Promise((resolve) => setTimeout(resolve, 80));
      return receipt;
    }
    if (command === "list_prompt_runs" || command === "get_prompt_run") {
      if (Date.now() < unavailableUntil) throw new Error("模拟：状态暂不可查询");
    }
    if (command === "list_prompt_runs") return structuredClone(options.conversations.map(latest).filter(Boolean));
    const job = args.requestId ? jobs.get(args.requestId) : [...jobs.values()].filter((job) => job.run.conversationId === args.conversationId).slice(-1)[0];
    if (command === "get_prompt_run") return job && job.run.conversationId === args.conversationId ? update(job) : null;
    if (!job || job.run.conversationId !== args.conversationId) throw new Error("运行不属于当前会话");
    if (command === "cancel_prompt_run") { finalize(job, true); await Promise.resolve(); return update(job); }
    if (command === "retry_save_prompt_run") {
      if (!job.pendingMessages) throw new Error("没有待保存结果");
      job.conversation.messages.push(...job.pendingMessages);
      job.pendingMessages = undefined;
      job.run.state = "completed";
      job.run.version++;
      job.run.error = null;
      publish(job, true);
      return update(job);
    }
    throw new Error(`未知模拟运行操作：${command}`);
  }

  if (mode === "restore" && options.conversations[0]) {
    admit("send_message", { requestId: "restored-request", conversationId: options.conversations[0].id, text: "继续整理这份资料。" });
  }
  return { handle };
}
