# Agent 运行观察与 Pi 接入设计

# 2026-09-08 实现校准

本文以当前实现为准：

- Tao 只托管会话、路由请求、归约 Pi 事件、持久化与关闭 Runtime；不会依据用户消息选择、启用或停用工具，也不重写 Pi 的 Agent loop、重试或上下文管理。
- Runtime 创建 `AgentSession` 时不传 `tools`、`noTools` 或 `excludeTools`。Pi 根据自身 `SettingsManager` 和内置默认值决定可用工具；Tao 不注入工具列表，也不会因消息内容改变工具集合。
- 工作区与 `%USERPROFILE%\.tao` 分离：前者是 Pi 工具相对路径的基准，后者仅存放 Tao 配置、认证和 Session。每个 Conversation 持有独立 `workspacePath`，创建或重建该会话的 AgentSession 时作为 Pi `cwd` 传入。
- Pi 的原生工具事件仅在 Runtime 内取用必要的工具名和目标路径，转换成产品级当前状态与可折叠执行摘要，例如“正在读取 xxx”“已读取 xxx”“正在根据读取结果整理回答”“正在执行命令”。状态会随事件更新，不形成工具日志列表；文件正文、命令输出、`event.args`、`event.result`、`partialResult` 和原始工具 JSON 不会越过 Node → Rust → React 边界。
- 当模型服务在首个 token 或工具选择之前超时、过载或断开时，不会产生 `tool_execution_start`；界面应显示模型连接/重试/失败状态，而不能把这种失败误判为工具没有工作。

## 目标

第一阶段先完成一个可观察的 Agent vertical slice：用户提问后，Tao 能显示 Pi 当前处于连接模型、思考、读取文件、执行命令、修改、重试、完成或停止中的哪一步。聊天区保留一条当前状态，并提供一块可折叠的执行摘要，不展示工具原始输入、输出或事件日志。每个会话可以选择自己的工作区；未选择时才使用 Runtime fallback cwd。`.tao` 仅用于 Tao 配置、认证和会话持久化。

## 分工原则

- Pi 继续负责 Agent loop、Session、模型调用、队列、上下文压缩和工具执行。
- Tao Runtime 负责托管多个 Pi AgentSession、关联 conversation/request、事件安全归约和进程生命周期。
- React 只消费 Tao Runtime 转发的事件，不重新实现 Pi loop。
- 事件保留 Pi 原生事件名，但只输出 Tao 允许的产品级文本；Tao 另外增加 `conversationId`、`requestId`、版本和耗时等传输元数据。

## 第一阶段事件

优先转发 Pi 原生的 `agent_start`、`agent_end`、`agent_settled`、`turn_start`、`turn_end`、`message_start`、`message_update`、`message_end`、`tool_execution_start`、`tool_execution_update`、`tool_execution_end`、`queue_update`、`compaction_start`、`compaction_end` 和重试事件。

主聊天区将这些事件压缩成用户可读的一条当前步骤。原始事件仅在 Runtime 内部用于状态归约和性能诊断；右侧检查器显示 Runtime、Session、工作区和耗时，不作为工具日志面板。

## 工具策略

Tao 不向 `AgentSession` 传递 `tools`、`noTools` 或 `excludeTools`，Pi 使用其自身默认工具配置并由 Agent loop 与模型自行决定是否调用。Tao 不做消息意图判断、工具选择或动态工具开关。当前版本尚未实现面向用户的写入/命令执行授权体验；工具事件只能产生产品级当前状态，不能把文件内容、命令 stdout、原始参数或完整工具结果推到 React。工具结果只在 Runtime 内部作为下一轮模型上下文使用。

## 验收标准

1. 提问后主区立即出现当前执行步骤，流式思考和正文不受影响。
2. 工具启用后，工具调用不会拖慢流式 UI，也不会在默认界面展示参数、输出或完整结果。
3. 两个会话可同时运行，事件不会串到错误会话。
4. 停止、steer、follow-up 和异常仍能正确结束当前运行状态。
5. 不修改 Pi 核心源码；若后续确需补丁，必须是连接层所需的最小改动。
