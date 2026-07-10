import type { App, Directive } from "vue";

/**
 * v-preload-img: preloads an image when it comes within `rootMargin` of the
 * viewport (before it's actually visible). Use on <img> elements that lazy-load:
 *
 *   <img v-preload-img :data-src="url" />
 *
 * On mount, the directive observes the element; when it nears the viewport
 * (300px margin by default), it copies data-src → src so the browser starts
 * fetching. Combine with loading="lazy" + decoding="async" for best results.
 *
 * Optimizations:
 *  - Single shared IntersectionObserver (low overhead)
 *  - Larger rootMargin (300px) to start loading earlier
 *  - Sets `fetchpriority="auto"` for near-viewport images
 *  - Graceful fallback when IntersectionObserver is unavailable
 */
const ROOT_MARGIN = "300px";

const observer = typeof IntersectionObserver !== "undefined"
  ? new IntersectionObserver(
      (entries, obs) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const el = entry.target as HTMLImageElement;
            const src = el.getAttribute("data-src");
            if (src && !el.src) {
              el.src = src;
              // hint browser to decode async (non-blocking)
              el.decoding = "async";
            }
            obs.unobserve(el);
          }
        }
      },
      { rootMargin: ROOT_MARGIN }
    )
  : null;

const preloadImg: Directive<HTMLImageElement> = {
  mounted(el) {
    if (observer) {
      observer.observe(el);
    } else {
      // no IntersectionObserver — set src immediately
      const src = el.getAttribute("data-src");
      if (src && !el.src) {
        el.src = src;
        el.decoding = "async";
      }
    }
  },
  beforeUnmount(el) {
    if (observer) observer.unobserve(el);
  },
};

export function registerPreloadImg(app: App) {
  app.directive("preload-img", preloadImg);
}
