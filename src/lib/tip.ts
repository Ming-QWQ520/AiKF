/**
 * v-tip —— 全局气泡提示指令（需求：所有 hover 带 title 的项统一为
 * 折叠侧栏 NTooltip 同款深色气泡样式，替换原生 title 原生提示）。
 *
 * 用法：
 *   <button v-tip="$t('common.back')">…</button>        默认自动方向（先上后下翻转）
 *   <div v-tip.bottom="长文本">…</div>                    强制出现在下方
 *   绑定值为空（undefined / ""）时不显示气泡。
 *
 * 实现说明：
 * - 单例气泡元素挂在 document.body（fixed 定位 + z-index 9999），
 *   播放器全屏层（z-50+）之上也能正常显示；
 * - hover 300ms 延迟弹出，离开/按下/滚动/窗口缩放立即隐藏；
 * - 纯 textContent 渲染，无 XSS 面；多语言切换时经 updated 钩子同步文本。
 */

type Placement = "top" | "bottom";

interface TipState {
  text: string;
  placement: Placement;
}

const SHOW_DELAY_MS = 300;
const GAP = 8; // 气泡与目标元素的间距
const EDGE = 8; // 距视口边缘的最小边距

const stateMap = new WeakMap<HTMLElement, TipState>();

let tipEl: HTMLDivElement | null = null;
let textEl: HTMLSpanElement | null = null;
let arrowEl: HTMLDivElement | null = null;
let showTimer: number | null = null;
let rafId: number | null = null;
let activeTarget: HTMLElement | null = null;
let listenersBound = false;

function ensureEl(): HTMLDivElement {
  if (tipEl) return tipEl;
  tipEl = document.createElement("div");
  tipEl.className = "aikf-tip";
  textEl = document.createElement("span");
  textEl.className = "aikf-tip-text";
  arrowEl = document.createElement("div");
  arrowEl.className = "aikf-tip-arrow";
  tipEl.appendChild(arrowEl);
  tipEl.appendChild(textEl);
  document.body.appendChild(tipEl);
  bindGlobalListeners();
  return tipEl;
}

function bindGlobalListeners() {
  if (listenersBound) return;
  listenersBound = true;
  // capture: true 以捕获任意内层滚动容器（main、弹窗正文、剧集网格等）
  window.addEventListener("scroll", hideNow, { capture: true, passive: true });
  window.addEventListener("resize", hideNow);
  window.addEventListener("mousedown", hideNow, { capture: true });
}

function clearTimers() {
  if (showTimer != null) {
    window.clearTimeout(showTimer);
    showTimer = null;
  }
  if (rafId != null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
}

function hideNow() {
  clearTimers();
  activeTarget = null;
  if (tipEl) tipEl.classList.remove("aikf-tip-show");
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function render(target: HTMLElement, text: string, placement: Placement) {
  if (!text) {
    hideNow();
    return;
  }
  const el = ensureEl();
  if (textEl) textEl.textContent = text;

  // 先隐藏状态下挂载测量尺寸，再定位显示（避免闪跳）
  el.style.visibility = "hidden";
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  const r = target.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  if (r.width === 0 && r.height === 0) {
    hideNow();
    return;
  }

  // 自动翻转：上方放不下 → 下方；下方放不下 → 上方
  let place: Placement = placement;
  if (place === "top" && r.top - h - GAP < EDGE && r.bottom + h + GAP < vh - EDGE) place = "bottom";
  else if (place === "bottom" && r.bottom + h + GAP > vh - EDGE && r.top - h - GAP >= EDGE) place = "top";

  const x = clamp(r.left + r.width / 2 - w / 2, EDGE, Math.max(EDGE, vw - w - EDGE));
  const y = place === "top" ? Math.max(EDGE, r.top - h - GAP) : Math.min(vh - h - EDGE, r.bottom + GAP);

  // 箭头对准目标中心，但限制在气泡内部
  if (arrowEl) {
    arrowEl.classList.toggle("aikf-tip-arrow-b", place === "top");
    arrowEl.classList.toggle("aikf-tip-arrow-t", place === "bottom");
    const ax = clamp(r.left + r.width / 2 - x - 4, 10, Math.max(10, w - 18));
    arrowEl.style.left = `${ax}px`;
  }

  el.style.left = `${Math.round(x)}px`;
  el.style.top = `${Math.round(y)}px`;
  el.style.visibility = "visible";
  activeTarget = target;
  rafId = requestAnimationFrame(() => {
    if (activeTarget === target) el.classList.add("aikf-tip-show");
  });
}

function scheduleShow(target: HTMLElement) {
  const st = stateMap.get(target);
  if (!st) return;
  clearTimers();
  // 切换目标时立即隐藏旧气泡，避免残影
  if (activeTarget && activeTarget !== target) tipEl?.classList.remove("aikf-tip-show");
  showTimer = window.setTimeout(() => render(target, st.text, st.placement), SHOW_DELAY_MS);
}

function onEnter(this: HTMLElement) {
  scheduleShow(this);
}
function onLeave() {
  hideNow();
}

export const tipDirective = {
  mounted(el: HTMLElement, binding: { value: unknown; arg?: string }) {
    const state: TipState = {
      text: binding.value == null ? "" : String(binding.value),
      placement: binding.arg === "bottom" ? "bottom" : "top",
    };
    stateMap.set(el, state);
    el.addEventListener("mouseenter", onEnter);
    el.addEventListener("mouseleave", onLeave);
  },
  updated(el: HTMLElement, binding: { value: unknown; arg?: string }) {
    const state = stateMap.get(el);
    if (!state) return;
    state.text = binding.value == null ? "" : String(binding.value);
    if (binding.arg) state.placement = binding.arg === "bottom" ? "bottom" : "top";
    // 若该元素气泡正在显示，实时刷新文本与位置
    if (activeTarget === el) render(el, state.text, state.placement);
  },
  unmounted(el: HTMLElement) {
    el.removeEventListener("mouseenter", onEnter);
    el.removeEventListener("mouseleave", onLeave);
    if (activeTarget === el) hideNow();
    stateMap.delete(el);
  },
};
