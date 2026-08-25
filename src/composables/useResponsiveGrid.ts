import { ref, computed, onMounted, onBeforeUnmount, nextTick } from "vue";

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
 * Usage:
 *   const { containerRef, style } = useResponsiveGrid({ minWidth: 160, gap: 12 });
 *   <div ref="containerRef" :style="style">...</div>
 *
 * The returned `style` object sets:
 *   - display: grid
 *   - grid-template-columns: repeat(N, minmax(0, 1fr))  // N = computed cols
 *   - gap: <gap>px
 */
export interface ResponsiveGridOptions {
  /** Minimum card width in pixels. Default: 160 */
  minWidth?: number;
  /** Gap between cards in pixels. Default: 12 */
  gap?: number;
  /** Initial column count before measurement. Default: 2 */
  initialCols?: number;
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
    // clientWidth excludes scrollbar width — this is the key to preventing
    // overflow on Windows where the scrollbar takes ~15px of horizontal space.
    const available = el.clientWidth;
    // Mathematical max cols that fit without overflow:
    //   cols * minWidth + (cols - 1) * gap <= available
    //   cols <= (available + gap) / (minWidth + gap)
    const cols = Math.max(1, Math.floor((available + gap) / (minWidth + gap)));
    colCount.value = cols;
  };

  onMounted(() => {
    // Wait for layout to settle (slot content, async data, etc.) before measuring.
    nextTick(() => {
      recompute();
      if (containerRef.value) {
        resizeObserver = new ResizeObserver(() => recompute());
        resizeObserver.observe(containerRef.value);
      }
    });
    // Also recompute on window resize (ResizeObserver catches container resizes
    // but window resize is a good fallback for cases where the container is
    // fixed-size and only its parent changes).
    window.addEventListener("resize", recompute, { passive: true });
  });

  onBeforeUnmount(() => {
    resizeObserver?.disconnect();
    resizeObserver = null;
    window.removeEventListener("resize", recompute);
  });

  const style = computed(() => ({
    display: "grid",
    gridTemplateColumns: `repeat(${colCount.value}, minmax(0, 1fr))`,
    gap: `${gap}px`,
  }));

  return { containerRef, style, colCount };
}
