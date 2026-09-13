<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from "vue";
import { Bookmark, Trash2, Star, Library, CircleUserRound, ChevronDown, Loader2, X, Check, TriangleAlert } from "lucide-vue-next";
import { useLibraryStore, STATUS_I18N_KEYS, STATUS_ORDER, STATUS_STYLES, type TrackStatus, type LibraryEntry } from "@/stores/library";
import { useUIStore } from "@/stores/ui";
import { anich } from "@/lib/anich/api-client";
import * as bgmApi from "@/lib/bangumi/client";
import { useBangumi } from "@/lib/bangumi/useBangumi";
import { useI18n } from "vue-i18n";
import SectionCard from "@/components/SectionCard.vue";
import CoverImage from "@/components/CoverImage.vue";
import { cn } from "@/lib/utils";
import { logInfo, logWarn } from "@/lib/logger";
import type { BgmEpisode } from "@/lib/bangumi/types";

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
  // 默认展开的条目：错峰预取云端逐集状态（芯片三色 + 云端对齐）。
  // 200ms 间隔串行化，避免同时打开几十个请求触发限流。
  if (bgmApi.isLoggedIn()) {
    library.list
      .filter((e) => e.bgmId && isEpExpanded(e))
      .forEach((e, i) => {
        setTimeout(() => void ensureCloudEpisodes(e), Math.min(i * 200, 2000));
      });
  }
  // 浮层全局关闭监听（Teleport 到 body 的弹层依赖 document 级事件）
  document.addEventListener("pointerdown", onDocPointerDown, true);
  document.addEventListener("keydown", onDocKeyDown);
  window.addEventListener("resize", closeFloat);
  window.addEventListener("scroll", onAnyScroll, { capture: true, passive: true });
});

onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", onDocPointerDown, true);
  document.removeEventListener("keydown", onDocKeyDown);
  window.removeEventListener("resize", closeFloat);
  window.removeEventListener("scroll", onAnyScroll, true);
  clearTimers();
  floatMenu.value = null;
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
// 需求 2026-09-13：集数明细「默认展开」，且展开/收起的选择要被记住 ——
// 此前展开状态只存在组件内存里，切页/重启后一律收回默认，用户视角即
// 「默认状态无法更改」。现改为 localStorage 持久化（按条目 id 记忆收起列表），
// 没有记录的条目（含新入库番剧）一律默认展开。
const EP_COLLAPSED_KEY = "aikf:library-epdetail:v1";

function loadEpCollapsed(): Set<number> {
  try {
    const raw = JSON.parse(localStorage.getItem(EP_COLLAPSED_KEY) || "[]") as number[];
    return new Set(Array.isArray(raw) ? raw.filter((n) => Number.isFinite(n)) : []);
  } catch {
    return new Set();
  }
}

function persistEpCollapsed(s: Set<number>) {
  try {
    localStorage.setItem(EP_COLLAPSED_KEY, JSON.stringify([...s]));
  } catch {
    /* storage full / unavailable */
  }
}

const epCollapsed = ref<Set<number>>(loadEpCollapsed());
const isEpExpanded = (entry: LibraryEntry) => !epCollapsed.value.has(entry.id);

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
  const s = new Set(epCollapsed.value);
  let expanded: boolean;
  if (s.has(entry.id)) {
    s.delete(entry.id);
    expanded = true;
  } else {
    s.add(entry.id);
    expanded = false;
  }
  epCollapsed.value = s;
  persistEpCollapsed(s);
  if (expanded) void ensureCloudEpisodes(entry);
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

/** 点击集数芯片：本地 toggle + 同步更新云端状态缓存。
 *  需求 2026-09-13 修复：此前云端缓存（cloudEpTypes）在点击后仍是旧值，
 *  芯片样式里「ct===2 强制已看色」会压过本地变更 —— 表现为点击后
 *  界面纹丝不动，但 auto-sync 已把变更推到 API（云端变了、界面没变）。 */
const clickEpisode = (entry: LibraryEntry, n: number) => {
  const willWatch = !entry.watchedEpisodes.includes(n);
  library.toggleEpisode(entry.id, n, entry.totalEpisodes);
  const cur = cloudEpTypes.value.get(entry.id);
  if (cur) {
    const nextEntry = new Map(cur);
    nextEntry.set(n, willWatch ? 2 : 0);
    const next = new Map(cloudEpTypes.value);
    next.set(entry.id, nextEntry);
    cloudEpTypes.value = next;
  }
};

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

// ── 视口浮层（需求 2026-09-13：bgm.tv 观看进度管理同款集数弹层 + 状态切换菜单）──
// 教训（前轮实测）：main 滚动容器带 contain:layout，fixed 后代会锚定滚动内容 ——
// 所有视口浮层必须 <Teleport to="body">；滚动/缩放时直接关闭（与 v-tip 行为一致）。
interface FloatMenuState {
  kind: "status" | "episode";
  entryId: number;
  ep?: number;
  x: number;
  y: number;
  pinned: boolean;
  step: "list" | "cancelConfirm";
}
const floatMenu = ref<FloatMenuState | null>(null);
const floatEl = ref<HTMLElement | null>(null);
const floatTrigger = ref<HTMLElement | null>(null);
let chipHoverTimer: number | null = null;
let floatCloseTimer: number | null = null;

const setFloatEl = (el: unknown) => {
  floatEl.value = (el as HTMLElement) ?? null;
};

const clearTimers = () => {
  if (chipHoverTimer !== null) { clearTimeout(chipHoverTimer); chipHoverTimer = null; }
  if (floatCloseTimer !== null) { clearTimeout(floatCloseTimer); floatCloseTimer = null; }
};

const closeFloat = () => {
  clearTimers();
  floatMenu.value = null;
  floatTrigger.value = null;
};

const scheduleFloatClose = (delay = 160) => {
  if (floatCloseTimer !== null) clearTimeout(floatCloseTimer);
  floatCloseTimer = window.setTimeout(() => {
    floatCloseTimer = null;
    closeFloat();
  }, delay);
};

const cancelFloatClose = () => {
  if (floatCloseTimer !== null) { clearTimeout(floatCloseTimer); floatCloseTimer = null; }
};

function openFloatAt(
  kind: "status" | "episode",
  entryId: number,
  trigger: HTMLElement,
  opts: { ep?: number; pinned: boolean }
) {
  cancelFloatClose();
  const r = trigger.getBoundingClientRect();
  const W = kind === "status" ? 176 : 256;
  const H = kind === "status" ? 300 : 168; // 估高：仅用于上下翻转判断
  const GAP = 6;
  let y = r.bottom + GAP;
  if (y + H > window.innerHeight - 8) y = Math.max(8, r.top - GAP - H);
  const x = Math.min(Math.max(8, r.right - W), window.innerWidth - W - 8);
  floatTrigger.value = trigger;
  floatMenu.value = { kind, entryId, ep: opts.ep, x, y, pinned: opts.pinned, step: "list" };
}

/** 浮层可用性：已登录且条目已绑定 Bangumi（否则芯片退回旧的点击切换已看） */
const canFloat = (entry: LibraryEntry) => bgmApi.isLoggedIn() && !!entry.bgmId;

// ── 章节元数据缓存（bgmId → 集数 → 章节）：弹层标题/首播/时长 + PATCH 所需 episode id ──
// GET /v0/episodes 为公开接口（无需登录），bgmOnly 条目同样可显示详情。
const epMeta = ref<Map<number, Map<number, BgmEpisode>>>(new Map());
const epMetaLoading = ref<Set<number>>(new Set());

async function ensureEpMeta(bgmId: number) {
  if (epMeta.value.has(bgmId) || epMetaLoading.value.has(bgmId)) return;
  epMetaLoading.value = new Set(epMetaLoading.value).add(bgmId);
  try {
    const eps = await bgmApi.getEpisodes(bgmId);
    const m = new Map<number, BgmEpisode>();
    for (const e of eps) {
      if (e.type !== 0) continue; // 仅正篇（SP/OP/ED 不参与逐集进度）
      const num = typeof e.ep === "number" ? e.ep : e.order ? parseFloat(e.order) : Number.NaN;
      if (Number.isInteger(num) && num >= 1) m.set(num, e);
    }
    const next = new Map(epMeta.value);
    next.set(bgmId, m);
    epMeta.value = next;
  } catch {
    /* 拉取失败：弹层仍显示芯片三色状态，仅无详情与操作按钮 */
  } finally {
    const s = new Set(epMetaLoading.value);
    s.delete(bgmId);
    epMetaLoading.value = s;
  }
}

// ── 集数芯片 hover / 点击 → 弹层 ──
function hoverChip(entry: LibraryEntry, n: number, ev: MouseEvent) {
  if (!canFloat(entry)) return;
  const el = ev.currentTarget as HTMLElement; // currentTarget 在定时器回调里已失效，须先捕获
  if (chipHoverTimer !== null) clearTimeout(chipHoverTimer);
  chipHoverTimer = window.setTimeout(() => {
    chipHoverTimer = null;
    openEpisodeFloat(entry, n, el, false);
  }, 150);
}

function leaveChip() {
  if (chipHoverTimer !== null) { clearTimeout(chipHoverTimer); chipHoverTimer = null; }
  const fm = floatMenu.value;
  if (fm?.kind === "episode" && !fm.pinned) scheduleFloatClose(160);
}

function pinChip(entry: LibraryEntry, n: number, ev: MouseEvent) {
  if (!canFloat(entry)) {
    clickEpisode(entry, n); // 未登录/未绑定：保持旧的点击切换已看
    return;
  }
  openEpisodeFloat(entry, n, ev.currentTarget as HTMLElement, true);
}

function openEpisodeFloat(entry: LibraryEntry, n: number, el: HTMLElement, pinned: boolean) {
  if (entry.bgmId) void ensureEpMeta(entry.bgmId);
  void ensureCloudEpisodes(entry);
  openFloatAt("episode", entry.id, el, { ep: n, pinned });
}

// ── 状态切换菜单（需求：番剧栏状态可点击，切换 想看/在看/看过/搁置/抛弃/取消追番）──
function toggleStatusMenu(entry: LibraryEntry, ev: MouseEvent) {
  const el = ev.currentTarget as HTMLElement;
  const fm = floatMenu.value;
  if (fm?.kind === "status" && fm.entryId === entry.id) {
    closeFloat();
    return;
  }
  openFloatAt("status", entry.id, el, { pinned: true });
}

const fmEntry = computed<LibraryEntry | null>(() =>
  floatMenu.value ? (library.entries[floatMenu.value.entryId] ?? null) : null
);
const fmEpMeta = computed<BgmEpisode | undefined>(() => {
  const fm = floatMenu.value;
  const e = fmEntry.value;
  if (!fm || fm.kind !== "episode" || !e?.bgmId) return undefined;
  return epMeta.value.get(e.bgmId)?.get(fm.ep ?? 0);
});
const fmEpWatched = computed(() => {
  const fm = floatMenu.value;
  const e = fmEntry.value;
  if (!fm || !e) return false;
  const n = fm.ep ?? 0;
  return e.watchedEpisodes.includes(n) || (cloudEpTypes.value.get(e.id)?.get(n) ?? 0) === 2;
});
const fmEpLoading = computed(() => {
  const e = fmEntry.value;
  return !!e?.bgmId && epMetaLoading.value.has(e.bgmId);
});

function applyStatus(next: TrackStatus) {
  const fm = floatMenu.value;
  if (!fm) return;
  library.setStatus(fm.entryId, next);
  closeFloat();
}

/** 非遮罩警告：同一浮层内切换为确认视图（无 backdrop，页面保持可交互） */
function askCancelTrack() {
  if (floatMenu.value) floatMenu.value = { ...floatMenu.value, step: "cancelConfirm" };
}

async function confirmCancelTrack() {
  const fm = floatMenu.value;
  if (!fm) return;
  const entry = library.entries[fm.entryId];
  closeFloat();
  if (!entry) return;
  // 需求：取消追番即删除并同步 Bangumi。auto-sync 刻意不做删除同步（防误触），
  // 此处是用户显式确认后的唯一删除通道。
  library.remove(entry.id);
  if (entry.bgmId && bgmApi.isLoggedIn()) {
    try {
      await bgmApi.deleteCollection(entry.bgmId);
      logInfo("library", `已同步取消 Bangumi 收藏 subject=${entry.bgmId}`); // i18n-skip: 日志文案
    } catch (e: any) {
      logWarn("library", `Bangumi 取消收藏失败（本地已移除）: ${e?.message || e}`); // i18n-skip: 日志文案
    }
  }
}

// ── 集数状态操作（看过 / 看到 / 想看 / 抛弃 / 撤销）──
// 顺序：本地乐观更新（auto-sync 3s 后推收藏级 ep_status）→ 三色缓存即时刷色 →
// PATCH 章节状态（看到 = 1..n 全量标记，其余仅当前话）。
type EpAction = "watched" | "watchedTo" | "wish" | "drop" | "undo";
const epBusy = ref(false);

async function epAct(action: EpAction) {
  const fm = floatMenu.value;
  if (!fm || fm.kind !== "episode" || epBusy.value) return;
  const entry = library.entries[fm.entryId];
  const n = fm.ep ?? 0;
  const bgmId = entry?.bgmId;
  if (!entry || !bgmId || n < 1) return;
  epBusy.value = true;
  try {
    const range = action === "watchedTo" ? Array.from({ length: n }, (_, i) => i + 1) : [n];
    const type = action === "wish" ? 1 : action === "drop" ? 3 : action === "undo" ? 0 : 2;
    // 1) 本地先行：看过/看到 → 标记（记入 played）；想看/抛弃/撤销 → 已看则取消
    for (const m of range) {
      const cur = library.entries[entry.id]; // 每次重读：store action 会整体替换 entries
      if (!cur) break;
      if (type === 2) {
        if (!cur.watchedEpisodes.includes(m)) library.markPlayedEpisode(entry.id, m, entry.totalEpisodes);
      } else if (cur.watchedEpisodes.includes(m)) {
        library.unmarkEpisode(entry.id, m);
      }
    }
    // 2) 三色缓存即时更新（芯片颜色立即变化，不等网络）
    const curCache = cloudEpTypes.value.get(entry.id);
    if (curCache) {
      const nextEntry = new Map(curCache);
      for (const m of range) nextEntry.set(m, type);
      const next = new Map(cloudEpTypes.value);
      next.set(entry.id, nextEntry);
      cloudEpTypes.value = next;
    }
    // 3) 云端章节状态（EpisodeCollectionType：1 想看 / 2 看过 / 3 抛弃 / 0 撤销）
    const meta = epMeta.value.get(bgmId);
    const ids = range.map((m) => meta?.get(m)?.id).filter((x): x is number => typeof x === "number");
    if (ids.length > 0) await bgmApi.setEpisodesStatus(bgmId, ids, type);
    // 弹层保持打开（bgm.tv 同款）：操作后按钮状态随 fmEpWatched 即时刷新，可继续调整
  } catch (e: any) {
    logWarn("library", `集数状态云端同步失败（本地/界面已生效）: ${e?.message || e}`); // i18n-skip: 日志文案
  } finally {
    epBusy.value = false;
  }
}

/** 弹层状态按钮样式（bgm.tv 观看进度管理同款胶囊组） */
function pillBtn(kind: "primary" | "amber" | "red" | "plain" | "active"): string {
  switch (kind) {
    case "active":
      return "bg-primary text-primary-foreground";
    case "primary":
      return "bg-foreground/[0.06] text-foreground hover:bg-primary hover:text-primary-foreground";
    case "amber":
      return "bg-amber-500/10 text-amber-600 ring-1 ring-amber-500/30 hover:bg-amber-500/20 dark:text-amber-400";
    case "red":
      return "bg-destructive/10 text-destructive ring-1 ring-destructive/25 hover:bg-destructive/20";
    default:
      return "bg-foreground/[0.06] text-muted-foreground hover:text-foreground";
  }
}

// ── 全局关闭监听：点击外部 / Esc / 滚动 / 缩放 ──
function onDocPointerDown(e: PointerEvent) {
  if (!floatMenu.value) return;
  const target = e.target as Node | null;
  if (target && floatEl.value?.contains(target)) return;
  if (target && floatTrigger.value?.contains(target)) return; // 触发键自身由 click 切换
  closeFloat();
}
function onDocKeyDown(e: KeyboardEvent) {
  if (e.key === "Escape" && floatMenu.value) closeFloat();
}
function onAnyScroll() {
  if (floatMenu.value) closeFloat();
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
            <button @click="ui.openDetail(entry.id, entry.image)" class="block shrink-0">
              <CoverImage :src="entry.image" :alt="entry.title" ratio="portrait" class="h-28 w-20 sm:h-32 sm:w-24" rounded="rounded-xl" />
            </button>
            <!-- 需求 2026-09-13：去除封面底部「继续观看」悬浮键（续播入口保留在详情页） -->
            <div class="flex min-w-0 flex-1 flex-col">
              <div class="flex items-start justify-between gap-2">
                <button @click="ui.openDetail(entry.id, entry.image)" class="min-w-0 text-left">
                  <h3 class="line-clamp-1 text-base font-bold text-foreground hover:text-primary">{{ entry.title }}</h3>
                  <p v-if="entry.tagline" class="mt-0.5 line-clamp-1 text-xs text-muted-foreground">{{ entry.tagline }}</p>
                </button>
                <div class="flex shrink-0 items-center gap-1">
                  <!-- 需求 2026-09-13：状态样式改为可点击 —— 弹出切换菜单
                       （想看/在看/看过/搁置/抛弃 + 取消追番），取代原删除键 -->
                  <button
                    @click.stop="toggleStatusMenu(entry, $event)"
                    :class="cn('state-layer flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-semibold transition-[filter] hover:brightness-110', STATUS_STYLES[entry.status].chip)"
                  >
                    {{ $t(STATUS_I18N_KEYS[entry.status]) }}
                    <ChevronDown class="h-3 w-3 opacity-70" />
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
                <div v-if="(entry.totalEpisodes > 0 || entry.bgmId)" class="mt-1.5">
                  <button
                    @click="toggleEpDetail(entry)"
                    class="flex items-center gap-1 rounded px-0.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
                  >
                    <Loader2 v-if="cloudEpLoading.has(entry.id)" class="h-3 w-3 animate-spin" />
                    <ChevronDown v-else :class="cn('h-3 w-3 transition-transform duration-200', isEpExpanded(entry) && 'rotate-180')" />
                    {{ $t('library.epDetail') }}
                    <span class="tabular-nums">{{ realWatched(entry) }}{{ entry.totalEpisodes > 0 ? `/${entry.totalEpisodes}` : '' }}</span>
                  </button>
                  <div v-if="isEpExpanded(entry) && entry.totalEpisodes > 0" class="mt-1.5 flex max-h-[88px] flex-wrap gap-1 overflow-y-auto">
                    <button
                      v-for="n in entry.totalEpisodes"
                      :key="n"
                      @mouseenter="hoverChip(entry, n, $event)"
                      @mouseleave="leaveChip"
                      @click.stop="pinChip(entry, n, $event)"
                      :class="cn(
                        'h-6 min-w-[26px] rounded-md px-1 text-[10px] font-semibold tabular-nums transition-colors',
                        chipClass(entry, n)
                      )"
                      v-tip="canFloat(entry) ? '' : chipTip(entry, n)"
                    >{{ n }}</button>
                  </div>
                </div>
              </div>

              <!-- 评分（需求 2026-09-13：Bangumi 1-10 分制，本地存储 + auto-sync 自动同步云端；
                   再次点击当前分数 = 清除本地评分） -->
              <div class="mt-3 flex flex-wrap items-center gap-2">
                <div
                  class="flex items-center gap-0.5"
                  v-tip="entry.score > 0 ? $t('library.myScoreN', { n: entry.score }) : $t('library.myScore')"
                >
                  <button
                    v-for="n in 10"
                    :key="n"
                    @click="library.setScore(entry.id, entry.score === n ? 0 : n)"
                    class="state-layer rounded p-0.5"
                    :aria-label="$t('library.rateN', { n })"
                  >
                    <Star :class="cn('h-4 w-4 transition-colors', n <= entry.score ? 'fill-tertiary text-tertiary' : 'text-muted-foreground/35 hover:text-tertiary/70')" />
                  </button>
                  <span v-if="entry.score > 0" class="ml-1 text-xs font-bold tabular-nums text-tertiary">{{ entry.score }}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </TransitionGroup>
    </div>

    <!-- ── 视口浮层：状态切换菜单 / 集数弹层（Teleport body，脱离 contain:layout）── -->
    <Teleport to="body">
      <div
        v-if="floatMenu"
        :ref="setFloatEl"
        :class="cn(
          'fixed z-[90] overflow-hidden rounded-xl border border-border bg-card shadow-xl shadow-black/10 dark:shadow-black/40',
          floatMenu.kind === 'status' ? 'w-44' : 'w-64'
        )"
        :style="{ left: `${floatMenu.x}px`, top: `${floatMenu.y}px` }"
        @mouseenter="cancelFloatClose"
        @mouseleave="floatMenu?.kind === 'episode' && !floatMenu.pinned ? scheduleFloatClose() : undefined"
      >
        <!-- ① 状态切换菜单 -->
        <template v-if="floatMenu.kind === 'status'">
          <div v-if="floatMenu.step === 'list'" class="p-1">
            <p class="px-2 pb-0.5 pt-1.5 text-[10px] font-medium text-muted-foreground">{{ $t('library.changeStatus') }}</p>
            <button
              v-for="st in STATUS_ORDER"
              :key="st"
              @click="applyStatus(st)"
              :class="cn(
                'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-xs transition-colors hover:bg-foreground/5',
                fmEntry?.status === st ? 'font-semibold text-foreground' : 'text-muted-foreground'
              )"
            >
              <span :class="cn('h-1.5 w-1.5 shrink-0 rounded-full', STATUS_STYLES[st].dot)" />
              {{ $t(STATUS_I18N_KEYS[st]) }}
              <Check v-if="fmEntry?.status === st" class="ml-auto h-3 w-3 text-primary" />
            </button>
            <div class="my-1 h-px bg-border" />
            <button
              @click="askCancelTrack"
              class="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-destructive transition-colors hover:bg-destructive/10"
            >
              <Trash2 class="h-3 w-3 shrink-0" /> {{ $t('library.status.cancel') }}
            </button>
          </div>
          <!-- 取消追番：非遮罩警告（无 backdrop，页面保持可交互，确认后才删） -->
          <div v-else class="p-3">
            <div class="flex items-center gap-2">
              <TriangleAlert class="h-4 w-4 shrink-0 text-amber-500" />
              <p class="text-xs font-semibold text-foreground">{{ $t('library.cancelWarnTitle') }}</p>
            </div>
            <p class="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">{{ $t('library.cancelWarnDesc') }}</p>
            <div class="mt-2.5 flex items-center justify-end gap-1.5">
              <button
                @click="floatMenu = { ...floatMenu, step: 'list' }"
                class="rounded-lg px-2.5 py-1.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
              >{{ $t('library.cancelKeep') }}</button>
              <button
                @click="confirmCancelTrack"
                class="rounded-lg bg-destructive px-2.5 py-1.5 text-[11px] font-semibold text-destructive-foreground transition-opacity hover:opacity-90"
              >{{ $t('library.cancelConfirm') }}</button>
            </div>
          </div>
        </template>

        <!-- ② 集数弹层（bgm.tv 观看进度管理同款：信息 + 状态胶囊组） -->
        <template v-else-if="fmEntry">
          <div class="flex items-center justify-between gap-2 bg-primary px-2.5 py-1.5 text-primary-foreground">
            <p class="min-w-0 truncate text-xs font-semibold">
              {{ 'ep.' + floatMenu.ep + (fmEpMeta?.name || fmEpMeta?.name_cn ? ' ' + (fmEpMeta.name || fmEpMeta.name_cn) : '') }}
            </p>
            <button @click="closeFloat" class="rounded p-0.5 transition-colors hover:bg-white/20" :aria-label="$t('common.close')">
              <X class="h-3.5 w-3.5" />
            </button>
          </div>
          <div class="px-2.5 pb-2.5 pt-2">
            <div v-if="fmEpLoading" class="flex items-center gap-1.5 py-1 text-[11px] text-muted-foreground">
              <Loader2 class="h-3 w-3 animate-spin" /> {{ $t('common.loading') }}
            </div>
            <template v-else-if="fmEpMeta">
              <p v-if="fmEpMeta.name_cn && fmEpMeta.name" class="truncate text-[11px] text-foreground">
                <span class="text-muted-foreground">{{ $t('library.epTitleCn') }}: </span>{{ fmEpMeta.name_cn }}
              </p>
              <p v-if="fmEpMeta.airdate" class="mt-0.5 truncate text-[11px] text-foreground">
                <span class="text-muted-foreground">{{ $t('library.epAirdate') }}: </span>{{ fmEpMeta.airdate }}
              </p>
              <p v-if="fmEpMeta.duration" class="mt-0.5 truncate text-[11px] text-foreground">
                <span class="text-muted-foreground">{{ $t('library.epDuration') }}: </span>{{ fmEpMeta.duration }}
              </p>
            </template>
            <p v-else class="py-1 text-[11px] text-muted-foreground">{{ $t('library.epNoMeta') }}</p>

            <!-- 状态胶囊组：已看过 → [想看][抛弃][撤销][看过·激活]；未看过 → [看过][看到][想看][抛弃] -->
            <div v-if="fmEpMeta" class="mt-2 flex flex-wrap items-center gap-1.5">
              <template v-if="fmEpWatched">
                <button :disabled="epBusy" @click="epAct('wish')" :class="cn('rounded-md px-2 py-1 text-[10px] font-semibold transition-colors disabled:opacity-50', pillBtn('amber'))">{{ $t('library.actWish') }}</button>
                <button :disabled="epBusy" @click="epAct('drop')" :class="cn('rounded-md px-2 py-1 text-[10px] font-semibold transition-colors disabled:opacity-50', pillBtn('red'))">{{ $t('library.actDrop') }}</button>
                <button :disabled="epBusy" @click="epAct('undo')" :class="cn('rounded-md px-2 py-1 text-[10px] font-semibold transition-colors disabled:opacity-50', pillBtn('plain'))">{{ $t('library.actUndo') }}</button>
                <button :class="cn('cursor-default rounded-md px-2 py-1 text-[10px] font-semibold', pillBtn('active'))">{{ $t('library.actWatched') }}</button>
              </template>
              <template v-else>
                <button :disabled="epBusy" @click="epAct('watched')" :class="cn('rounded-md px-2 py-1 text-[10px] font-semibold transition-colors disabled:opacity-50', pillBtn('primary'))">{{ $t('library.actWatched') }}</button>
                <button :disabled="epBusy" @click="epAct('watchedTo')" :class="cn('rounded-md px-2 py-1 text-[10px] font-semibold transition-colors disabled:opacity-50', pillBtn('primary'))">{{ $t('library.actWatchedTo') }}</button>
                <button :disabled="epBusy" @click="epAct('wish')" :class="cn('rounded-md px-2 py-1 text-[10px] font-semibold transition-colors disabled:opacity-50', pillBtn('amber'))">{{ $t('library.actWish') }}</button>
                <button :disabled="epBusy" @click="epAct('drop')" :class="cn('rounded-md px-2 py-1 text-[10px] font-semibold transition-colors disabled:opacity-50', pillBtn('red'))">{{ $t('library.actDrop') }}</button>
              </template>
            </div>
          </div>
        </template>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.fade-up { animation: fadeUpL 0.3s ease both; }
@keyframes fadeUpL { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }
.lib-leave-active { transition: all 0.3s ease; }
.lib-leave-to { opacity: 0; transform: scale(0.96); }
</style>
