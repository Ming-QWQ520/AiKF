<script setup lang="ts">
import { computed, ref } from "vue";
import { Flame, Clock, TrendingUp } from "lucide-vue-next";
import { anich } from "@/lib/anich/api-client";
import { useUIStore } from "@/stores/ui";
import { useAsync } from "@/composables/useAsync";
import CoverImage from "@/components/CoverImage.vue";
import HeroCarousel from "@/components/HeroCarousel.vue";
import { weekdayLabel, formatRelative } from "@/lib/anich/format";
import { cn } from "@/lib/utils";

const ui = useUIStore();

const { data: latestData, isLoading: latestLoading } = useAsync(() => anich.latest(), { source: () => "latest" });
const { data: calData, isLoading: calLoading } = useAsync(() => anich.calendar(), { source: () => "cal" });
const { data: listData, isLoading: listLoading } = useAsync(() => anich.list({ type: "tv", skip: 0 }), { source: () => "list" });

// Carousel 1 — 今日更新 (today's latest updates)
const todaySlides = computed(() =>
  (latestData.value?.items ?? []).slice(0, 6).map((s) => ({ id: s.id, image: s.image, title: s.title, subtitle: s.name }))
);
// Carousel 2 — 热播榜 (hot ranking)
const hotSlides = computed(() =>
  (listData.value?.items ?? []).slice(0, 6).map((s) => ({ id: s.id, image: s.image, title: s.title, subtitle: s.tagline }))
);

// Weekly schedule
const today = new Date().getDay();
const activeDay = ref(today);
const days = computed(() => calData.value?.data ?? []);
const activeDayList = computed(() => days.value.find((d) => d.sort % 7 === activeDay.value)?.list ?? []);

// Right sidebar — compact today's updates list
const todayUpdates = computed(() => (latestData.value?.items ?? []).slice(0, 5));
// Right sidebar — hot ranking list
const hotRank = computed(() => (listData.value?.items ?? []).slice(0, 6));

// Fresh grid
const fresh = computed(() => (listData.value?.items ?? []).slice(0, 12));
</script>

<template>
  <div class="mx-auto flex max-w-[1400px] flex-col gap-4 sm:gap-6">
    <!-- ── Row 1: today-updates carousel (left) + right sidebar (right) ── -->
    <div class="flex flex-col gap-4 lg:flex-row lg:gap-6">
      <HeroCarousel
        :slides="todaySlides"
        badge="今日更新"
        :is-loading="latestLoading"
        class-name="flex-1"
        @open="(id, cover) => ui.openDetail(id, cover)"
      >
        <template #badge-icon><Flame class="h-3 w-3" /></template>
      </HeroCarousel>

      <!-- Right sidebar (desktop only) — compact today's updates list -->
      <aside class="hidden w-[240px] shrink-0 flex-col gap-6 xl:flex xl:w-[280px]">
        <div>
          <div class="mb-3 flex items-center gap-2">
            <Flame class="h-4 w-4 text-primary" />
            <h4 class="text-sm font-bold text-foreground">今日更新</h4>
          </div>
          <div v-if="latestLoading" class="space-y-2">
            <div v-for="i in 3" :key="i" class="h-16 rounded-lg shimmer" />
          </div>
          <div v-else class="space-y-2">
            <button
              v-for="item in todayUpdates" :key="item.id"
              @click="ui.openDetail(item.id, item.image)"
              class="flex w-full items-center gap-2.5 rounded-lg p-1.5 text-left transition-colors hover:bg-foreground/5"
            >
              <CoverImage :src="item.image" :alt="item.title" ratio="portrait" class="h-12 w-9 shrink-0" rounded="rounded-md" />
              <div class="min-w-0 flex-1">
                <p class="line-clamp-1 text-xs font-medium text-foreground">{{ item.title }}</p>
                <p class="text-[10px] text-muted-foreground">第{{ item.episode }}话</p>
              </div>
            </button>
          </div>
        </div>
      </aside>
    </div>

    <!-- ── Row 2: hot-ranking carousel (left) + right sidebar (right) ── -->
    <div class="flex flex-col gap-4 lg:flex-row lg:gap-6">
      <HeroCarousel
        :slides="hotSlides"
        badge="热播榜"
        :is-loading="listLoading"
        class-name="flex-1"
        @open="(id, cover) => ui.openDetail(id, cover)"
      >
        <template #badge-icon><TrendingUp class="h-3 w-3" /></template>
      </HeroCarousel>

      <!-- Right sidebar (desktop only) — hot ranking list -->
      <aside class="hidden w-[240px] shrink-0 flex-col gap-6 xl:flex xl:w-[280px]">
        <div>
          <div class="mb-3 flex items-center gap-2">
            <TrendingUp class="h-4 w-4 text-primary" />
            <h4 class="text-sm font-bold text-foreground">热播榜</h4>
          </div>
          <div v-if="listLoading" class="space-y-2">
            <div v-for="i in 6" :key="i" class="h-9 rounded-lg shimmer" />
          </div>
          <div v-else class="space-y-1">
            <button
              v-for="(item, i) in hotRank" :key="item.id"
              @click="ui.openDetail(item.id, item.image)"
              class="flex w-full items-center gap-3 rounded-lg p-1.5 text-left transition-colors hover:bg-foreground/5"
            >
              <span :class="cn('flex h-5 w-5 shrink-0 items-center justify-center rounded text-[11px] font-bold', i < 3 ? 'bg-primary text-primary-foreground' : 'bg-foreground/10 text-muted-foreground')">{{ i + 1 }}</span>
              <span class="line-clamp-1 text-xs text-foreground">{{ item.title }}</span>
            </button>
          </div>
        </div>
      </aside>
    </div>

    <!-- ── Weekly schedule ── -->
    <section>
      <div class="mb-4 flex items-center gap-2">
        <Clock class="h-5 w-5 text-primary" />
        <h3 class="text-base font-bold text-foreground">追番时间表</h3>
      </div>
      <!-- Day tabs -->
      <div class="mb-4 flex gap-1">
        <button
          v-for="d in [0,1,2,3,4,5,6]" :key="d"
          @click="activeDay = d"
          :class="cn('rounded-lg px-4 py-1.5 text-sm font-medium transition-colors', activeDay === d ? 'bg-foreground text-background' : 'text-muted-foreground hover:bg-foreground/5')"
        >
          {{ weekdayLabel(d) }}
        </button>
      </div>
      <!-- Schedule grid -->
      <div v-if="calLoading" class="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
        <div v-for="i in 6" :key="i" class="aspect-[3/4] rounded-lg shimmer" />
      </div>
      <div v-else-if="activeDayList.length === 0" class="py-8 text-center text-sm text-muted-foreground">本日暂无放送</div>
      <div v-else class="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
        <button
          v-for="item in activeDayList.slice(0, 12)" :key="item.id"
          @click="ui.openDetail(item.id, item.image)"
          class="group flex flex-col text-left"
        >
          <CoverImage :src="item.image" :alt="item.title" ratio="portrait" rounded="rounded-lg" class="transition-transform group-hover:scale-[1.03]" />
          <p class="mt-1.5 line-clamp-1 text-xs font-medium text-foreground">{{ item.title }}</p>
          <p v-if="item.episodes[0]" class="text-[10px] text-muted-foreground">{{ item.episodes[0].future ? formatRelative(item.episodes[0].date) : `更新至${item.episodes[0].sort}话` }}</p>
        </button>
      </div>
    </section>

    <!-- ── Fresh anime grid ── -->
    <section>
      <div class="mb-4 flex items-center justify-between">
        <div class="flex items-center gap-2">
          <Flame class="h-5 w-5 text-primary" />
          <h3 class="text-base font-bold text-foreground">新番速递</h3>
        </div>
        <button @click="ui.setView('browse')" class="text-xs font-medium text-primary hover:underline">查看更多 →</button>
      </div>
      <div v-if="listLoading" class="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
        <div v-for="i in 6" :key="i" class="aspect-[3/4] rounded-lg shimmer" />
      </div>
      <div v-else class="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
        <button
          v-for="item in fresh" :key="item.id"
          @click="ui.openDetail(item.id, item.image)"
          class="group flex flex-col text-left"
        >
          <CoverImage :src="item.image" :alt="item.title" ratio="portrait" rounded="rounded-lg" class="transition-transform group-hover:scale-[1.03]" />
          <p class="mt-1.5 line-clamp-1 text-xs font-medium text-foreground">{{ item.title }}</p>
          <p v-if="item.tagline" class="text-[10px] text-muted-foreground">{{ item.tagline }}</p>
        </button>
      </div>
    </section>
  </div>
</template>
