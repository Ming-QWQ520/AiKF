<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from "vue";
import { Play, ChevronLeft, ChevronRight } from "lucide-vue-next";
import { gsap } from "gsap";
import { cn } from "@/lib/utils";

interface CarouselSlide {
  id: number;
  image: string;
  title: string;
  subtitle?: string;
}

const props = withDefaults(defineProps<{
  slides: CarouselSlide[];
  badge: string;
  isLoading?: boolean;
  className?: string;
}>(), {
  isLoading: false,
  className: "",
});

const emit = defineEmits<{
  (e: "open", id: number, cover: string): void;
}>();

const index = ref(0);
let timer = 0;
const paused = ref(false);
const slideRefs = ref<HTMLElement[]>([]);

const slides = computed(() => props.slides);

const next = () => {
  if (slides.value.length) index.value = (index.value + 1) % slides.value.length;
};
const prev = () => {
  if (slides.value.length) index.value = (index.value - 1 + slides.value.length) % slides.value.length;
};
const goTo = (i: number) => { index.value = i; };

const startTimer = () => {
  if (timer) clearInterval(timer);
  if (slides.value.length > 1) timer = window.setInterval(next, 5000);
};
const stopTimer = () => {
  if (timer) { clearInterval(timer); timer = 0; }
};

onMounted(() => { if (!paused.value) startTimer(); });
onBeforeUnmount(() => stopTimer());

watch(() => slides.value.length, () => {
  if (!paused.value) startTimer();
});
watch(slides, (s) => { if (index.value >= s.length) index.value = 0; });

// GSAP crossfade on slide change
watch(index, (ni, oi) => {
  if (ni === oi) return;
  nextTick(() => {
    const incoming = slideRefs.value[ni];
    const outgoing = slideRefs.value[oi];
    if (outgoing && incoming) {
      // fade out old, fade in new (stagger-free, GPU-accelerated)
      gsap.fromTo(outgoing, { opacity: 1 }, { opacity: 0, duration: 0.4, ease: "power2.inOut" });
      gsap.fromTo(incoming, { opacity: 0 }, { opacity: 1, duration: 0.5, ease: "power2.out", delay: 0.1 });
      // subtle ken-burns zoom on the incoming image
      const img = incoming.querySelector("img");
      if (img) gsap.fromTo(img, { scale: 1.05 }, { scale: 1, duration: 1.2, ease: "power1.out" });
    } else if (incoming) {
      gsap.fromTo(incoming, { opacity: 0 }, { opacity: 1, duration: 0.5, ease: "power2.out" });
    }
  });
});

const onMouseEnter = () => { paused.value = true; stopTimer(); };
const onMouseLeave = () => { paused.value = false; startTimer(); };
</script>

<template>
  <section
    :class="cn('relative h-[280px] w-full overflow-hidden rounded-2xl ring-1 ring-border/30 sm:h-[320px]', className)"
    @mouseenter="onMouseEnter"
    @mouseleave="onMouseLeave"
  >
    <!-- Loading / empty -->
    <div v-if="isLoading || slides.length === 0" class="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-primary/5 to-secondary/5">
      <div class="h-8 w-8 animate-spin rounded-full border-2 border-border border-t-primary" />
    </div>

    <!-- Slides (all rendered, GSAP controls visibility via opacity) -->
    <div
      v-for="(item, i) in slides"
      :key="item.id"
      :ref="(el) => { if (el) slideRefs[i] = el as HTMLElement }"
      class="absolute inset-0"
      :style="{ opacity: i === 0 ? 1 : 0 }"
    >
      <img
        :src="item.image"
        :alt="item.title"
        class="h-full w-full object-cover will-change-transform"
        draggable="false"
        loading="eager"
        decoding="async"
        :fetchpriority="i === 0 ? 'high' : 'low'"
      />
      <div class="absolute inset-0 bg-gradient-to-r from-black/80 via-black/30 to-transparent" />
      <div class="absolute inset-0 bg-gradient-to-t from-black/70 to-transparent" />
      <div class="absolute inset-0 flex flex-col justify-end p-5 sm:p-6">
        <div class="max-w-md">
          <span class="mb-1.5 inline-flex items-center gap-1 rounded bg-primary px-2 py-0.5 text-[11px] font-bold text-primary-foreground">
            <slot name="badge-icon" />{{ badge }}
          </span>
          <h2 class="line-clamp-2 text-lg font-extrabold tracking-tight text-white sm:text-2xl">{{ item.title }}</h2>
          <p v-if="item.subtitle" class="mt-1 line-clamp-1 text-xs text-white/60">{{ item.subtitle }}</p>
          <button
            @click="emit('open', item.id, item.image)"
            class="mt-3 flex items-center gap-2 rounded-lg bg-white px-4 py-2 text-sm font-bold text-black transition-colors hover:bg-white/90"
          >
            <Play class="h-4 w-4 fill-current" /> 立即观看
          </button>
        </div>
      </div>
    </div>

    <!-- Controls -->
    <template v-if="slides.length > 1">
      <button @click="prev" class="absolute left-3 top-1/2 z-10 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full bg-black/50 text-white hover:bg-black/70">
        <ChevronLeft class="h-4 w-4" />
      </button>
      <button @click="next" class="absolute right-3 top-1/2 z-10 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full bg-black/50 text-white hover:bg-black/70">
        <ChevronRight class="h-4 w-4" />
      </button>
      <div class="absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 gap-1.5">
        <button
          v-for="(s, i) in slides" :key="s.id" @click="goTo(i)"
          :class="cn('h-1.5 rounded-full transition-all', i === index ? 'w-5 bg-white' : 'w-1.5 bg-white/40')"
        />
      </div>
    </template>
  </section>
</template>
