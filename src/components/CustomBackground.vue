<script setup lang="ts">
import { computed } from "vue";
import { useSettingsStore } from "@/stores/settings";

/**
 * Custom user-defined background image.
 *
 * Renders a FIXED full-viewport layer at -z-20 (behind everything, including
 * the AmbientBackground mesh at -z-10 and the TitleBar). This way the custom
 * background covers the entire window, including behind the title bar.
 *
 * Honors the `background` settings: enabled / url / opacity / blur / scale.
 */
const settings = useSettingsStore();
const bg = computed(() => settings.data.background);

const layerStyle = computed(() => {
  if (!bg.value.enabled || !bg.value.url) return { display: "none" };
  // Use cover for full-viewport coverage; scale adjusts the cover factor
  // (scale > 100 zooms in, scale < 100 zooms out via background-size percentage).
  const scale = bg.value.scale;
  return {
    backgroundImage: `url("${bg.value.url}")`,
    // "cover" ensures the image always fills the viewport; the scale value
    // is applied via a CSS transform on a wrapper to allow zoom without
    // breaking coverage.
    backgroundSize: "cover",
    backgroundPosition: "center center",
    backgroundRepeat: "no-repeat",
    opacity: String(bg.value.opacity / 100),
    filter: bg.value.blur > 0 ? `blur(${bg.value.blur}px)` : "none",
    transform: `scale(${scale / 100})`,
    transformOrigin: "center center",
  } as Record<string, string>;
});
</script>

<template>
  <div aria-hidden="true" class="pointer-events-none fixed inset-0 -z-20 overflow-hidden">
    <div class="absolute inset-0" :style="layerStyle" />
  </div>
</template>
