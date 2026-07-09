<script setup lang="ts">
import { ref, computed } from "vue";
import { Bookmark, Trash2, Play, CheckCircle2, Star, Library } from "lucide-vue-next";
import { useLibraryStore, STATUS_LABELS, STATUS_ORDER, STATUS_STYLES, type TrackStatus } from "@/stores/library";
import { useUIStore } from "@/stores/ui";
import SectionCard from "@/components/SectionCard.vue";
import CoverImage from "@/components/CoverImage.vue";
import { cn } from "@/lib/utils";

const library = useLibraryStore();
const ui = useUIStore();

const filter = ref<TrackStatus | "all">("all");
const confirmClear = ref(false);

const all = computed(() => library.list);
const list = computed(() => (filter.value === "all" ? all.value : all.value.filter((e) => e.status === filter.value)));
const counts = computed(() => {
  const c: Record<string, number> = { all: all.value.length };
  for (const s of STATUS_ORDER) c[s] = all.value.filter((e) => e.status === s).length;
  return c;
});

const doClear = () => {
  if (confirmClear.value) {
    library.clearAll();
    confirmClear.value = false;
  } else {
    confirmClear.value = true;
  }
};
</script>

<template>
  <div class="mx-auto flex max-w-[1400px] flex-col gap-5">
    <SectionCard>
      <div class="flex flex-col gap-4">
        <div class="flex items-center justify-between gap-3">
          <div class="flex items-center gap-3">
            <span class="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/15 text-primary ring-1 ring-primary/20">
              <Bookmark class="h-4.5 w-4.5" />
            </span>
            <div>
              <h2 class="text-lg font-bold sm:text-xl">我的追番库</h2>
              <p class="text-xs text-muted-foreground sm:text-sm">共 {{ all.length }} 部 · 数据保存在本地</p>
            </div>
          </div>
          <button v-if="all.length > 0" @click="doClear" :class="cn('state-layer flex items-center gap-1 rounded-full px-3 py-1.5 text-xs font-medium', confirmClear ? 'bg-destructive text-destructive-foreground' : 'bg-foreground/5 text-muted-foreground hover:text-destructive')">
            <Trash2 class="h-3 w-3" /> {{ confirmClear ? "确认清空" : "清空" }}
          </button>
        </div>
        <div class="no-scrollbar flex gap-1.5 overflow-x-auto">
          <button @click="filter = 'all'" :class="cn('state-layer flex shrink-0 items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-medium transition-colors', filter === 'all' ? 'bg-primary text-primary-foreground shadow-sm shadow-primary/25' : 'bg-foreground/5 text-muted-foreground hover:text-foreground')">
            全部 <span :class="filter === 'all' ? 'opacity-80' : 'opacity-60'" class="text-[10px]">{{ counts.all }}</span>
          </button>
          <button v-for="s in STATUS_ORDER" :key="s" @click="filter = s" :class="cn('state-layer flex shrink-0 items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-medium transition-colors', filter === s ? 'bg-primary text-primary-foreground shadow-sm shadow-primary/25' : 'bg-foreground/5 text-muted-foreground hover:text-foreground')">
            <span :class="cn('h-1.5 w-1.5 rounded-full', STATUS_STYLES[s].dot)" />
            {{ STATUS_LABELS[s] }} <span :class="filter === s ? 'opacity-80' : 'opacity-60'" class="text-[10px]">{{ counts[s] ?? 0 }}</span>
          </button>
        </div>
      </div>
    </SectionCard>

    <div v-if="list.length === 0" class="glass glass-sheen flex min-h-[320px] flex-col items-center justify-center gap-3 rounded-3xl p-10 text-center">
      <Library class="h-12 w-12 text-muted-foreground/30" />
      <div>
        <p class="text-base font-semibold text-foreground">追番库还是空的</p>
        <p class="mt-1 text-sm text-muted-foreground">去发现页找到喜欢的番剧，加入追番吧</p>
      </div>
    </div>

    <div v-else class="flex flex-col gap-3">
      <TransitionGroup name="lib">
        <div v-for="(entry, i) in list" :key="entry.id" :style="{ animationDelay: `${Math.min(i * 0.02, 0.2)}s` }" class="glass glass-sheen rounded-3xl p-3 sm:p-4 fade-up">
          <div class="flex gap-3 sm:gap-4">
            <button @click="ui.openDetail(entry.id, entry.image)" class="shrink-0">
              <CoverImage :src="entry.image" :alt="entry.title" ratio="portrait" class="h-28 w-20 sm:h-32 sm:w-24" rounded="rounded-2xl" />
            </button>
            <div class="flex min-w-0 flex-1 flex-col">
              <div class="flex items-start justify-between gap-2">
                <button @click="ui.openDetail(entry.id, entry.image)" class="min-w-0 text-left">
                  <h3 class="line-clamp-1 text-base font-bold text-foreground hover:text-primary">{{ entry.title }}</h3>
                  <p v-if="entry.tagline" class="mt-0.5 line-clamp-1 text-xs text-muted-foreground">{{ entry.tagline }}</p>
                </button>
                <div class="flex shrink-0 items-center gap-1">
                  <span :class="cn('rounded-full px-2.5 py-1 text-[11px] font-semibold', STATUS_STYLES[entry.status].chip)">{{ STATUS_LABELS[entry.status] }}</span>
                  <button @click="library.remove(entry.id)" class="state-layer rounded-full p-1.5 text-muted-foreground hover:text-destructive" aria-label="移除">
                    <Trash2 class="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>

              <div class="mt-2.5">
                <div class="flex items-center justify-between text-xs text-muted-foreground">
                  <span>观看进度</span>
                  <span class="font-medium text-foreground">
                    {{ entry.watchedEpisodes.length }}{{ entry.totalEpisodes > 0 ? ` / ${entry.totalEpisodes}` : "" }} 话
                    <span v-if="entry.totalEpisodes > 0" class="ml-1 text-muted-foreground">· {{ Math.round((entry.watchedEpisodes.length / entry.totalEpisodes) * 100) }}%</span>
                  </span>
                </div>
                <div class="mt-1.5 h-2 overflow-hidden rounded-full bg-foreground/10">
                  <div class="h-full rounded-full bg-gradient-to-r from-primary to-tertiary transition-all duration-500" :style="{ width: `${entry.totalEpisodes > 0 ? Math.round((entry.watchedEpisodes.length / entry.totalEpisodes) * 100) : (entry.watchedEpisodes.length > 0 ? 100 : 0)}%` }" />
                </div>
              </div>

              <div class="mt-3 flex flex-wrap items-center gap-2">
                <button v-if="entry.currentEpisode > 0" @click="ui.openPlayer({ bangumiID: entry.id, episode: Math.max(1, entry.currentEpisode), title: entry.title, cover: entry.image })" class="state-layer flex items-center gap-1.5 rounded-full bg-primary px-3.5 py-1.5 text-xs font-semibold text-primary-foreground shadow-sm shadow-primary/25">
                  <Play class="h-3 w-3 fill-current" /> 继续观看 第{{ Math.max(1, entry.currentEpisode) }}话
                </button>
                <button @click="library.toggleEpisode(entry.id, entry.currentEpisode + 1, entry.totalEpisodes)" class="state-layer flex items-center gap-1.5 rounded-full bg-foreground/5 px-3 py-1.5 text-xs font-medium text-foreground">
                  <CheckCircle2 class="h-3 w-3" /> 标记下一话
                </button>
                <div class="flex items-center gap-0.5">
                  <button v-for="n in 10" :key="n" @click="library.setScore(entry.id, n)" class="state-layer p-0.5" :aria-label="`评分 ${n}`">
                    <Star :class="cn('h-3.5 w-3.5 transition-colors', n <= entry.score ? 'fill-tertiary text-tertiary' : 'text-muted-foreground/40')" />
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </TransitionGroup>
    </div>
  </div>
</template>

<style scoped>
.fade-up { animation: fadeUpL 0.3s ease both; }
@keyframes fadeUpL { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }
.lib-leave-active { transition: all 0.3s ease; }
.lib-leave-to { opacity: 0; transform: scale(0.96); }
</style>
