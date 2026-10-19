import "./collaboration.css";

interface CollaborationTrace { id: string; title: string; metadata?: Record<string, unknown> }
const labels: Record<string, string> = { pending: "待认领", blocked: "等待依赖验收", queued: "排队", preparing: "准备中", running: "执行中", waiting_permission: "待确认", cancelling: "停止中", submitted: "已提交", accepted: "已验收", rejected: "未通过", cancelled: "已取消", failed: "失败", interrupted: "已中断" };

export function CollaborationBoard({ traces }: { traces: CollaborationTrace[] }) {
  const tasks = new Map<string, CollaborationTrace>();
  const messages = new Map<string, string>();
  for (const trace of traces) {
    if (typeof trace.metadata?.taskId === "string" && typeof trace.metadata.taskState === "string") tasks.set(trace.metadata.taskId, trace);
    if (typeof trace.metadata?.messageId === "string" && typeof trace.metadata.delivery === "string") messages.set(trace.metadata.messageId, trace.metadata.delivery);
  }
  if (!tasks.size) return null;
  const finished = [...tasks.values()].filter((trace) => ["submitted", "accepted", "rejected", "cancelled", "failed", "interrupted"].includes(String(trace.metadata?.taskState))).length;
  return <section className="collaboration-board" aria-label="协作任务">
    <header><strong>协作任务</strong><span>{finished} / {tasks.size} 执行结束</span></header>
    <ul>{[...tasks.values()].map((trace) => {
      const state = String(trace.metadata?.taskState);
      const name = trace.title.replace(/^子任务\s*·\s*/, "");
      const generation = Number(trace.metadata?.generation ?? 0);
      const dependencies = Number(trace.metadata?.dependencyCount ?? 0);
      return <li key={trace.id}><div className="collaboration-task-name"><strong title={name}>{name}</strong><small>{String(trace.metadata?.profileName ?? "子代理")}{generation > 0 ? ` · 第 ${generation} 次执行` : ""}{dependencies > 0 ? ` · ${dependencies} 项依赖` : ""}{trace.metadata?.taskVersion ? ` · v${trace.metadata.taskVersion}` : ""}</small></div><span className={`collaboration-task-state ${state}`}>{labels[state] ?? state}</span></li>;
    })}</ul>
    {messages.size > 0 && <footer>{messages.size} 条协作消息 · {[...messages.values()].filter((state) => state === "delivered").length} 条已投递{[...messages.values()].some((state) => state === "queued") ? " · 有待投递消息" : ""}{[...messages.values()].some((state) => state === "undelivered") ? " · 有未投递消息" : ""}</footer>}
  </section>;
}
