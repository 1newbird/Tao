# 多智能体通信与任务板

主代理可将独立任务交给获准组合；未选择组合时使用默认成员，继承当前组合能力并受父子权限交集约束。成员使用独立历史，仅接收委派内容与明确提供的信息。当前仅一层委派，共享工作区；不递归派生，不保证文件隔离。

- spawn_agent 返回成员/任务 ID；followup_task 复用成员历史并新建任务。单成员串行执行。
- list_agents 查名册；send_message 定向发消息，read_agent_messages 查自己的邮箱。消息不唤醒空闲成员，delivered 不等于已处理，不授予权限。
- create_task 显式填写 dependsOn，无依赖填 []。前置结果 accepted 后才解除阻塞，submitted 不算通过。
- list_tasks 查状态与版本；成员 claim_task 预领后续任务后应结束当前任务，让调度器运行，不能等待自己。
- 主代理 assign_task 分配，检查候选证据后 review_agent_task 验收；使用实际 taskId、version、attemptId，不猜测或复用旧代次。
- wait_agent 超时不取消任务；返回消息不表示任务结束。避免成员相互等待，及时回答问题、验收前置任务。
- cancel_task 只取消一项；cancel_agent 停止成员。retry_agent_task 保留旧尝试，不回滚已发生操作；先核实副作用并说明原因。

主请求结束或停止会回收未完成成员；跨轮常驻、递归团队、分布式执行尚未实现。历史查看和独立窗口不创建执行者，关闭查看窗口不停止任务。并发、任务数、模型轮次和时限受当前预算约束，不应通过重试绕过。
