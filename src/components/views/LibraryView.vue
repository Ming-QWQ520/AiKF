<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { Bookmark, Trash2, Play, CheckCircle2, Star, Library, CircleUserRound, ChevronDown, Loader2 } from "lucide-vue-next";
import { useLibraryStore, STATUS_I18N_KEYS, STATUS_ORDER, STATUS_STYLES, type TrackStatus, type LibraryEntry } from "@/stores/library";
import { useUIStore } from "@/stores/ui";
import { anich } from "@/lib/anich/api-client";
import * as bgmApi from "@/lib/bangumi/client";
import { useBangumi } from "@/lib/bangumi/useBangumi";
import { useI18n } from "vue-i18n";
import SectionCard from "@/components/SectionCard.vue";
import CoverImage from "@/components/CoverImage.vue";
import { cn } from "@/lib/utils";

const library = useLibraryStore();
const ui = useUIStore();
const { t } = useI18n();

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

// ── 集数明细（需求：观看过的集数不连续时，追番库提供逐集明细展示）──
// 展开后显示全部集数芯片；点击芯片可切换已看/未看
// （变更经 auto-sync 自动推送到 Bangumi，无需手动同步）。
const epDetailExpanded = ref<Set<number>>(new Set());

// ── 云端逐集观看状态（需求：观看集数不连续时显示真实明细）──
// 展开「集数明细」时，若条目已绑定 Bangumi 且已登录，拉取逐集收藏状态
// （GET /v0/users/-/collections/{id}/episodes）并与本地观看记录合并：
// - 云端「看过」→ 并入本地观看记录（并集语义，不删本地多看的集数）；
// - 云端「想看/抛弃」→ 芯片以对应颜色展示（本地模型无此粒度，仅展示）；
// - bgmOnly 条目总集数未知时，顺带用云端章节列表补全。
const cloudEpTypes = ref<Map<number, Map<number, number>>>(new Map());
const cloudEpLoading = ref<Set<number>>(new Set());
const cloudEpDone = new Set<number>(); // 本次运行内已拉取过的条目

const toggleEpDetail = (entry: LibraryEntry) => {
  const s = new Set(epDetailExpanded.value);
  if (s.has(entry.id)) s.delete(entry.id);
  else {
    s.add(entry.id);
    void ensureCloudEpisodes(entry);
  }
  epDetailExpanded.value = s;
};

async function ensureCloudEpisodes(entry: LibraryEntry) {
  if (!bgmApi.isLoggedIn() || !entry.bgmId) return;
  if (cloudEpDone.has(entry.id) || cloudEpLoading.value.has(entry.id)) return;
  cloudEpLoading.value = new Set(cloudEpLoading.value).add(entry.id);
  try {
    // bgmOnly / 总集数未知 → 先用云端章节列表补全（数本篇话数）
    if ((entry.totalEpisodes ?? 0) <= 0) {
      try {
        const eps = await bgmApi.getEpisodes(entry.bgmId);
        const n = eps.filter((e) => e.type === 0).length;
        if (n > 0) library.syncMeta(entry.id, { totalEpisodes: n });
      } catch {
        /* 补全失败不影响后续流程 */
      }
    }
    const items = await bgmApi.getSubjectEpisodeCollection(entry.bgmId);
    const m = new Map<number, number>();
    const cloudWatched: number[] = [];
    for (const it of items) {
      if (!it?.episode) continue;
      const num =
        typeof it.episode.ep === "number"
          ? it.episode.ep
          : it.episode.order
            ? parseFloat(it.episode.order)
            : Number.NaN;
      if (!Number.isInteger(num) || num < 1) continue;
      m.set(num, Number(it.type) || 0);
      if (Number(it.type) === 2) cloudWatched.push(num);
    }
    // 与拉取时同一对齐通道：watchedEpisodes := 云端看过 ∪ 本应用内真实标记（played），
    // 旧版顺序假设的虚假标记（如云端没看过的 1/2）在这里同样被清除
    if (cloudWatched.length > 0) library.reconcileEpisodes(entry.id, cloudWatched);
    const next = new Map(cloudEpTypes.value);
    next.set(entry.id, m);
    cloudEpTypes.value = next;
  } catch {
    /* 拉取失败静默：明细仍显示本地观看记录 */
  } finally {
    const s2 = new Set(cloudEpLoading.value);
    s2.delete(entry.id);
    cloudEpLoading.value = s2;
    cloudEpDone.add(entry.id);
  }
}

const isWatched = (entry: LibraryEntry, n: number) => entry.watchedEpisodes.includes(n);

/** 真实观看数（≤ 总集数）：与集数芯片同源，统一从逐集记录取长度。
 *  此前计数器误用 currentEpisode（「看到第几话」指针），会出现
 *  「计数 26/26 但芯片只亮 7 集」的假进度 —— 指针现在只用于「继续观看」。 */
const realWatched = (entry: LibraryEntry): number =>
  entry.totalEpisodes > 0
    ? Math.min(entry.watchedEpisodes.length, entry.totalEpisodes)
    : entry.watchedEpisodes.length;

/** 集数芯片样式：云端状态优先级展示（看过=主色 / 想看=琥珀 / 抛弃=红） */
function chipClass(entry: LibraryEntry, n: number): string {
  const ct = cloudEpTypes.value.get(entry.id)?.get(n) ?? 0;
  if (isWatched(entry, n) || ct === 2) return "bg-primary text-primary-foreground";
  if (ct === 1) return "bg-amber-500/15 text-amber-600 ring-1 ring-amber-500/40 dark:text-amber-400";
  if (ct === 3) return "bg-destructive/10 text-destructive ring-1 ring-destructive/30";
  return "bg-foreground/[0.06] text-muted-foreground hover:bg-foreground/10 hover:text-foreground";
}

function chipTip(entry: LibraryEntry, n: number): string {
  const ct = cloudEpTypes.value.get(entry.id)?.get(n) ?? 0;
  if (ct === 1) return t("library.epWish", { n });
  if (ct === 3) return t("library.epDropped", { n });
  return isWatched(entry, n) ? t("library.epWatched", { n }) : t("library.epUnwatched", { n });
}
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
              v-tip="$t('nav.me')"
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
                      {{ $t('common.episodesOf', { cur: realWatched(entry), total: entry.totalEpisodes }) }}
                      <span class="ml-1 text-muted-foreground">· {{ Math.min(100, Math.round((realWatched(entry) / entry.totalEpisodes) * 100)) }}%</span>
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
                        ? Math.min(100, Math.round((realWatched(entry) / entry.totalEpisodes) * 100))
                        : 0}%`
                    }"
                  />
                </div>

                <!-- 集数明细（需求：观看集数不连续时提供逐集明细；点击芯片可切换已看/未看）
                     bgmOnly 条目总集数未知时也可展开 —— 展开时会先从云端补全总集数 -->
                <div v-if="entry.totalEpisodes > 0 || entry.bgmId" class="mt-1.5">
                  <button
                    @click="toggleEpDetail(entry)"
                    class="flex items-center gap-1 rounded px-0.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
                  >
                    <Loader2 v-if="cloudEpLoading.has(entry.id)" class="h-3 w-3 animate-spin" />
                    <ChevronDown v-else :class="cn('h-3 w-3 transition-transform duration-200', epDetailExpanded.has(entry.id) && 'rotate-180')" />
                    {{ $t('library.epDetail') }}
                    <span class="tabular-nums">{{ realWatched(entry) }}{{ entry.totalEpisodes > 0 ? `/${entry.totalEpisodes}` : '' }}</span>
                  </button>
                  <div v-if="epDetailExpanded.has(entry.id) && entry.totalEpisodes > 0" class="mt-1.5 flex max-h-[88px] flex-wrap gap-1 overflow-y-auto">
                    <button
                      v-for="n in entry.totalEpisodes"
                      :key="n"
                      @click="library.toggleEpisode(entry.id, n, entry.totalEpisodes)"
                      :class="cn(
                        'h-6 min-w-[26px] rounded-md px-1 text-[10px] font-semibold tabular-nums transition-colors',
                        chipClass(entry, n)
                      )"
                      v-tip="chipTip(entry, n)"
                    >{{ n }}</button>
                  </div>
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
