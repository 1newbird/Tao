import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import * as Menu from "@radix-ui/react-dropdown-menu";
import type { AgentProfile } from "./agent-profiles";

export function AgentIcon({ className = "" }: { className?: string }) {
  return <svg className={className} aria-hidden="true" viewBox="0 0 20 20"><rect x="4" y="5" width="12" height="11" rx="3" /><path d="M10 2.5V5M7.5 9h.01M12.5 9h.01M7.5 12.5h5M2 9v3M18 9v3" /></svg>;
}

export function ChevronIcon() {
  return <svg className="menu-chevron" aria-hidden="true" viewBox="0 0 20 20"><path d="m6 8 4 4 4-4" /></svg>;
}

export interface ProfileMenuAction {
  label: string;
  description?: string;
  disabled?: boolean;
  danger?: boolean;
  onSelect: () => void;
}

function useMenuSurface(disabled = false) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => { setContainer(trigger.current?.closest<HTMLElement>(".app-shell") ?? null); }, []);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  return { trigger, container, open, setOpen };
}

function MenuActions({ actions }: { actions: ProfileMenuAction[] }) {
  return actions.map((action) => (
    <Menu.Item key={action.label} className={`tao-menu-item ${action.danger ? "danger" : ""}`} disabled={action.disabled} onSelect={action.onSelect}>
      <span className="tao-menu-copy"><span>{action.label}</span>{action.description && <small>{action.description}</small>}</span>
    </Menu.Item>
  ));
}

export function ProfileActionMenu({ label, children, actions, disabled = false }: { label: string; children: ReactNode; actions: ProfileMenuAction[]; disabled?: boolean }) {
  const surface = useMenuSurface(disabled);
  return (
    <Menu.Root modal={false} open={surface.open} onOpenChange={surface.setOpen}>
      <Menu.Trigger asChild><button ref={surface.trigger} className="profile-more-button" type="button" aria-label={label} title={label} disabled={disabled}>{children}</button></Menu.Trigger>
      <Menu.Portal container={surface.container}>
        <Menu.Content className="tao-menu profile-action-menu" align="end" sideOffset={8} collisionPadding={12} aria-label={label} onEscapeKeyDown={(event) => event.stopPropagation()}>
          <MenuActions actions={actions} />
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}

export function ConversationProfileMenu({ profiles, value, name, revision, defaultProfileId, projectProfileId, disabled, actions, onSelect }: {
  profiles: AgentProfile[];
  value: string;
  name: string;
  revision: number;
  defaultProfileId: string;
  projectProfileId?: string;
  disabled: boolean;
  actions: ProfileMenuAction[];
  onSelect: (id: string) => void;
}) {
  const surface = useMenuSurface(disabled);
  const available = profiles.some((profile) => profile.id === value);
  return (
    <Menu.Root modal={false} open={surface.open} onOpenChange={surface.setOpen}>
      <Menu.Trigger asChild>
        <button ref={surface.trigger} className="conversation-profile-trigger" type="button" disabled={disabled} aria-label={`当前会话智能体组合：${name}`} title={disabled ? "会话运行或准备完成后可切换组合" : `选择智能体组合 · 当前版本 v${revision}`}>
          <AgentIcon /><span>{name}</span><ChevronIcon />
        </button>
      </Menu.Trigger>
      <Menu.Portal container={surface.container}>
        <Menu.Content className="tao-menu conversation-profile-menu" align="end" sideOffset={8} collisionPadding={12} aria-label="选择会话组合" onEscapeKeyDown={(event) => event.stopPropagation()}>
          <Menu.Label className="tao-menu-heading">会话组合 <span>当前 v{revision}</span></Menu.Label>
          <Menu.RadioGroup value={value} onValueChange={(id) => { if (id !== value) onSelect(id); }} className="profile-menu-options">
            {!available && <Menu.RadioItem className="tao-menu-item profile-menu-option" value={value} disabled><AgentIcon /><span className="tao-menu-copy"><strong>{name}</strong><small>使用保留的配置快照</small></span><span className="profile-choice-check">✓</span></Menu.RadioItem>}
            {profiles.map((profile) => (
              <Menu.RadioItem key={profile.id} value={profile.id} textValue={profile.name} className="tao-menu-item profile-menu-option">
                <AgentIcon />
                <span className="tao-menu-copy"><strong>{profile.name}</strong><small>{profile.description || (profile.configuration.toolMode === "custom" ? `${profile.configuration.enabledTools.length + profile.customToolIds.length} 个工具` : "默认工具组合")}</small></span>
                {profile.id === (projectProfileId ?? defaultProfileId) && <span className="profile-menu-badge">{projectProfileId ? "项目默认" : "默认"}</span>}
                <Menu.ItemIndicator className="profile-choice-check">✓</Menu.ItemIndicator>
              </Menu.RadioItem>
            ))}
          </Menu.RadioGroup>
          {actions.length > 0 && <><Menu.Separator className="tao-menu-separator" /><MenuActions actions={actions} /></>}
          <Menu.Label className="tao-menu-footnote">切换组合会保留已有对话上下文</Menu.Label>
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}
