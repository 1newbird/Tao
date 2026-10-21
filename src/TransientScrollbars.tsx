import { useEffect } from "react";
import "./scrollbars.css";

/** Appearance only: native scrolling and each view's follow state stay intact. */
export function TransientScrollbars() {
  useEffect(() => {
    const timers = new Map<HTMLElement, number>();
    let dragging: HTMLElement | null = null;
    const reveal = (element: HTMLElement) => {
      window.clearTimeout(timers.get(element));
      element.setAttribute("data-scroll-active", "");
      timers.set(element, window.setTimeout(() => {
        if (dragging === element) return;
        element.removeAttribute("data-scroll-active");
        timers.delete(element);
      }, 900));
    };
    const onScroll = (event: Event) => {
      if (event.target instanceof HTMLElement) reveal(event.target);
    };
    const onPointerDown = (event: PointerEvent) => {
      const element = event.target;
      if (!(element instanceof HTMLElement)) return;
      const bounds = element.getBoundingClientRect();
      const verticalGutter = element.offsetWidth - element.clientWidth;
      const horizontalGutter = element.offsetHeight - element.clientHeight;
      if ((element.scrollHeight > element.clientHeight && verticalGutter > 0 && event.clientX >= bounds.right - verticalGutter)
        || (element.scrollWidth > element.clientWidth && horizontalGutter > 0 && event.clientY >= bounds.bottom - horizontalGutter)) {
        dragging = element;
        reveal(element);
      }
    };
    const release = () => {
      const element = dragging;
      dragging = null;
      if (element) reveal(element);
    };
    // Capture also covers nested panels and menus rendered through portals.
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    window.addEventListener("blur", release);
    return () => {
      document.removeEventListener("scroll", onScroll, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
      window.removeEventListener("blur", release);
      for (const [element, timer] of timers) {
        window.clearTimeout(timer);
        element.removeAttribute("data-scroll-active");
      }
    };
  }, []);
  return null;
}
