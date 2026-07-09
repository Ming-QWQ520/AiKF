<script setup lang="ts">
import { computed, ref, onMounted, onBeforeUnmount, watch } from "vue";
import { Play, ChevronLeft, ChevronRight, Flame, Clock, TrendingUp } from "lucide-vue-next";
import { anich } from "@/lib/anich/api-client";
import { useUIStore } from "@/stores/ui";
import { useAsync } from "@/composables/useAsync";
import CoverImage from "@/components/CoverImage.vue";
import { weekdayLabel, formatRelative } from "@/lib/anich/format";
import { cn } from "@/lib/utils";

const ui = useUIStore();

const { data: latestData, isLoading: latestLoading } = useAsync(() => anich.latest(), { source: () => "latest" });
const { data: calData, isLoading: calLoading } = useAsync(() => anich.calendar(), { source: () => "cal" });
const { data: listData, isLoading: listLoading } = useAsync(() => anich.list({ type: "tv", skip: 0 }), { source: () => "list" });

// Hero carousel
const heroSlides = computed(() => (latestData.value?.items ?? []).slice(0, 6));
const heroIndex = ref(0);
let heroTimer = 0;
const nextHero = () => { if (heroSlides.value.length) heroIndex.value = (heroIndex.value + 1) % heroSlides.value.length; };
const prevHero = () => { if (heroSlides.value.length) heroIndex.value = (heroIndex.value - 1 + heroSlides.value.length) % heroSlides.value.length; };
const goToHero = (i: number) => { heroIndex.value = i; };
const heroHovered = ref(false);
watch(heroHovered, (h) => {
  if (h) { if (heroTimer) { clearInterval(heroTimer); heroTimer = 0; } }
  else { if (!heroTimer) heroTimer = window.setInterval(nextHero, 5000); }
});
onMounted(() => { heroTimer = window.setInterval(nextHero, 5000); });
onBeforeUnmount(() => { if (heroTimer) clearInterval(heroTimer); });
watch(heroSlides, (s) => { if (heroIndex.value >= s.length) heroIndex.value = 0; });

// Weekly schedule
const today = new Date().getDay();
const activeDay = ref(today);
const days = computed(() => calData.value?.data ?? []);
const activeDayList = computed(() => days.value.find((d) => d.sort % 7 === activeDay.value)?.list ?? []);

// Right sidebar
const todayUpdates = computed(() => (latestData.value?.items ?? []).slice(0, 5));
const hotRank = computed(() => (listData.value?.items ?? []).slice(0, 6));

// Fresh grid
const fresh = computed(() => (listData.value?.items ?? []).slice(0, 12));
</script>

<template>
  <div class="mx-auto flex max-w-[1400px] flex-col gap-6">
    <!-- ── Top row: hero banner (left) + right sidebar (right) ── -->
    <div class="flex gap-6">
      <!-- Hero banner -->
      <section
        class="relative aspect-video flex-1 overflow-hidden rounded-2xl ring-1 ring-border/30"
        @mouseenter="heroHovered = true"
        @mouseleave="heroHovered = false"
      >
        <div v-if="latestLoading || heroSlides.length === 0" class="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-primary/5 to-secondary/5">
          <div class="h-8 w-8 animate-spin rounded-full border-2 border-border border-t-primary" />
        </div>
        <div
          v-for="(item, i) in heroSlides"
          v-show="i === heroIndex"
          :key="item.id"
          class="absolute inset-0"
        >
          <img :src="item.image" :alt="item.title" class="h-full w-full object-cover" draggable="false" loading="eager" />
          <div class="absolute inset-0 bg-gradient-to-r from-black/80 via-black/30 to-transparent" />
          <div class="absolute inset-0 bg-gradient-to-t from-black/70 to-transparent" />
          <div class="absolute inset-0 flex flex-col justify-end p-6 sm:p-8">
            <div class="max-w-md">
              <span class="mb-2 inline-block rounded bg-primary px-2 py-0.5 text-[11px] font-bold text-primary-foreground">热播</span>
              <h2 class="line-clamp-2 text-xl font-extrabold tracking-tight text-white sm:text-3xl">{{ item.title }}</h2>
              <p v-if="item.name" class="mt-1.5 line-clamp-1 text-sm text-white/60">{{ item.name }}</p>
              <button
                @click="ui.openDetail(item.id, item.image)"
                class="mt-4 flex items-center gap-2 rounded-lg bg-white px-5 py-2.5 text-sm font-bold text-black transition-colors hover:bg-white/90"
              >
                <Play class="h-4 w-4 fill-current" /> 立即观看
              </button>
            </div>
          </div>
        </div>
        <template v-if="heroSlides.length > 1">
          <button @click="prevHero" class="absolute left-3 top-1/2 z-10 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full bg-black/50 text-white hover:bg-black/70">
            <ChevronLeft class="h-4 w-4" />
          </button>
          <button @click="nextHero" class="absolute right-3 top-1/2 z-10 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full bg-black/50 text-white hover:bg-black/70">
            <ChevronRight class="h-4 w-4" />
          </button>
          <div class="absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 gap-1.5">
            <button
              v-for="(s, i) in heroSlides" :key="s.id" @click="goToHero(i)"
              :class="cn('h-1.5 rounded-full transition-all', i === heroIndex ? 'w-5 bg-white' : 'w-1.5 bg-white/40')"
            />
          </div>
        </template>
      </section>

      <!-- Right sidebar (desktop only) -->
      <aside class="hidden w-[280px] shrink-0 flex-col gap-6 lg:flex">
        <!-- 今日更新 -->
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

        <!-- 热播榜 -->
        <div>
          <div class="mb-3 flex items-center gap-2">
            <TrendingUp class="h-4 w-4 text-primary" />
            <h4 class="text-sm font-bold text-foreground">热播榜</h4>
          </div>
          <div v-if="listLoading" class="space-y-2">
            <div v-for="i in 4" :key="i" class="h-12 rounded-lg shimmer" />
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
