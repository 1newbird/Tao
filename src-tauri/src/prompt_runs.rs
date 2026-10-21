use crate::models::{Conversation, Message, PromptRun, PromptRunState, PromptRunUpdate, RetryMessageRequest, SendMessageRequest};
use crate::{pi, runtime::TaoRuntimeManager, storage};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Clone)]
struct Outcome {
    messages: Vec<Message>,
    state: PromptRunState,
    error: Option<String>,
}

#[derive(Default)]
struct RunIndex {
    initialized: bool,
    closing: bool,
    runs: HashMap<String, PromptRun>,
    // Retain the already computed result until its atomic disk commit succeeds.
    pending_results: HashMap<String, Outcome>,
}

impl RunIndex {
    fn record_outcome(&mut self, request_id: &str, outcome: Outcome) -> bool {
        if self.pending_results.contains_key(request_id)
            || !self.runs.get(request_id).is_some_and(|run| run.state.blocks_submission()) {
            return false;
        }
        self.pending_results.insert(request_id.into(), outcome);
        true
    }
    fn latest(&self, conversation_id: &str) -> Option<PromptRun> {
        self.runs.values().filter(|run| run.conversation_id == conversation_id)
            .max_by_key(|run| run.sequence).cloned()
    }

    fn admit(&self, conversation_id: &str, request_id: &str, fingerprint: &str) -> Result<Option<PromptRun>, String> {
        if self.closing { return Err("Tao 正在退出，不再接收任务".into()); }
        if let Some(run) = self.runs.get(request_id) {
            if run.conversation_id != conversation_id || run.fingerprint != fingerprint {
                return Err("请求 ID 已用于不同内容，不能重新执行".into());
            }
            return Ok(Some(run.clone()));
        }
        if self.latest(conversation_id).is_some_and(|run| run.state.blocks_submission()) {
            return Err("当前会话仍有任务或未保存结果，请先停止任务或重试保存".into());
        }
        Ok(None)
    }
}

#[derive(Default)]
pub struct PromptRunManager {
    index: Mutex<RunIndex>,
}

fn fingerprint(kind: &str, request: &impl Serialize) -> Result<String, String> {
    let bytes = serde_json::to_vec(&(kind, request)).map_err(|error| error.to_string())?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

fn update_run(conversation: &mut Conversation, run: &PromptRun) -> Result<(), String> {
    let target = conversation.prompt_runs.iter_mut().find(|value| value.request_id == run.request_id)
        .ok_or("运行记录已不存在，未写入迟到结果")?;
    *target = run.clone();
    Ok(())
}

fn recover_conversation(conversation: &mut Conversation) -> bool {
    let mut errors = Vec::new();
    for run in &mut conversation.prompt_runs {
        if !run.state.blocks_submission() { continue; }
        let message = "上次运行因应用退出或后台断开而中断。已有文件或外部操作不会回滚，请先核对结果；Tao 未自动重放任务。".to_string();
        errors.push(pi::error_message(message.clone(), run.retry_configuration.take()));
        run.state = PromptRunState::Interrupted;
        run.version += 1;
        run.updated_at = storage::now_millis();
        run.finished_at = Some(run.updated_at);
        run.error = Some(message);
    }
    if errors.is_empty() { return false; }
    conversation.messages.extend(errors);
    conversation.updated_at = storage::now_millis();
    true
}

impl PromptRunManager {
    pub fn initialize(&self, app: &AppHandle) -> Result<(), String> {
        let _transaction = storage::conversation_guard()?;
        let mut index = self.index.lock().map_err(|_| "运行记录不可用")?;
        if index.initialized { return Ok(()); }
        index.runs.clear();
        for mut conversation in storage::load_conversations(app)? {
            if recover_conversation(&mut conversation) { storage::write_conversation(app, &conversation)?; }
            for run in conversation.prompt_runs { index.runs.insert(run.request_id.clone(), run); }
        }
        index.initialized = true;
        Ok(())
    }

    pub fn start_message(&self, app: &AppHandle, request: SendMessageRequest) -> Result<PromptRunUpdate, String> {
        let key = fingerprint("send", &request)?;
        let conversation_id = request.conversation_id.clone();
        let request_id = request.request_id.clone();
        self.start(app, &conversation_id, &request_id, key, || pi::prepare_message(app, request))
    }

    pub fn start_retry(&self, app: &AppHandle, request: RetryMessageRequest) -> Result<PromptRunUpdate, String> {
        let key = fingerprint("retry", &request)?;
        let conversation_id = request.conversation_id.clone();
        let request_id = request.request_id.clone();
        self.start(app, &conversation_id, &request_id, key, || pi::prepare_retry(app, request))
    }

    fn start(&self, app: &AppHandle, conversation_id: &str, request_id: &str, key: String,
        prepare: impl FnOnce() -> Result<pi::PreparedPrompt, String>) -> Result<PromptRunUpdate, String> {
        if request_id.is_empty() || request_id.len() > 128 { return Err("请求 ID 长度无效".into()); }
        self.initialize(app)?;
        let transaction = storage::conversation_guard()?;
        let mut index = self.index.lock().map_err(|_| "运行记录不可用")?;
        if let Some(run) = index.admit(conversation_id, request_id, &key)? {
            return Ok(PromptRunUpdate { run, conversation: storage::load_conversation_unlocked(app, conversation_id)? });
        }
        let mut prepared = prepare()?;
        let now = storage::now_millis();
        let run = PromptRun {
            request_id: request_id.into(), conversation_id: conversation_id.into(), fingerprint: key,
            sequence: prepared.conversation.prompt_runs.last().map_or(0, |run| run.sequence)
                .max(index.latest(conversation_id).map_or(0, |run| run.sequence)) + 1, version: 1,
            state: PromptRunState::Starting, started_at: now, updated_at: now, finished_at: None, error: None,
            retry_configuration: Some(prepared.retry),
        };
        prepared.conversation.prompt_runs.push(run.clone());
        // Admission and the user's message are a single durable commit, before
        // any Runtime or model operation can begin.
        storage::write_conversation(app, &prepared.conversation)?;
        index.runs.insert(request_id.into(), run.clone());
        drop(index);
        drop(transaction);
        let update = PromptRunUpdate { run, conversation: Some(prepared.conversation) };
        emit(app, &update);
        let worker_app = app.clone();
        let worker_id = request_id.to_string();
        std::thread::spawn(move || {
            let manager = worker_app.state::<TaoRuntimeManager>();
            let dispatcher = manager.prepare_dispatch(&worker_app);
            worker_app.state::<Self>().dispatch(&worker_app, &worker_id, prepared.command, dispatcher);
        });
        Ok(update)
    }

    fn dispatch(&self, app: &AppHandle, request_id: &str, command: Value,
        dispatcher: Result<crate::runtime::RuntimeDispatch, String>) {
        let result = (|| -> Result<(), String> {
            let dispatcher = dispatcher?;
            let _transaction = storage::conversation_guard()?;
            let mut index = self.index.lock().map_err(|_| "运行记录不可用")?;
            if index.closing { return Err("Tao 正在退出，任务未继续派发".into()); }
            let Some(mut run) = index.runs.get(request_id).cloned() else { return Ok(()); };
            // Cancellation before dispatch cannot be undone by a late ready.
            if run.state != PromptRunState::Starting { return Ok(()); }
            run.state = PromptRunState::Running;
            run.version += 1;
            run.updated_at = storage::now_millis();
            let mut conversation = storage::load_conversation_unlocked(app, &run.conversation_id)?.ok_or("会话已不存在")?;
            update_run(&mut conversation, &run)?;
            storage::write_conversation(app, &conversation)?;
            index.runs.insert(request_id.into(), run.clone());
            emit(app, &PromptRunUpdate { run, conversation: None });
            let callback_app = app.clone();
            let callback_id = request_id.to_string();
            // Registration and sending are serialized with cancellation. Ready
            // waiting happened outside both locks; no long turn is awaited.
            dispatcher.send(command, Box::new(move |result| {
                callback_app.state::<Self>().complete(&callback_app, &callback_id, result);
            }))
        })();
        if let Err(error) = result { self.complete(app, request_id, Err(error)); }
    }

    fn complete(&self, app: &AppHandle, request_id: &str, response: Result<Value, String>) {
        let result = (|| -> Result<PromptRunUpdate, String> {
            let _transaction = storage::conversation_guard()?;
            let mut index = self.index.lock().map_err(|_| "运行记录不可用")?;
            let run = index.runs.get(request_id).cloned().ok_or("运行记录不存在")?;
            if !run.state.blocks_submission() || index.pending_results.contains_key(request_id) {
                return Ok(PromptRunUpdate { run, conversation: None });
            }
            let result = response.and_then(|value| pi::parse_prompt_messages(&value));
            let outcome = match result {
                Ok(messages) => {
                    let stopped = messages.iter().any(|message| message.status.as_deref() == Some("stopped"));
                    Outcome { messages, state: if stopped { PromptRunState::Stopped } else { PromptRunState::Completed }, error: None }
                }
                Err(error) => {
                    let disconnected = error.contains("Tao Runtime 输出通道") || error.contains("Tao Runtime 已关闭")
                        || !app.state::<TaoRuntimeManager>().status().is_ok_and(|status| status.ready);
                    let detail = if disconnected { format!("后台连接已中断：{error}。已有操作不会回滚，请核对后再决定是否重试。") } else { error };
                    Outcome { messages: vec![pi::error_message(detail.clone(), run.retry_configuration.clone())],
                        state: if disconnected { PromptRunState::Interrupted } else { PromptRunState::Failed }, error: Some(detail) }
                }
            };
            index.record_outcome(request_id, outcome);
            Ok(self.persist_result(app, &mut index, request_id))
        })();
        match result {
            Ok(update) => emit(app, &update),
            Err(error) => eprintln!("Tao 运行结果归档失败：{error}"),
        }
    }

    fn persist_result(&self, app: &AppHandle, index: &mut RunIndex, request_id: &str) -> PromptRunUpdate {
        commit_result(index, request_id,
            |conversation_id| storage::load_conversation_unlocked(app, conversation_id)?.ok_or("会话已不存在，未重建已删除会话".into()),
            |conversation| storage::write_conversation(app, conversation))
    }

    pub fn retry_save(&self, app: &AppHandle, conversation_id: &str, request_id: &str) -> Result<PromptRunUpdate, String> {
        self.initialize(app)?;
        let _transaction = storage::conversation_guard()?;
        let mut index = self.index.lock().map_err(|_| "运行记录不可用")?;
        let run = index.runs.get(request_id).ok_or("运行记录不存在")?;
        if run.conversation_id != conversation_id { return Err("运行不属于当前会话".into()); }
        if !run.state.blocks_submission() {
            return Ok(PromptRunUpdate { run: run.clone(), conversation: storage::load_conversation_unlocked(app, conversation_id)? });
        }
        if run.state != PromptRunState::SaveFailed || !index.pending_results.contains_key(request_id) {
            return Err("当前没有待重试保存的结果".into());
        }
        let update = self.persist_result(app, &mut index, request_id);
        emit(app, &update);
        Ok(update)
    }

    pub fn list(&self, app: &AppHandle) -> Result<Vec<PromptRun>, String> {
        self.initialize(app)?;
        let index = self.index.lock().map_err(|_| "运行记录不可用")?;
        let mut latest: HashMap<&str, &PromptRun> = HashMap::new();
        for run in index.runs.values() {
            if latest.get(run.conversation_id.as_str()).is_none_or(|previous| previous.sequence < run.sequence) {
                latest.insert(&run.conversation_id, run);
            }
        }
        Ok(latest.values().map(|run| { let mut visible = (*run).clone(); visible.retry_configuration = None; visible }).collect())
    }

    pub fn get(&self, app: &AppHandle, conversation_id: &str, request_id: Option<&str>) -> Result<Option<PromptRunUpdate>, String> {
        self.initialize(app)?;
        let _transaction = storage::conversation_guard()?;
        let index = self.index.lock().map_err(|_| "运行记录不可用")?;
        let run = match request_id { Some(id) => index.runs.get(id).cloned(), None => index.latest(conversation_id) };
        let Some(run) = run else { return Ok(None); };
        if run.conversation_id != conversation_id { return Err("运行不属于当前会话".into()); }
        Ok(Some(PromptRunUpdate { run, conversation: storage::load_conversation_unlocked(app, conversation_id)? }))
    }

    pub fn cancel(&self, app: &AppHandle, conversation_id: &str, request_id: &str) -> Result<PromptRunUpdate, String> {
        self.initialize(app)?;
        let transaction = storage::conversation_guard()?;
        let mut index = self.index.lock().map_err(|_| "运行记录不可用")?;
        let mut run = index.runs.get(request_id).cloned().ok_or("找不到要停止的运行")?;
        if run.conversation_id != conversation_id { return Err("运行不属于当前会话".into()); }
        if run.state == PromptRunState::SaveFailed { return Err("执行已结束，请重试保存结果".into()); }
        if !run.state.blocks_submission() { return Ok(PromptRunUpdate { run, conversation: None }); }
        if run.state == PromptRunState::Starting {
            // Reserve cancellation before releasing either lock. Otherwise a
            // late ready could dispatch between this check and completion.
            run.state = PromptRunState::Cancelling;
            run.version += 1;
            index.runs.insert(request_id.into(), run);
            let message = json!({ "messages": [{ "role": "assistant", "content": "生成已停止，可以继续提问。", "status": "stopped" }] });
            drop(index); drop(transaction);
            self.complete(app, request_id, Ok(message));
            return self.get(app, conversation_id, Some(request_id))?.ok_or("运行记录不存在".into());
        }
        run.state = PromptRunState::Cancelling;
        run.version += 1;
        run.updated_at = storage::now_millis();
        run.error = None;
        // Cancellation must still run when disk persistence is unavailable.
        if let Ok(Some(mut conversation)) = storage::load_conversation_unlocked(app, conversation_id) {
            if update_run(&mut conversation, &run).and_then(|_| storage::write_conversation(app, &conversation)).is_err() {
                run.error = Some("停止已请求，但停止状态暂未保存".into());
            }
        }
        index.runs.insert(request_id.into(), run.clone());
        drop(index); drop(transaction);
        let update = PromptRunUpdate { run, conversation: None };
        emit(app, &update);
        let cancel_app = app.clone();
        let id = request_id.to_string();
        let conversation = conversation_id.to_string();
        std::thread::spawn(move || {
            let result = cancel_app.state::<TaoRuntimeManager>().request(&cancel_app,
                json!({ "type": "cancel_active", "conversationId": conversation, "requestId": id }), std::time::Duration::from_secs(15));
            if let Err(error) = result {
                cancel_app.state::<Self>().cancel_warning(&cancel_app, &id, error);
            } else {
                std::thread::sleep(std::time::Duration::from_secs(5));
                cancel_app.state::<Self>().cancel_warning(&cancel_app, &id, "仍未收到原任务的结束记录，可重试停止或在 Runtime 设置中重启后台".into());
            }
        });
        Ok(update)
    }

    fn cancel_warning(&self, app: &AppHandle, request_id: &str, error: String) {
        if let Ok(mut index) = self.index.lock() {
            if let Some(run) = index.runs.get_mut(request_id) {
                if run.state != PromptRunState::Cancelling { return; }
                run.version += 1;
                run.error = Some(format!("停止尚未确认：{error}。请核对状态或重试停止；不要重复执行任务。"));
                emit(app, &PromptRunUpdate { run: run.clone(), conversation: None });
            }
        }
    }

    pub fn begin_shutdown(&self) {
        if let Ok(mut index) = self.index.lock() { index.closing = true; }
    }

    pub fn finish_shutdown(&self, app: &AppHandle) {
        // Give already delivered replies time to commit. Any unfinished record
        // remains durable and is recovered as interrupted on the next launch.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        loop {
            let active = self.index.lock().is_ok_and(|index| index.runs.values().any(|run|
                matches!(run.state, PromptRunState::Starting | PromptRunState::Running | PromptRunState::Cancelling)));
            if !active || std::time::Instant::now() >= deadline { break; }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
        let unsaved = self.index.lock().map(|index| index.pending_results.keys().filter_map(|id| index.runs.get(id).cloned()).collect::<Vec<_>>()).unwrap_or_default();
        for run in unsaved { let _ = self.retry_save(app, &run.conversation_id, &run.request_id); }
    }
}

fn emit(app: &AppHandle, update: &PromptRunUpdate) {
    let _ = app.emit("tao-prompt-run", update);
}

fn commit_result(index: &mut RunIndex, request_id: &str,
    load: impl FnOnce(&str) -> Result<Conversation, String>,
    save: impl FnOnce(&Conversation) -> Result<(), String>) -> PromptRunUpdate {
    let mut run = index.runs[request_id].clone();
    let outcome = index.pending_results[request_id].clone();
    run.version += 1;
    run.updated_at = storage::now_millis();
    run.finished_at.get_or_insert(run.updated_at);
    run.state = outcome.state;
    run.error = outcome.error;
    run.retry_configuration = None;
    let saved = (|| -> Result<Conversation, String> {
        let mut conversation = load(&run.conversation_id)?;
        update_run(&mut conversation, &run)?;
        conversation.messages.extend(outcome.messages);
        conversation.updated_at = run.updated_at;
        save(&conversation)?;
        Ok(conversation)
    })();
    let conversation = match saved {
        Ok(conversation) => { index.pending_results.remove(request_id); Some(conversation) }
        Err(error) => {
            run.state = PromptRunState::SaveFailed;
            run.error = Some(format!("执行已结束，但结果保存失败：{error}。请重试保存，不要重新执行任务；未保存结果仅保留在本次应用运行中。"));
            None
        }
    };
    index.runs.insert(request_id.into(), run.clone());
    PromptRunUpdate { run, conversation }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn run(state: PromptRunState) -> PromptRun {
        PromptRun { request_id: "request-a".into(), conversation_id: "chat-a".into(), fingerprint: "same".into(),
            sequence: 1, version: 2, state, started_at: 1, updated_at: 1, finished_at: None, error: None, retry_configuration: None }
    }

    fn fixture() -> (RunIndex, Conversation) {
        let record = run(PromptRunState::Running);
        let mut conversation = storage::new_conversation("mock", "mock", "off");
        conversation.id = record.conversation_id.clone();
        conversation.prompt_runs.push(record.clone());
        let mut index = RunIndex::default();
        index.runs.insert(record.request_id.clone(), record);
        (index, conversation)
    }

    fn outcome() -> Outcome {
        let mut answer = pi::error_message("核对结果：720".into(), None);
        answer.role = "assistant".into();
        Outcome { messages: vec![answer], state: PromptRunState::Completed, error: None }
    }

    #[test]
    fn duplicate_token_survives_serialization_and_different_payload_is_rejected() {
        let record = run(PromptRunState::Completed);
        let restored: PromptRun = serde_json::from_str(&serde_json::to_string(&record).unwrap()).unwrap();
        let mut index = RunIndex::default();
        index.runs.insert(restored.request_id.clone(), restored);
        assert_eq!(index.admit("chat-a", "request-a", "same").unwrap().unwrap().state, PromptRunState::Completed);
        assert!(index.admit("chat-a", "request-a", "changed").is_err());
        assert!(index.admit("chat-b", "request-a", "same").is_err());
        assert!(index.admit("chat-a", "request-b", "new").unwrap().is_none());
    }

    #[test]
    fn running_and_unsaved_results_block_only_their_own_conversation() {
        for state in [PromptRunState::Starting, PromptRunState::Running, PromptRunState::Cancelling, PromptRunState::SaveFailed] {
            let mut index = RunIndex::default();
            index.runs.insert("request-a".into(), run(state));
            assert!(index.admit("chat-a", "request-b", "next").is_err());
            assert!(index.admit("chat-b", "request-b", "next").unwrap().is_none());
            assert!(index.admit("chat-a", "request-a", "same").unwrap().is_some());
        }
    }

    #[test]
    fn late_failure_cannot_replace_an_already_computed_success() {
        let (mut index, _) = fixture();
        let success = outcome();
        let expected = success.messages[0].id.clone();
        assert!(index.record_outcome("request-a", success));
        let mut late = outcome(); late.state = PromptRunState::Interrupted;
        assert!(!index.record_outcome("request-a", late));
        assert_eq!(index.pending_results["request-a"].messages[0].id, expected);
    }

    #[test]
    fn disk_failure_retains_result_and_retry_commits_it_once_without_execution() {
        let temp = std::env::temp_dir();
        let root = temp.join(storage::new_id("prompt-run-test"));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("conversation.json");
        let blocked = root.join("blocked-target");
        fs::create_dir(&blocked).unwrap();
        let (mut index, mut conversation) = fixture();
        conversation.title = "运行期间重命名".into();
        conversation.pinned = true;
        storage::write_json(&path, &conversation, "测试会话").unwrap();
        let result = outcome();
        let message_id = result.messages[0].id.clone();
        index.record_outcome("request-a", result);
        let load = |_: &str| serde_json::from_slice::<Conversation>(&fs::read(&path).unwrap()).map_err(|error| error.to_string());
        let failed = commit_result(&mut index, "request-a", load, |conversation| storage::write_json(&blocked, conversation, "测试会话"));
        assert_eq!(failed.run.state, PromptRunState::SaveFailed);
        assert!(index.pending_results.contains_key("request-a"));
        assert!(load("chat-a").unwrap().messages.is_empty());
        let saved = commit_result(&mut index, "request-a", load, |conversation| storage::write_json(&path, conversation, "测试会话"));
        assert_eq!(saved.run.state, PromptRunState::Completed);
        let restored = load("chat-a").unwrap();
        assert_eq!(restored.title, "运行期间重命名");
        assert!(restored.pinned);
        assert_eq!(restored.messages.len(), 1);
        assert_eq!(restored.messages[0].id, message_id);
        assert_eq!(restored.prompt_runs[0].state, PromptRunState::Completed);
        assert!(!index.pending_results.contains_key("request-a"));
        assert!(!index.record_outcome("request-a", outcome()));
        // Remove only the unique test directory explicitly created above.
        assert_eq!(root.parent(), Some(temp.as_path()));
        assert!(root.file_name().unwrap().to_string_lossy().starts_with("prompt-run-test-"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn restart_marks_active_record_interrupted_once_without_replaying_it() {
        let (_, mut conversation) = fixture();
        assert!(recover_conversation(&mut conversation));
        assert_eq!(conversation.prompt_runs[0].state, PromptRunState::Interrupted);
        assert_eq!(conversation.messages.len(), 1);
        assert_eq!(conversation.messages[0].role, "error");
        assert!(!recover_conversation(&mut conversation));
        assert_eq!(conversation.messages.len(), 1);
    }

    #[test]
    fn missing_record_does_not_recreate_a_deleted_run() {
        let (mut index, mut conversation) = fixture();
        conversation.prompt_runs.clear();
        index.record_outcome("request-a", outcome());
        let update = commit_result(&mut index, "request-a", |_| Ok(conversation), |_| panic!("must not persist a missing run"));
        assert_eq!(update.run.state, PromptRunState::SaveFailed);
    }
}
