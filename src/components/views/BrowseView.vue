<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { LayoutGrid, ChevronLeft, ChevronRight, X } from "lucide-vue-next";
import { anich } from "@/lib/anich/api-client";
import { useUIStore } from "@/stores/ui";
import { useAsync } from "@/composables/useAsync";
import type { BangumiLang, BangumiType } from "@/lib/anich/types";
import CoverImage from "@/components/CoverImage.vue";
import AnimeGridSkeleton from "@/components/AnimeGridSkeleton.vue";
import SectionCard from "@/components/SectionCard.vue";
import { cn } from "@/lib/utils";

const ui = useUIStore();
const PAGE_SIZE = 24;

const TYPE_OPTIONS: { value?: BangumiType; label: string }[] = [
  { value: undefined, label: "全部" },
  { value: "tv", label: "TV" },
  { value: "movie", label: "剧场版" },
  { value: "ova", label: "OVA" },
];
const LANG_OPTIONS: { value?: BangumiLang; label: string }[] = [
  { value: undefined, label: "全部" },
  { value: "ja", label: "日语" },
  { value: "zh", label: "国语" },
  { value: "en", label: "英语" },
  { value: "ko", label: "韩语" },
  { value: "other", label: "其他" },
];
const YEAR_OPTIONS = ["", "2026", "2025", "2024", "2023", "2022", "2021", "2020"];
const YEAR_LABELS: Record<string, string> = { "": "全部", "2020": "2020及更早" };

// Sort options (client-side since API doesn't support sort param)
const SORT_OPTIONS = [
  { value: "default", label: "默认" },
  { value: "latest", label: "最新" },
  { value: "rating", label: "评分" },
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
  <div class="mx-auto flex max-w-[1400px] flex-col gap-5">
    <!-- Filters -->
    <SectionCard>
      <div class="flex items-center justify-between gap-3">
        <div class="flex items-center gap-3">
          <span class="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/15 text-primary ring-1 ring-primary/20">
            <LayoutGrid class="h-4.5 w-4.5" />
          </span>
          <div>
            <h2 class="text-lg font-bold sm:text-xl">番剧分类</h2>
            <p class="text-xs text-muted-foreground sm:text-sm">
              筛选你感兴趣的番剧
              <template v-if="activeFilterCount > 0"> · 已应用 {{ activeFilterCount }} 个筛选</template>
            </p>
          </div>
        </div>
        <button v-if="activeFilterCount > 0" @click="clearAll" class="state-layer flex items-center gap-1 rounded-full bg-foreground/5 px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground">
          <X class="h-3 w-3" /> 清除
        </button>
      </div>

      <div class="mt-4 flex flex-col gap-3">
        <!-- 类型 -->
        <div class="flex items-start gap-3">
          <span class="mt-1.5 w-16 shrink-0 text-xs font-medium text-muted-foreground">类型</span>
          <div class="flex flex-wrap gap-1.5">
            <button v-for="o in TYPE_OPTIONS" :key="o.label" @click="setFilter('type', o.value)" :class="cn('state-layer whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-medium transition-colors', filters.type === o.value ? 'bg-primary text-primary-foreground' : 'bg-foreground/5 text-muted-foreground hover:bg-foreground/10 hover:text-foreground')">{{ o.label }}</button>
          </div>
        </div>
        <!-- 语言 -->
        <div class="flex items-start gap-3">
          <span class="mt-1.5 w-16 shrink-0 text-xs font-medium text-muted-foreground">语言</span>
          <div class="flex flex-wrap gap-1.5">
            <button v-for="o in LANG_OPTIONS" :key="o.label" @click="setFilter('lang', o.value)" :class="cn('state-layer whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-medium transition-colors', filters.lang === o.value ? 'bg-primary text-primary-foreground' : 'bg-foreground/5 text-muted-foreground hover:bg-foreground/10 hover:text-foreground')">{{ o.label }}</button>
          </div>
        </div>
        <!-- 年份 -->
        <div class="flex items-start gap-3">
          <span class="mt-1.5 w-16 shrink-0 text-xs font-medium text-muted-foreground">年份</span>
          <div class="flex flex-wrap gap-1.5">
            <button v-for="y in YEAR_OPTIONS" :key="y || 'all'" @click="setFilter('year', y)" :class="cn('state-layer whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-medium transition-colors', filters.year === y ? 'bg-primary text-primary-foreground' : 'bg-foreground/5 text-muted-foreground hover:bg-foreground/10 hover:text-foreground')">{{ YEAR_LABELS[y] ?? y }}</button>
          </div>
        </div>
        <!-- 类型标签 -->
        <div class="flex items-start gap-3">
          <span class="mt-1.5 w-16 shrink-0 text-xs font-medium text-muted-foreground">类型标签</span>
          <div class="no-scrollbar flex flex-nowrap gap-1.5 overflow-x-auto">
            <button @click="setFilter('genre', undefined)" :class="cn('state-layer whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-medium transition-colors', !filters.genre ? 'bg-primary text-primary-foreground' : 'bg-foreground/5 text-muted-foreground hover:bg-foreground/10 hover:text-foreground')">全部</button>
            <button v-for="g in (genresData ?? [])" :key="g.name" @click="setFilter('genre', g.name)" :class="cn('state-layer whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-medium transition-colors', filters.genre === g.name ? 'bg-primary text-primary-foreground' : 'bg-foreground/5 text-muted-foreground hover:bg-foreground/10 hover:text-foreground')">{{ g.name }} <span class="ml-1 text-[10px] opacity-60">{{ g.count }}</span></button>
          </div>
        </div>
        <!-- 标记 -->
        <div class="flex items-start gap-3">
          <span class="mt-1.5 w-16 shrink-0 text-xs font-medium text-muted-foreground">标记</span>
          <div class="no-scrollbar flex flex-nowrap gap-1.5 overflow-x-auto">
            <button @click="setFilter('mark', undefined)" :class="cn('state-layer whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-medium transition-colors', !filters.mark ? 'bg-primary text-primary-foreground' : 'bg-foreground/5 text-muted-foreground hover:bg-foreground/10 hover:text-foreground')">全部</button>
            <button v-for="m in (marksData ?? [])" :key="m.name" @click="setFilter('mark', m.name)" :class="cn('state-layer whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-medium transition-colors', filters.mark === m.name ? 'bg-primary text-primary-foreground' : 'bg-foreground/5 text-muted-foreground hover:bg-foreground/10 hover:text-foreground')">{{ m.name }} <span class="ml-1 text-[10px] opacity-60">{{ m.count }}</span></button>
          </div>
        </div>
        <!-- 排序 -->
        <div class="flex items-start gap-3">
          <span class="mt-1.5 w-16 shrink-0 text-xs font-medium text-muted-foreground">排序</span>
          <div class="flex flex-wrap gap-1.5">
            <button v-for="o in SORT_OPTIONS" :key="o.value" @click="sortKey = o.value" :class="cn('state-layer whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-medium transition-colors', sortKey === o.value ? 'bg-primary text-primary-foreground' : 'bg-foreground/5 text-muted-foreground hover:bg-foreground/10 hover:text-foreground')">{{ o.label }}</button>
          </div>
        </div>
      </div>
    </SectionCard>

    <!-- Results -->
    <section class="flex flex-col gap-4">
      <div class="flex items-center justify-between">
        <p class="text-sm text-muted-foreground">{{ isLoading ? "加载中…" : `共 ${items.length}${hasNext ? "+" : ""} 部结果` }}</p>
        <div class="flex items-center gap-1.5">
          <button :disabled="!hasPrev" @click="ui.setBrowseFilters({ skip: Math.max(0, filters.skip - PAGE_SIZE) })" :class="cn('state-layer flex h-8 w-8 items-center justify-center rounded-full transition-colors', !hasPrev ? 'cursor-not-allowed text-muted-foreground/30' : 'glass text-foreground hover:bg-foreground/10')"><ChevronLeft class="h-4 w-4" /></button>
          <span class="min-w-[3.5rem] text-center text-xs font-medium text-muted-foreground">第 {{ Math.floor(filters.skip / PAGE_SIZE) + 1 }} 页</span>
          <button :disabled="!hasNext" @click="ui.setBrowseFilters({ skip: filters.skip + PAGE_SIZE })" :class="cn('state-layer flex h-8 w-8 items-center justify-center rounded-full transition-colors', !hasNext ? 'cursor-not-allowed text-muted-foreground/30' : 'glass text-foreground hover:bg-foreground/10')"><ChevronRight class="h-4 w-4" /></button>
        </div>
      </div>
      <AnimeGridSkeleton v-if="isLoading" :count="PAGE_SIZE" />
      <!-- Card grid with rating + metadata (like screenshot) -->
      <div v-else-if="items.length === 0" class="glass glass-sheen flex min-h-[200px] items-center justify-center rounded-3xl p-10 text-center text-muted-foreground">
        没有符合条件的番剧，试试调整筛选
      </div>
      <div v-else class="grid grid-cols-2 gap-x-4 gap-y-5 sm:grid-cols-3 sm:gap-x-5 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
        <button
          v-for="item in items" :key="item.id"
          @click="ui.openDetail(item.id, item.image)"
          class="group flex flex-col text-left"
        >
          <CoverImage :src="item.image" :alt="item.title" ratio="portrait" rounded="rounded-lg" class="transition-transform group-hover:scale-[1.03]" />
          <p class="mt-1.5 line-clamp-1 text-xs font-medium text-foreground">{{ item.title }}</p>
          <p v-if="item.tagline" class="text-[10px] text-muted-foreground">{{ item.tagline }}</p>
          <div class="mt-0.5 flex items-center gap-2 text-[10px] text-muted-foreground">
            <span v-if="item.episode" class="text-secondary">更新至{{ item.episode }}话</span>
            <span v-if="item.episodesTotal">共{{ item.episodesTotal }}话</span>
          </div>
        </button>
      </div>
    </section>
  </div>
</template>
