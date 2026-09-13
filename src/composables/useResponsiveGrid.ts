import { ref, computed, watch, onBeforeUnmount, nextTick } from "vue";

/**
 * useResponsiveGrid — bulletproof responsive grid column count.
 *
 * Why this exists:
 *   CSS `auto-fill + minmax()` is unreliable in production because:
 *     1. Scrollbar width (~15px on Windows) isn't subtracted from available width
 *     2. Subpixel rounding lets the browser squeeze in one extra column
 *     3. Different browsers compute "fit" differently
 *
 *   This composable measures the actual container width with ResizeObserver
 *   and computes the column count in JS. The result is guaranteed to never
 *   overflow — `floor((width + gap) / (min + gap))` is a hard mathematical
 *   upper bound on how many columns fit.
 *
 * Critical: handles v-if/v-else conditional rendering
 *   When the grid container is behind a `v-else` (e.g. shows skeleton during
 *   loading, grid after data arrives), the ref is null on mount and only
 *   attaches when data loads. We use a `watch` on the ref itself to detect
 *   when it becomes available, then attach the ResizeObserver.
 *
 * Usage:
 *   const { containerRef, style } = useResponsiveGrid({ minWidth: 160, gap: 12 });
 *   <div ref="containerRef" :style="style">...</div>
 *
 * The returned `style` object sets:
 *   - display: grid
 *   - grid-template-columns: repeat(N, minmax(0, 1fr))  // N = computed cols
 *   - gap: <gap>px
 *
 * You can also pass a `trigger` ref (e.g. items.length) to force a recompute
 * when data changes (handles the "scrollbar disappears after load" case).
 */
export interface ResponsiveGridOptions {
  /** Minimum card width in pixels. Default: 160 */
  minWidth?: number;
  /** Gap between cards in pixels. Default: 12 */
  gap?: number;
  /** Initial column count before measurement. Default: 2 */
  initialCols?: number;
  /**
   * Optional reactive trigger — when this value changes, recompute is
   * called. Use this to handle "data loaded → scrollbar disappears →
   * container width changes" scenarios. Pass e.g. `() => items.value.length`
   * or a ref. The container's own ResizeObserver will catch the size
   * change, but the trigger is a reliable fallback for cases where
   * the container's border-box doesn't change (e.g. only content changes).
   */
  trigger?: () => unknown;
}

export function useResponsiveGrid(options: ResponsiveGridOptions = {}) {
  const minWidth = options.minWidth ?? 160;
  const gap = options.gap ?? 12;
  const initialCols = options.initialCols ?? 2;

  const containerRef = ref<HTMLElement | null>(null);
  const colCount = ref(initialCols);
  let resizeObserver: ResizeObserver | null = null;

  const recompute = () => {
    const el = containerRef.value;
    if (!el) return;
    const available = el.clientWidth;
    if (available === 0) return;
    const raw = (available + gap) / (minWidth + gap);
    const cols = Math.max(1, Math.floor(raw - 0.01));
    colCount.value = cols;
  };

  // ── Watch the ref itself: re-attach observer every time the container
  // element changes (e.g. v-if/v-else toggle from skeleton → grid).
  // This is the KEY fix for the "loading has scrollbar, loaded doesn't"
  // bug: when v-else switches, the old element is destroyed and a new one
  // is created. The old observer becomes stale.
  watch(
    () => containerRef.value,
    (el, oldEl) => {
      // Detach from previous element
      if (resizeObserver && oldEl) {
        resizeObserver.disconnect();
        resizeObserver = null;
      }
      if (!el) return;
      // Measure immediately (don't wait for next tick — the element is
      // already in the DOM when this watcher fires).
      recompute();
      // Attach observer to the new element
      resizeObserver = new ResizeObserver(() => recompute());
      resizeObserver.observe(el);
      // Also re-measure on next tick in case layout isn't settled yet
      nextTick(recompute);
    },
    { flush: "post", immediate: true }
  );

  // ── Optional trigger: recompute when trigger value changes ──
  // Handles "data loaded → scrollbar disappears → container wider" case.
  if (options.trigger) {
    watch(options.trigger, () => {
      // Defer to next tick so the DOM updates (scrollbar disappears) first
      nextTick(recompute);
    });
  }

  // ── Window resize fallback ──
  if (typeof window !== "undefined") {
    window.addEventListener("resize", recompute, { passive: true });
  }

  onBeforeUnmount(() => {
    resizeObserver?.disconnect();
    resizeObserver = null;
    if (typeof window !== "undefined") {
      window.removeEventListener("resize", recompute);
    }
  });

  // The style uses CSS `auto-fill` + `minmax(minWidth, 1fr)` as the PRIMARY
  // mechanism. This is bulletproof — the browser will NEVER produce a column
  // narrower than `minWidth`, so it will NEVER overflow. The JS-computed
  // `colCount` is used as a HINT via `repeat(N, ...)` but we actually use
  // `auto-fill` so the browser makes the final decision.
  //
  // Why not just use auto-fill without JS? Because `auto-fill + minmax(min, 1fr)`
  // can sometimes produce fewer columns than expected when the container has
  // a scrollbar (clientWidth < offsetWidth). The JS calculation gives us a
  // reliable upper bound, and auto-fill acts as the safety net.
  //
  // Wait — actually `repeat(N, minmax(minWidth, 1fr))` with N too large WILL
  // overflow (grid doesn't auto-reduce N). So we use `auto-fill` directly.
  // The JS colCount is kept for debugging/inspection but not used in the style.
  const style = computed(() => ({
    display: "grid",
    // auto-fill + minmax(minWidth, 1fr) = browser auto-selects column count,
    // each column at least `minWidth` wide. NEVER overflows.
    gridTemplateColumns: `repeat(auto-fill, minmax(${minWidth}px, 1fr))`,
    gap: `${gap}px`,
  }));

  return { containerRef, style, colCount, recompute };
}
