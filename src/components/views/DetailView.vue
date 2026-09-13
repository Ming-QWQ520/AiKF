<script setup lang="ts">
import { computed, ref, watch, onMounted, onBeforeUnmount, nextTick } from "vue";
import { useI18n } from "vue-i18n";
import { Play, Star, Heart, ChevronDown, ChevronUp, Info, RefreshCw, Search as SearchIcon, X, Loader2 } from "lucide-vue-next";
import { anich } from "@/lib/anich/api-client";
import { anichSearchFirst } from "@/lib/bangumi/sync";
import { useUIStore } from "@/stores/ui";
import { useLibraryStore, STATUS_I18N_KEYS, STATUS_ORDER, STATUS_STYLES, type TrackStatus } from "@/stores/library";
import { useAsync } from "@/composables/useAsync";
import { useResponsiveGrid } from "@/composables/useResponsiveGrid";
import CoverImage from "@/components/CoverImage.vue";
import BgmEntityDialog from "@/components/BgmEntityDialog.vue";
import { cn } from "@/lib/utils";

const ui = useUIStore();
const library = useLibraryStore();
const { t, d } = useI18n();

// ── bgmOnly 条目（云端导入、暂无 AniCh 资源，负数占位 id）──
// 需求：无论是否有资源都添加至追番库。打开详情页时惰性重试 AniCh 匹配：
// 命中则升级为真实条目（重新建键 + 摘除标记）并正常加载；
// 未命中则展示提示（番剧仍在库中，资源上线后再次打开即可自动匹配）。
const bgmOnlyEntry = computed(() => {
  const id = ui.detailId;
  if (id == null) return null;
  const e = library.entries[id];
  return e?.bgmOnly ? e : null;
});
const matchedAnichId = ref<number | null>(null);
/** AniCh 条目 id：普通条目 = ui.detailId；bgmOnly = 惰性匹配结果（null 时不发起请求） */
const anichId = computed<number | null>(() =>
  bgmOnlyEntry.value ? matchedAnichId.value : ui.detailId
);
const bgmOnlyUnmatched = computed(() => !!bgmOnlyEntry.value && matchedAnichId.value == null);

watch(
  () => bgmOnlyEntry.value,
  async (e) => {
    matchedAnichId.value = null;
    if (!e) return;
    try {
      const hit = await anichSearchFirst(e.title, e.title);
      // 等待期间用户可能已切换详情页，校验仍是同一条目且仍是 bgmOnly
      const cur = bgmOnlyEntry.value;
      if (hit && cur && cur.id === e.id) {
        library.upgradeBgmOnly(e.id, hit);
        // 升级后条目不再是 bgmOnly，anichId 自动回落到 ui.detailId；
        // 切换到真实 AniCh id 以加载详情/剧集
        if (ui.detailId === e.id) ui.detailId = hit.id;
      }
    } catch {
      /* 匹配失败保持未匹配状态，不阻断页面 */
    }
  },
  { immediate: true }
);

const { data: detail, isLoading: detailLoading } = useAsync(() => anich.detail(anichId.value!), { enabled: anichId, source: anichId });
const { data: episodes } = useAsync(() => anich.episodes(anichId.value!), { enabled: anichId, source: anichId });
const { data: related } = useAsync(() => anich.related(anichId.value!), { enabled: anichId, source: anichId });
const { data: characters } = useAsync(() => anich.characters(anichId.value!), { enabled: anichId, source: anichId });

// ── Tabs（需求：角色项右侧新增「制作」与「关联条目」，原「推荐」Tab 即关联条目
// 数据源，合并升级为分组完整展示，避免两个 Tab 内容重复）──
// ⚠️ TDZ 教训（生产包 "Cannot access 'C' before initialization"）：useAsync 内部
// watch(immediate) 会在 setup 期间同步求值 enabled → staffTabActive → activeTab，
// 因此 activeTab 必须先于下方 staff 的 useAsync 声明，否则制作 Tab 的数据请求
// 永远不会发出（staff 列表永远为空）。
const activeTab = ref<"info" | "episodes" | "comments" | "characters" | "staff" | "bgmRelated">("info");

// ── 制作人员（需求：角色项右侧新增制作 Tab）——进入该 Tab 时才拉取 ──
const staffTabActive = computed(() => activeTab.value === "staff");
const { data: staff, isLoading: staffLoading } = useAsync(() => anich.persons(anichId.value!), {
  enabled: computed(() => staffTabActive.value && anichId.value != null),
  source: anichId,
});

const entry = computed(() => (ui.detailId != null ? library.entries[ui.detailId] : undefined));
const cover = computed(() => detail.value?.image || ui.detailCover);
const bestRating = computed(() => detail.value?.rating?.find((r) => r.score > 0));

/** 角色图加载失败 → 隐藏图片留底色占位 */
const onCharImgError = (e: Event) => {
  (e.target as HTMLElement).style.opacity = "0";
};

// ── Tabs（需求：角色项右侧新增「制作」与「关联条目」，原「推荐」Tab 即关联条目
// 数据源，合并升级为分组完整展示，避免两个 Tab 内容重复）──
const TABS = [
  { key: "info", labelKey: "detail.tabInfo" },
  { key: "episodes", labelKey: "detail.tabEpisodes" },
  { key: "comments", labelKey: "detail.tabComments" },
  { key: "characters", labelKey: "detail.tabCharacters" },
  { key: "staff", labelKey: "detail.tabStaff" },
  { key: "bgmRelated", labelKey: "detail.tabBgmRelated" },
] as const;

// ── Tab bar 滑动指示条（需求：切换 Tab 时 hover 指示条平滑移动，而非逐键出现/消失）──
// 单一元素 + left/width CSS 过渡；字体加载/语言切换/容器尺寸变化时重测量。
const tabBarRef = ref<HTMLElement | null>(null);
const tabBtnEls = new Map<string, HTMLElement>();
const setTabBtnRef = (key: string, el: unknown) => {
  if (el) tabBtnEls.set(key, el as HTMLElement);
  else tabBtnEls.delete(key);
};
const indicator = ref({ x: 0, w: 0, ready: false });
const updateIndicator = () => {
  const el = tabBtnEls.get(activeTab.value);
  if (!el) return;
  // offsetLeft 相对 offsetParent（即带 relative 的 tabBar 行），含行内 padding
  indicator.value = { x: el.offsetLeft, w: el.offsetWidth, ready: true };
};
watch(activeTab, () => nextTick(updateIndicator), { immediate: true });
onMounted(() => {
  nextTick(updateIndicator);
  // 字体异步加载/语言切换后文字宽度变化；窗口缩放同样重测
  window.addEventListener("resize", updateIndicator, { passive: true });
  if (document.fonts?.ready) void document.fonts.ready.then(updateIndicator).catch(() => {});
});
onBeforeUnmount(() => window.removeEventListener("resize", updateIndicator));

// ── Hero helpers ──
const LANG_KEY: Record<string, string> = {
  ja: "common.langNames.ja",
  zh: "common.langNames.zh",
  en: "common.langNames.en",
  ko: "common.langNames.ko",
  other: "common.langNames.other",
};
const langLabel = (l?: string) => (l ? (LANG_KEY[l] ? t(LANG_KEY[l]) : l) : "");
const fmtCnDate = (ts?: number) => {
  if (!ts || ts <= 0) return "—";
  return d(ts, "long");
};
const fmtEpDate = (ts?: number) => {
  if (!ts || ts <= 0) return "";
  return d(ts, "longTime");
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
const { containerRef: charGridRef, style: charGridStyle } = useResponsiveGrid({
  minWidth: 112,
  gap: 12,
  trigger: () => `${characters.value?.length ?? 0}-${ui.sidebarCollapsed}`,
});

// ── 制作人员按职务分组（保持首次出现顺序；一人多职务时在各组重复出现，与 Bangumi 网页一致）──
const staffGroups = computed(() => {
  const list = staff.value ?? [];
  const groups: { job: string; people: any[] }[] = [];
  const idx = new Map<string, number>();
  for (const p of list) {
    const jobs = String(p?.jobs || "")
      .split(/[,，、;；]/)
      .map((s) => s.trim())
      .filter(Boolean);
    for (const j of jobs.length ? jobs : ["—"]) {
      if (!idx.has(j)) {
        idx.set(j, groups.length);
        groups.push({ job: j, people: [] });
      }
      groups[idx.get(j)!].people.push(p);
    }
  }
  return groups;
});

// ── 关联条目按类型分组（续集/书籍/画集/联动/片头曲…，完整展示不再截断12条）──
const relatedGroups = computed(() => {
  const list = related.value ?? [];
  const groups: { type: string; items: any[] }[] = [];
  const idx = new Map<string, number>();
  for (const it of list) {
    const ty = String(it?.type || "").trim() || "—";
    if (!idx.has(ty)) {
      idx.set(ty, groups.length);
      groups.push({ type: ty, items: [] });
    }
    groups[idx.get(ty)!].items.push(it);
  }
  return groups;
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
  () => anich.comments(anichId.value!, 1, undefined),
  { enabled: anichId, source: anichId }
);
const { data: commentCountData } = useAsync(
  () => anich.commentCount(anichId.value!, 1),
  { enabled: anichId, source: anichId }
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
/** 设置我的评分（下拉菜单内 10 星）：0 = 清除本地评分。
 *  变更经 auto-sync 自动推送到 Bangumi（rate 字段）。 */
const setEntryScore = (n: number) => {
  if (ui.detailId == null) return;
  library.setScore(ui.detailId, n);
};
const closeStatusMenu = () => { statusMenuOpen.value = false; };

// ── 角色/制作人员详情弹窗（需求：角色/制作可点击查看详情）──
const entity = ref<{ kind: "character" | "person"; id: number; name?: string; image?: string } | null>(null);
const openEntity = (kind: "character" | "person", id: number, name?: string, image?: string) => {
  if (id == null) return;
  entity.value = { kind, id, name, image };
};

// ── 回到顶部按键（需求：评论页/制作页等长内容页右下角固定悬浮）──
// 显示范围 = 全部 Tab（评论/制作/关联条目/剧集/角色均可能超长，阈值 320px 统一处理）。
// ⚠️ 渲染位置：必须 Teleport 到 body —— main 滚动容器带 contain:layout，会成为
// fixed 后代的 containing block，且其 padding box 锚定在滚动内容坐标空间上，
// 按钮会随内容滚走（表现为「右下角永远不出现」）；脱离 main 子树后 fixed
// 重新锚定视口，稳定固定于视口右下角。
const showBackTop = ref(false);
let mainScroller: HTMLElement | null = null;
let scrollerBound = false;
const onMainScroll = () => {
  showBackTop.value = (mainScroller?.scrollTop ?? 0) > 320;
};
const bindMainScroller = () => {
  if (scrollerBound) return;
  const el = document.querySelector("main");
  if (!el) return;
  mainScroller = el as HTMLElement;
  mainScroller.addEventListener("scroll", onMainScroll, { passive: true });
  scrollerBound = true;
};
onMounted(() => nextTick(bindMainScroller));
watch(activeTab, () => {
  nextTick(() => {
    bindMainScroller();
    onMainScroll();
  });
});
onBeforeUnmount(() => {
  mainScroller?.removeEventListener("scroll", onMainScroll);
  mainScroller = null;
});
const backToTop = () => {
  mainScroller?.scrollTo({ top: 0, behavior: "smooth" });
};

// ── 重新匹配 AniCh 资源（修复误匹配 / 补匹配 bgmOnly 条目）──
// 自动匹配可能张冠李戴（同名不同季、译名差异），提供手动搜索重绑：
// 观看记录/状态/评分/Bangumi 关联全部保留，仅替换 AniCh 资源指向。
const rematchOpen = ref(false);
const rematchKeyword = ref("");
const rematchLoading = ref(false);
const rematchResults = ref<any[] | null>(null);

const openRematch = () => {
  rematchKeyword.value = entry.value?.title || detail.value?.title || "";
  rematchResults.value = null;
  statusMenuOpen.value = false;
  rematchOpen.value = true;
};
const closeRematch = () => { rematchOpen.value = false; };

const doRematchSearch = async () => {
  const kw = rematchKeyword.value.trim();
  if (!kw || rematchLoading.value) return;
  rematchLoading.value = true;
  try {
    const res = await anich.search(kw, 0);
    rematchResults.value = res.items ?? [];
  } catch {
    rematchResults.value = [];
  } finally {
    rematchLoading.value = false;
  }
};

const applyRematch = (hit: any) => {
  if (ui.detailId == null || !hit?.id) return;
  const oldId = ui.detailId;
  library.rebindEntry(oldId, {
    id: hit.id,
    title: hit.title,
    image: hit.image,
    tagline: hit.tagline,
    totalEpisodes: hit.episodes_total ?? 0,
  });
  // 跟随切换到新条目（触发详情/剧集重新加载）
  if (ui.detailId === oldId) ui.detailId = hit.id;
  rematchOpen.value = false;
};
</script>

<template>
  <div v-if="ui.detailId == null" class="surface mx-auto mt-20 max-w-md rounded-2xl p-10 text-center text-muted-foreground">{{ $t('detail.none') }}</div>
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
            <h1 class="text-xl font-extrabold tracking-tight text-foreground sm:text-2xl">{{ detail?.title || entry?.title }}</h1>

            <div class="mt-3 space-y-1 text-xs leading-relaxed text-foreground/85">
              <p><span class="text-muted-foreground">{{ $t('detail.metaTime') }}: </span>{{ fmtCnDate(detail?.airdate) }}</p>
              <p><span class="text-muted-foreground">{{ $t('detail.metaStatus') }}: </span>{{ $t('detail.totalEps', { n: detail?.episodesTotal || episodes?.length || '…' }) }}<template v-if="detail?.status"> · {{ detail.status }}</template></p>
              <p v-if="detail?.lang"><span class="text-muted-foreground">{{ $t('detail.metaLang') }}: </span>{{ langLabel(detail.lang) }}</p>
              <p v-if="detail?.region?.length"><span class="text-muted-foreground">{{ $t('detail.metaRegion') }}: </span>{{ detail.region.join(" · ") }}</p>
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
              <span class="text-xs text-muted-foreground">{{ bestRating.count ? $t('detail.ratedBy', { n: bestRating.count }) : "" }}{{ $t('detail.score', { s: bestRating.score.toFixed(1) }) }}</span>
            </div>

            <div class="mt-4 flex flex-wrap items-center gap-2.5">
              <button v-if="episodes && episodes.length > 0" @click="handlePlay(1)" class="flex items-center gap-2 rounded-lg bg-primary px-5 py-2 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90">
                <Play class="h-4 w-4 fill-current" /> {{ $t('detail.playNow') }}
              </button>
              <!-- 收藏：首次点击默认在看；再次点击弹出状态菜单/取消收藏 -->
              <div class="relative">
                <button @click="toggleFav" :class="cn('flex items-center gap-1.5 rounded-lg border px-4 py-2 text-sm font-medium transition-colors', entry ? 'border-primary/40 bg-primary/10 text-primary hover:bg-primary/15' : 'border-border text-foreground hover:bg-foreground/5')">
                  <Heart :class="cn('h-4 w-4', entry && 'fill-primary text-primary')" />
                  {{ entry ? `${$t('detail.favorited')} · ${$t(STATUS_I18N_KEYS[entry.status])}` : $t('detail.fav') }}
                  <ChevronDown v-if="entry" :class="cn('h-3 w-3 transition-transform', statusMenuOpen && 'rotate-180')" />
                </button>
                <!-- 状态菜单（含我的评分：Bangumi 1-10 分制，点击即存并经 auto-sync 同步云端） -->
                <div v-if="statusMenuOpen && entry" class="absolute left-0 top-full z-30 mt-1.5 w-52 overflow-hidden rounded-xl border border-border bg-card py-1 shadow-xl shadow-black/10 dark:shadow-black/50">
                  <button
                    v-for="s in STATUS_ORDER"
                    :key="s"
                    type="button"
                    @click="pickStatus(s)"
                    :class="cn('flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-foreground/5', entry.status === s ? 'font-bold text-primary' : 'text-foreground')"
                  >
                    <span :class="cn('h-1.5 w-1.5 rounded-full', STATUS_STYLES[s].dot)" />
                    {{ $t(STATUS_I18N_KEYS[s]) }}
                    <span v-if="entry.status === s" class="ml-auto text-[10px]">✓</span>
                  </button>
                  <div class="my-1 h-px bg-border/60" />
                  <div class="px-3 py-1.5">
                    <p class="mb-1 text-[10px] font-medium text-muted-foreground">
                      {{ $t('library.myScore') }}
                      <span v-if="entry.score > 0" class="ml-1 font-bold tabular-nums text-tertiary">{{ entry.score }}</span>
                    </p>
                    <div class="flex items-center gap-0.5">
                      <button
                        v-for="n in 10"
                        :key="`rs${n}`"
                        type="button"
                        @click="setEntryScore(entry.score === n ? 0 : n)"
                        class="p-px"
                        :aria-label="$t('library.rateN', { n })"
                      >
                        <Star :class="cn('h-3.5 w-3.5 transition-colors', n <= entry.score ? 'fill-tertiary text-tertiary' : 'text-muted-foreground/35 hover:text-tertiary/70')" />
                      </button>
                    </div>
                    <button
                      v-if="entry.score > 0"
                      type="button"
                      @click="setEntryScore(0)"
                      class="mt-1 text-[10px] text-muted-foreground transition-colors hover:text-destructive"
                    >
                      {{ $t('library.scoreClear') }}
                    </button>
                  </div>
                  <div class="my-1 h-px bg-border/60" />
                  <button type="button" @click="openRematch" class="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-foreground transition-colors hover:bg-foreground/5">
                    <RefreshCw class="h-3 w-3" /> {{ $t('detail.rematch') }}
                  </button>
                  <button type="button" @click="unfav" class="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-destructive transition-colors hover:bg-destructive/10">
                    <Heart class="h-3 w-3" /> {{ $t('detail.unfav') }}
                  </button>
                </div>
              </div>
            </div>
          </template>
        </div>
      </div>
    </section>

    <!-- bgmOnly 未匹配提示：番剧已在库中，但 AniCh 暂无对应资源（可手动重新匹配） -->
    <div v-if="bgmOnlyUnmatched" class="mx-auto max-w-[1200px] px-4 pt-4 sm:px-6">
      <div class="flex flex-wrap items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs leading-relaxed text-amber-700 dark:text-amber-400">
        <Info class="h-4 w-4 shrink-0" />
        <span class="min-w-0 flex-1">{{ $t('detail.bgmOnlyNoMatch') }}</span>
        <button
          @click="openRematch"
          class="state-layer flex shrink-0 items-center gap-1.5 rounded-lg border border-amber-500/40 px-2.5 py-1.5 text-[11px] font-medium text-amber-700 transition-colors hover:bg-amber-500/15 dark:text-amber-400"
        >
          <RefreshCw class="h-3 w-3" /> {{ $t('detail.rematch') }}
        </button>
      </div>
    </div>

    <!-- ═══ Tab bar（指示条单一元素随激活 Tab 平滑滑动，不再逐键出现/消失）═══ -->
    <div class="border-b border-border/70">
      <div ref="tabBarRef" class="relative mx-auto flex max-w-[1200px] gap-7 px-4 sm:px-6">
        <button
          v-for="t in TABS"
          :key="t.key"
          :ref="(el) => setTabBtnRef(t.key, el)"
          @click="activeTab = t.key"
          :class="cn(
            'relative pb-2.5 pt-1 text-sm font-medium transition-colors',
            activeTab === t.key ? 'text-primary' : 'text-muted-foreground hover:text-foreground'
          )"
        >
          {{ t.labelKey ? $t(t.labelKey) : '' }}
          <span v-if="t.key === 'comments' && commentCount" class="text-[10px]"> {{ commentCount }}</span>
        </button>
        <!-- 滑动指示条：transform/left 过渡由 CSS 接管（低耗）;
             opacity:0 兜底首帧未测量时不闪烁；data-anim=off 时全局规则自动把过渡时长压到 0.01ms -->
        <span
          class="tab-indicator absolute bottom-0 left-0 h-0.5 rounded-full bg-primary transition-[left,width] duration-300 ease-out"
          :style="{ left: `${indicator.x}px`, width: `${indicator.w}px`, opacity: indicator.ready ? 1 : 0 }"
        />
      </div>
    </div>

    <!-- ═══ Tab content（需求：切换时低耗 CSS 动画；mode=out-in 先卸后挂降低同时布局开销）═══ -->
    <div class="mx-auto min-h-[420px] max-w-[1200px] px-4 py-6 sm:px-6">
    <Transition name="tabfade" mode="out-in">
      <!-- ── 详情 ── -->
      <div v-if="activeTab === 'info'" key="info" class="space-y-7">
        <p v-if="detail?.overview" class="whitespace-pre-line text-sm leading-7 text-foreground/90">【{{ detail.overview }}】</p>
        <p v-else-if="!detailLoading" class="text-sm text-muted-foreground">{{ $t('detail.noOverview') }}</p>

        <div v-if="detail?.genres?.length">
          <h4 class="mb-2.5 text-sm font-bold text-foreground">{{ $t('detail.genres') }}</h4>
          <div class="flex flex-wrap gap-2">
            <span v-for="g in detail.genres" :key="g" class="rounded-full border border-border px-3.5 py-1 text-xs text-foreground/85">{{ g }}</span>
          </div>
        </div>

        <div v-if="detail?.marks?.length">
          <h4 class="mb-2.5 text-sm font-bold text-foreground">{{ $t('detail.tags') }}</h4>
          <div class="flex flex-wrap gap-2">
            <span v-for="m in detail.marks" :key="m.name" class="rounded-full bg-muted px-3 py-1 text-xs text-muted-foreground">
              {{ m.name }} <span class="ml-0.5 tabular-nums">{{ m.count }}</span>
            </span>
          </div>
        </div>
      </div>

      <!-- ── 剧集：缩略图卡片网格 ── -->
      <div v-else-if="activeTab === 'episodes'" key="episodes">
        <div v-if="!episodes || episodes.length === 0" class="py-10 text-center text-sm text-muted-foreground">{{ $t('detail.noEpisodes') }}</div>
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
              <CoverImage :src="ep.image || cover" :alt="ep.title || $t('common.epN', { n: ep.sort })" ratio="wide" rounded="rounded-none" class="transition-[filter] duration-200 group-hover:brightness-110" />
              <div class="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-between gap-1 bg-gradient-to-t from-black/85 via-black/40 to-transparent px-1.5 pb-1 pt-5">
                <span class="rounded bg-black/60 px-1 font-mono text-[10px] leading-4 tabular-nums text-white/95">{{ fmtEpDuration(ep.duration) || "--:--" }}</span>
                <!-- 需求：无资源的集数要显示「无资源」角标（此前只标有资源，无资源集无任何标注） -->
                <span v-if="ep.status" class="rounded bg-emerald-600/90 px-1 text-[9px] font-semibold leading-4 text-white">{{ $t('detail.hasResource') }}</span>
                <span v-else class="rounded bg-red-500/85 px-1 text-[9px] font-semibold leading-4 text-white">{{ $t('detail.noResource') }}</span>
              </div>
            </div>
            <div class="px-1.5 pb-1 pt-1.5">
              <p class="line-clamp-1 text-xs font-semibold text-foreground">{{ $t('common.epNT', { n: ep.sort, t: ep.title }) }}</p>
              <p class="mt-0.5 text-[10px] tabular-nums text-muted-foreground">{{ fmtEpDate(ep.airdate) }}</p>
            </div>
          </button>
        </div>
      </div>

      <!-- ── 评论 ── -->
      <div v-else-if="activeTab === 'comments'" key="comments">
        <div v-if="commentsLoading" class="space-y-3"><div v-for="i in 3" :key="i" class="h-20 rounded-lg shimmer" /></div>
        <div v-else-if="comments.length === 0" class="py-10 text-center text-sm text-muted-foreground">{{ $t('detail.noComments') }}</div>
        <div v-else class="space-y-4">
          <!-- content-visibility：视口外评论卡跳过布局/绘制，长评论列表滚动大幅减负 -->
          <div v-for="c in comments" :key="c.id" class="comment-item surface rounded-xl p-4">
            <div class="flex items-center gap-2">
              <img v-if="c.user?.avatar" :src="c.user.avatar" alt="" class="h-7 w-7 rounded-full object-cover" draggable="false" />
              <div v-else class="flex h-7 w-7 items-center justify-center rounded-full bg-primary/20 text-xs font-bold text-primary">{{ (c.user?.name || "?").charAt(0) }}</div>
              <div class="flex-1">
                <span class="text-sm font-semibold text-foreground">{{ c.user?.name || $t('detail.anonymous') }}</span>
                <span v-if="c.user?.issp" class="ml-1 rounded bg-tertiary/30 px-1 text-[9px] text-tertiary-foreground">UP</span>
              </div>
              <span class="text-[10px] text-muted-foreground">{{ fmtCommentDate(c.date) }}</span>
            </div>
            <p class="mt-2 text-sm leading-relaxed text-foreground/80">{{ c.text }}</p>
            <div class="mt-2 flex items-center gap-4 text-[11px] text-muted-foreground">
              <span v-if="c.likes_count" class="flex items-center gap-1">♥ {{ c.likes_count }}</span>
              <button v-if="c.replies_count > 0" @click="toggleReplies(c.id)" class="flex items-center gap-1 hover:text-foreground">
                {{ (expandedReplies.has(c.id) ? $t('common.collapse') : $t('common.expand')) + ' ' + $t('detail.replies', { n: c.replies_count }) }}
                <ChevronDown :class="cn('h-3 w-3 transition-transform', expandedReplies.has(c.id) && 'rotate-180')" />
              </button>
              <span v-if="c.address" class="text-muted-foreground/50">{{ c.address }}</span>
            </div>
            <div v-if="expandedReplies.has(c.id) && repliesCache[c.id]" class="mt-3 ml-9 space-y-3 border-l border-border/40 pl-4">
              <div v-if="repliesLoading.has(c.id)" class="text-xs text-muted-foreground">{{ $t('common.loading') }}</div>
              <div v-for="r in repliesCache[c.id]" :key="r.id" class="rounded-lg bg-muted p-2.5">
                <div class="flex items-center gap-2">
                  <img v-if="r.user?.avatar" :src="r.user.avatar" alt="" class="h-5 w-5 rounded-full object-cover" />
                  <span class="text-xs font-semibold text-foreground">{{ r.user?.name || $t('detail.anonymous') }}</span>
                  <span class="text-[10px] text-muted-foreground">{{ fmtCommentDate(r.date) }}</span>
                </div>
                <p class="mt-1 text-xs leading-relaxed text-foreground/70">{{ r.text }}</p>
              </div>
              <div v-if="repliesCache[c.id].length === 0" class="text-xs text-muted-foreground">{{ $t('detail.noReplies') }}</div>
            </div>
          </div>
        </div>
      </div>

      <!-- ── 角色（需求：可点击查看详情）── -->
      <div v-else-if="activeTab === 'characters'" key="characters">
        <div v-if="!characters || characters.length === 0" class="py-10 text-center text-sm text-muted-foreground">{{ $t('detail.noCharacters') }}</div>
        <div v-else ref="charGridRef" class="w-full overflow-hidden" :style="{ ...charGridStyle, contain: 'layout', maxWidth: '100%' }">
          <button
            v-for="c in characters"
            :key="c.id"
            class="group min-w-0 text-center"
            @click="openEntity('character', c.id, c.name, c.image)"
            v-tip="c.name"
          >
            <!-- 无边框：仅上半身截图 + 名称 + CV；hover 高亮提示可点击 -->
            <div class="aspect-square w-full overflow-hidden rounded-xl bg-muted ring-1 ring-transparent transition-shadow group-hover:ring-primary/40">
              <img :src="c.image" :alt="c.name" loading="lazy" class="h-full w-full object-cover object-top" @error="onCharImgError" />
            </div>
            <p class="mt-1.5 line-clamp-1 text-xs font-medium text-foreground transition-colors group-hover:text-primary">{{ c.name }}</p>
            <p v-if="c.actors[0]" class="line-clamp-1 text-[10px] text-muted-foreground">CV: {{ c.actors[0].name }}</p>
          </button>
        </div>
      </div>

      <!-- ── 制作（需求：角色项右侧新增；数据 = AniCh 代理 Bangumi 制作人员，按职务分组）── -->
      <div v-else-if="activeTab === 'staff'" key="staff">
        <div v-if="staffLoading" class="grid grid-cols-[repeat(auto-fill,minmax(96px,1fr))] gap-3">
          <div v-for="i in 8" :key="i" class="aspect-square rounded-xl shimmer" />
        </div>
        <div v-else-if="staffGroups.length === 0" class="py-10 text-center text-sm text-muted-foreground">{{ $t('detail.noStaff') }}</div>
        <div v-else class="space-y-5">
          <section v-for="g in staffGroups" :key="g.job" class="detail-section">
            <h4 class="mb-2 flex items-center gap-2 text-sm font-bold text-foreground">
              {{ g.job === '—' ? $t('detail.staffOther') : g.job }}
              <span class="text-[10px] font-normal tabular-nums text-muted-foreground">{{ g.people.length }}</span>
            </h4>
            <div class="grid grid-cols-[repeat(auto-fill,minmax(96px,1fr))] gap-3">
              <button
                v-for="p in g.people"
                :key="`${g.job}-${p.id}`"
                class="group min-w-0 text-center"
                @click="openEntity('person', p.id, p.name, p.image)"
                v-tip="p.name"
              >
                <div class="aspect-square w-full overflow-hidden rounded-xl bg-muted ring-1 ring-transparent transition-shadow group-hover:ring-primary/40">
                  <img
                    v-if="p.image"
                    :src="p.image"
                    :alt="p.name"
                    loading="lazy"
                    class="h-full w-full object-cover object-top"
                    draggable="false"
                    @error="($event.target as HTMLElement).style.opacity = '0'"
                  />
                </div>
                <p class="mt-1.5 line-clamp-1 text-xs font-medium text-foreground transition-colors group-hover:text-primary">{{ p.name }}</p>
              </button>
            </div>
          </section>
        </div>
      </div>

      <!-- ── 关联条目（需求：角色项右侧新增；原推荐 Tab 同数据源升级为完整分组展示，点击进入应用内详情）── -->
      <div v-else-if="activeTab === 'bgmRelated'" key="bgmRelated">
        <div v-if="!related || related.length === 0" class="py-10 text-center text-sm text-muted-foreground">{{ $t('detail.noRelated') }}</div>
        <div v-else class="space-y-5">
          <section v-for="g in relatedGroups" :key="g.type" class="detail-section">
            <h4 class="mb-2 flex items-center gap-2 text-sm font-bold text-foreground">
              {{ g.type === '—' ? $t('detail.relatedOther') : g.type }}
              <span class="text-[10px] font-normal tabular-nums text-muted-foreground">{{ g.items.length }}</span>
            </h4>
            <div class="grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-3">
              <button
                v-for="item in g.items"
                :key="`${g.type}-${item.id}`"
                @click="ui.openDetail(item.id, item.image)"
                class="group flex min-w-0 flex-col text-left"
                v-tip="item.title"
              >
                <CoverImage :src="item.image" :alt="item.title" ratio="portrait" rounded="rounded-lg" class="transition-transform group-hover:scale-[1.03]" />
                <p class="mt-1.5 line-clamp-1 text-xs font-medium text-foreground transition-colors group-hover:text-primary">{{ item.title }}</p>
                <p v-if="item.episodesTotal > 0" class="text-[10px] tabular-nums text-muted-foreground">{{ $t('detail.totalEps', { n: item.episodesTotal }) }}</p>
              </button>
            </div>
          </section>
        </div>
      </div>
    </Transition>
    </div>

    <!-- 状态菜单遮罩：点击空白处关闭 -->
    <div v-if="statusMenuOpen" class="fixed inset-0 z-20" @click="closeStatusMenu" />

    <!-- ── 回到顶部（评论/制作等长内容页通用）：Teleport 到 body，真视口 fixed 右下角 ──
         移动端抬高避开底部导航，桌面端贴角落；淡入淡出见 globals.css .backtop-* -->
    <Teleport to="body">
      <Transition name="backtop">
        <button
          v-if="showBackTop"
          @click="backToTop"
          class="fixed bottom-20 right-5 z-[60] flex h-10 w-10 items-center justify-center rounded-full border border-border bg-card text-muted-foreground shadow-lg shadow-black/10 transition-colors hover:text-foreground active:scale-95 md:bottom-6 md:right-6 dark:shadow-black/50"
          v-tip="$t('common.backTop')"
          :aria-label="$t('common.backTop')"
        >
          <ChevronUp class="h-4.5 w-4.5" />
        </button>
      </Transition>
    </Teleport>

    <!-- ── 重新匹配弹窗：搜索 AniCh 并手动选择正确条目 ── -->
    <div v-if="rematchOpen" class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" @click.self="closeRematch">
      <div class="flex max-h-[80vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl shadow-black/30">
        <div class="flex shrink-0 items-center justify-between gap-2 border-b border-border/70 px-4 py-3">
          <h3 class="text-sm font-semibold text-foreground">{{ $t('detail.rematchTitle') }}</h3>
          <button @click="closeRematch" class="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground">
            <X class="h-4 w-4" />
          </button>
        </div>
        <div class="shrink-0 px-4 py-3">
          <p class="mb-2.5 text-[11px] leading-relaxed text-muted-foreground">{{ $t('detail.rematchHint') }}</p>
          <div class="flex gap-2">
            <input
              v-model="rematchKeyword"
              @keydown.enter="doRematchSearch"
              :placeholder="$t('detail.rematchPlaceholder')"
              class="min-w-0 flex-1 rounded-lg border border-border bg-background px-3 py-2 text-xs text-foreground outline-none focus:border-primary/50"
            />
            <button
              @click="doRematchSearch"
              :disabled="rematchLoading || !rematchKeyword.trim()"
              class="state-layer flex shrink-0 items-center gap-1.5 rounded-lg bg-primary px-3.5 py-2 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              <Loader2 v-if="rematchLoading" class="h-3.5 w-3.5 animate-spin" />
              <SearchIcon v-else class="h-3.5 w-3.5" />
              {{ $t('detail.rematchSearch') }}
            </button>
          </div>
        </div>
        <div class="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
          <div v-if="rematchLoading" class="space-y-2 pt-1">
            <div v-for="i in 4" :key="i" class="h-14 rounded-xl shimmer" />
          </div>
          <div v-else-if="rematchResults && rematchResults.length === 0" class="py-10 text-center text-xs text-muted-foreground">
            {{ $t('detail.rematchEmpty') }}
          </div>
          <div v-else-if="rematchResults" class="flex flex-col gap-1.5">
            <button
              v-for="it in rematchResults"
              :key="it.id"
              @click="applyRematch(it)"
              class="flex items-center gap-3 rounded-xl border border-transparent p-2 text-left transition-colors hover:border-primary/30 hover:bg-primary/5"
            >
              <CoverImage :src="it.image" :alt="it.title" ratio="portrait" rounded="rounded-lg" class="w-10 shrink-0" />
              <div class="min-w-0 flex-1">
                <p class="line-clamp-1 text-xs font-semibold text-foreground">{{ it.title }}</p>
                <p class="mt-0.5 text-[10px] text-muted-foreground">
                  ID {{ it.id }}<template v-if="it.episodes_total"> · {{ $t('detail.totalEps', { n: it.episodes_total }) }}</template>
                </p>
              </div>
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- ── 角色/制作人员详情弹窗（可点击查看详情）── -->
    <BgmEntityDialog
      v-if="entity"
      :kind="entity.kind"
      :id="entity.id"
      :initial-name="entity.name"
      :initial-image="entity.image"
      @close="entity = null"
    />
  </div>
</template>
