import type { App } from "vue";

/**
 * Global UX hardening for the AiKF app.
 *
 * Always-on behaviors (NOT configurable — hardcoded for app-like UX):
 *  - Block web shortcuts (Ctrl+S/P/F/U/R etc.), keep Ctrl+C/V/A/X
 *  - Disable right-click context menu
 *  - Block F-keys (F3/F5/F12)
 *  - Block Backspace "back" navigation
 *
 * Always-on (not configurable):
 *  - Spacebar scrolls the page (shift+space scrolls up) unless typing in an input
 *  - Sets draggable=false on all <img> elements
 */
export function registerGlobalUX(app: App) {
  const handler = (e: KeyboardEvent) => {
    const el = e.target as HTMLElement | null;
    const tag = el?.tagName ?? "";
    const isTyping =
      tag === "INPUT" ||
      tag === "TEXTAREA" ||
      tag === "SELECT" ||
      el?.isContentEditable === true;

    // — shortcut blocking (always on, NOT configurable) —
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && !e.altKey) {
      const k = e.key.toLowerCase();
      // keep Ctrl+C / Ctrl+V / Ctrl+A / Ctrl+X
      if (["c", "v", "a", "x"].includes(k)) return;
      // block: s, p, f, g, o, u, r
      if (["s", "p", "f", "g", "o", "u", "r"].includes(k)) {
        e.preventDefault();
        return;
      }
      if (["+", "-", "="].includes(k)) {
        e.preventDefault();
        return;
      }
      if (e.shiftKey && ["i", "j", "c"].includes(k)) {
        e.preventDefault();
        return;
      }
    }
    // F-keys
    if (!ctrl) {
      if (["F3", "F5", "F12"].includes(e.key)) {
        e.preventDefault();
        return;
      }
    }

    // Backspace (browser "back" nav) — only when not typing
    if (e.key === "Backspace" && !isTyping) {
      e.preventDefault();
      return;
    }

    // — spacebar scroll (always on) —
    if (e.key === " " && !isTyping) {
      e.preventDefault();
      const dist = e.shiftKey ? -window.innerHeight * 0.85 : window.innerHeight * 0.85;
      window.scrollBy({ top: dist, behavior: "smooth" });
    }
  };

  window.addEventListener("keydown", handler, { capture: true });

  // — right-click context menu (always on, NOT configurable) —
  const contextMenuHandler = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };
  window.addEventListener("contextmenu", contextMenuHandler, { capture: true });

  // — disable image dragging globally (always on) —
  const setImgNotDraggable = () => {
    document.querySelectorAll("img").forEach((img) => {
      img.setAttribute("draggable", "false");
      if (!img.style.userSelect) img.style.userSelect = "none";
    });
  };
  const observer = new MutationObserver(() => setImgNotDraggable());
  const start = () => {
    setImgNotDraggable();
    observer.observe(document.body, { childList: true, subtree: true });
  };
  if (document.body) start();
  else document.addEventListener("DOMContentLoaded", start);

  app.config.globalProperties.$teardown = () => {
    window.removeEventListener("keydown", handler, { capture: true } as any);
    window.removeEventListener("contextmenu", contextMenuHandler, { capture: true } as any);
    observer.disconnect();
  };
}
