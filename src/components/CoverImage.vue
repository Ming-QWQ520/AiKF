<script setup lang="ts">
import { ref, watch, computed } from "vue";
import { cn } from "@/lib/utils";

const props = withDefaults(
  defineProps<{
    src?: string;
    alt: string;
    ratio?: "portrait" | "square" | "wide";
    rounded?: string;
    class?: string;
  }>(),
  { ratio: "portrait", rounded: "rounded-2xl" }
);

const loaded = ref(false);
const errored = ref(false);

watch(
  () => props.src,
  () => {
    loaded.value = false;
    errored.value = false;
  }
);

const ratioClass = computed(
  () =>
    ({
      portrait: "aspect-[3/4]",
      square: "aspect-square",
      wide: "aspect-video",
    })[props.ratio]
);
</script>

<template>
  <div
    :class="cn('relative overflow-hidden bg-gradient-to-br from-primary/15 via-secondary/10 to-tertiary/15', ratioClass, rounded, props.class)"
  >
    <!-- shimmer placeholder (CSS-only, GPU-accelerated) -->
    <div v-if="!loaded && !errored" class="absolute inset-0 shimmer" />
    <img
      v-if="src && !errored"
      v-preload-img
      :data-src="src"
      :alt="alt"
      loading="lazy"
      decoding="async"
      draggable="false"
      @load="loaded = true"
      @error="errored = true"
      :class="cn('h-full w-full object-cover pointer-events-none select-none will-change-[opacity,transform] transition-[opacity,transform] duration-500 ease-out', loaded ? 'scale-100 opacity-100 blur-0' : 'scale-105 opacity-0 blur-md')"
    />
    <div v-else class="absolute inset-0 flex items-center justify-center">
      <svg viewBox="0 0 24 24" fill="none" class="h-8 w-8 text-muted-foreground/60" stroke="currentColor" stroke-width="1.5">
        <path stroke-linecap="round" stroke-linejoin="round" d="m2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909M3.75 3.75h16.5a2.25 2.25 0 0 1 2.25 2.25v12a2.25 2.25 0 0 1-2.25 2.25H3.75a2.25 2.25 0 0 1-2.25-2.25v-12a2.25 2.25 0 0 1 2.25-2.25Zm9.75 4.5a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Z" />
      </svg>
    </div>
    <div class="pointer-events-none absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-black/55 to-transparent" />
  </div>
</template>
