import { defaultDelegation } from "./agent-profiles";
import type { AgentCatalog, DelegationConfiguration } from "./agent-profiles";

export function DelegationSettings({ value, catalog, onChange, onHelp }: {
  value?: DelegationConfiguration;
  catalog: AgentCatalog;
  onChange: (next: DelegationConfiguration) => void;
  onHelp?: () => void;
}) {
  const options = { ...defaultDelegation(), ...value };
  return <section className="profile-form-group delegation-settings">
    <h3>子代理协作</h3>
    {onHelp && <button type="button" className="guide-link" onClick={onHelp}>了解派发、查看和人工介入 →</button>}
    <label className="toggle-row"><span><strong>允许委派子任务</strong><small>新组合默认开启；成员使用独立上下文，可按需关闭。</small></span><input type="checkbox" checked={options.enabled} onChange={(event) => onChange({ ...options, enabled: event.currentTarget.checked })} /></label>
    <p className="delegation-hint">协作工具由 Tao 自动加载，不需要在“工具与权限”逐项勾选。此开关控制是否允许委派；下列组合限制可派发的成员范围。</p>
    {options.enabled && <>
      <fieldset className="delegation-profiles"><legend>指定成员组合（可选）</legend>{catalog.profiles.map((profile) => <label key={profile.id}><input type="checkbox" checked={options.allowedProfileIds.includes(profile.id)} onChange={(event) => onChange({ ...options, allowedProfileIds: event.currentTarget.checked ? [...options.allowedProfileIds, profile.id] : options.allowedProfileIds.filter((id) => id !== profile.id) })} /><span>{profile.name || "未命名组合"}</span></label>)}</fieldset>
      {options.allowedProfileIds.length === 0 && <p role="status">使用默认成员，继承当前组合的提示词、工具和权限，并受父子权限交集约束。选择组合后仅允许派发到所选组合。</p>}
      <div className="two-column-settings">
        {([
          ["maxConcurrent", "同时执行的子任务", 1, 4],
          ["maxTasks", "每轮子任务总数", 1, 32],
          ["maxTurns", "每个子任务模型轮次", 1, 100],
        ] as const).map(([key, label, min, max]) => <label className="setting-field" key={key}><span>{label}</span><input type="number" min={min} max={max} step={1} value={options[key]} onChange={(event) => onChange({ ...options, [key]: Number(event.currentTarget.value) })} /></label>)}
        <label className="setting-field"><span>每个子任务最长时间（秒）</span><input type="number" min={1} max={1200} step={1} value={options.timeoutMs / 1000} onChange={(event) => onChange({ ...options, timeoutMs: Number(event.currentTarget.value) * 1000 })} /></label>
      </div>
      <p className="delegation-hint">成员可定向交流、从共享任务板预领一项后续任务；依赖验收后才能执行。主智能体可接续、取消或重新分配任务，每项最多三次尝试。工具权限取父子组合交集，共用当前工作区；仅一层委派，主会话结束或停止时回收全部子任务。</p>
    </>}
  </section>;
}
