<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { LayoutGrid, ChevronLeft, ChevronRight, X } from "lucide-vue-next";
import { anich } from "@/lib/anich/api-client";
import { useUIStore } from "@/stores/ui";
import { useAsync } from "@/composables/useAsync";
import { useResponsiveGrid } from "@/composables/useResponsiveGrid";
import type { BangumiLang, BangumiType } from "@/lib/anich/types";
import CoverImage from "@/components/CoverImage.vue";
import AnimeGridSkeleton from "@/components/AnimeGridSkeleton.vue";
import SectionCard from "@/components/SectionCard.vue";
import { cn } from "@/lib/utils";

const ui = useUIStore();
const PAGE_SIZE = 24;

const TYPE_OPTIONS: { value?: BangumiType; labelKey: string }[] = [
  { value: undefined, labelKey: "common.all" },
  { value: "tv", labelKey: "browse.typeTv" },
  { value: "movie", labelKey: "browse.typeMovie" },
  { value: "ova", labelKey: "browse.typeOva" },
];
const LANG_OPTIONS: { value?: BangumiLang; labelKey: string }[] = [
  { value: undefined, labelKey: "common.all" },
  { value: "ja", labelKey: "common.langNames.ja" },
  { value: "zh", labelKey: "common.langNames.zh" },
  { value: "en", labelKey: "common.langNames.en" },
  { value: "ko", labelKey: "common.langNames.ko" },
  { value: "other", labelKey: "common.langNames.other" },
];
const YEAR_OPTIONS = ["", "2026", "2025", "2024", "2023", "2022", "2021", "2020"];
const YEAR_LABEL_KEYS: Record<string, string> = { "": "common.all", "2020": "browse.year2020" };

// Sort options (client-side since API doesn't support sort param)
const SORT_OPTIONS = [
  { value: "default", labelKey: "browse.sortDefault" },
  { value: "latest", labelKey: "browse.sortLatest" },
  { value: "rating", labelKey: "browse.sortRating" },
] as const;
type SortKey = typeof SORT_OPTIONS[number]["value"];
const sortKey = ref<SortKey>("default");

const { data: genresData } = useAsync(() => anich.tags("genre", 0), { source: () => "g" });
const { data: marksData } = useAsync(() => anich.tags("mark", 0), { source: () => "m" });

const filters = computed(() => ({ ...ui.browseFilters }));
const { data: listData, isLoading } = useAsync(() => anich.list(filters.value), { source: filters });

const rawItems = computed(() => listData.value?.items ?? []);
const items = computed(() => {
  const arr = [...rawItems.value];
  if (sortKey.value === "latest") {
    arr.sort((a, b) => (b.date || 0) - (a.date || 0));
  } else if (sortKey.value === "rating") {
    // We don't have rating in list items, so sort by episodesTotal desc as proxy
    arr.sort((a, b) => (b.episodesTotal || 0) - (a.episodesTotal || 0));
  }
  return arr;
});

const hasPrev = computed(() => filters.value.skip > 0);
const hasNext = computed(() => rawItems.value.length >= PAGE_SIZE);

// Bulletproof responsive grid — measures container width via ResizeObserver
// and computes column count in JS. Never overflows (see composable docs).
// Pass `trigger` so the grid recomputes when:
// - data loads (skeleton → grid switch causes scrollbar to disappear)
// - sidebar toggles (main container width changes)
// NOTE: must be declared AFTER `items` — the watch() inside evaluates the
// trigger getter synchronously, so referencing later-declared consts here
// would throw a TDZ ReferenceError and abort the whole mount.
const { containerRef: gridContainerRef, style: gridStyle } = useResponsiveGrid({
  minWidth: 160,
  gap: 12,
  trigger: () => `${items.value.length}-${ui.sidebarCollapsed}`,
});

const activeFilterCount = computed(() =>
  (filters.value.type ? 1 : 0) + (filters.value.lang ? 1 : 0) + (filters.value.year ? 1 : 0) +
  (filters.value.genre ? 1 : 0) + (filters.value.mark ? 1 : 0) + (sortKey.value !== "default" ? 1 : 0)
);

const setFilter = <K extends keyof typeof ui.browseFilters>(k: K, v: (typeof ui.browseFilters)[K]) => {
  ui.setBrowseFilters({ [k]: v, skip: 0 } as any);
};
const clearAll = () => {
  ui.resetBrowseSkip();
  ui.setBrowseFilters({ type: undefined, lang: undefined, year: "", genre: undefined, mark: undefined });
  sortKey.value = "default";
};

watch(() => filters.value.skip, () => window.scrollTo({ top: 0, behavior: "smooth" }));

</script>

<template>
  <div class="mx-auto flex w-full min-w-0 max-w-[1400px] flex-col gap-5 overflow-x-hidden px-1">
    <!-- Filters -->
    <SectionCard>
      <div class="flex items-center justify-between gap-3">
        <div class="flex items-center gap-3">
          <span class="flex h-9 w-9 items-center justify-center rounded-lg bg-muted text-muted-foreground ring-1 ring-border">
            <LayoutGrid class="h-4.5 w-4.5" />
          </span>
          <div>
            <h2 class="text-lg font-semibold sm:text-xl">{{ $t('browse.title') }}</h2>
            <p class="text-xs text-muted-foreground sm:text-sm">
              {{ $t('browse.subtitle') }}
              <template v-if="activeFilterCount > 0"> · {{ $t('browse.applied', { n: activeFilterCount }) }}</template>
            </p>
          </div>
        </div>
        <button v-if="activeFilterCount > 0" @click="clearAll" class="state-layer flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground">
          <X class="h-3 w-3" /> {{ $t('browse.clear') }}
        </button>
      </div>

      <div class="mt-4 flex min-w-0 flex-col gap-3">
        <!-- 类型 -->
        <div class="flex min-w-0 items-start gap-3">
          <span class="mt-1.5 w-16 shrink-0 text-xs font-medium text-muted-foreground">{{ $t('browse.type') }}</span>
          <div class="flex min-w-0 flex-wrap gap-1.5">
            <button v-for="o in TYPE_OPTIONS" :key="o.labelKey" @click="setFilter('type', o.value)" :class="cn('state-layer whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-medium transition-colors', filters.type === o.value ? 'bg-foreground text-background' : 'bg-muted text-muted-foreground hover:bg-accent hover:text-foreground')">{{ $t(o.labelKey) }}</button>
          </div>
        </div>
        <!-- 语言 -->
        <div class="flex min-w-0 items-start gap-3">
          <span class="mt-1.5 w-16 shrink-0 text-xs font-medium text-muted-foreground">{{ $t('browse.lang') }}</span>
          <div class="flex min-w-0 flex-wrap gap-1.5">
            <button v-for="o in LANG_OPTIONS" :key="o.labelKey" @click="setFilter('lang', o.value)" :class="cn('state-layer whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-medium transition-colors', filters.lang === o.value ? 'bg-foreground text-background' : 'bg-muted text-muted-foreground hover:bg-accent hover:text-foreground')">{{ $t(o.labelKey) }}</button>
          </div>
        </div>
        <!-- 年份 -->
        <div class="flex min-w-0 items-start gap-3">
          <span class="mt-1.5 w-16 shrink-0 text-xs font-medium text-muted-foreground">{{ $t('browse.year') }}</span>
          <div class="flex min-w-0 flex-wrap gap-1.5">
            <button v-for="y in YEAR_OPTIONS" :key="y || 'all'" @click="setFilter('year', y)" :class="cn('state-layer whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-medium transition-colors', filters.year === y ? 'bg-foreground text-background' : 'bg-muted text-muted-foreground hover:bg-accent hover:text-foreground')">{{ YEAR_LABEL_KEYS[y] ? $t(YEAR_LABEL_KEYS[y]) : y }}</button>
          </div>
        </div>
        <!-- 类型标签 — flex-wrap so tags wrap to next line instead of overflowing -->
        <div class="flex min-w-0 items-start gap-3">
          <span class="mt-1.5 w-16 shrink-0 text-xs font-medium text-muted-foreground">{{ $t('browse.genre') }}</span>
          <div class="flex min-w-0 flex-wrap gap-1.5">
            <button @click="setFilter('genre', undefined)" :class="cn('state-layer whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-medium transition-colors', !filters.genre ? 'bg-foreground text-background' : 'bg-muted text-muted-foreground hover:bg-accent hover:text-foreground')">{{ $t('common.all') }}</button>
            <button v-for="g in (genresData ?? [])" :key="g.name" @click="setFilter('genre', g.name)" :class="cn('state-layer whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-medium transition-colors', filters.genre === g.name ? 'bg-foreground text-background' : 'bg-muted text-muted-foreground hover:bg-accent hover:text-foreground')">{{ g.name }} <span class="ml-1 text-[10px] opacity-60">{{ g.count }}</span></button>
          </div>
        </div>
        <!-- 标记 — flex-wrap so tags wrap to next line instead of overflowing -->
        <div class="flex min-w-0 items-start gap-3">
          <span class="mt-1.5 w-16 shrink-0 text-xs font-medium text-muted-foreground">{{ $t('browse.mark') }}</span>
          <div class="flex min-w-0 flex-wrap gap-1.5">
            <button @click="setFilter('mark', undefined)" :class="cn('state-layer whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-medium transition-colors', !filters.mark ? 'bg-foreground text-background' : 'bg-muted text-muted-foreground hover:bg-accent hover:text-foreground')">{{ $t('common.all') }}</button>
            <button v-for="m in (marksData ?? [])" :key="m.name" @click="setFilter('mark', m.name)" :class="cn('state-layer whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-medium transition-colors', filters.mark === m.name ? 'bg-foreground text-background' : 'bg-muted text-muted-foreground hover:bg-accent hover:text-foreground')">{{ m.name }} <span class="ml-1 text-[10px] opacity-60">{{ m.count }}</span></button>
          </div>
        </div>
        <!-- 排序 -->
        <div class="flex min-w-0 items-start gap-3">
          <span class="mt-1.5 w-16 shrink-0 text-xs font-medium text-muted-foreground">{{ $t('browse.sort') }}</span>
          <div class="flex min-w-0 flex-wrap gap-1.5">
            <button v-for="o in SORT_OPTIONS" :key="o.value" @click="sortKey = o.value" :class="cn('state-layer whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-medium transition-colors', sortKey === o.value ? 'bg-foreground text-background' : 'bg-muted text-muted-foreground hover:bg-accent hover:text-foreground')">{{ $t(o.labelKey) }}</button>
          </div>
        </div>
      </div>
    </SectionCard>

    <!-- Results -->
    <section class="flex min-w-0 flex-col gap-4">
      <div class="flex items-center justify-between">
        <p class="text-sm text-muted-foreground">{{ isLoading ? $t('common.loading') : $t('browse.resultCount', { n: items.length, suffix: hasNext ? '+' : '' }) }}</p>
        <div class="flex items-center gap-1.5">
          <button :disabled="!hasPrev" @click="ui.setBrowseFilters({ skip: Math.max(0, filters.skip - PAGE_SIZE) })" :class="cn('state-layer flex h-8 w-8 items-center justify-center rounded-lg border transition-colors', !hasPrev ? 'cursor-not-allowed border-border text-muted-foreground/30' : 'surface text-foreground hover:border-foreground/25')"><ChevronLeft class="h-4 w-4" /></button>
          <span class="min-w-[3.5rem] text-center text-xs font-medium text-muted-foreground">{{ $t('common.pageN', { n: Math.floor(filters.skip / PAGE_SIZE) + 1 }) }}</span>
          <button :disabled="!hasNext" @click="ui.setBrowseFilters({ skip: filters.skip + PAGE_SIZE })" :class="cn('state-layer flex h-8 w-8 items-center justify-center rounded-lg border transition-colors', !hasNext ? 'cursor-not-allowed border-border text-muted-foreground/30' : 'surface text-foreground hover:border-foreground/25')"><ChevronRight class="h-4 w-4" /></button>
        </div>
      </div>
      <AnimeGridSkeleton v-if="isLoading" :count="PAGE_SIZE" />
      <!-- Card grid with rating + metadata (like screenshot) -->
      <div v-else-if="items.length === 0" class="surface flex min-h-[200px] items-center justify-center rounded-2xl p-10 text-center text-muted-foreground">
        {{ $t('browse.noResults') }}
      </div>
      <!-- Dynamic responsive grid. Column count is computed in JS based on
           the actual measured container width (via ResizeObserver). Container
           has overflow:hidden + contain:layout + maxWidth:100% as triple
           protection against any subpixel rounding or scrollbar timing issues. -->
      <div
        v-else
        ref="gridContainerRef"
        class="min-w-0 w-full overflow-hidden"
        :style="{ ...gridStyle, contain: 'layout', maxWidth: '100%' }"
      >
        <button
          v-for="item in items" :key="item.id"
          @click="ui.openDetail(item.id, item.image)"
          class="group flex min-w-0 flex-col text-left"
        >
          <CoverImage :src="item.image" :alt="item.title" ratio="portrait" rounded="rounded-lg" class="transition-transform group-hover:scale-[1.03]" />
          <p class="mt-1.5 line-clamp-1 text-xs font-medium text-foreground">{{ item.title }}</p>
          <p v-if="item.tagline" class="line-clamp-1 text-[10px] text-muted-foreground">{{ item.tagline }}</p>
          <div class="mt-0.5 flex items-center gap-2 text-[10px] text-muted-foreground">
            <span v-if="item.episode" class="text-secondary">{{ $t('common.upToEp', { n: item.episode }) }}</span>
            <span v-if="item.episodesTotal">{{ $t('common.totalEps', { n: item.episodesTotal }) }}</span>
          </div>
        </button>
      </div>
    </section>
  </div>
</template>
