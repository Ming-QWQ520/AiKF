<script setup lang="ts">
import { ref, computed } from "vue";
import { CalendarDays } from "lucide-vue-next";
import { anich } from "@/lib/anich/api-client";
import { useUIStore } from "@/stores/ui";
import { useAsync } from "@/composables/useAsync";
import SectionCard from "@/components/SectionCard.vue";
import CoverImage from "@/components/CoverImage.vue";
import { weekdayLabel, formatRelative } from "@/lib/anich/format";
import { cn } from "@/lib/utils";

const ui = useUIStore();
const { data, isLoading } = useAsync(() => anich.calendar(), { source: () => "calendar" });

const today = new Date().getDay();
const activeDay = ref(today);
const days = computed(() => data.value?.data ?? []);
const active = computed(() => days.value.find((d) => d.sort % 7 === activeDay.value) ?? days.value[0]);
</script>

<template>
  <div class="mx-auto flex max-w-[1400px] flex-col gap-6">
    <SectionCard>
      <div class="flex flex-col gap-4">
        <div class="flex items-center gap-3">
          <span class="flex h-9 w-9 items-center justify-center rounded-xl bg-secondary/15 text-secondary ring-1 ring-secondary/20">
            <CalendarDays class="h-4.5 w-4.5" />
          </span>
          <div>
            <h2 class="text-lg font-bold sm:text-xl">每周放送时间表</h2>
            <p class="text-xs text-muted-foreground sm:text-sm">按星期查看当季番剧更新安排</p>
          </div>
        </div>
        <div class="no-scrollbar -mx-1 flex gap-1.5 overflow-x-auto px-1">
          <button
            v-for="d in [0, 1, 2, 3, 4, 5, 6]" :key="d"
            @click="activeDay = d"
            :class="cn('state-layer relative flex min-w-[68px] flex-col items-center gap-0.5 rounded-2xl px-4 py-2.5 text-sm font-semibold transition-colors', activeDay === d ? 'bg-primary text-primary-foreground shadow-lg shadow-primary/25' : 'text-muted-foreground hover:bg-foreground/5 hover:text-foreground')"
          >
            <span>{{ weekdayLabel(d) }}</span>
            <span :class="cn('text-[10px]', activeDay === d ? 'text-primary-foreground/80' : 'text-muted-foreground/70')">
              {{ days.find((x) => x.sort % 7 === d)?.list.length ?? 0 }} 部
            </span>
          </button>
        </div>
      </div>
    </SectionCard>

    <section class="flex flex-col gap-3">
      <div v-if="isLoading" class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <div v-for="i in 6" :key="i" class="h-24 rounded-2xl shimmer" />
      </div>
      <div v-else-if="active && active.list.length > 0" class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <button
          v-for="(item, i) in active.list" :key="item.id"
          @click="ui.openDetail(item.id, item.image)"
          :style="{ animationDelay: `${Math.min(i * 0.025, 0.3)}s` }"
          class="state-layer glass glass-sheen group flex items-center gap-3 rounded-2xl p-3 text-left fade-up"
        >
          <CoverImage :src="item.image" :alt="item.title" ratio="portrait" class="h-20 w-14 shrink-0" rounded="rounded-xl" />
          <div class="min-w-0 flex-1">
            <p class="line-clamp-1 text-sm font-semibold text-foreground">{{ item.title }}</p>
            <div class="mt-1 flex flex-wrap gap-1">
              <span v-for="g in item.genres.slice(0, 2)" :key="g" class="rounded-full bg-foreground/5 px-2 py-0.5 text-[10px] text-muted-foreground">{{ g }}</span>
              <span class="rounded-full bg-foreground/5 px-2 py-0.5 text-[10px] text-muted-foreground">{{ item.lang }}</span>
            </div>
            <p v-if="item.episodes[0]" class="mt-1.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <span :class="cn('inline-block h-1.5 w-1.5 rounded-full', item.episodes[0].future ? 'bg-tertiary' : 'bg-secondary')" />
              {{ item.episodes[0].future ? formatRelative(item.episodes[0].date) : "已更新" }} ·
              <span class="line-clamp-1">{{ item.episodes[0].name }}</span>
            </p>
          </div>
        </button>
      </div>
      <div v-else class="glass glass-sheen flex min-h-[200px] items-center justify-center rounded-3xl p-10 text-sm text-muted-foreground">
        本日暂无放送安排
      </div>
    </section>
  </div>
</template>

<style scoped>
.fade-up { animation: fadeUpC 0.4s ease both; }
@keyframes fadeUpC { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }
</style>
