import type { CSSProperties } from "react";
export type AccentColor = "tao" | "developer" | "ocean" | "amber" | "graphite";
export const ACCENT_OPTIONS: Array<{ id: AccentColor; label: string; color: string; strong: string; soft: string; line: string }> = [
  { id: "tao", label: "Tao", color: "#5d7861", strong: "#45614a", soft: "#edf3ed", line: "#b9cbbb" },
  { id: "developer", label: "开发者绿", color: "#2f8057", strong: "#216844", soft: "#eaf5ee", line: "#a9d1b9" },
  { id: "ocean", label: "蓝青", color: "#4b7897", strong: "#345d79", soft: "#edf4f8", line: "#b6cfdf" },
  { id: "amber", label: "琥珀", color: "#a8752d", strong: "#81571e", soft: "#fff5e5", line: "#e1c797" },
  { id: "graphite", label: "石墨", color: "#555b63", strong: "#3d434b", soft: "#eef0f2", line: "#c2c7cc" },
];
export function accentStyle(accentColor: string, theme: "light" | "dark"): CSSProperties {
  const preset = ACCENT_OPTIONS.find((option) => option.id === accentColor) ?? ACCENT_OPTIONS[0];
  return {
    "--tao-accent": preset.color,
    "--tao-accent-strong": theme === "dark" ? preset.color : preset.strong,
    "--tao-accent-soft": theme === "dark" ? `color-mix(in srgb, ${preset.color} 18%, #181b19)` : preset.soft,
    "--tao-accent-line": theme === "dark" ? `color-mix(in srgb, ${preset.color} 62%, #353a36)` : preset.line,
  } as CSSProperties;
}
