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
  if (slides.value.length > 1) timer = window.setInterval(next, 6000);
};
const stopTimer = () => {
  if (timer) { clearInterval(timer); timer = 0; }
};

onMounted(() => { if (!paused.value) startTimer(); });
onBeforeUnmount(() => stopTimer());

watch(() => slides.value.length, () => {
  if (index.value >= slides.value.length) index.value = 0;
  if (!paused.value) startTimer();
});
watch(slides, (s) => { if (index.value >= s.length) index.value = 0; });

// GSAP crossfade on slide change + title slide-up
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
      if (img) gsap.fromTo(img, { scale: 1.06 }, { scale: 1, duration: 1.4, ease: "power1.out" });
      // 文案上滑入场
      const copy = incoming.querySelector(".aikf-copy");
      if (copy) gsap.fromTo(copy, { y: 18, opacity: 0 }, { y: 0, opacity: 1, duration: 0.55, ease: "power3.out", delay: 0.12 });
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
    :class="cn('group/carousel relative h-[300px] w-full overflow-hidden rounded-2xl border border-border sm:h-[340px]', className)"
    @mouseenter="onMouseEnter"
    @mouseleave="onMouseLeave"
  >
    <!-- Loading / empty -->
    <div v-if="isLoading || slides.length === 0" class="absolute inset-0 flex items-center justify-center bg-muted">
      <div class="h-8 w-8 animate-spin rounded-full border-2 border-border border-t-foreground/70" />
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
      <div class="absolute inset-0 bg-gradient-to-t from-black/75 via-black/10 to-transparent" />
      <div class="absolute inset-0 flex flex-col justify-end p-5 sm:p-7">
        <div class="aikf-copy max-w-md">
          <span class="mb-2.5 inline-flex items-center gap-1 rounded-full bg-white/15 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-white ring-1 ring-white/25 backdrop-blur-sm">
            <slot name="badge-icon" />{{ badge }}
          </span>
          <h2 class="line-clamp-2 text-xl font-extrabold tracking-tight text-white drop-shadow-sm sm:text-2xl">{{ item.title }}</h2>
          <p v-if="item.subtitle" class="mt-1.5 line-clamp-1 text-xs text-white/65">{{ item.subtitle }}</p>
          <button
            @click="emit('open', item.id, item.image)"
            class="mt-4 flex items-center gap-2 rounded-xl bg-white px-5 py-2.5 text-sm font-semibold text-zinc-900 shadow-lg shadow-black/20 transition-all hover:bg-white/90 hover:shadow-black/30 active:scale-[0.98]"
          >
            <Play class="h-4 w-4 fill-current" /> 立即观看
          </button>
        </div>
      </div>
    </div>

    <!-- 左右箭头：hover 时浮现 -->
    <template v-if="slides.length > 1">
      <button
        @click="prev"
        aria-label="上一张"
        class="absolute left-3 top-1/2 z-10 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full bg-black/45 text-white opacity-0 backdrop-blur-sm transition-all duration-200 hover:bg-black/70 group-hover/carousel:opacity-100"
      >
        <ChevronLeft class="h-5 w-5" />
      </button>
      <button
        @click="next"
        aria-label="下一张"
        class="absolute right-3 top-1/2 z-10 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full bg-black/45 text-white opacity-0 backdrop-blur-sm transition-all duration-200 hover:bg-black/70 group-hover/carousel:opacity-100"
      >
        <ChevronRight class="h-5 w-5" />
      </button>

      <!-- 底部进度条式指示器：自动播放时当前项有填充动画，hover 暂停 -->
      <div class="absolute bottom-3.5 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5">
        <button
          v-for="(s, i) in slides"
          :key="s.id"
          @click="goTo(i)"
          :aria-label="`第${i + 1}张`"
          :class="cn(
            'relative h-1 overflow-hidden rounded-full bg-white/30 transition-all duration-300',
            i === index ? 'w-10' : 'w-4 hover:bg-white/50'
          )"
        >
          <!-- 当前项：填充动画（暂停时动画同步暂停） -->
          <span
            v-if="i === index"
            :key="`fill-${index}-${paused ? 'p' : 'r'}`"
            class="absolute inset-y-0 left-0 rounded-full bg-white"
            :class="paused ? 'aikf-car-fill-paused' : 'aikf-car-fill'"
          />
        </button>
      </div>
    </template>
  </section>
</template>

<style scoped>
/* 6s 自动播放进度填充；hover 暂停时冻结在当前位置 */
.aikf-car-fill {
  animation: aikfCarFill 6s linear forwards;
}
.aikf-car-fill-paused {
  animation: aikfCarFill 6s linear forwards;
  animation-play-state: paused;
}
@keyframes aikfCarFill {
  from { width: 0%; }
  to { width: 100%; }
}
</style>
