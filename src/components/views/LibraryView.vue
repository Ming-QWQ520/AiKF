<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { Bookmark, Trash2, Play, CheckCircle2, Star, Library, CircleUserRound } from "lucide-vue-next";
import { useLibraryStore, STATUS_I18N_KEYS, STATUS_ORDER, STATUS_STYLES, type TrackStatus } from "@/stores/library";
import { useUIStore } from "@/stores/ui";
import { anich } from "@/lib/anich/api-client";
import { useBangumi } from "@/lib/bangumi/useBangumi";
import SectionCard from "@/components/SectionCard.vue";
import CoverImage from "@/components/CoverImage.vue";
import { cn } from "@/lib/utils";

const library = useLibraryStore();
const ui = useUIStore();

const filter = ref<TrackStatus | "all">("all");
const confirmClear = ref(false);

// ── Bangumi 登录态（需求：登录后仅展示头像+名称，无其它内容）──
// 用户信息由 NavShell 壳层挂载时统一拉取，此处不再重复请求。
const bgm = useBangumi();

// ── 旧数据自动修复：历史条目可能缺失 totalEpisodes（=0），导致追番库无法
// 显示「已看 X / 总 Y 话 · Z%」，且主卡片进度条被误拉满。进入本页时后台
// 逐个拉取集数列表补全（请求经 withCache + in-flight 去重，失败静默）。
onMounted(async () => {
  const broken = library.list.filter((e) => (e.totalEpisodes ?? 0) <= 0);
  if (broken.length === 0) return;
  await Promise.allSettled(
    broken.map(async (e) => {
      try {
        const eps = await anich.episodes(e.id);
        if (Array.isArray(eps) && eps.length > 0) {
          library.syncMeta(e.id, { totalEpisodes: eps.length });
        }
      } catch {
        /* 拉取失败不影响页面，下次进入重试 */
      }
    })
  );
});

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
// 注：云同步已全自动化 —— 每次修改约 3 秒后自动推送变更条目（auto-sync.ts），
// 登录/启动时自动从云端拉取（useBangumi），页面不再提供任何手动同步按钮。</script>

<template>
  <div class="mx-auto flex max-w-[1400px] flex-col gap-5">
    <SectionCard>
      <div class="flex flex-col gap-4">
        <div class="flex items-center justify-between gap-3">
          <div class="flex items-center gap-3">
            <span class="flex h-9 w-9 items-center justify-center rounded-lg bg-muted text-muted-foreground ring-1 ring-border">
              <Bookmark class="h-4.5 w-4.5" />
            </span>
            <div>
              <h2 class="text-lg font-semibold sm:text-xl">{{ $t('library.title') }}</h2>
              <p class="text-xs text-muted-foreground sm:text-sm">{{ $t('library.subtitle', { n: all.length }) }}</p>
            </div>
          </div>
          <div class="flex shrink-0 items-center gap-2">
            <!-- 登录后仅展示 Bangumi 头像 + 名称（点击进入「我的」） -->
            <button
              v-if="bgm.loggedIn.value"
              @click="ui.setView('settings')"
              class="flex items-center gap-2 rounded-full bg-muted/60 py-1 pl-1 pr-3 transition-colors hover:bg-muted"
              :title="$t('nav.me')"
            >
              <img
                v-if="bgm.user.value?.avatar?.medium"
                :src="bgm.user.value.avatar.medium"
                alt=""
                class="h-6 w-6 shrink-0 rounded-full object-cover ring-1 ring-border"
                draggable="false"
              />
              <span v-else class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-background ring-1 ring-border">
                <CircleUserRound class="h-3.5 w-3.5 text-muted-foreground" />
              </span>
              <span class="max-w-[140px] truncate text-xs font-medium text-foreground">{{ bgm.user.value?.nickname || bgm.user.value?.username || 'Bangumi' }}</span>
            </button>
            <button v-if="all.length > 0" @click="doClear" :class="cn('state-layer flex items-center gap-1 rounded-lg border px-3 py-1.5 text-xs font-medium', confirmClear ? 'border-destructive bg-destructive text-destructive-foreground' : 'border-border text-muted-foreground hover:border-destructive/40 hover:text-destructive')">
              <Trash2 class="h-3 w-3" /> {{ confirmClear ? $t('library.confirmClear') : $t('library.clear') }}
            </button>
          </div>
        </div>
        <div class="no-scrollbar flex gap-1.5 overflow-x-auto">
          <button @click="filter = 'all'" :class="cn('state-layer flex shrink-0 items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-medium transition-colors', filter === 'all' ? 'bg-foreground text-background' : 'bg-muted text-muted-foreground hover:text-foreground')">
            {{ $t('common.all') }} <span :class="filter === 'all' ? 'opacity-70' : 'opacity-60'" class="text-[10px]">{{ counts.all }}</span>
          </button>
          <button v-for="s in STATUS_ORDER" :key="s" @click="filter = s" :class="cn('state-layer flex shrink-0 items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-medium transition-colors', filter === s ? 'bg-foreground text-background' : 'bg-muted text-muted-foreground hover:text-foreground')">
            <span :class="cn('h-1.5 w-1.5 rounded-full', STATUS_STYLES[s].dot)" />
            {{ $t(STATUS_I18N_KEYS[s]) }} <span :class="filter === s ? 'opacity-70' : 'opacity-60'" class="text-[10px]">{{ counts[s] ?? 0 }}</span>
          </button>
        </div>
      </div>
    </SectionCard>

    <div v-if="list.length === 0" class="surface flex min-h-[320px] flex-col items-center justify-center gap-3 rounded-2xl p-10 text-center">
      <Library class="h-12 w-12 text-muted-foreground/30" />
      <div>
        <p class="text-base font-semibold text-foreground">{{ $t('library.empty') }}</p>
        <p class="mt-1 text-sm text-muted-foreground">{{ $t('library.emptyHint') }}</p>
      </div>
    </div>

    <div v-else class="flex flex-col gap-3">
      <TransitionGroup name="lib">
        <div v-for="(entry, i) in list" :key="entry.id" :style="{ animationDelay: `${Math.min(i * 0.02, 0.2)}s` }" class="surface rounded-2xl p-3 fade-up hover:border-foreground/20 sm:p-4">
          <div class="flex gap-3 sm:gap-4">
            <button @click="ui.openDetail(entry.id, entry.image)" class="shrink-0">
              <CoverImage :src="entry.image" :alt="entry.title" ratio="portrait" class="h-28 w-20 sm:h-32 sm:w-24" rounded="rounded-xl" />
            </button>
            <div class="flex min-w-0 flex-1 flex-col">
              <div class="flex items-start justify-between gap-2">
                <button @click="ui.openDetail(entry.id, entry.image)" class="min-w-0 text-left">
                  <h3 class="line-clamp-1 text-base font-bold text-foreground hover:text-primary">{{ entry.title }}</h3>
                  <p v-if="entry.tagline" class="mt-0.5 line-clamp-1 text-xs text-muted-foreground">{{ entry.tagline }}</p>
                </button>
                <div class="flex shrink-0 items-center gap-1">
                  <span :class="cn('rounded-full px-2.5 py-1 text-[11px] font-semibold', STATUS_STYLES[entry.status].chip)">{{ $t(STATUS_I18N_KEYS[entry.status]) }}</span>
                  <button @click="library.remove(entry.id)" class="state-layer rounded-full p-1.5 text-muted-foreground hover:text-destructive" :aria-label="$t('library.remove')">
                    <Trash2 class="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>

              <div class="mt-2.5">
                <div class="flex items-center justify-between text-xs">
                  <span class="text-muted-foreground">{{ $t('library.progress') }}</span>
                  <span class="font-medium text-foreground tabular-nums">
                    <template v-if="entry.totalEpisodes > 0">
                      {{ $t('common.episodesOf', { cur: entry.currentEpisode || entry.watchedEpisodes.length, total: entry.totalEpisodes }) }}
                      <span class="ml-1 text-muted-foreground">· {{ Math.min(100, Math.round(((entry.currentEpisode || entry.watchedEpisodes.length) / entry.totalEpisodes) * 100)) }}%</span>
                    </template>
                    <template v-else-if="entry.watchedEpisodes.length > 0">
                      {{ $t('library.watchedN', { n: entry.watchedEpisodes.length }) }}
                    </template>
                    <template v-else>
                      {{ $t('common.notStarted') }}
                    </template>
                  </span>
                </div>
                <div class="mt-1.5 h-1.5 overflow-hidden rounded-full bg-foreground/10">
                  <div
                    class="h-full rounded-full bg-primary transition-all duration-500"
                    :style="{
                      width: `${entry.totalEpisodes > 0
                        ? Math.min(100, Math.round(((entry.currentEpisode || entry.watchedEpisodes.length) / entry.totalEpisodes) * 100))
                        : 0}%`
                    }"
                  />
                </div>
              </div>

              <div class="mt-3 flex flex-wrap items-center gap-2">
                <button v-if="entry.currentEpisode > 0" @click="ui.openPlayer({ bangumiID: entry.id, episode: Math.max(1, entry.currentEpisode), title: entry.title, cover: entry.image })" class="state-layer flex items-center gap-1.5 rounded-lg bg-primary px-3.5 py-1.5 text-xs font-semibold text-primary-foreground transition-opacity hover:opacity-90">
                  <Play class="h-3 w-3 fill-current" /> {{ $t('library.continueAt', { n: Math.max(1, entry.currentEpisode) }) }}
                </button>
                <button @click="library.toggleEpisode(entry.id, entry.currentEpisode + 1, entry.totalEpisodes)" class="state-layer flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-foreground/5">
                  <CheckCircle2 class="h-3 w-3" /> {{ $t('library.markNext') }}
                </button>
                <div class="flex items-center gap-0.5">
                  <button v-for="n in 10" :key="n" @click="library.setScore(entry.id, n)" class="state-layer p-0.5" :aria-label="$t('library.rateN', { n })">
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
