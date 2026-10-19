import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { MarkdownContent } from "./MarkdownContent";
import { useFollowScroll } from "./useFollowScroll";
import type { ScrollPosition } from "./useFollowScroll";
import { deliveryState, teamState } from "./collaboration-types";
import type { TeamRun, TeamView } from "./collaboration-types";
import "./collaboration.css";
import { accentStyle } from "./appearance";

interface Props { conversationId: string; pinnedRunId?: string; pinnedAgentId?: string; returnToMainToken?: number; navigationTarget?: HTMLElement | null }
interface DraftTarget { taskId: string; attemptId: string | null; expectedVersion: number }
interface MemberDraft { mode: string; body: string; taskName: string; target: DraftTarget | null }
const time = (value?: number) => value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "—";

export function CollaborationWorkspace({ conversationId, pinnedRunId, pinnedAgentId, returnToMainToken, navigationTarget }: Props) {
  const [runs, setRuns] = useState<TeamRun[]>([]);
  const [runId, setRunId] = useState(pinnedRunId ?? "");
  const [agentId, setAgentId] = useState(pinnedAgentId ?? "");
  const [navigationOpen, setNavigationOpen] = useState(true);
  const [snapshot, setSnapshot] = useState<{ key: string; view: TeamView } | null>(null);
  const [error, setError] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [eventLimit, setEventLimit] = useState(100);
  const [refresh, setRefresh] = useState(0);
  const selectedRun = useRef(pinnedRunId ?? "");
  const followLatest = useRef(true);
  const scrollMemory = useRef(new Map<string, ScrollPosition>());
  const drafts = useRef(new Map<string, MemberDraft>());
  const key = `${conversationId}:${runId}:${agentId}`;
  const view = snapshot?.key === key ? snapshot.view : null;
  const summary = snapshot?.view.runId === runId ? snapshot.view : null;

  useEffect(() => { if (!pinnedAgentId) setAgentId(""); }, [returnToMainToken, pinnedAgentId]);
  useEffect(() => {
    if (pinnedRunId || !conversationId) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const result = await invoke<{ runs: TeamRun[]; warnings: string[] }>("get_collaboration", { conversationId });
        if (disposed) return;
        setRuns(result.runs); setWarnings(result.warnings);
        const nextRun = followLatest.current || !result.runs.some((run) => run.runId === selectedRun.current) ? result.runs[0]?.runId ?? "" : selectedRun.current;
        if (nextRun !== selectedRun.current) { selectedRun.current = nextRun; setRunId(nextRun); setAgentId(""); }
      } catch (reason) { if (!disposed) setError(String(reason)); }
      if (!disposed) timer = setTimeout(load, 3000);
    };
    void load();
    return () => { disposed = true; clearTimeout(timer); };
  }, [conversationId, pinnedRunId]);

  useEffect(() => {
    if (!runId) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const next = await invoke<TeamView>("get_collaboration", { conversationId, runId, agentId: agentId || undefined, eventLimit });
        if (disposed) return;
        setSnapshot({ key, view: next }); setError("");
        timer = setTimeout(load, next.live ? 1200 : 5000);
      } catch (reason) { if (!disposed) { setError(String(reason)); timer = setTimeout(load, 3000); } }
    };
    void load();
    return () => { disposed = true; clearTimeout(timer); };
  }, [conversationId, runId, agentId, key, eventLimit, refresh]);

  function selectMember(id: string) { setAgentId(id); setEventLimit(100); }
  if (!runId && !error && !warnings.length) return null;
  const connectionError = error || warnings.join("；");
  const back = !pinnedAgentId ? () => setAgentId("") : undefined;
  return <>
    {!pinnedAgentId && navigationTarget && createPortal(<section className="collaboration-navigation" aria-label="协作成员">
      <button className="member-navigation-toggle" type="button" aria-expanded={navigationOpen} onClick={() => setNavigationOpen((current) => !current)}>
        <span className="member-navigation-title">协作成员 <small>{summary?.agents.length ?? runs.find((run) => run.runId === runId)?.members ?? 0}</small></span>
        <span className={`member-navigation-chevron ${navigationOpen ? "is-open" : ""}`} aria-hidden="true">›</span>
      </button>
      {navigationOpen && <div className="member-navigation-body">
        {runId && <>
          <label className="member-round-label">协作轮次<select aria-label="协作轮次" value={runId} onChange={(event) => { selectedRun.current = event.target.value; followLatest.current = event.target.value === runs[0]?.runId; setRunId(event.target.value); setAgentId(""); setSnapshot(null); }}>
            {runs.map((run) => <option key={run.runId} value={run.runId}>{time(run.createdAt)} · {run.closed ? "历史" : "本轮"} · {run.members} 成员</option>)}
          </select></label>
          <nav className="member-roster" aria-label="协作成员列表">
            <button className={`member-roster-row ${!agentId ? "selected" : ""}`} type="button" aria-pressed={!agentId} onClick={back}>
              <span className="member-roster-avatar is-root" aria-hidden="true">T</span><span className="member-roster-name">主对话<small>返回本会话</small></span><span className="member-roster-arrow" aria-hidden="true">›</span>
            </button>
            {(summary?.agents ?? []).map((agent) => <button className={`member-roster-row ${agentId === agent.id ? "selected" : ""}`} type="button" key={agent.id} aria-pressed={agentId === agent.id} onClick={() => selectMember(agent.id)}>
              <span className="member-roster-avatar" aria-hidden="true">{agent.name.slice(0, 1)}</span><span className="member-roster-name">{agent.name}<small>{teamState[agent.state] ?? agent.state}{summary?.closed ? " · 历史只读" : ""}</small></span><span className="member-roster-arrow" aria-hidden="true">›</span>
            </button>)}
          </nav>
          {!summary && !error && <p className="member-muted" role="status">正在读取成员列表…</p>}
        </>}
        {connectionError && <p className="member-error" role="status">协作记录暂不可用：{connectionError}</p>}
      </div>}
    </section>, navigationTarget)}
    {agentId && <section className="collaboration-workspace is-open" aria-label="协作成员查看">
      {connectionError && <div className="member-connection-error" role="status">{connectionError}</div>}
      {view ? <MemberDetail key={`${runId}:${agentId}`} view={view} agentId={agentId} stale={Boolean(error)} standalone={Boolean(pinnedAgentId)} onBack={back} onRefresh={() => setRefresh((current) => current + 1)} onEarlier={() => setEventLimit((current) => Math.min(1000, current + 100))} eventLimit={eventLimit} scrollMemory={scrollMemory.current} drafts={drafts.current} /> : <div className="member-loading" role="status">{back && <button type="button" onClick={back}>← 返回主对话</button>}<p>正在读取成员记录…</p></div>}
    </section>}
  </>;
}

function MemberDetail({ view, agentId, stale, standalone, onBack, onRefresh, onEarlier, eventLimit, scrollMemory, drafts }: { view: TeamView; agentId: string; stale: boolean; standalone: boolean; onBack?: () => void; onRefresh: () => void; onEarlier: () => void; eventLimit: number; scrollMemory: Map<string, ScrollPosition>; drafts: Map<string, MemberDraft> }) {
  const draftKey = `${view.runId}:${agentId}`;
  const [section, setSection] = useState("dialogue");
  const [mode, setMode] = useState(drafts.get(draftKey)?.mode ?? "message");
  const [body, setBody] = useState(drafts.get(draftKey)?.body ?? "");
  const [taskName, setTaskName] = useState(drafts.get(draftKey)?.taskName ?? "");
  const [draftTarget, setDraftTarget] = useState<DraftTarget | null>(drafts.get(draftKey)?.target ?? null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [stopAction, setStopAction] = useState("");
  const [copiedKey, setCopiedKey] = useState("");
  const pending = useRef<{ fingerprint: string; key: string } | null>(null);
  const agent = view.agents.find((item) => item.id === agentId);
  const task = view.tasks.find((item) => item.id === agent?.taskId);
  const attempts = view.attempts.filter((item) => item.agentId === agentId);
  const taskIds = new Set(attempts.map((attempt) => attempt.taskId));
  const tasks = view.tasks.filter((item) => taskIds.has(item.id));
  const events = view.events.filter((event) => event.agentId === agentId);
  const messages = view.messages.filter((message) => message.from === agentId || message.to === agentId);
  const active = view.live && !view.closed && !stale && !agent?.retired;
  const canSupplement = active && task && ["queued", "preparing", "running", "waiting_permission"].includes(task.state);
  const scroll = useFollowScroll(`${view.runId}:${agentId}:${section}`, true, scrollMemory);
  const currentTarget = task ? { taskId: task.id, attemptId: task.attemptId, expectedVersion: task.version } : null;
  const draftChanged = Boolean(draftTarget && (draftTarget.taskId !== task?.id || draftTarget.attemptId !== task?.attemptId || draftTarget.expectedVersion !== task?.version));
  useEffect(() => { drafts.set(draftKey, { mode, body, taskName, target: draftTarget }); }, [drafts, draftKey, mode, body, taskName, draftTarget]);
  const copy = useCallback((text: string, key: string) => { void navigator.clipboard.writeText(text).then(() => setCopiedKey(key)).catch(() => setNotice("复制失败，请手动选择文本")); }, []);
  const md = (content: string, id: string) => <MarkdownContent content={content} messageId={id} onCopy={copy} copiedKey={copiedKey} />;
  const name = (id: string) => id === "user" ? "用户" : id === view.rootAgentId ? "主代理" : view.agents.find((item) => item.id === id)?.name ?? "成员";
  async function control(action: string) {
    if (!task || !active || busy) return;
    const target = ["message", "followup"].includes(action) ? draftTarget ?? currentTarget! : currentTarget!;
    const request = { conversationId: view.conversationId, runId: view.runId, agentId, ...target, action, ...(["message", "followup"].includes(action) ? { body: body.trim(), ...(action === "followup" ? { taskName: taskName.trim() } : {}) } : {}) };
    const fingerprint = JSON.stringify(request);
    if (pending.current?.fingerprint !== fingerprint) pending.current = { fingerprint, key: crypto.randomUUID() };
    setBusy(true); setNotice("");
    try {
      await invoke("control_collaboration", { request: { ...request, requestKey: pending.current.key } });
      setNotice(action === "message" ? "说明已入箱；请在协作消息中查看送达状态。" : action === "followup" ? "已追加任务，成员按顺序执行。" : "停止请求已记录，请查看任务状态确认完成。");
      if (["message", "followup"].includes(action)) { setBody(""); setTaskName(""); setDraftTarget(null); }
      pending.current = null; setStopAction("");
    } catch (reason) { setNotice(`${String(reason)}。已保留输入，请刷新核对状态。`); }
    finally { setBusy(false); onRefresh(); }
  }
  if (!agent) return <div className="member-loading">{onBack && <button type="button" onClick={onBack}>← 返回主对话</button>}<p>成员已不可用，请返回主对话选择。</p></div>;
  return <div className="member-detail">
    <header className="member-detail-heading"><div>{onBack && <button className="member-back" type="button" onClick={onBack}>← 返回主对话</button>}<h2>{agent.name}</h2><p>{teamState[agent.state] ?? agent.state} · 组合 v{agent.revision} · {time(view.createdAt)}</p></div><div className="member-heading-actions">
      <button type="button" onClick={onRefresh}>刷新</button>
      <button type="button" onClick={() => void invoke(standalone ? "focus_main_window" : "open_member_window", standalone ? { conversationId: view.conversationId } : { conversationId: view.conversationId, runId: view.runId, agentId }).catch((reason) => setNotice(String(reason)))}>{standalone ? "返回主窗口" : "独立窗口"}</button>
    </div></header>
    <p className="member-ownership" title={`会话 ${view.conversationId}\n轮次 ${view.runId}\n成员 ${agent.id}`}>所属主会话 {view.conversationId.slice(0, 12)} · 本轮 {view.runId.slice(0, 8)} · {view.closed ? `已结束：${view.closeReason || "历史只读"}` : "关闭查看页不会停止任务"}</p>
    <nav className="member-sections" aria-label="成员详情分类">{[["dialogue", "对话"], ["execution", "执行记录"], ["messages", `协作消息 ${messages.length}`], ["tasks", `任务历史 ${tasks.length}`]].map(([id, label]) => <button type="button" className={section === id ? "selected" : ""} key={id} onClick={() => setSection(id)}>{label}</button>)}</nav>
    <div className="member-scroll-container"><div className="member-scroll" role="region" aria-label="成员详情记录" tabIndex={0} ref={scroll.viewportRef} onScroll={scroll.onScroll} onWheelCapture={scroll.onWheelCapture} onPointerDownCapture={scroll.onPointerDownCapture} onKeyDownCapture={scroll.onKeyDownCapture}><div className="member-scroll-content">
      {view.droppedEvents > 0 && <p className="member-muted">早期执行摘要已按容量上限裁剪；任务与尝试结果仍保留。</p>}
      {view.hasEarlierEvents && eventLimit >= 1000 && <p className="member-muted">当前显示最近 1000 条执行摘要；最终结果可在任务历史查看。</p>}
      {view.hasEarlierEvents && eventLimit < 1000 && <button type="button" onClick={onEarlier}>加载更早记录</button>}
      {section === "dialogue" && attempts.map((attempt) => { const item = view.tasks.find((entry) => entry.id === attempt.taskId); const output = events.filter((event) => event.attemptId === attempt.id && event.kind === "assistant"); const dialogue = [...output.map((event) => ({ id: event.id, text: event.text, time: event.createdAt, user: false, status: event.status })), ...messages.filter((message) => message.from === "user" && message.to === agentId && message.targetAttemptId === attempt.id).map((message) => ({ id: message.id, text: message.body, time: message.createdAt, user: true, status: message.delivery }))].sort((a, b) => a.time - b.time); return <section className="member-attempt" key={attempt.id}>
        <h3>{item?.title ?? "任务"} <span>第 {attempt.generation} 次 · {teamState[attempt.state] ?? attempt.state}</span></h3>
        {item?.description && <details className="member-instruction"><summary>任务说明</summary>{md(item.description, `${attempt.id}-instruction`)}</details>}
        {attempt.retryReason && <p className="member-muted">重试说明：{attempt.retryReason}</p>}
        {dialogue.map((event) => <article className={`member-output ${event.user ? "member-user-message" : ""}`} key={event.id}>{event.user && <small className="member-muted">用户补充 · {deliveryState[event.status] ?? event.status}</small>}{md(event.text, event.id)}{event.status === "running" && <span className="member-muted">正在生成…</span>}</article>)}
        {!output.length && attempt.result && md(attempt.result, `${attempt.id}-result`)}
        {!output.length && !attempt.result && !attempt.error && <p className="member-muted">{view.closed ? "该历史尝试没有保存中间输出。" : "等待成员输出…"}</p>}
        {attempt.resultTruncated && <p className="member-muted">结果超过保存上限，已截断。</p>}
        {attempt.error && <p className="member-error">{attempt.error}</p>}
      </section>; })}
      {section === "execution" && <><p className="member-muted">仅展示工具名称和执行状态，原始参数及工具返回内容不进入此视图。</p>{events.filter((event) => event.kind === "tool").map((event) => <article className="member-record" key={event.id}><strong>{event.text}</strong><span>{event.status === "running" ? "执行中" : event.status === "error" ? "失败" : event.status === "stopped" ? "已停止" : "已完成"}</span><small>{time(event.createdAt)} · {view.tasks.find((item) => item.id === event.taskId)?.title}</small></article>)}</>}
      {section === "messages" && <>{!messages.length && <p className="member-muted">暂无协作消息。</p>}{messages.map((message) => <article className={`member-record ${message.from === "user" ? "from-user" : ""}`} key={message.id}><strong>{name(message.from)} → {name(message.to)}</strong><span>{deliveryState[message.delivery] ?? message.delivery}</span><small>{time(message.createdAt)}{message.replyTo ? " · 回复消息" : ""}</small>{md(message.body, message.id)}{message.deliveryReason && <small>{message.deliveryReason}</small>}</article>)}</>}
      {section === "tasks" && tasks.map((item) => <section className="member-attempt" key={item.id}><h3>{item.title}<span>{teamState[item.state] ?? item.state} · v{item.version}</span></h3><p className="member-muted">依赖 {item.dependsOn.length} 项{item.reviewedAt ? ` · 验收时间 ${time(item.reviewedAt)}` : ""}</p>{attempts.filter((attempt) => attempt.taskId === item.id).map((attempt) => <details className="member-instruction" key={attempt.id}><summary>第 {attempt.generation} 次执行 · {teamState[attempt.state] ?? attempt.state}</summary><p>{time(attempt.startedAt)} → {time(attempt.endedAt)}</p>{attempt.retryReason && <p>{attempt.retryReason}</p>}{attempt.result && md(attempt.result, `${attempt.id}-history`)}{attempt.error && <p className="member-error">{attempt.error}</p>}<small>{attempt.modelTurns ?? 0} 个模型轮次</small></details>)}</section>)}
      {!attempts.length && <p className="member-muted">该成员尚无执行尝试。</p>}
    </div></div>{!scroll.following && <button type="button" className="member-latest" onClick={scroll.scrollToLatest}>↓ 回到最新</button>}</div>
    <footer className="member-controls">
      {view.live && agent.state === "waiting_permission" && <p className="member-muted">成员正在等待权限确认，请到主会话处理。</p>}
      {!active && <p className="member-muted">{stale ? "连接暂不可用，控制已暂停。" : "本轮已结束或成员已停止；通过主会话发起新任务。"}</p>}
      {!active && body && <textarea aria-label="未发送草稿" readOnly rows={2} value={body} />}
      {active && <><div className="member-control-row"><select aria-label="成员消息操作" value={mode} onChange={(event) => { setMode(event.target.value); setDraftTarget(currentTarget); }} disabled={busy}><option value="message">补充当前任务</option><option value="followup">追加新任务</option></select><span>{mode === "message" ? "在下一次模型调用前送达，不改变工具权限" : "复用成员历史，按顺序执行"}</span></div>
        {mode === "followup" && <input aria-label="追加任务名称" placeholder="新任务名称" maxLength={120} value={taskName} onChange={(event) => { if (!draftTarget) setDraftTarget(currentTarget); setTaskName(event.target.value); }} disabled={busy} />}
        <textarea aria-label="给成员的说明" placeholder={mode === "message" ? "向该成员补充说明…" : "填写新的任务要求…"} rows={2} maxLength={4000} value={body} onChange={(event) => { if (!draftTarget) setDraftTarget(currentTarget); setBody(event.target.value); }} disabled={busy} />
        {draftChanged && <p className="member-feedback">草稿对应的任务或版本已经变化，尚未发送。<button type="button" disabled={busy} onClick={() => setDraftTarget(currentTarget)}>确认用于当前任务</button></p>}
        <div className="member-control-row"><button className="member-primary" type="button" disabled={busy || draftChanged || !body.trim() || (mode === "message" ? !canSupplement : !taskName.trim())} onClick={() => void control(mode)}>{busy ? "处理中…" : mode === "message" ? "发送说明" : "追加任务"}</button><span className="member-spacer" />
          <select aria-label="停止范围" value={stopAction} disabled={busy} onChange={(event) => setStopAction(event.target.value)}><option value="">停止操作…</option>{canSupplement && <option value="cancel_task">停止当前任务</option>}<option value="cancel_agent">停止成员及排队任务</option><option value="stop_run">停止整轮协作</option></select>
          {stopAction && <button className="member-danger" type="button" disabled={busy} onClick={() => void control(stopAction)}>确认停止</button>}</div>
      </>}
      {notice && <p className="member-feedback" role="status">{notice}</p>}
    </footer>
  </div>;
}

export function MemberWindow() {
  const params = new URLSearchParams(location.search);
  const [appearance, setAppearance] = useState({ theme: "system", accentColor: "tao" });
  const [darkSystem, setDarkSystem] = useState(matchMedia("(prefers-color-scheme: dark)").matches);
  useEffect(() => {
    let disposed = false;
    const load = () => { void invoke<{ theme: string; accentColor: string }>("get_member_appearance").then((result) => { if (!disposed) setAppearance(result); }).catch(() => {}); };
    const media = matchMedia("(prefers-color-scheme: dark)");
    const change = () => setDarkSystem(media.matches);
    load(); window.addEventListener("focus", load); media.addEventListener("change", change);
    return () => { disposed = true; window.removeEventListener("focus", load); media.removeEventListener("change", change); };
  }, []);
  const theme = appearance.theme === "dark" || (appearance.theme === "system" && darkSystem) ? "dark" : "light";
  return <div className={`app-shell member-window-shell theme-${theme}`} style={accentStyle(appearance.accentColor, theme)}><CollaborationWorkspace conversationId={params.get("conversationId") ?? ""} pinnedRunId={params.get("runId") ?? ""} pinnedAgentId={params.get("agentId") ?? ""} /></div>;
}
