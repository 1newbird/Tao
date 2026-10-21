import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { latestPromptRun, newerRun, runBlocksSubmission } from "./prompt-run-state";
import type { PromptRun, PromptRunUpdate, PromptStartReceipt } from "./prompt-run-state";

type RunConversation = { id: string; promptRuns?: PromptRun[] };
type Submission = { command: string; request: { requestId: string; conversationId: string } & Record<string, unknown> };

export function usePromptRuns<T extends RunConversation>(enabled: boolean, onUpdate: (update: PromptRunUpdate<T>) => void, onRejection: (conversationId: string, error: string, requestId: string) => void) {
  const [runs, setRuns] = useState<Record<string, PromptRun>>({});
  const [uncertain, setUncertain] = useState<Record<string, boolean>>({});
  const [statusError, setStatusError] = useState("");
  const cursor = useRef<Record<string, PromptRun>>({});
  const delivered = useRef(new Set<string>());
  const submissions = useRef(new Map<string, Submission>());
  const callbacks = useRef({ onUpdate, onRejection });
  callbacks.current = { onUpdate, onRejection };

  const receive = useCallback(async (update: PromptRunUpdate<T>) => {
    let candidate = update;
    if (submissions.current.get(candidate.run.conversationId)?.request.requestId === candidate.run.requestId) {
      submissions.current.delete(candidate.run.conversationId);
      setUncertain((values) => ({ ...values, [candidate.run.conversationId]: false }));
    }
    const currentConversationRun = candidate.conversation && latestPromptRun(candidate.conversation);
    if (currentConversationRun && currentConversationRun.sequence > candidate.run.sequence) candidate = { ...candidate, run: currentConversationRun };
    let key = `${candidate.run.requestId}:${candidate.run.version}`;
    const current = cursor.current[candidate.run.conversationId];
    const sameVersion = current?.requestId === candidate.run.requestId && current.version === candidate.run.version;
    if (!newerRun(current, candidate.run) && !(sameVersion && candidate.conversation && !delivered.current.has(key))) return;
    // Preserve streamed output until the authoritative saved conversation is
    // available. A missed terminal event is recovered by the same read API.
    if (!candidate.conversation && (!runBlocksSubmission(candidate.run) || current?.requestId !== candidate.run.requestId)) {
      const saved = await invoke<PromptRunUpdate<T> | null>("get_prompt_run", { conversationId: candidate.run.conversationId, requestId: candidate.run.requestId });
      if (!saved?.conversation) return;
      candidate = saved;
      const savedLatest = latestPromptRun(saved.conversation);
      if (savedLatest && savedLatest.sequence > candidate.run.sequence) candidate = { ...candidate, run: savedLatest };
      key = `${candidate.run.requestId}:${candidate.run.version}`;
      const latest = cursor.current[candidate.run.conversationId];
      if (!newerRun(latest, candidate.run) && !(latest?.requestId === candidate.run.requestId && latest.version === candidate.run.version && !delivered.current.has(key))) return;
    }
    cursor.current[candidate.run.conversationId] = candidate.run;
    if (candidate.conversation) delivered.current.add(key);
    const pending = submissions.current.get(candidate.run.conversationId);
    if (pending?.request.requestId === candidate.run.requestId) {
      submissions.current.delete(candidate.run.conversationId);
      setUncertain((values) => ({ ...values, [candidate.run.conversationId]: false }));
    }
    setRuns((values) => ({ ...values, [candidate.run.conversationId]: candidate.run }));
    callbacks.current.onUpdate(candidate);
  }, []);

  const hydrate = useCallback((conversations: T[]) => {
    for (const conversation of conversations) {
      const run = latestPromptRun(conversation);
      if (!run) continue;
      if (runBlocksSubmission(run)) callbacks.current.onUpdate({ run, conversation, confirmed: false });
      else void receive({ run, conversation });
    }
  }, [receive]);

  const reconcile = useCallback(async () => {
    const snapshots = await invoke<PromptRun[]>("list_prompt_runs");
    await Promise.all(snapshots.filter((run) => newerRun(cursor.current[run.conversationId], run))
      .map((run) => receive({ run })));
  }, [receive]);

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    let polling = false;
    const poll = () => {
      if (disposed || polling || document.hidden) return;
      polling = true;
      void reconcile().then(() => { if (!disposed) setStatusError(""); }).catch((error) => {
        if (!disposed) setStatusError(`暂时无法核对后台任务状态：${String(error)}。已有任务不会自动重试。`);
      })
        .finally(() => { polling = false; });
    };
    void listen<PromptRunUpdate<T>>("tao-prompt-run", ({ payload }) => {
      if (!disposed) void receive(payload).catch(() => {});
    }).then((stop) => { if (disposed) stop(); else { unlisten = stop; poll(); } }).catch(() => { poll(); });
    const timer = window.setInterval(poll, 2000);
    window.addEventListener("focus", poll);
    document.addEventListener("visibilitychange", poll);
    return () => { disposed = true; unlisten?.(); clearInterval(timer); window.removeEventListener("focus", poll); document.removeEventListener("visibilitychange", poll); };
  }, [enabled, receive, reconcile]);

  const submit = useCallback(async (submission: Submission) => {
    const conversationId = submission.request.conversationId;
    submissions.current.set(conversationId, submission);
    // If the bridge loses its reply, retry only the identical admission token.
    // The backend has already persisted that identity before executing anything.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const receipt = await invoke<PromptStartReceipt<T>>(submission.command, { request: submission.request });
        if (receipt.update) { await receive(receipt.update); return; }
        submissions.current.delete(conversationId);
        setUncertain((values) => ({ ...values, [conversationId]: false }));
        callbacks.current.onRejection(conversationId, receipt.error ?? "请求没有被接收", submission.request.requestId);
        void reconcile().catch(() => {});
        return;
      } catch {
        if (!submissions.current.has(conversationId)) return; // An event already confirmed admission.
      }
    }
    setUncertain((values) => ({ ...values, [conversationId]: true }));
    void reconcile().catch(() => {});
  }, [receive, reconcile]);

  const confirmSubmission = useCallback(async (conversationId: string) => {
    const pending = submissions.current.get(conversationId);
    if (pending) await submit(pending);
    else await reconcile();
  }, [submit, reconcile]);

  const cancel = useCallback(async (conversationId: string, requestId: string) => {
    const update = await invoke<PromptRunUpdate<T>>("cancel_prompt_run", { conversationId, requestId });
    await receive(update);
  }, [receive]);

  const retrySave = useCallback(async (conversationId: string, requestId: string) => {
    const update = await invoke<PromptRunUpdate<T>>("retry_save_prompt_run", { conversationId, requestId });
    await receive(update);
  }, [receive]);

  return { runs, uncertain, statusError, hydrate, submit, confirmSubmission, cancel, retrySave };
}
