import type { App } from "vue";

/**
 * Global UX hardening for the AiKF app:
 *
 * 1. Disables common web shortcuts (keeps Ctrl+C / Ctrl+V):
 *    - Ctrl+S (save page), Ctrl+P (print), Ctrl+F / Ctrl+G / F3 (find),
 *      Ctrl+O (open file), Ctrl+U (view source), F5 / Ctrl+R (reload),
 *      Ctrl+Plus/Minus/0 (zoom), Ctrl+Shift+I/J/C / F12 (devtools),
 *      Backspace (nav back).
 * 2. Spacebar scrolls the page down (shift+space scrolls up), unless the
 *    focus is inside an input/textarea/contenteditable.
 * 3. Sets draggable=false on all <img> elements (prevents image drag ghost).
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

    // — shortcut blocking —
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && !e.altKey) {
      const k = e.key.toLowerCase();
      // keep Ctrl+C / Ctrl+V / Ctrl+A / Ctrl+X
      if (["c", "v", "a", "x"].includes(k)) return;
      // block: s, p, f, g, o, u, r, +, -, 0, shift+i/j/c
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

    // — spacebar scroll —
    if (e.key === " " && !isTyping) {
      e.preventDefault();
      const dist = e.shiftKey ? -window.innerHeight * 0.85 : window.innerHeight * 0.85;
      window.scrollBy({ top: dist, behavior: "smooth" });
    }
  };

  window.addEventListener("keydown", handler, { capture: true });

  // — disable image dragging globally —
  const setImgNotDraggable = () => {
    document.querySelectorAll("img").forEach((img) => {
      img.setAttribute("draggable", "false");
      if (!img.style.userSelect) img.style.userSelect = "none";
    });
  };
  // run after mount + observe DOM mutations
  const observer = new MutationObserver(() => setImgNotDraggable());
  const start = () => {
    setImgNotDraggable();
    observer.observe(document.body, { childList: true, subtree: true });
  };
  if (document.body) start();
  else document.addEventListener("DOMContentLoaded", start);

  app.config.globalProperties.$teardown = () => {
    window.removeEventListener("keydown", handler, { capture: true } as any);
    observer.disconnect();
  };
}
