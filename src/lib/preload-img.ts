import type { App, Directive } from "vue";

/**
 * v-preload-img: preloads an image when it comes within `rootMargin` of the
 * viewport (before it's actually visible). Use on <img> elements that lazy-load:
 *
 *   <img v-preload-img :data-src="url" />
 *
 * On mount, the directive observes the element; when it nears the viewport
 * (200px margin by default), it copies data-src → src so the browser starts
 * fetching. Combine with loading="lazy" for a double safety net.
 */
const observer = typeof IntersectionObserver !== "undefined"
  ? new IntersectionObserver(
      (entries, obs) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const el = entry.target as HTMLImageElement;
            const src = el.getAttribute("data-src");
            if (src && !el.src) el.src = src;
            obs.unobserve(el);
          }
        }
      },
      { rootMargin: "200px" }
    )
  : null;

const preloadImg: Directive<HTMLImageElement> = {
  mounted(el) {
    if (observer) observer.observe(el);
    else {
      // no IntersectionObserver — set src immediately
      const src = el.getAttribute("data-src");
      if (src && !el.src) el.src = src;
    }
  },
  beforeUnmount(el) {
    if (observer) observer.unobserve(el);
  },
};

export function registerPreloadImg(app: App) {
  app.directive("preload-img", preloadImg);
}
