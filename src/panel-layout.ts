const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 460;
const RUNTIME_MIN = 360;
const RUNTIME_MAX = 860;
const CHAT_MIN = 420;
const HANDLE = 10;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** Fit both panels around a usable conversation; stored widths remain user preferences. */
export function resolvePanelLayout(input: { width: number; sidebarOpen: boolean; runtimeOpen: boolean; sidebarWidth: number; runtimeWidth: number }) {
  const width = Math.max(0, input.width);
  const sidebarOpen = input.sidebarOpen && width >= SIDEBAR_MIN + CHAT_MIN + HANDLE + (input.runtimeOpen ? RUNTIME_MIN + HANDLE : 0);
  const sidebarMax = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, width - CHAT_MIN - HANDLE - (input.runtimeOpen ? RUNTIME_MIN + HANDLE : 0)));
  const sidebarWidth = sidebarOpen ? clamp(input.sidebarWidth, SIDEBAR_MIN, sidebarMax) : 0;
  const runtimeMax = Math.max(0, Math.min(RUNTIME_MAX, width - sidebarWidth - (sidebarOpen ? HANDLE : 0) - CHAT_MIN - HANDLE));
  const runtimeMin = Math.min(RUNTIME_MIN, runtimeMax);
  const runtimeWidth = input.runtimeOpen ? clamp(input.runtimeWidth, runtimeMin, runtimeMax) : 0;
  return { sidebarOpen, sidebarWidth, sidebarMin: SIDEBAR_MIN, sidebarMax, runtimeWidth, runtimeMin, runtimeMax };
}
