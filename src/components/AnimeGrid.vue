<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, nextTick } from "vue";
import { cn } from "@/lib/utils";
import AnimeCard from "./AnimeCard.vue";

defineProps<{
  items: Array<{
    id: number;
    title: string;
    image: string;
    tagline?: string;
    episode?: number;
    episodesTotal?: number;
    name?: string;
  }>;
  emptyHint?: string;
}>();

const emit = defineEmits<{ (e: "select", id: number, cover?: string): void }>();

// ── Dynamic grid column count via ResizeObserver ──
// CSS auto-fill + minmax is unreliable with scrollbars / subpixel rounding,
// so we measure the actual container width and compute column count in JS.
const MIN_CARD_WIDTH = 160;
const GRID_GAP = 12;
const gridContainerRef = ref<HTMLElement | null>(null);
const gridColCount = ref(2);

const onGridResize = () => {
  const el = gridContainerRef.value;
  if (!el) return;
  const available = el.clientWidth;
  const cols = Math.max(1, Math.floor((available + GRID_GAP) / (MIN_CARD_WIDTH + GRID_GAP)));
  gridColCount.value = cols;
};
let resizeObserver: ResizeObserver | null = null;
onMounted(() => {
  nextTick(() => {
    onGridResize();
    if (gridContainerRef.value) {
      resizeObserver = new ResizeObserver(() => onGridResize());
      resizeObserver.observe(gridContainerRef.value);
    }
  });
});
onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  resizeObserver = null;
});

const gridStyle = computed(() => ({
  display: 'grid',
  gridTemplateColumns: `repeat(${gridColCount.value}, minmax(0, 1fr))`,
  gap: `${GRID_GAP}px ${GRID_GAP}px`,
}));
</script>

<template>
  <div v-if="items.length === 0" class="flex min-h-[200px] flex-col items-center justify-center gap-2 rounded-3xl glass glass-sheen p-10 text-center">
    <svg viewBox="0 0 24 24" fill="none" class="h-10 w-10 text-muted-foreground/40" stroke="currentColor" stroke-width="1.5">
      <path stroke-linecap="round" stroke-linejoin="round" d="M9.879 7.519c1.171-1.025 3.071-1.025 4.242 0 1.172 1.025 1.172 2.687 0 3.712-.203.179-.43.326-.67.442-.745.361-1.45.999-1.45 1.827v.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 5.25h.008v.008H12v-.008Z" />
    </svg>
    <p class="text-sm text-muted-foreground">{{ emptyHint ?? "暂无内容" }}</p>
  </div>
  <!-- Dynamic responsive grid — column count computed via ResizeObserver. -->
  <div
    v-else
    ref="gridContainerRef"
    :class="cn('min-w-0 w-full overflow-hidden')"
    :style="gridStyle"
  >
    <AnimeCard
      v-for="(item, i) in items"
      :key="`${item.id}-${i}`"
      :id="item.id"
      :title="item.title"
      :image="item.image"
      :tagline="item.tagline"
      :episode="item.episode"
      :episodes-total="item.episodesTotal"
      :latest-name="item.name"
      :index="i"
      @select="(id, cover) => emit('select', id, cover)"
    />
  </div>
</template>
