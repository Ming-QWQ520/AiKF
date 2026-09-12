import type { App } from "vue";

/**
 * Global UX hardening for the AiKF app.
 *
 * Always-on behaviors (NOT configurable — hardcoded for app-like UX):
 *  - Block web/browser shortcuts comprehensively:
 *      · F1–F11 (help/refresh/find/caret/address/menu/fullscreen)
 *      · Ctrl+<letter> except the editing whitelist C/V/A/X/Z/Y
 *        (save/print/find/source/refresh/bookmark/history/downloads/
 *         new-tab/close-window/zoom-reset/tab-switch/…)
 *      · Ctrl+Shift+<letter>/Delete except "i" (devtools passthrough)
 *      · Ctrl+Tab / Ctrl+0-9 / Ctrl+Enter / Ctrl++-=
 *      · Alt+←/→/Home/D (browser back/forward/home/address bar)
 *      · Backspace "back" navigation (when not typing)
 *    Kept usable on purpose:
 *      · Ctrl+C/V/A/X + Ctrl+Z/Y (clipboard & undo/redo — user required)
 *      · Ctrl+Backspace (delete-word inside inputs)
 *      · plain Tab (focus navigation) & Escape & arrow keys (player)
 *      · F12 / Ctrl+Shift+I (WebView devtools accelerator)
 *  - Disable right-click context menu
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

    const ctrl = e.ctrlKey || e.metaKey;
    const alt = e.altKey;
    const k = e.key.toLowerCase();

    // — devtools shortcut (F12 / Ctrl+Shift+I) — pass through so the
    // WebView's native accelerator opens the inspector. Do NOT
    // preventDefault here.
    if (e.key === "F12") return;
    if (ctrl && e.shiftKey && !alt && k === "i") return;

    // — F1–F11: browser UI keys (help/find-bar/caret-browsing/address-bar/
    // menu-bar/refresh/fullscreen). The app has no F-key bindings, block all.
    if (!ctrl && !alt && /^F([1-9]|1[0-1])$/.test(e.key)) {
      e.preventDefault();
      return;
    }

    if (ctrl && !alt) {
      if (e.shiftKey) {
        // Ctrl+Shift+<letter>/Delete — browser chrome keys (new incognito
        // window, reopen tab, close window, bookmarks, clear-data, …).
        // "i" was already passed through above for devtools.
        if (/^[a-z]$/.test(k) || k === "delete") {
          e.preventDefault();
          return;
        }
      } else {
        // Editing whitelist — keep clipboard & undo/redo (user required C/V).
        if (["c", "v", "a", "x", "z", "y"].includes(k)) return;
        // Every other Ctrl+<letter>: save/print/find/view-source/refresh/
        // bookmark/history/downloads/new-tab/close-window/address-bar…
        if (/^[a-z]$/.test(k)) {
          e.preventDefault();
          return;
        }
        // Tab switching (Ctrl+Tab/Shift-Tab), zoom reset (Ctrl+0),
        // tab jump (Ctrl+1-9), address-bar completion (Ctrl+Enter).
        if (k === "tab" || k === "enter" || /^[0-9]$/.test(k)) {
          e.preventDefault();
          return;
        }
        // Zoom in/out (Ctrl+ / Ctrl+- / Ctrl+=)
        if (["+", "-", "="].includes(k)) {
          e.preventDefault();
          return;
        }
        // Ctrl+Backspace (delete-word) is intentionally KEPT for inputs.
      }
    }

    // — Alt browser navigation: back / forward / home / address bar —
    if (alt && !ctrl && ["arrowleft", "arrowright", "home", "d"].includes(k)) {
      e.preventDefault();
      return;
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
