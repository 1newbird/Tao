import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent, WheelEvent } from "react";

export interface ScrollPosition { top: number; following: boolean }
const BOTTOM_DISTANCE = 64;

/** Each conversation owns its reading position; layout updates never opt it in. */
export function useFollowScroll(key: string, enabled: boolean, memory?: Map<string, ScrollPosition>) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const positions = useRef(memory ?? new Map<string, ScrollPosition>());
  const current = useRef({ key, following: true, expectedTop: null as number | null });
  const dragging = useRef(false);
  const [following, setFollowing] = useState(true);
  const save = useCallback(() => {
    const element = viewportRef.current;
    if (element) positions.current.set(current.current.key, { top: element.scrollTop, following: current.current.following });
  }, []);
  const updateFollowing = useCallback((value: boolean) => {
    current.current.following = value;
    setFollowing(value);
    save();
  }, [save]);
  const scrollToLatest = useCallback(() => {
    const element = viewportRef.current;
    updateFollowing(true);
    if (!element) return;
    element.scrollTop = element.scrollHeight;
    current.current.expectedTop = element.scrollTop;
    save();
  }, [save, updateFollowing]);
  const synchronize = useCallback(() => {
    const element = viewportRef.current;
    if (!element) return;
    if (current.current.following) {
      element.scrollTop = element.scrollHeight;
      current.current.expectedTop = element.scrollTop;
    }
    save();
  }, [save]);

  useLayoutEffect(() => {
    const element = viewportRef.current;
    if (!enabled || !element) return;
    const saved = positions.current.get(key);
    dragging.current = false;
    current.current = { key, following: saved?.following ?? true, expectedTop: null };
    setFollowing(current.current.following);
    element.scrollTop = saved && !saved.following ? saved.top : element.scrollHeight;
    current.current.expectedTop = element.scrollTop;
    save();
    const observer = new ResizeObserver(synchronize);
    observer.observe(element);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    return () => observer.disconnect();
  }, [key, enabled, save, synchronize]);

  // Runs before paint for React updates; ResizeObserver also catches reflow
  // caused by panel resizing and streamed Markdown changing block structure.
  useLayoutEffect(() => { if (enabled) synchronize(); });

  useLayoutEffect(() => {
    const release = () => {
      if (!dragging.current) return;
      dragging.current = false;
      const element = viewportRef.current;
      if (element) updateFollowing(element.scrollHeight - element.clientHeight - element.scrollTop <= BOTTOM_DISTANCE);
    };
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    return () => { window.removeEventListener("pointerup", release); window.removeEventListener("pointercancel", release); };
  }, [updateFollowing]);

  const onScroll = useCallback(() => {
    const element = viewportRef.current;
    if (!element) return;
    const expected = current.current.expectedTop;
    current.current.expectedTop = null;
    if (dragging.current) updateFollowing(false);
    else if (expected === null || Math.abs(element.scrollTop - expected) > 1) {
      updateFollowing(element.scrollHeight - element.clientHeight - element.scrollTop <= BOTTOM_DISTANCE);
    }
    save();
  }, [save, updateFollowing]);
  const onWheelCapture = useCallback((event: WheelEvent<HTMLDivElement>) => {
    const element = viewportRef.current;
    if (event.deltaY < 0 && element && element.scrollHeight > element.clientHeight + BOTTOM_DISTANCE) {
      current.current.expectedTop = null;
      updateFollowing(false);
    }
  }, [updateFollowing]);
  const onPointerDownCapture = useCallback((event: PointerEvent<HTMLDivElement>) => {
    // Native scrollbar presses target the viewport. Pause even before the
    // thumb has moved past the near-bottom threshold.
    if (event.target === event.currentTarget && event.currentTarget.scrollHeight > event.currentTarget.clientHeight + BOTTOM_DISTANCE) {
      dragging.current = true;
      current.current.expectedTop = null;
      updateFollowing(false);
    }
  }, [updateFollowing]);
  const onKeyDownCapture = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (["ArrowUp", "PageUp", "Home"].includes(event.key) || (event.key === " " && event.shiftKey)) {
      current.current.expectedTop = null;
      updateFollowing(false);
    }
  }, [updateFollowing]);
  return { viewportRef, following, scrollToLatest, onScroll, onWheelCapture, onPointerDownCapture, onKeyDownCapture };
}
