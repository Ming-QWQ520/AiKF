<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { Play, Star, Heart, ChevronDown } from "lucide-vue-next";
import { anich } from "@/lib/anich/api-client";
import { useUIStore } from "@/stores/ui";
import { useLibraryStore, STATUS_LABELS, STATUS_ORDER, STATUS_STYLES, type TrackStatus } from "@/stores/library";
import { useAsync } from "@/composables/useAsync";
import { useResponsiveGrid } from "@/composables/useResponsiveGrid";
import CoverImage from "@/components/CoverImage.vue";
import { cn } from "@/lib/utils";

const ui = useUIStore();
const library = useLibraryStore();

const idRef = computed(() => ui.detailId);
const { data: detail, isLoading: detailLoading } = useAsync(() => anich.detail(idRef.value!), { enabled: idRef, source: idRef });
const { data: episodes } = useAsync(() => anich.episodes(idRef.value!), { enabled: idRef, source: idRef });
const { data: related } = useAsync(() => anich.related(idRef.value!), { enabled: idRef, source: idRef });
const { data: characters } = useAsync(() => anich.characters(idRef.value!), { enabled: idRef, source: idRef });

const entry = computed(() => (ui.detailId != null ? library.entries[ui.detailId] : undefined));
const cover = computed(() => detail.value?.image || ui.detailCover);
const bestRating = computed(() => detail.value?.rating?.find((r) => r.score > 0));

/** 角色图加载失败 → 隐藏图片留底色占位 */
const onCharImgError = (e: Event) => {
  (e.target as HTMLElement).style.opacity = "0";
};

// ── Tabs (reference app order: 详情 / 剧集 / 评论 / 角色 / 推荐) ──
const activeTab = ref<"info" | "episodes" | "comments" | "characters" | "related">("info");
const TABS = [
  { key: "info", label: "详情" },
  { key: "episodes", label: "剧集" },
  { key: "comments", label: "评论" },
  { key: "characters", label: "角色" },
  { key: "related", label: "推荐" },
] as const;

// ── Hero helpers ──
const LANG_LABELS: Record<string, string> = { ja: "日语", zh: "国语", en: "英语", ko: "韩语", other: "其他" };
const langLabel = (l?: string) => (l ? LANG_LABELS[l] ?? l : "");
const fmtCnDate = (ts?: number) => {
  if (!ts || ts <= 0) return "—";
  const d = new Date(ts);
  return `${d.getFullYear()}年${String(d.getMonth() + 1).padStart(2, "0")}月${String(d.getDate()).padStart(2, "0")}日`;
};
const fmtEpDate = (ts?: number) => {
  if (!ts || ts <= 0) return "";
  const d = new Date(ts);
  const base = `${d.getFullYear()}年${String(d.getMonth() + 1).padStart(2, "0")}月${String(d.getDate()).padStart(2, "0")}日`;
  const t = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
  return `${base} ${t}`;
};
const fmtEpDuration = (sec?: number) => {
  if (!sec || sec <= 0) return "";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
};
/** Star fill ratio: anich ratings are on a 10-point scale. */
const starPct = computed(() => {
  const s = bestRating.value?.score ?? 0;
  return `${Math.max(0, Math.min(100, (s / 10) * 100))}%`;
});

/** Episode currently open in the player (for the ring highlight). */
const playingEpisode = computed(() =>
  ui.player.open && ui.player.bangumiID === ui.detailId ? ui.player.episode : null
);

// ── Responsive grids ──
const { containerRef: epGridRef, style: epGridStyle } = useResponsiveGrid({
  minWidth: 188,
  gap: 14,
  trigger: () => `${episodes.value?.length ?? 0}-${activeTab.value === "episodes" ? 1 : 0}-${ui.sidebarCollapsed}`,
});
const { containerRef: relatedGridRef, style: relatedGridStyle } = useResponsiveGrid({
  minWidth: 160,
  gap: 12,
  trigger: () => `${related.value?.length ?? 0}-${activeTab.value === "related" ? 1 : 0}-${ui.sidebarCollapsed}`,
});
const { containerRef: charGridRef, style: charGridStyle } = useResponsiveGrid({
  minWidth: 112,
  gap: 12,
  trigger: () => `${characters.value?.length ?? 0}-${ui.sidebarCollapsed}`,
});

// ── Library metadata sync (unchanged behaviour) ──
watch(() => detail.value, (d) => {
  if (!d || ui.detailId == null) return;
  if (!library.has(ui.detailId)) return;
  const total = d.episodesTotal || (episodes.value?.length ?? 0) || 0;
  library.syncMeta(ui.detailId, {
    title: d.title,
    image: d.image,
    tagline: d.genres?.join("/"),
    totalEpisodes: total,
  });
}, { immediate: true });

watch(() => episodes.value, (eps) => {
  if (!eps || ui.detailId == null) return;
  if (!library.has(ui.detailId)) return;
  const existing = library.get(ui.detailId);
  if (eps.length > 0 && (existing?.totalEpisodes ?? 0) < eps.length) {
    library.syncMeta(ui.detailId, { totalEpisodes: eps.length });
  }
}, { immediate: true });

// ── Comments ──
const { data: commentsData, isLoading: commentsLoading } = useAsync(
  () => anich.comments(idRef.value!, 1, undefined),
  { enabled: idRef, source: idRef }
);
const { data: commentCountData } = useAsync(
  () => anich.commentCount(idRef.value!, 1),
  { enabled: idRef, source: idRef }
);
const comments = computed(() => commentsData.value?.body?.data ?? []);
const commentCount = computed(() => commentCountData.value?.body?.data ?? 0);

const expandedReplies = ref<Set<string>>(new Set());
const repliesCache = ref<Record<string, any[]>>({});
const repliesLoading = ref<Set<string>>(new Set());

const toggleReplies = async (commentId: string) => {
  if (expandedReplies.value.has(commentId)) {
    expandedReplies.value.delete(commentId);
    return;
  }
  expandedReplies.value.add(commentId);
  if (!repliesCache.value[commentId]) {
    repliesLoading.value.add(commentId);
    try {
      const res = await anich.commentReplies(commentId);
      repliesCache.value[commentId] = res.body?.data ?? [];
    } catch { repliesCache.value[commentId] = []; }
    repliesLoading.value.delete(commentId);
  }
};

const fmtCommentDate = (ts: number) => {
  if (!ts) return "";
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

// ── Actions ──
const ensureEntry = () => {
  if (!detail.value || ui.detailId == null) return false;
  if (!library.has(ui.detailId)) {
    library.addOrUpdate(
      { id: detail.value.id, title: detail.value.title, image: detail.value.image, tagline: detail.value.genres.join("/"), totalEpisodes: detail.value.episodesTotal },
      "watching"
    );
    return true;
  }
  return library.has(ui.detailId);
};

const handlePlay = (episode: number) => {
  ensureEntry();
  ui.openPlayer({ bangumiID: ui.detailId!, episode, title: detail.value?.title ?? "", cover: cover.value });
};

/**
 * 收藏按键（需求 v0.1.0）：
 * - 未收藏 → 点击直接收藏，默认「在看」状态；
 * - 已收藏 → 点击弹出菜单，可修改追番状态或取消收藏。
 */
const statusMenuOpen = ref(false);
const toggleFav = () => {
  if (ui.detailId == null || !detail.value) return;
  if (library.has(ui.detailId)) {
    statusMenuOpen.value = !statusMenuOpen.value;
    return;
  }
  // 首次收藏：默认设为「在看」
  library.addOrUpdate(
    { id: detail.value.id, title: detail.value.title, image: detail.value.image, tagline: detail.value.genres.join("/"), totalEpisodes: detail.value.episodesTotal },
    "watching"
  );
  statusMenuOpen.value = false;
};
const pickStatus = (s: TrackStatus) => {
  if (ui.detailId == null) return;
  library.setStatus(ui.detailId, s);
  statusMenuOpen.value = false;
};
const unfav = () => {
  if (ui.detailId == null) return;
  library.remove(ui.detailId);
  statusMenuOpen.value = false;
};
const closeStatusMenu = () => { statusMenuOpen.value = false; };
</script>

<template>
  <div v-if="ui.detailId == null" class="surface mx-auto mt-20 max-w-md rounded-2xl p-10 text-center text-muted-foreground">未选择番剧</div>
  <div v-else class="relative min-w-0 w-full pb-24">
    <!-- ═══ Hero: blurred backdrop + poster + meta ═══
         修复：overflow-hidden 只作用于背景层（裁剪 scale-125 模糊图），
         不能放在 section 上 —— 否则会裁剪收藏状态下拉菜单（表现为展开框溢出/被截断）。 -->
    <section class="relative">
      <div class="absolute inset-0 overflow-hidden">
        <img :src="cover" alt="" draggable="false" class="h-full w-full scale-125 object-cover opacity-25 blur-2xl" />
        <div class="absolute inset-0 bg-gradient-to-b from-background/50 via-background/85 to-background" />
      </div>

      <div class="relative mx-auto flex max-w-[1200px] flex-col gap-5 px-4 pb-7 pt-7 sm:flex-row sm:gap-8 sm:px-6">
        <!-- Poster -->
        <div class="mx-auto w-40 shrink-0 sm:mx-0 sm:w-48">
          <template v-if="detailLoading"><div class="aspect-[3/4] w-full rounded-2xl shimmer" /></template>
          <CoverImage v-else :src="cover" :alt="detail?.title ?? ''" ratio="portrait" rounded="rounded-2xl" class="shadow-xl shadow-black/10 ring-1 ring-foreground/10 dark:shadow-black/50" />
        </div>

        <!-- Meta -->
        <div class="flex min-w-0 flex-1 flex-col">
          <template v-if="detailLoading">
            <div class="space-y-3"><div class="h-7 w-3/4 rounded-lg shimmer" /><div class="h-4 w-1/2 rounded shimmer" /><div class="h-8 w-full rounded-lg shimmer" /></div>
          </template>
          <template v-else>
            <h1 class="text-xl font-extrabold tracking-tight text-foreground sm:text-2xl">{{ detail?.title }}</h1>

            <div class="mt-3 space-y-1 text-xs leading-relaxed text-foreground/85">
              <p><span class="text-muted-foreground">时间: </span>{{ fmtCnDate(detail?.airdate) }}</p>
              <p><span class="text-muted-foreground">状态: </span>全{{ detail?.episodesTotal || episodes?.length || "…" }}集<template v-if="detail?.status"> · {{ detail.status }}</template></p>
              <p v-if="detail?.lang"><span class="text-muted-foreground">语言: </span>{{ langLabel(detail.lang) }}</p>
              <p v-if="detail?.region?.length"><span class="text-muted-foreground">地区: </span>{{ detail.region.join(" · ") }}</p>
            </div>

            <!-- Rating: 5-star strip + score line -->
            <div v-if="bestRating" class="mt-3 flex items-center gap-2">
              <div class="relative inline-flex h-4 w-[88px] shrink-0">
                <div class="flex gap-0.5">
                  <Star v-for="i in 5" :key="`b${i}`" class="h-4 w-4 shrink-0 fill-foreground/15 text-foreground/15" />
                </div>
                <div class="absolute inset-y-0 left-0 overflow-hidden" :style="{ width: starPct }">
                  <div class="flex gap-0.5">
                    <Star v-for="i in 5" :key="`f${i}`" class="h-4 w-4 shrink-0 fill-amber-400 text-amber-400" />
                  </div>
                </div>
              </div>
              <span class="text-xs text-muted-foreground">{{ bestRating.count ? `由${bestRating.count}人评` : "" }}{{ bestRating.score.toFixed(1) }}分</span>
            </div>

            <div class="mt-4 flex flex-wrap items-center gap-2.5">
              <button v-if="episodes && episodes.length > 0" @click="handlePlay(1)" class="flex items-center gap-2 rounded-lg bg-primary px-5 py-2 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90">
                <Play class="h-4 w-4 fill-current" /> 立即播放
              </button>
              <!-- 收藏：首次点击默认在看；再次点击弹出状态菜单/取消收藏 -->
              <div class="relative">
                <button @click="toggleFav" :class="cn('flex items-center gap-1.5 rounded-lg border px-4 py-2 text-sm font-medium transition-colors', entry ? 'border-primary/40 bg-primary/10 text-primary hover:bg-primary/15' : 'border-border text-foreground hover:bg-foreground/5')">
                  <Heart :class="cn('h-4 w-4', entry && 'fill-primary text-primary')" />
                  {{ entry ? `已收藏 · ${STATUS_LABELS[entry.status]}` : "收藏" }}
                  <ChevronDown v-if="entry" :class="cn('h-3 w-3 transition-transform', statusMenuOpen && 'rotate-180')" />
                </button>
                <!-- 状态菜单 -->
                <div v-if="statusMenuOpen && entry" class="absolute left-0 top-full z-30 mt-1.5 w-40 overflow-hidden rounded-xl border border-border bg-card py-1 shadow-xl shadow-black/10 dark:shadow-black/50">
                  <button
                    v-for="s in STATUS_ORDER"
                    :key="s"
                    type="button"
                    @click="pickStatus(s)"
                    :class="cn('flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-foreground/5', entry.status === s ? 'font-bold text-primary' : 'text-foreground')"
                  >
                    <span :class="cn('h-1.5 w-1.5 rounded-full', STATUS_STYLES[s].dot)" />
                    {{ STATUS_LABELS[s] }}
                    <span v-if="entry.status === s" class="ml-auto text-[10px]">✓</span>
                  </button>
                  <div class="my-1 h-px bg-border/60" />
                  <button type="button" @click="unfav" class="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-destructive transition-colors hover:bg-destructive/10">
                    <Heart class="h-3 w-3" /> 取消收藏
                  </button>
                </div>
              </div>
            </div>
          </template>
        </div>
      </div>
    </section>

    <!-- ═══ Tab bar ═══ -->
    <div class="border-b border-border/70">
      <div class="mx-auto flex max-w-[1200px] gap-7 px-4 sm:px-6">
        <button
          v-for="t in TABS"
          :key="t.key"
          @click="activeTab = t.key"
          :class="cn(
            'relative pb-2.5 pt-1 text-sm font-medium transition-colors',
            activeTab === t.key ? 'text-primary' : 'text-muted-foreground hover:text-foreground'
          )"
        >
          {{ t.label }}
          <span v-if="t.key === 'comments' && commentCount" class="text-[10px]"> {{ commentCount }}</span>
          <span v-if="activeTab === t.key" class="absolute inset-x-0 -bottom-px h-0.5 rounded-full bg-primary" />
        </button>
      </div>
    </div>

    <!-- ═══ Tab content ═══ -->
    <div class="mx-auto min-h-[420px] max-w-[1200px] px-4 py-6 sm:px-6">
      <!-- ── 详情 ── -->
      <div v-if="activeTab === 'info'" class="space-y-7">
        <p v-if="detail?.overview" class="whitespace-pre-line text-sm leading-7 text-foreground/90">【{{ detail.overview }}】</p>
        <p v-else-if="!detailLoading" class="text-sm text-muted-foreground">暂无简介</p>

        <div v-if="detail?.genres?.length">
          <h4 class="mb-2.5 text-sm font-bold text-foreground">分类</h4>
          <div class="flex flex-wrap gap-2">
            <span v-for="g in detail.genres" :key="g" class="rounded-full border border-border px-3.5 py-1 text-xs text-foreground/85">{{ g }}</span>
          </div>
        </div>

        <div v-if="detail?.marks?.length">
          <h4 class="mb-2.5 text-sm font-bold text-foreground">标签</h4>
          <div class="flex flex-wrap gap-2">
            <span v-for="m in detail.marks" :key="m.name" class="rounded-full bg-muted px-3 py-1 text-xs text-muted-foreground">
              {{ m.name }} <span class="ml-0.5 tabular-nums">{{ m.count }}</span>
            </span>
          </div>
        </div>
      </div>

      <!-- ── 剧集：缩略图卡片网格 ── -->
      <div v-else-if="activeTab === 'episodes'">
        <div v-if="!episodes || episodes.length === 0" class="py-10 text-center text-sm text-muted-foreground">暂无剧集</div>
        <div v-else ref="epGridRef" class="w-full overflow-hidden" :style="{ ...epGridStyle, contain: 'layout', maxWidth: '100%' }">
          <button
            v-for="ep in episodes"
            :key="ep.sort"
            type="button"
            @click="handlePlay(ep.sort)"
            class="group min-w-0 overflow-hidden rounded-xl text-left ring-1"
            :class="ep.sort === playingEpisode ? 'ring-2 ring-primary' : 'ring-foreground/5'"
          >
            <div class="relative aspect-video w-full overflow-hidden bg-muted">
              <!-- 需求：集数 hover 只需图片有轻微变化即可（亮度微调，无缩放/无播放遮罩） -->
              <CoverImage :src="ep.image || cover" :alt="ep.title || `第${ep.sort}集`" ratio="wide" rounded="rounded-none" class="transition-[filter] duration-200 group-hover:brightness-110" />
              <div class="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-between gap-1 bg-gradient-to-t from-black/85 via-black/40 to-transparent px-1.5 pb-1 pt-5">
                <span class="rounded bg-black/60 px-1 font-mono text-[10px] leading-4 tabular-nums text-white/95">{{ fmtEpDuration(ep.duration) || "--:--" }}</span>
                <!-- 需求：无资源的集数要显示「无资源」角标（此前只标有资源，无资源集无任何标注） -->
                <span v-if="ep.status" class="rounded bg-emerald-600/90 px-1 text-[9px] font-semibold leading-4 text-white">有资源</span>
                <span v-else class="rounded bg-red-500/85 px-1 text-[9px] font-semibold leading-4 text-white">无资源</span>
              </div>
            </div>
            <div class="px-1.5 pb-1 pt-1.5">
              <p class="line-clamp-1 text-xs font-semibold text-foreground">第{{ ep.sort }}集 {{ ep.title }}</p>
              <p class="mt-0.5 text-[10px] tabular-nums text-muted-foreground">{{ fmtEpDate(ep.airdate) }}</p>
            </div>
          </button>
        </div>
      </div>

      <!-- ── 评论 ── -->
      <div v-else-if="activeTab === 'comments'">
        <div v-if="commentsLoading" class="space-y-3"><div v-for="i in 3" :key="i" class="h-20 rounded-lg shimmer" /></div>
        <div v-else-if="comments.length === 0" class="py-10 text-center text-sm text-muted-foreground">暂无评论</div>
        <div v-else class="space-y-4">
          <div v-for="c in comments" :key="c.id" class="surface rounded-xl p-4">
            <div class="flex items-center gap-2">
              <img v-if="c.user?.avatar" :src="c.user.avatar" alt="" class="h-7 w-7 rounded-full object-cover" draggable="false" />
              <div v-else class="flex h-7 w-7 items-center justify-center rounded-full bg-primary/20 text-xs font-bold text-primary">{{ (c.user?.name || "?").charAt(0) }}</div>
              <div class="flex-1">
                <span class="text-sm font-semibold text-foreground">{{ c.user?.name || "匿名" }}</span>
                <span v-if="c.user?.issp" class="ml-1 rounded bg-tertiary/30 px-1 text-[9px] text-tertiary-foreground">UP</span>
              </div>
              <span class="text-[10px] text-muted-foreground">{{ fmtCommentDate(c.date) }}</span>
            </div>
            <p class="mt-2 text-sm leading-relaxed text-foreground/80">{{ c.text }}</p>
            <div class="mt-2 flex items-center gap-4 text-[11px] text-muted-foreground">
              <span v-if="c.likes_count" class="flex items-center gap-1">♥ {{ c.likes_count }}</span>
              <button v-if="c.replies_count > 0" @click="toggleReplies(c.id)" class="flex items-center gap-1 hover:text-foreground">
                {{ expandedReplies.has(c.id) ? "收起" : "展开" }} {{ c.replies_count }} 条回复
                <ChevronDown :class="cn('h-3 w-3 transition-transform', expandedReplies.has(c.id) && 'rotate-180')" />
              </button>
              <span v-if="c.address" class="text-muted-foreground/50">{{ c.address }}</span>
            </div>
            <div v-if="expandedReplies.has(c.id) && repliesCache[c.id]" class="mt-3 ml-9 space-y-3 border-l border-border/40 pl-4">
              <div v-if="repliesLoading.has(c.id)" class="text-xs text-muted-foreground">加载中…</div>
              <div v-for="r in repliesCache[c.id]" :key="r.id" class="rounded-lg bg-muted p-2.5">
                <div class="flex items-center gap-2">
                  <img v-if="r.user?.avatar" :src="r.user.avatar" alt="" class="h-5 w-5 rounded-full object-cover" />
                  <span class="text-xs font-semibold text-foreground">{{ r.user?.name || "匿名" }}</span>
                  <span class="text-[10px] text-muted-foreground">{{ fmtCommentDate(r.date) }}</span>
                </div>
                <p class="mt-1 text-xs leading-relaxed text-foreground/70">{{ r.text }}</p>
              </div>
              <div v-if="repliesCache[c.id].length === 0" class="text-xs text-muted-foreground">暂无回复</div>
            </div>
          </div>
        </div>
      </div>

      <!-- ── 角色 ── -->
      <div v-else-if="activeTab === 'characters'">
        <div v-if="!characters || characters.length === 0" class="py-10 text-center text-sm text-muted-foreground">暂无角色资料</div>
        <div v-else ref="charGridRef" class="w-full overflow-hidden" :style="{ ...charGridStyle, contain: 'layout', maxWidth: '100%' }">
          <div v-for="c in characters" :key="c.id" class="min-w-0 text-center">
            <!-- 无边框：仅上半身截图 + 名称 + CV -->
            <div class="aspect-square w-full overflow-hidden rounded-xl bg-muted">
              <img :src="c.image" :alt="c.name" loading="lazy" class="h-full w-full object-cover object-top" @error="onCharImgError" />
            </div>
            <p class="mt-1.5 line-clamp-1 text-xs font-medium text-foreground">{{ c.name }}</p>
            <p v-if="c.actors[0]" class="line-clamp-1 text-[10px] text-muted-foreground">CV: {{ c.actors[0].name }}</p>
          </div>
        </div>
      </div>

      <!-- ── 推荐 ── -->
      <div v-else-if="activeTab === 'related'">
        <div v-if="!related || related.length === 0" class="py-10 text-center text-sm text-muted-foreground">暂无相关推荐</div>
        <div v-else ref="relatedGridRef" class="w-full overflow-hidden" :style="{ ...relatedGridStyle, contain: 'layout', maxWidth: '100%' }">
          <button v-for="item in related.slice(0, 12)" :key="item.id" @click="ui.openDetail(item.id, item.image)" class="group flex min-w-0 flex-col text-left">
            <CoverImage :src="item.image" :alt="item.title" ratio="portrait" rounded="rounded-lg" class="transition-transform group-hover:scale-[1.03]" />
            <p class="mt-1.5 line-clamp-1 text-xs font-medium text-foreground">{{ item.title }}</p>
            <p v-if="item.type" class="text-[10px] text-muted-foreground">{{ item.type }}</p>
          </button>
        </div>
      </div>
    </div>

    <!-- 状态菜单遮罩：点击空白处关闭 -->
    <div v-if="statusMenuOpen" class="fixed inset-0 z-20" @click="closeStatusMenu" />
  </div>
</template>
