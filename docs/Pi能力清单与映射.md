# Pi 能力清单与 Tao 映射

本文档记录 Tao 当前 vendored Pi 版本已经确认的能力、源码证据、Tao 接入方式和风险。新增功能前先更新本表，再决定是否开发。

# 2026-09-08 当前接入约束

| 能力 | 当前做法 | 不做的事 |
|---|---|---|
| 工具运行 | Pi 决定是否调用其默认已启用工具；Runtime 仅订阅事件 | Tao 不按 prompt 判断工具意图，不注入、allowlist 或动态切换工具 |
| 工作区 | 每个 Conversation 的 `workspacePath` 在创建其 AgentSession 时传为 Pi `cwd` | `.tao` 不作为工作区，也不是文件访问沙箱 |
| 工具状态 | 仅转为一条当前动作，例如“正在读取目录 src” | 不把原始参数、文件正文、stdout 或完整结果给 React，也不堆叠工具日志 |
| 超时重试 | `SettingsManager.inMemory()` 覆盖 Pi provider 请求保护，Pi 自己自动重试 | Tao 不实现第二套重试 loop |
| 多会话 | 单个 Node Runtime 托管多个独立 `AgentSession`，按 conversationId/requestId 路由 | 不用 `switch_session` 串行化会话 |

模型服务在工具调用前无首包、超时或返回上游错误时，Pi 不会产生工具事件；这应被归类为模型服务故障，而不是工作区权限或 UI 事件问题。

## 一、Session 与会话树

| Pi 能力 | 原生接口/事件 | Tao 计划 | 当前状态 |
|---|---|---|---|
| 创建 Session | `SessionManager.create`、RPC `new_session` | Tao 新建会话调用 Runtime | 已确认，未直接接入 RPC |
| 恢复 Session | `SessionManager.open`、启动参数 `--session` | Tao 用 `.tao/sessions/<id>.jsonl` | 已接入，单宿主内每会话独立 AgentSession |
| 同进程切换 Session | RPC `switch_session`、`AgentSessionRuntime.switchSession` | 空闲会话复用 Runtime；切换会重建 AgentSession | 已确认，后续接入 |
| Session 分支 | RPC `fork`、`get_fork_messages` | 会话树和分支 UI | 已确认，后续接入 |
| Session 树 | RPC `get_tree`、`get_entries` | 右侧/独立会话树 | 已确认，后续接入 |
| Session 命名 | RPC `set_session_name` | Tao 标题和 Pi 名称同步 | 已确认，后续接入 |
| 删除 Session | Session 文件管理 | Tao 删除会话及对应文件 | Tao 已有删除，后续改为 Pi 事实源 |

### `switch_session` 的重要限制

Pi 支持同一 RPC 进程切换 Session，但切换不是轻量指针替换：它会中止当前运行、持久化并销毁旧 `AgentSession`，打开目标 `SessionManager`，重新创建 runtime，再重新绑定扩展。

因此：

- 单进程切换适合顺序使用多个会话。
- 切换正在生成的会话会先中止当前轮次。
- 一个 RPC 进程不能同时生成多个 Session。
- Tao 当前由一个 Node Runtime 同时托管多个独立 `AgentSessionRuntime` 以保证并发；产品切换不调用 `switch_session`。

## 二、Agent loop 与生成控制

| Pi 能力 | 原生接口/事件 | Tao 映射 | 当前状态 |
|---|---|---|---|
| 普通提示 | RPC `prompt` | `send_message` | 已接入 |
| 中止 | RPC `abort` | `abort_generation` | 已接入 |
| 生成中调整 | RPC `steer` | `queue_message(steer)` | 已接入 |
| 回答后继续 | RPC `follow_up` | `queue_message(follow_up)` | 已接入 |
| 队列状态 | `queue_update` | Tao queue event | 已接入 |
| 流式思考/正文 | `message_update` | Tao message event | 已接入 |
| 轮次生命周期 | `turn_start`、`turn_end` | Tao turn event | 部分接入 |
| Agent 生命周期 | `agent_start`、`agent_end`、`agent_settled` | Tao runtime/turn event | 部分接入 |
| 重试 | RPC `abort_retry`、Pi retry logic | 右侧重试按钮 | 后续接入 |

## 三、上下文与记忆

| Pi 能力 | 原生接口/事件 | Tao 计划 | 当前状态 |
|---|---|---|---|
| Session 上下文 | `SessionManager.buildSessionContext` | Pi 作为事实源 | 已接入间接使用 |
| 自动压缩 | `AgentSession` compaction | 右侧显示上下文和压缩状态 | Pi 已有，UI 未接入 |
| 压缩钩子 | `session_before_compact` 等 Extension 事件 | Prompt/Context 工作台策略 | 已确认，后续接入 |
| 分支摘要 | branch summary | 会话树和上下文检查器 | 已确认，后续接入 |
| Context 使用量 | Session stats/context usage | 右侧上下文面板 | 部分有 RPC，UI 未接入 |
| Prompt Template | Resource loader、prompt templates | 工作台管理模板 | 当前启动参数禁用，后续开启 |
| Context Files | Resource loader、context files | 用户级/项目级上下文 | 当前启动参数禁用，后续开启 |

## 四、Extension 与运行时装配

| Pi 能力 | 原生机制 | Tao 产品入口 | 当前状态 |
|---|---|---|---|
| 输入拦截 | `input`、`before_agent_start` | 输入策略设计器 | 已确认，后续接入 |
| Agent 启动修改 | `before_agent_start` | 系统提示词/上下文策略 | 已确认，后续接入 |
| Session 生命周期 | `session_start`、`session_before_switch`、`session_shutdown` | 会话策略 | 已确认，后续接入 |
| Message 拦截 | `message_start`、`message_update`、`message_end` | 消息策略/事件时间线 | 已确认，部分已转换 |
| 自定义消息 | `sendCustomMessage`、custom message event | 运行信息和扩展消息 | 已确认，后续接入 |
| 自定义命令 | Extension command registration | Tao 命令面板 | 已确认，后续接入 |
| Extension 状态 | extension status/events | 右侧 Runtime 状态 | 已确认，后续接入 |
| UI 替换/扩展 | Extension UI bindings | Tao 原生 UI 适配层 | 后续接入，需定义边界 |

当前 Tao 使用 `--no-extensions`、`--no-skills`、`--no-prompt-templates` 和 `--no-context-files`，因此上述能力已经存在但尚未在产品运行时启用。

## 五、Provider、Model 与思考模式

| Pi 能力 | 原生接口/配置 | Tao 映射 | 当前状态 |
|---|---|---|---|
| Provider 模型目录 | `packages/ai/src/providers/data/*.json` | 模型设置和列表 | 已接入 |
| 自定义 Provider | `.tao/models.json` | Base URL 和协议设置 | 已接入 |
| 认证 | `.tao/auth.json` | 全局 API key 设置 | 已接入 |
| 切换模型 | RPC `set_model`、`cycle_model` | 模型选择器 | 已确认，当前重启进程 |
| 思考级别 | RPC `set_thinking_level`、`cycle_thinking_level` | 思考模式选择器 | 已确认，默认值已落盘 |
| 可用模型查询 | RPC `get_available_models` | 动态模型列表 | 已确认，后续替换静态扫描 |
| 可用思考级别 | RPC `get_available_thinking_levels` | 按模型展示可用级别 | 已确认，后续接入 |
| Provider 请求改写 | Extension/Provider runtime hooks | Provider 策略工作台 | 已确认，后续接入 |

## 六、工具、权限与桌面能力

| Pi 能力 | 原生机制 | Tao 计划 | 当前状态 |
|---|---|---|---|
| 工具注册 | Extension `registerTool` | 工具市场/配置 | 当前禁用 |
| 工具调用事件 | `tool_execution_start/update/end` | 聊天区单条当前状态 | 已接入（已归约，不展示原始事件） |
| 工具结果拦截 | `tool_call`、工具结果事件 | 后续权限边界设计（不改变 Pi loop） | 已确认，后续接入 |
| Bash/终端 | Pi 默认 bash tool/events | 聊天区“正在执行命令”当前状态 | 已接入状态归约；不显示 stdout 或终端面板 |
| 文件变更 | Pi 工具执行后的受控摘要来源 | 右侧文件变更摘要、diff 摘要和验证状态 | 后续接入；不传工具原始结果 |
| 权限确认 | Pi 基础能力 + Tao policy | Tao 权限中心 | 必须由 Tao 设计 |
| 沙盒 | Pi 外部运行环境能力有限 | Tao 工作区/沙盒 | 必须单独设计 |

## 七、Tao Runtime 接入原则

1. React 只接收 Tao Runtime 事件，不直接解析 Pi 原始事件。
2. Rust Runtime 负责 Pi RPC、Session、进程和扩展生命周期。
3. Pi 已有能力优先通过 RPC/SDK/Extension 接入，不重复实现。
4. Pi 没有完整产品语义的能力，由 Tao Runtime 转换为稳定事件和状态。
5. 任何打开 Extension、Skill、Prompt Template 或工具的改动，都必须先补权限、错误隔离和配置迁移设计。
6. 本文档记录的“已确认”只表示源码中存在，不表示 Tao 已经完成 UI 接入。
# 当前 Runtime 映射状态

基础对话事件已经收敛为 `tao-runtime-event` v1：`runtime/status`、`message/thinking_delta`、`message/text_delta`、`turn/started|aborted|completed`、`tool/started|updated|ended`、`context/compaction_started|compaction_ended`、`retry/started|ended`、`queue/updated|error`、`error/runtime`、`metric/ready|first_output|completed`。工具事件只归约为聊天区一条当前状态；旧的前端直连 `pi-stream`、`pi-timing` 方式不再作为产品接口。

Prompt/Context 首版已确认复用 Pi CLI 的 `--system-prompt` 与 `--append-system-prompt`。Tao 仅负责保存和映射配置，不修改 Pi 内核；后续再评估 prompt template、context files、Extension hooks 的界面化接入。
