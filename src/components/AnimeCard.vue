<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { gsap } from "gsap";
import { useLibraryStore } from "@/stores/library";
import CoverImage from "./CoverImage.vue";

const props = withDefaults(
  defineProps<{
    id: number;
    title: string;
    image: string;
    tagline?: string;
    episode?: number;
    episodesTotal?: number;
    latestName?: string;
    index?: number;
  }>(),
  { index: 0 }
);

const emit = defineEmits<{ (e: "select", id: number, cover?: string): void }>();

const library = useLibraryStore();
const inLibrary = computed(() => !!library.entries[props.id]);

const onClick = () => emit("select", props.id, props.image);

// GSAP entrance animation
const cardRef = ref<HTMLElement | null>(null);
onMounted(() => {
  if (cardRef.value) {
    gsap.from(cardRef.value, {
      opacity: 0,
      y: 16,
      duration: 0.4,
      ease: "power2.out",
      delay: Math.min((props.index ?? 0) * 0.025, 0.3),
      clearProps: "opacity,transform",
    });
  }
});
</script>

<template>
  <button
    ref="cardRef"
    type="button"
    @click="onClick"
    style="content-visibility: auto; contain-intrinsic-size: 220px"
    class="group relative flex flex-col text-left state-layer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background rounded-2xl transition-transform duration-200 hover:-translate-y-1 active:scale-[0.98]"
  >
    <div class="relative">
      <CoverImage
        :src="image"
        :alt="title"
        ratio="portrait"
        rounded="rounded-2xl"
        class="ring-1 ring-black/5 shadow-lg shadow-black/10 transition-all duration-500 group-hover:shadow-xl group-hover:shadow-primary/20 group-hover:ring-primary/30"
      />
      <div class="absolute left-2 top-2 flex flex-col gap-1">
        <span v-if="typeof episode === 'number' && episode > 0" class="glass-strong glass-sheen rounded-full px-2 py-0.5 text-[10px] font-semibold text-foreground shadow">
          第{{ episode }}话
        </span>
      </div>
      <span v-if="inLibrary" class="absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-md">
        <svg viewBox="0 0 24 24" fill="none" class="h-3 w-3" stroke="currentColor" :stroke-width="3.5">
          <path stroke-linecap="round" stroke-linejoin="round" d="m4.5 12.75 6 6 9-13.5" />
        </svg>
      </span>
      <div class="absolute inset-x-0 bottom-0 flex translate-y-2 flex-col gap-1 p-2 opacity-0 transition-all duration-300 group-hover:translate-y-0 group-hover:opacity-100">
        <span class="glass-strong glass-sheen rounded-full px-2.5 py-1 text-center text-[11px] font-medium text-foreground backdrop-blur-md">查看详情</span>
      </div>
    </div>
    <div class="mt-2 px-0.5">
      <h3 class="line-clamp-1 text-sm font-semibold text-foreground" :title="title">{{ title }}</h3>
      <p v-if="latestName || tagline" class="mt-0.5 line-clamp-1 text-[11px] text-muted-foreground">{{ latestName || tagline }}</p>
      <p v-if="episodesTotal" class="mt-0.5 text-[10px] text-muted-foreground/70">共{{ episodesTotal }}话</p>
    </div>
  </button>
</template>
