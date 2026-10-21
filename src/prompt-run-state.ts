export type PromptRunState = "starting" | "running" | "cancelling" | "save_failed" | "completed" | "stopped" | "failed" | "interrupted";

export interface PromptRun {
  requestId: string;
  conversationId: string;
  sequence: number;
  version: number;
  state: PromptRunState;
  startedAt: number;
  updatedAt: number;
  finishedAt: number | null;
  error: string | null;
}

export interface PromptRunUpdate<T> { run: PromptRun; conversation?: T; confirmed?: boolean }
export interface PromptStartReceipt<T> { update: PromptRunUpdate<T> | null; error: string | null }

export function latestPromptRun(conversation: { promptRuns?: PromptRun[] }): PromptRun | undefined {
  const runs = conversation.promptRuns;
  return runs?.[runs.length - 1];
}

export function runBlocksSubmission(run: PromptRun): boolean {
  return ["starting", "running", "cancelling", "save_failed"].includes(run.state);
}

export function newerRun(current: PromptRun | undefined, incoming: PromptRun): boolean {
  if (!current) return true;
  if (incoming.sequence !== current.sequence) return incoming.sequence > current.sequence;
  return incoming.requestId === current.requestId && incoming.version > current.version;
}

export function runStatus(run: PromptRun): string {
  return ({ starting: "请求已接收，正在连接后台…", running: "任务执行中", cancelling: "正在停止…", save_failed: "执行已结束，结果待保存",
    completed: "已完成", stopped: "已停止", failed: "执行失败", interrupted: "执行已中断" })[run.state];
}
