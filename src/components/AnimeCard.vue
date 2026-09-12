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
    class="group relative flex min-w-0 flex-col text-left state-layer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background rounded-xl transition-transform duration-200 hover:-translate-y-0.5 active:scale-[0.98]"
  >
    <div class="relative">
      <CoverImage
        :src="image"
        :alt="title"
        ratio="portrait"
        rounded="rounded-xl"
        class="ring-1 ring-foreground/5 transition-all duration-300 group-hover:ring-foreground/15"
      />
      <div class="absolute left-1.5 top-1.5 flex flex-col gap-1">
        <span v-if="typeof episode === 'number' && episode > 0" class="rounded-md bg-black/60 px-1.5 py-0.5 text-[10px] font-semibold text-white backdrop-blur-sm">
          {{ $t('discover.epN', { n: episode }) }}
        </span>
      </div>
      <span v-if="inLibrary" class="absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-sm">
        <svg viewBox="0 0 24 24" fill="none" class="h-3 w-3" stroke="currentColor" :stroke-width="3.5">
          <path stroke-linecap="round" stroke-linejoin="round" d="m4.5 12.75 6 6 9-13.5" />
        </svg>
      </span>
      <div class="absolute inset-x-0 bottom-0 flex translate-y-1.5 flex-col gap-1 p-2 opacity-0 transition-all duration-200 group-hover:translate-y-0 group-hover:opacity-100">
        <span class="rounded-md bg-white/95 px-2.5 py-1 text-center text-[11px] font-semibold text-zinc-900 shadow-sm">{{ $t('common.viewDetails') }}</span>
      </div>
    </div>
    <div class="mt-2 px-0.5">
      <h3 class="line-clamp-1 text-sm font-medium text-foreground" :title="title">{{ title }}</h3>
      <p v-if="latestName || tagline" class="mt-0.5 line-clamp-1 text-[11px] text-muted-foreground">{{ latestName || tagline }}</p>
      <p v-if="episodesTotal" class="mt-0.5 text-[10px] text-muted-foreground/70">{{ $t('common.totalEps', { n: episodesTotal }) }}</p>
    </div>
  </button>
</template>
