import { defaultCompaction } from "./agent-profiles";
import type { CompactionConfiguration } from "./agent-profiles";

export function CompactionSettings({ value, onChange }: { value?: CompactionConfiguration; onChange: (value: CompactionConfiguration) => void }) {
  const policy = { ...defaultCompaction(), ...value };
  const update = (patch: Partial<CompactionConfiguration>) => onChange({ ...policy, ...patch });
  return <div className="workspace-section form-section">
    <div className="workspace-heading"><span className="eyebrow">Context</span><h2>上下文压缩策略</h2><p>压缩为较早的对话生成摘要，保留近期内容继续执行。主会话和每个成员分别维护上下文与压缩记录。</p></div>
    <section className="profile-form-group"><h3>触发与保留</h3>
      <label className="setting-field"><span>压缩方式</span><select value={policy.mode} onChange={(event) => update({ mode: event.currentTarget.value as CompactionConfiguration["mode"] })}><option value="inherit">沿用 Runtime 默认策略</option><option value="automatic">自定义自动压缩</option><option value="disabled">关闭自动压缩</option></select><small>沿用模式保留当前 Runtime 设置。关闭后，上下文过长可能导致模型请求失败，不会自动删除历史。</small></label>
      {policy.mode === "automatic" && <>
        <div className="two-column-settings"><label className="setting-field"><span>预留 token 数</span><input type="number" min={256} max={131072} step={256} value={policy.reserveTokens} onChange={(event) => update({ reserveTokens: Number(event.currentTarget.value) })} /><small>预计用量接近“模型上下文窗口 − 预留量”时尝试压缩。</small></label>
          <label className="setting-field"><span>保留近期 token 数</span><input type="number" min={512} max={131072} step={256} value={policy.keepRecentTokens} onChange={(event) => update({ keepRecentTokens: Number(event.currentTarget.value) })} /><small>按完整消息边界保留，实际用量可能不同；两项之和须小于模型上下文窗口。</small></label></div>
        <label className="setting-field"><span>摘要补充要求</span><textarea rows={6} maxLength={16000} value={policy.instructions} onChange={(event) => update({ instructions: event.currentTarget.value })} placeholder="例如：保留任务目标、证据来源、已确认决定、当前文件改动与未完成任务，不将计划写成完成。" /><small>平台会要求保留目标、决定、证据与待办；补充要求不会修改工具授权。</small></label>
      </>}
    </section>
    <p className="delegation-hint">压缩会调用当前模型并产生用量。工作过程显示真实的整理开始、结束或失败，底层会话保留摘要记录；首次上下文页记录的是初始输入，不是压缩后的逐轮追踪。团队总预算和独立摘要查看页尚未开放。</p>
  </div>;
}
