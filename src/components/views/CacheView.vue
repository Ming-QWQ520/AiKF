<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import {
  HardDriveDownload, FolderOpen, RefreshCw, ChevronDown, ChevronRight,
  Play, Trash2, Check, Download, AlertCircle, Loader2, FolderClosed, XCircle, Network, Zap,
  Activity, Database, Cpu, Layers, X,
} from "lucide-vue-next";
import { useUIStore } from "@/stores/ui";
import { useLibraryStore, STATUS_I18N_KEYS, STATUS_STYLES } from "@/stores/library";
import { useSettingsStore } from "@/stores/settings";
import {
  useCacheStore, isTauriEnv, formatBytes, formatDuration, formatSpeed, sanitizeName,
  type CacheBangumi,
} from "@/stores/cache";
import { anich } from "@/lib/anich/api-client";
import { useI18n } from "vue-i18n";
import {
  loadServerDanmaku, loadBiliDanmaku, loadDandanDanmaku, biliCidOf, mergeDanmaku,
  type DanmakuSource,
} from "@/lib/danmaku";
import { cn } from "@/lib/utils";
import CoverImage from "@/components/CoverImage.vue";

const ui = useUIStore();
const library = useLibraryStore();
const settings = useSettingsStore();
const cache = useCacheStore();
const { t } = useI18n();

onMounted(() => {
  cache.init();
});

// ── 追番库展开状态 ──
const expandedLib = ref<Set<number>>(new Set());
function toggleLibExpand(id: number) {
  const next = new Set(expandedLib.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  expandedLib.value = next;
  if (next.has(id)) ensureEpisodes(id);
}

// ── 已缓存番剧折叠状态（需求：增加折叠/收起按键）──
const expandedCached = ref<Set<number>>(new Set());
function toggleCachedExpand(id: number) {
  const next = new Set(expandedCached.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  expandedCached.value = next;
}

// ── 每部番剧的剧集列表（懒加载 API）──
// 保留 sites：缓存弹幕时需要 bili_cid 探测哔哩哔哩弹幕源
const apiEpisodes = ref<Record<number, { sort: number; title: string; sites?: { site: string; id: string }[] }[]>>({});
const episodesLoading = ref<Record<number, boolean>>({});
async function ensureEpisodes(id: number) {
  if (apiEpisodes.value[id] || episodesLoading.value[id]) return;
  episodesLoading.value = { ...episodesLoading.value, [id]: true };
  try {
    const eps = await anich.episodes(id);
    apiEpisodes.value = { ...apiEpisodes.value, [id]: eps.map((e) => ({ sort: e.sort, title: e.title, sites: e.sites })) };
  } catch {
    apiEpisodes.value = { ...apiEpisodes.value, [id]: [] };
  }
  episodesLoading.value = { ...episodesLoading.value, [id]: false };
}

// ── 选择状态（先选择再下载）──
const selected = ref<Record<number, number[]>>({});
function isSelected(id: number, sort: number): boolean {
  return (selected.value[id] ?? []).includes(sort);
}
function toggleSelect(id: number, sort: number) {
  const cur = selected.value[id] ?? [];
  const next = cur.includes(sort) ? cur.filter((s) => s !== sort) : [...cur, sort];
  selected.value = { ...selected.value, [id]: next };
}
function selectAllUncached(id: number, sorts: number[]) {
  const uncached = sorts.filter((s) => {
    const st = cache.statusOf(id, s).status;
    return st !== "done" && st !== "downloading";
  });
  selected.value = { ...selected.value, [id]: Array.from(new Set([...(selected.value[id] ?? []), ...uncached])) };
}
function clearSelect(id: number) {
  selected.value = { ...selected.value, [id]: [] };
}

// ── 下载节点（线路）自选 ──
// 每部番剧可手动指定从哪条线路/节点下载；"" = 自动（HLS 优选 adkwai，无 HLS 回退直链单线程）。
// 线路选项从第一话（或首选中的最小集数）的 VOD 解析，按「主机名+协议」去重。
interface DlLineOption { key: string; host: string; name: string; adkwai: boolean; proto: string }
const lineMenuFor = ref<number | null>(null);
const lineOptions = ref<Record<number, DlLineOption[]>>({});
const lineOptionsLoading = ref<Record<number, boolean>>({});
const pickedLine = ref<Record<number, string>>({});

function currentLineSort(id: number): number {
  const sel = selected.value[id] ?? [];
  return sel.length ? Math.min(...sel) : 1;
}
async function toggleLineMenu(id: number) {
  if (lineMenuFor.value === id) { lineMenuFor.value = null; return; }
  lineMenuFor.value = id;
  if (lineOptions.value[id]) return;
  lineOptionsLoading.value = { ...lineOptionsLoading.value, [id]: true };
  try {
    const vod = await anich.vod(id, currentLineSort(id));
    const seen = new Set<string>();
    const opts: DlLineOption[] = [];
    for (const s of vod.sources ?? []) {
      // 下载器支持 m3u8（多线程）与直链单文件 MP4（单线程），与 pickSource 策略一致
      const proto = sourceProto(s.url);
      if (!proto) continue;
      const host = hostOf(s.url);
      // 按「主机名+协议」去重：同一主机可能同时提供 m3u8 与 MP4 直链源，
      // 只按主机名去重会把直链线路挤掉
      const dk = `${host}|${proto}`;
      if (seen.has(dk)) continue;
      seen.add(dk);
      opts.push({ key: host, host, name: (s.caption || "").trim() || host, adkwai: isAdkwai(s.url), proto });
    }
    lineOptions.value = { ...lineOptions.value, [id]: opts };
  } catch {
    lineOptions.value = { ...lineOptions.value, [id]: [] };
  }
  lineOptionsLoading.value = { ...lineOptionsLoading.value, [id]: false };
}
function pickLine(id: number, key: string) {
  pickedLine.value = { ...pickedLine.value, [id]: key };
  lineMenuFor.value = null;
}
function pickedLineName(id: number): string {
  const key = pickedLine.value[id];
  if (!key) return t("cache.autoPick");
  return lineOptions.value[id]?.find((o) => o.key === key)?.name ?? key;
}

// ── 下载动作 ──
const resolving = ref<Record<number, boolean>>({});
const downloadError = ref<Record<number, string>>({});
async function startDownload(entry: { id: number; title: string; image: string; totalEpisodes: number }) {
  const id = entry.id;
  const sorts = selected.value[id] ?? [];
  if (sorts.length === 0) return;
  downloadError.value = { ...downloadError.value, [id]: "" };
  resolving.value = { ...resolving.value, [id]: true };
  try {
    // 为每集取 VOD 播放地址（并行解析：减少批量下载时首集 URL 的等待与过期风险）
    const sortsAsc = [...sorts].sort((a, b) => a - b);
    // Promise.all 保持输入顺序，episodes 已按集数升序
    const episodes: { sort: number; title: string; url: string; lineName: string }[] = await Promise.all(
      sortsAsc.map(async (sort) => {
        const vod = await anich.vod(id, sort);
        const want = pickedLine.value[id] ?? "";
        const src = pickSource(vod.sources ?? [], want);
        if (!src) throw new Error(t("cache.errNoSource", { n: sort }));
        // 自选节点严格匹配：该话在所选线路下无可用源时明确报错（不静默回退）
        if (want && hostOf(src.url) !== want) {
          throw new Error(t("cache.errNoSourceOnLine", { n: sort, line: pickedLineName(id) }));
        }
        return {
          sort,
          title: apiEpisodes.value[id]?.find((e) => e.sort === sort)?.title || t("common.huaN", { n: sort }),
          url: src.url,
          lineName: src.caption || hostOf(src.url),
        };
      })
    );
    await cache.startDownload({
      bangumiId: id,
      title: entry.title,
      cover: entry.image,
      totalEpisodes: entry.totalEpisodes || apiEpisodes.value[id]?.length || 0,
      threads: settings.data.cacheThreads,
      mp4Threads: settings.data.cacheMp4Threads,
      episodes,
    });
    clearSelect(id);
    await cache.refresh();
    // 需求：本地缓存增加缓存弹幕 —— 后台逐集拉取多源弹幕写入缓存目录（不阻塞下载流程）
    void cacheDanmakuFor(id, sortsAsc, entry.title);
  } catch (e: unknown) {
    downloadError.value = { ...downloadError.value, [id]: e instanceof Error ? e.message : String(e) };
  }
  resolving.value = { ...resolving.value, [id]: false };
}

function hostOf(url: string): string {
  try { return new URL(url).hostname; } catch { return t("common.unknownSource"); }
}
function isAdkwai(url: string): boolean { return url.includes("adkwai.com"); }
// 判定逻辑必须与播放页（PlayerDialog sourceProtoLabel）保持一致：
// 否则播放页显示的线路在缓存页的节点下拉里会丢失。
function isHls(url: string): boolean {
  return /\.m3u8(\?|#|$)/i.test(url) || url.includes("/m3u8/") || url.includes("/parse/m3u8");
}
/** 视频直链（mp4/webm/mov/m4v/mkv/ts；下载器按单文件单线程下载）。
 *  实测 API 大量线路（adkwai/kwai/xfvod 等）为 MP4 直链——播放页标「MP4」。 */
function isVideo(url: string): boolean {
  return /\.(mp4|webm|mov|m4v|mkv|ts)(\?|#|$)/i.test(url);
}
/** 线路协议标签：m3u8 / MP4；不支持的源返回空串（判定与播放页 sourceProtoLabel 一致） */
function sourceProto(url: string): string {
  if (isHls(url)) return "m3u8";
  if (isVideo(url)) return "MP4";
  return "";
}
/** 协议 chip 配色：m3u8 天蓝 / MP4 琥珀 */
function protoChipClass(proto: string): string {
  if (proto === "m3u8") return "bg-sky-500/15 text-sky-600 dark:text-sky-400";
  return "bg-amber-500/15 text-amber-600 dark:text-amber-400";
}
/**
 * 缓存选源策略：m3u8（多线程）优先，无 m3u8 时回退直链 MP4（单线程下载）。
 * 用户自选节点（preferredHost）在全部可用源中优先精确匹配 →
 * 自动模式下 HLS adkwai 优先 → 任意 HLS → MP4。
 * 无可用源返回 null（由调用方报错）。
 */
function pickSource(sources: { url: string; caption: string }[], preferredHost = ""): { url: string; caption: string } | null {
  if (!sources.length) return null;
  if (preferredHost) {
    const m = sources.find((s) => hostOf(s.url) === preferredHost && sourceProto(s.url));
    if (m) return m;
  }
  const hls = sources.filter((s) => isHls(s.url));
  if (hls.length) {
    const kwai = hls.find((s) => isAdkwai(s.url));
    return kwai ?? hls[0];
  }
  const video = sources.find((s) => isVideo(s.url));
  return video ?? null;
}

// ── 缓存弹幕（需求：本地缓存增加缓存弹幕）──
// 开始下载后后台逐集拉取多源弹幕（服务端 + 哔哩哔哩 + 弹弹），
// 合并去重后写入缓存目录 danmaku.json，离线播放本地缓存时可直接加载。
const danmakuCached = ref<Record<number, boolean>>({});
async function cacheDanmakuFor(id: number, sorts: number[], title: string) {
  for (const sort of sorts) {
    try {
      const eps = apiEpisodes.value[id] ?? [];
      const ep = eps.find((e) => e.sort === sort);
      const parts: DanmakuSource[] = [];
      try { parts.push(await loadServerDanmaku(id, sort)); } catch {}
      try {
        const cid = biliCidOf(ep?.sites);
        if (cid) parts.push(await loadBiliDanmaku(cid));
      } catch {}
      try { parts.push(await loadDandanDanmaku(title, sort)); } catch {}
      const items = mergeDanmaku(parts);
      if (items.length > 0) {
        await cache.saveDanmaku({
          bangumiId: id,
          title,
          sort,
          epTitle: ep?.title || t("common.huaN", { n: sort }),
          json: JSON.stringify(items),
        });
      }
      danmakuCached.value = { ...danmakuCached.value, [id]: true };
    } catch (e) {
      console.warn("[AiKF Cache] 缓存弹幕失败:", sort, e);
    }
  }
}

async function cancelOne(id: number, sort: number) {
  await cache.cancelDownload(id, sort);
}
async function cancelAll(id: number) {
  await cache.cancelDownload(id);
}

// ── 播放本地缓存 ──
const playing = ref<string>("");
async function playLocal(id: number, sort: number, title: string, cover: string, epTitle: string) {
  const key = `${id}:${sort}`;
  playing.value = key;
  try {
    const url = await cache.playUrl(id, sort);
    if (!url) throw new Error(t("cache.errFileMissing"));
    ui.openLocalPlayer({ bangumiID: id, episode: sort, title, cover, episodeTitle: epTitle, localPath: url });
  } catch (e) {
    downloadError.value = { ...downloadError.value, [id]: e instanceof Error ? e.message : String(e) };
  }
  playing.value = "";
}

// ── 删除 ──
const confirmDelete = ref<string>("");
async function removeEpisode(id: number, sort: number) {
  await cache.removeCache(id, sort);
  confirmDelete.value = "";
}
async function removeBangumi(id: number) {
  await cache.removeCache(id);
  confirmDelete.value = "";
}

// ── 计算视图 ──
const libList = computed(() => library.list);
const cachedList = computed<CacheBangumi[]>(() =>
  cache.bangumi.filter((b) => b.episodes.some((e) => e.status === "done"))
);
const cachedDone = (b: CacheBangumi) => b.episodes.filter((e) => e.status === "done").length;
const cachedSize = (b: CacheBangumi) => b.episodes.filter((e) => e.status === "done").reduce((n, e) => n + (e.bytes || 0), 0);
const downloadingAny = computed(() => Object.keys(cache.live).length > 0);

function libCachedCount(id: number): number {
  return cache.byId(id)?.episodes.filter((e) => e.status === "done").length ?? 0;
}

/** 选集网格按集数升序展示（修复排序混乱不美观问题） */
function sortedApiEpisodes(id: number): { sort: number; title: string }[] {
  return [...(apiEpisodes.value[id] ?? [])].sort((a, b) => a.sort - b.sort);
}
function liveSummary(id: number): { count: number; bytes: number; bytesTotal: number; speed: number } {
  const live = cache.liveBangumi.get(id);
  if (live) {
    return { count: live.count, bytes: live.bytes, bytesTotal: live.bytesTotal, speed: live.speed };
  }
  let count = 0, bytes = 0, bytesTotal = 0, speed = 0;
  for (const ep of cache.byId(id)?.episodes ?? []) {
    const st = cache.statusOf(id, ep.sort);
    if (st.status !== "downloading") continue;
    count++;
    bytes += st.bytes || 0;
    bytesTotal += st.bytesTotal || 0;
    speed += st.speed || 0;
  }
  return { count, bytes, bytesTotal, speed };
}
function libProgress(entry: { id: number; totalEpisodes: number; currentEpisode: number; watchedEpisodes: number[] }) {
  const total = entry.totalEpisodes || 0;
  const cur = Math.min(entry.currentEpisode || entry.watchedEpisodes.length || 0, total || Infinity);
  if (total > 0) return { label: t("common.episodesOf", { cur, total }), pct: Math.min(100, Math.round((cur / total) * 100)) };
  return { label: cur > 0 ? t("common.episodesN", { n: cur }) : t("common.notStarted"), pct: 0 };
}

function fmtDate(ts: number): string {
  if (!ts) return "—";
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// ── Steam 下载管理器：下载中任务列表（参考用户上传的 Steam 截图）──
// 每部正在下载的番剧 = 一个 Steam 风格任务卡：封面 + 绿色进度条 +
// 「正在下载数据 X MB / Y MB」+ 速度 + 估计剩余时间 + 方形取消键。
interface DlTask {
  id: number; title: string; cover: string;
  count: number; sorts: number[]; currentSort: number; epTitle: string;
  bytes: number; bytesTotal: number; speed: number; pct: number; etaSec: number;
}
const downloadingList = computed<DlTask[]>(() => {
  const out: DlTask[] = [];
  for (const [idStr, agg] of cache.liveBangumi) {
    const id = Number(idStr);
    if (!Number.isFinite(id)) continue;
    const idx = cache.byId(id);
    const lib = library.list.find((e) => e.id === id);
    const sorts = [...agg.sorts].sort((a, b) => a - b);
    // 当前话 = 已有实际数据（分片/字节）的第一集，否则取最小集数
    const currentSort = sorts.find((s) => {
      const l = cache.live[`${id}:${s}`];
      return l && (l.bytes > 0 || l.segmentsTotal > 0);
    }) ?? sorts[0];
    const cur = currentSort != null ? cache.live[`${id}:${currentSort}`] : undefined;
    const bytes = cur?.bytes ?? 0;
    const bytesTotal = cur?.bytesTotal ?? 0;
    out.push({
      id,
      title: idx?.title || lib?.title || agg.title || t("cache.titleFallback", { id }),
      cover: idx?.cover || lib?.image || "",
      count: agg.count,
      sorts,
      currentSort: currentSort ?? 0,
      epTitle: idx?.episodes.find((e) => e.sort === currentSort)?.title || "",
      bytes,
      bytesTotal,
      speed: agg.speed,
      pct: bytesTotal > 0 ? Math.min(100, Math.round((bytes / bytesTotal) * 100)) : 0,
      etaSec: agg.speed > 0 && bytesTotal > bytes ? Math.round((bytesTotal - bytes) / agg.speed) : 0,
    });
  }
  return out.sort((a, b) => b.speed - a.speed);
});
const totalDlSpeed = computed(() => downloadingList.value.reduce((n, d) => n + d.speed, 0));
const totalDlCount = computed(() => downloadingList.value.reduce((n, d) => n + d.count, 0));

/** Steam 风格估计剩余时间 */
function formatEta(sec: number): string {
  if (!sec || sec <= 0) return "—";
  if (sec < 60) return t("cache.etaSec", { n: sec });
  if (sec < 3600) return t("cache.etaMinSec", { m: Math.floor(sec / 60), s: Math.round(sec % 60) });
  return t("cache.etaHourMin", { h: Math.floor(sec / 3600), m: Math.floor((sec % 3600) / 60) });
}

/** Steam 风格完成时间 */
function fmtCompleted(ts: number): string {
  if (!ts) return "—";
  const d0 = new Date(ts);
  const hm = `${String(d0.getHours()).padStart(2, "0")}:${String(d0.getMinutes()).padStart(2, "0")}`;
  const dayStart = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((dayStart(new Date()) - dayStart(d0)) / 86400000);
  if (diffDays === 0) return `${t("cache.today")} ${hm}`;
  if (diffDays === 1) return `${t("cache.yesterday")} ${hm}`;
  return `${fmtDate(ts).slice(0, 10)} ${hm}`;
}
/** 最近一集完成时间（Steam 已完成列表右侧的「完成于：」） */
function lastCompletedAt(b: CacheBangumi): number {
  return b.episodes.filter((e) => e.status === "done").reduce((m, e) => Math.max(m, e.cached_at || 0), 0);
}

// Steam 已完成区「清除全部」（删除全部已缓存番剧，二次确认后执行）
const clearAllConfirm = ref(false);
const clearingAll = ref(false);
async function clearAllCompleted() {
  clearingAll.value = true;
  try {
    for (const b of cachedList.value) await cache.removeCache(b.id);
  } finally {
    clearingAll.value = false;
    clearAllConfirm.value = false;
  }
}
</script>

<template>
  <div class="mx-auto flex max-w-[1400px] flex-col gap-5">
    <!-- 线路下拉点击遮罩：点击空白处关闭 -->
    <div v-if="lineMenuFor !== null" class="fixed inset-0 z-20" @click="lineMenuFor = null" />
    <!-- ═══ 页头：标题 + 缓存统计 + 操作（不再显示「保存至…」路径行） ═══ -->
    <div class="surface rounded-2xl p-5">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="flex items-center gap-3">
          <span class="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 text-primary ring-1 ring-primary/20">
            <HardDriveDownload class="h-5 w-5" />
          </span>
          <div>
            <h2 class="text-lg font-bold sm:text-xl">{{ $t('cache.title') }}</h2>
            <p class="text-xs text-muted-foreground sm:text-sm">{{ $t('cache.subtitle') }}</p>
          </div>
        </div>
        <div class="flex items-center gap-2">
          <button
            type="button"
            @click="cache.rescan()"
            class="state-layer flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
            v-tip="$t('cache.rebuildIndexTitle')"
          >
            <RefreshCw class="h-3.5 w-3.5" /> {{ $t('cache.rebuildIndex') }}
          </button>
          <button
            type="button"
            @click="cache.openDir()"
            class="state-layer flex items-center gap-1.5 rounded-lg bg-primary px-3.5 py-2 text-xs font-semibold text-primary-foreground transition-opacity hover:opacity-90"
          >
            <FolderOpen class="h-3.5 w-3.5" /> {{ $t('cache.openDir') }}
          </button>
        </div>
      </div>

      <!-- Steam 风格指标条：网络速度 / 下载队列 / 磁盘占用 / 线程（仿 Steam 顶栏「网络·峰值·磁盘使用量」） -->
      <div class="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        <div class="rounded-xl bg-muted/60 px-3.5 py-2.5">
          <p class="flex items-center gap-1 text-[10px] text-muted-foreground"><Activity class="h-3 w-3 text-emerald-500" /> {{ $t('cache.netSpeed') }}</p>
          <p class="mt-0.5 text-base font-bold tabular-nums text-foreground">
            <template v-if="totalDlSpeed > 0">{{ formatSpeed(totalDlSpeed) }}</template>
            <template v-else><span class="text-sm font-medium text-muted-foreground">{{ $t('cache.idle') }}</span></template>
          </p>
        </div>
        <div class="rounded-xl bg-muted/60 px-3.5 py-2.5">
          <p class="flex items-center gap-1 text-[10px] text-muted-foreground"><Download class="h-3 w-3 text-primary" /> {{ $t('cache.queue') }}</p>
          <p class="mt-0.5 text-base font-bold tabular-nums text-foreground">
            {{ $t('common.countBu', { n: downloadingList.length }) }}
            <span v-if="totalDlCount > 0" class="text-xs font-normal text-muted-foreground">· {{ $t('common.countEps', { n: totalDlCount }) }}</span>
          </p>
        </div>
        <div class="rounded-xl bg-muted/60 px-3.5 py-2.5">
          <p class="flex items-center gap-1 text-[10px] text-muted-foreground"><Database class="h-3 w-3 text-sky-500" /> {{ $t('cache.diskUsage') }}</p>
          <p class="mt-0.5 text-base font-bold tabular-nums text-foreground">
            {{ formatBytes(cache.cachedBytes) }}
            <span class="text-xs font-normal text-muted-foreground">· {{ $t('common.countEps', { n: cache.cachedCount }) }}</span>
          </p>
        </div>
        <div class="rounded-xl bg-muted/60 px-3.5 py-2.5">
          <p class="flex items-center gap-1 text-[10px] text-muted-foreground"><Cpu class="h-3 w-3 text-violet-500" /> {{ $t('cache.threads') }}</p>
          <p class="mt-0.5 flex items-baseline gap-1.5 text-base font-bold tabular-nums text-foreground">
            {{ settings.data.cacheThreads }}
            <span class="flex items-center gap-0.5 text-[10px] font-normal text-muted-foreground">
              <button class="rounded bg-foreground/10 px-1 leading-4 hover:bg-foreground/20" @click="settings.setCacheThreads(settings.data.cacheThreads - 1)">−</button>
              <button class="rounded bg-foreground/10 px-1 leading-4 hover:bg-foreground/20" @click="settings.setCacheThreads(settings.data.cacheThreads + 1)">＋</button>
            </span>
          </p>
        </div>
        <!-- 需求：并发下载 = 同时缓存的集数，默认 3，最高 12（m3u8/MP4 全部生效） -->
        <div class="rounded-xl bg-muted/60 px-3.5 py-2.5">
          <p class="flex items-center gap-1 text-[10px] text-muted-foreground"><Layers class="h-3 w-3 text-amber-500" /> {{ $t('cache.concurrency') }}</p>
          <p class="mt-0.5 flex items-baseline gap-1.5 text-base font-bold tabular-nums text-foreground">
            {{ settings.data.cacheMp4Threads }}
            <span class="flex items-center gap-0.5 text-[10px] font-normal text-muted-foreground">
              <button class="rounded bg-foreground/10 px-1 leading-4 hover:bg-foreground/20" @click="settings.setCacheMp4Threads(settings.data.cacheMp4Threads - 1)">−</button>
              <button class="rounded bg-foreground/10 px-1 leading-4 hover:bg-foreground/20" @click="settings.setCacheMp4Threads(settings.data.cacheMp4Threads + 1)">＋</button>
            </span>
          </p>
        </div>
      </div>
      <p v-if="!isTauriEnv" class="mt-3 rounded-lg bg-amber-500/10 px-3 py-2 text-[11px] text-amber-600 dark:text-amber-400">
        {{ $t('cache.browserHint') }}
      </p>
    </div>

    <!-- ═══ 下载中（Steam 下载管理器：绿色进度条 + 正在下载数据 + 估计剩余时间） ═══ -->
    <section v-if="downloadingList.length > 0">
      <div class="mb-3 flex items-center gap-3">
        <h3 class="flex flex-none items-baseline gap-1.5 text-[15px] font-bold text-foreground">
          {{ $t('cache.downloading') }} <span class="text-xs font-medium tabular-nums text-muted-foreground">({{ downloadingList.length }})</span>
        </h3>
        <span class="h-px min-w-6 flex-1 bg-foreground/10" />
        <span class="flex flex-none items-center gap-1.5 text-[11px] font-semibold tabular-nums text-emerald-500">
          <Activity class="h-3.5 w-3.5" /> {{ formatSpeed(totalDlSpeed) || $t('cache.connecting') }}
        </span>
      </div>

      <div class="flex flex-col gap-2.5">
        <!-- 注意：不能加 overflow-hidden —— 节点选择下拉需要溢出卡片边界 -->
        <div v-for="d in downloadingList" :key="`dl${d.id}`" class="surface rounded-2xl p-3.5 sm:p-4">
          <div class="flex items-center gap-3">
            <button type="button" class="shrink-0" @click="ui.openDetail(d.id, d.cover)">
              <CoverImage :src="d.cover" :alt="d.title" ratio="portrait" class="h-16 w-11 shrink-0 sm:h-[72px] sm:w-12" rounded="rounded-lg" />
            </button>
            <div class="min-w-0 flex-1">
              <div class="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <button type="button" class="line-clamp-1 max-w-full text-sm font-bold text-foreground hover:text-primary" @click="ui.openDetail(d.id, d.cover)">{{ d.title }}</button>
                <span class="text-[11px] text-muted-foreground">{{ $t('cache.downloadingN', { n: d.count }) }}</span>
              </div>
              <!-- Steam 进度行：正在下载数据 ── 242.6 MB / 799.1 MB -->
              <div class="mt-2 flex items-center justify-between gap-2 text-[11px]">
                <span class="truncate text-muted-foreground">
                  {{ $t('cache.downloadingData') }}<template v-if="d.currentSort"> · {{ $t('common.huaN', { n: d.currentSort }) }}<template v-if="d.epTitle"> {{ d.epTitle }}</template></template>
                </span>
                <span class="flex-none tabular-nums text-muted-foreground">
                  <span class="font-semibold text-foreground">{{ formatBytes(d.bytes) }}</span>
                  <template v-if="d.bytesTotal > 0"> / {{ formatBytes(d.bytesTotal) }}</template>
                  <template v-if="d.pct > 0"> · {{ d.pct }}%</template>
                </span>
              </div>
              <!-- Steam 绿色进度条 -->
              <div class="mt-1 h-2 overflow-hidden rounded-[3px] bg-emerald-500/15">
                <div class="h-full rounded-[3px] bg-gradient-to-r from-emerald-500 to-lime-400 transition-all duration-500" :style="{ width: d.pct + '%' }" />
              </div>
              <div class="mt-1.5 flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
                <span class="tabular-nums">{{ $t('cache.eta', { t: formatEta(d.etaSec) }) }}</span>
                <span class="font-semibold tabular-nums text-emerald-500">{{ formatSpeed(d.speed) || $t('cache.connecting') }}</span>
              </div>
            </div>
            <!-- Steam 方形取消键 -->
            <button
              type="button"
              @click="cancelAll(d.id)"
              class="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-destructive text-white shadow-sm transition-opacity hover:opacity-85"
              v-tip="$t('cache.cancelAllTitle')"
            >
              <X class="h-4 w-4" />
            </button>
          </div>
          <!-- 每集绿色迷你进度（Steam 更新任务的分集细节） -->
          <div class="mt-3 grid grid-cols-4 gap-1.5 sm:grid-cols-6 md:grid-cols-8 lg:grid-cols-10">
            <div
              v-for="s in d.sorts"
              :key="`dlep${d.id}-${s}`"
              class="relative flex h-[46px] flex-col items-center justify-center overflow-hidden rounded-lg border border-emerald-500/30 bg-emerald-500/[0.06]"
            >
              <span class="text-[13px] font-extrabold leading-none tabular-nums text-emerald-600 dark:text-emerald-400">{{ String(s).padStart(2, "0") }}</span>
              <span class="mt-1 text-[9px] leading-none tabular-nums text-emerald-600/80 dark:text-emerald-400/80">{{ cache.statusOf(d.id, s).pct }}%</span>
              <span class="absolute inset-x-1.5 bottom-1 h-[3px] overflow-hidden rounded-full bg-emerald-500/15">
                <span class="block h-full rounded-full bg-gradient-to-r from-emerald-500 to-lime-400 transition-all duration-500" :style="{ width: cache.statusOf(d.id, s).pct + '%' }" />
              </span>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- ═══ 追番库：先选择再下载（Steam「即将进行」队列） ═══ -->
    <section>
      <div class="mb-3 flex items-center gap-3">
        <h3 class="flex flex-none items-baseline gap-1.5 text-[15px] font-bold text-foreground">
          {{ $t('cache.upcoming') }} <span class="text-xs font-medium tabular-nums text-muted-foreground">({{ libList.length }})</span>
        </h3>
        <span class="h-px min-w-6 flex-1 bg-foreground/10" />
        <p class="flex-none text-[11px] text-muted-foreground">{{ $t('cache.upcomingHint') }}</p>
      </div>

      <div v-if="libList.length === 0" class="surface flex min-h-[200px] flex-col items-center justify-center gap-2 rounded-2xl p-8 text-center">
        <FolderClosed class="h-10 w-10 text-muted-foreground/30" />
        <p class="text-sm font-medium text-foreground">{{ $t('library.empty') }}</p>
        <p class="text-xs text-muted-foreground">{{ $t('cache.libEmptyHint') }}</p>
      </div>

      <div v-else class="flex flex-col gap-2.5">
        <!-- 注意：不能加 overflow-hidden —— 节点选择下拉需要向上溢出卡片边界 -->
        <div v-for="entry in libList" :key="entry.id" class="surface rounded-2xl">
          <!-- 行头 -->
          <div class="flex items-center gap-3 p-3 sm:px-4">
            <button type="button" class="shrink-0" @click="ui.openDetail(entry.id, entry.image)">
              <CoverImage :src="entry.image" :alt="entry.title" ratio="portrait" class="h-16 w-11 sm:h-[72px] sm:w-12" rounded="rounded-lg" />
            </button>
            <button type="button" class="min-w-0 flex-1 text-left" @click="ui.openDetail(entry.id, entry.image)">
              <div class="flex items-center gap-2">
                <h4 class="line-clamp-1 text-sm font-bold text-foreground hover:text-primary">{{ entry.title }}</h4>
                <span :class="cn('shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold', STATUS_STYLES[entry.status].chip)">{{ $t(STATUS_I18N_KEYS[entry.status]) }}</span>
              </div>
              <div class="mt-1.5 flex items-center gap-2">
                <div class="h-1 w-28 overflow-hidden rounded-full bg-foreground/10 sm:w-40">
                  <div class="h-full rounded-full bg-primary transition-all duration-500" :style="{ width: libProgress(entry).pct + '%' }" />
                </div>
                <span class="text-[10px] tabular-nums text-muted-foreground">{{ libProgress(entry).label }}</span>
              </div>
              <p v-if="liveSummary(entry.id).count > 0" class="mt-1 flex items-center gap-1.5 text-[10px] font-medium text-emerald-500">
                <Loader2 class="h-3 w-3 animate-spin" />
                {{ $t('cache.cachingN', { n: liveSummary(entry.id).count }) }}
                · {{ formatBytes(liveSummary(entry.id).bytes) }}<template v-if="liveSummary(entry.id).bytesTotal > 0"> / {{ $t('cache.approx') }} {{ formatBytes(liveSummary(entry.id).bytesTotal) }}</template>
                · {{ formatSpeed(liveSummary(entry.id).speed) || "…" }}
              </p>
              <p v-else class="mt-1 text-[10px] text-muted-foreground">
                <template v-if="libCachedCount(entry.id) > 0">{{ $t('cache.cachedN', { n: libCachedCount(entry.id) }) }}</template>
                <template v-else>{{ $t('cache.notCached') }}</template>
              </p>
            </button>
            <button
              v-if="cache.byId(entry.id)?.episodes.some((e) => e.status === 'downloading')"
              type="button"
              @click="cancelAll(entry.id)"
              class="state-layer shrink-0 rounded-lg border border-border px-2.5 py-1.5 text-[11px] font-medium text-destructive transition-colors hover:bg-destructive/10"
            >
              {{ $t('cache.cancelAll') }}
            </button>
            <button
              type="button"
              @click="toggleLibExpand(entry.id)"
              class="state-layer flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
              :aria-label="expandedLib.has(entry.id) ? $t('common.collapse') : $t('cache.expandPick')"
            >
              <ChevronDown v-if="expandedLib.has(entry.id)" class="h-4 w-4" />
              <ChevronRight v-else class="h-4 w-4" />
            </button>
          </div>

          <!-- 展开区：先选择，再下载 -->
          <div v-if="expandedLib.has(entry.id)" class="border-t border-border/60 px-3 pb-3.5 pt-3 sm:px-4">
            <div v-if="episodesLoading[entry.id]" class="flex items-center gap-2 py-4 text-xs text-muted-foreground">
              <Loader2 class="h-3.5 w-3.5 animate-spin" /> {{ $t('cache.fetchingEps') }}
            </div>
            <template v-else>
              <div class="grid grid-cols-5 gap-1.5 sm:grid-cols-6 md:grid-cols-8 lg:grid-cols-10">
                <button
                  v-for="ep in sortedApiEpisodes(entry.id)"
                  :key="ep.sort"
                  type="button"
                  :disabled="cache.statusOf(entry.id, ep.sort).status === 'downloading'"
                  @click="toggleSelect(entry.id, ep.sort)"
                  v-tip="`(${ep.sort}) ${ep.title}${cache.statusOf(entry.id, ep.sort).status === 'failed' ? ' · ' + cache.statusOf(entry.id, ep.sort).errorMsg : ''}`"
                  :class="cn(
                    'group relative flex h-[52px] flex-col items-center justify-center overflow-hidden rounded-xl border transition-all',
                    cache.statusOf(entry.id, ep.sort).status === 'done'
                      ? 'border-emerald-500/40 bg-emerald-500/10'
                      : cache.statusOf(entry.id, ep.sort).status === 'downloading'
                        ? 'border-primary/50 bg-primary/10'
                        : cache.statusOf(entry.id, ep.sort).status === 'failed'
                          ? 'border-destructive/40 bg-destructive/5'
                          : isSelected(entry.id, ep.sort)
                            ? 'border-primary bg-primary/15 ring-1 ring-primary/50'
                            : 'border-border bg-background/40 hover:border-foreground/30 hover:bg-foreground/[0.04]'
                  )"
                >
                  <!-- 状态角标（右上角） -->
                  <span class="absolute right-1 top-1">
                    <Check v-if="cache.statusOf(entry.id, ep.sort).status === 'done'" class="h-3 w-3 text-emerald-500" />
                    <Loader2 v-else-if="cache.statusOf(entry.id, ep.sort).status === 'downloading'" class="h-3 w-3 animate-spin text-primary" />
                    <XCircle v-else-if="cache.statusOf(entry.id, ep.sort).status === 'failed'" class="h-3 w-3 text-destructive" />
                    <Check v-else-if="isSelected(entry.id, ep.sort)" class="h-3 w-3 text-primary" />
                  </span>
                  <!-- 集数主数字 -->
                  <span
                    class="text-[15px] font-extrabold leading-none tabular-nums"
                    :class="
                      cache.statusOf(entry.id, ep.sort).status === 'done'
                        ? 'text-emerald-600 dark:text-emerald-400'
                        : cache.statusOf(entry.id, ep.sort).status === 'downloading' || isSelected(entry.id, ep.sort)
                          ? 'text-primary'
                          : cache.statusOf(entry.id, ep.sort).status === 'failed'
                            ? 'text-destructive'
                            : 'text-foreground/85'
                    "
                  >
                    {{ String(ep.sort).padStart(2, "0") }}
                  </span>
                  <!-- 底部小字（下载中时被进度条替代） -->
                  <span v-if="cache.statusOf(entry.id, ep.sort).status === 'done'" class="mt-1.5 text-[9px] leading-none tabular-nums text-muted-foreground">
                    {{ formatBytes(cache.statusOf(entry.id, ep.sort).bytes) }}
                  </span>
                  <span v-else-if="cache.statusOf(entry.id, ep.sort).status === 'downloading'" class="mt-1.5 text-[9px] leading-none tabular-nums text-primary/80">
                    {{ cache.statusOf(entry.id, ep.sort).pct }}%
                  </span>
                  <span v-else-if="cache.statusOf(entry.id, ep.sort).status === 'failed'" class="mt-1.5 text-[9px] leading-none text-destructive/80">{{ $t('cache.failed') }}</span>
                  <span v-else-if="isSelected(entry.id, ep.sort)" class="mt-1.5 text-[9px] leading-none text-primary/80">{{ $t('cache.selected') }}</span>
                  <span v-else class="mt-1.5 text-[9px] leading-none text-muted-foreground/50">{{ $t('cache.uncached') }}</span>
                  <!-- 下载中：迷你进度条 -->
                  <span
                    v-if="cache.statusOf(entry.id, ep.sort).status === 'downloading'"
                    class="absolute inset-x-2 bottom-1 h-[3px] overflow-hidden rounded-full bg-foreground/10"
                  >
                    <span
                      class="block h-full rounded-full bg-primary transition-all duration-500"
                      :style="{ width: cache.statusOf(entry.id, ep.sort).pct + '%' }"
                    />
                  </span>
                </button>
              </div>

              <!-- 操作条：先选择再下载 -->
              <div class="mt-3 flex flex-wrap items-center gap-2">
                <span class="text-xs font-medium text-foreground">
                  {{ $t('cache.selectedN', { n: (selected[entry.id] ?? []).length }) }}
                </span>
                <span class="text-[10px] text-muted-foreground">·</span>
                <button type="button" @click="selectAllUncached(entry.id, (apiEpisodes[entry.id] ?? []).map((e) => e.sort))" class="text-[11px] font-medium text-primary hover:underline">{{ $t('cache.selectAllUncached') }}</button>
                <button type="button" @click="clearSelect(entry.id)" class="text-[11px] font-medium text-muted-foreground hover:text-foreground">{{ $t('cache.clearSelection') }}</button>

                <span class="mx-1 hidden h-4 w-px bg-border sm:block" />

                <!-- 下载节点自选：自动优选 / 指定线路 -->
                <div class="relative">
                  <button
                    type="button"
                    @click.stop="toggleLineMenu(entry.id)"
                    class="flex items-center gap-1 rounded-md bg-foreground/[0.06] px-2 py-1 text-[11px] font-medium text-foreground transition-colors hover:bg-foreground/10"
                    v-tip="$t('cache.node')"
                  >
                    <Network class="h-3 w-3 text-muted-foreground" />
                    {{ $t('cache.node') }}：{{ pickedLineName(entry.id) }}
                    <ChevronDown :class="cn('h-3 w-3 text-muted-foreground transition-transform', lineMenuFor === entry.id && 'rotate-180')" />
                  </button>
                  <!-- 线路下拉（向上展开，避免超出卡片） -->
                  <div
                    v-if="lineMenuFor === entry.id"
                    class="absolute bottom-full left-0 z-30 mb-1.5 w-64 overflow-hidden rounded-xl border border-border bg-card shadow-xl shadow-black/20 dark:shadow-black/60"
                  >
                    <div class="border-b border-border/60 px-3 py-2 text-[10px] font-semibold text-muted-foreground">{{ $t('cache.pickNodeTitle') }}</div>
                    <div class="max-h-56 overflow-y-auto p-1">
                      <div v-if="lineOptionsLoading[entry.id]" class="flex items-center gap-2 px-2.5 py-3 text-[11px] text-muted-foreground">
                        <Loader2 class="h-3.5 w-3.5 animate-spin" /> {{ $t('cache.fetchingLines') }}
                      </div>
                      <template v-else>
                        <button
                          type="button"
                          @click="pickLine(entry.id, '')"
                          :class="cn('flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[11px] transition-colors hover:bg-foreground/5', !(pickedLine[entry.id]) ? 'font-bold text-primary' : 'text-foreground')"
                        >
                          <Zap class="h-3.5 w-3.5 shrink-0" />
                          <span class="min-w-0 flex-1">{{ $t('cache.autoPick') }}</span>
                          <span class="shrink-0 text-[9px] text-muted-foreground">{{ $t('cache.autoPickHint') }}</span>
                          <Check v-if="!pickedLine[entry.id]" class="h-3 w-3 shrink-0" />
                        </button>
                        <button
                          v-for="opt in lineOptions[entry.id] ?? []"
                          :key="opt.key"
                          type="button"
                          @click="pickLine(entry.id, opt.key)"
                          :class="cn('flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[11px] transition-colors hover:bg-foreground/5', pickedLine[entry.id] === opt.key ? 'font-bold text-primary' : 'text-foreground')"
                        >
                          <span class="h-1.5 w-1.5 shrink-0 rounded-full" :class="opt.adkwai ? 'bg-emerald-500' : 'bg-muted-foreground/40'" />
                          <span class="min-w-0 flex-1">
                            <span class="block truncate leading-tight">{{ opt.name }}</span>
                            <span class="block truncate text-[9px] font-normal leading-tight text-muted-foreground">{{ opt.host }}</span>
                          </span>
                          <span class="shrink-0 rounded px-1 py-0.5 text-[9px] font-semibold" :class="protoChipClass(opt.proto)">{{ opt.proto }}</span>
                          <span v-if="opt.adkwai" class="shrink-0 rounded bg-emerald-500/15 px-1 py-0.5 text-[9px] font-semibold text-emerald-600 dark:text-emerald-400">{{ $t('cache.preferred') }}</span>
                          <Check v-if="pickedLine[entry.id] === opt.key" class="h-3 w-3 shrink-0" />
                        </button>
                        <div v-if="(lineOptions[entry.id] ?? []).length === 0" class="px-2.5 py-3 text-[11px] text-muted-foreground">
                          {{ $t('cache.noLines') }}
                        </div>
                      </template>
                    </div>
                  </div>
                </div>

                <span class="mx-1 hidden h-4 w-px bg-border sm:block" />

                <span class="flex items-center gap-1 text-[11px] text-muted-foreground">
                  {{ $t('cache.threads') }}
                  <button type="button" @click="settings.setCacheThreads(settings.data.cacheThreads - 1)" class="flex h-5 w-5 items-center justify-center rounded bg-foreground/10 text-xs font-bold hover:bg-foreground/20">−</button>
                  <span class="w-5 text-center font-bold tabular-nums text-foreground">{{ settings.data.cacheThreads }}</span>
                  <button type="button" @click="settings.setCacheThreads(settings.data.cacheThreads + 1)" class="flex h-5 w-5 items-center justify-center rounded bg-foreground/10 text-xs font-bold hover:bg-foreground/20">＋</button>
                  <span class="text-[10px]">(1–32)</span>
                </span>

                <!-- 需求：并发下载 = 同时缓存的集数（默认 3，最高 12），全部线路类型生效 -->
                <span class="flex items-center gap-1 text-[11px] text-muted-foreground" v-tip="$t('cache.concurrencyTitle')">
                  {{ $t('cache.concurrency') }}
                  <button type="button" @click="settings.setCacheMp4Threads(settings.data.cacheMp4Threads - 1)" class="flex h-5 w-5 items-center justify-center rounded bg-foreground/10 text-xs font-bold hover:bg-foreground/20">−</button>
                  <span class="w-5 text-center font-bold tabular-nums text-foreground">{{ settings.data.cacheMp4Threads }}</span>
                  <button type="button" @click="settings.setCacheMp4Threads(settings.data.cacheMp4Threads + 1)" class="flex h-5 w-5 items-center justify-center rounded bg-foreground/10 text-xs font-bold hover:bg-foreground/20">＋</button>
                  <span class="text-[10px]">(1–12)</span>
                </span>

                <div class="ml-auto flex items-center gap-2">
                  <button
                    v-if="cache.byId(entry.id)?.episodes.some((e) => e.status === 'downloading')"
                    type="button"
                    @click="cancelAll(entry.id)"
                    class="state-layer rounded-lg border border-destructive/50 px-3 py-1.5 text-xs font-medium text-destructive transition-colors hover:bg-destructive/10"
                  >
                    {{ $t('cache.cancelDownload') }}
                  </button>
                  <button
                    type="button"
                    :disabled="(selected[entry.id] ?? []).length === 0 || resolving[entry.id]"
                    @click="startDownload({ id: entry.id, title: entry.title, image: entry.image, totalEpisodes: entry.totalEpisodes })"
                    class="state-layer flex items-center gap-1.5 rounded-lg bg-primary px-4 py-1.5 text-xs font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <Loader2 v-if="resolving[entry.id]" class="h-3.5 w-3.5 animate-spin" />
                    <Download v-else class="h-3.5 w-3.5" />
                    {{ resolving[entry.id] ? $t('cache.resolving') : $t('cache.startDownload') }}
                  </button>
                </div>
              </div>
              <p v-if="downloadError[entry.id]" class="mt-2 flex items-center gap-1.5 text-[11px] text-destructive">
                <AlertCircle class="h-3 w-3 shrink-0" /> {{ downloadError[entry.id] }}
              </p>
            </template>
          </div>
        </div>
      </div>
    </section>

    <!-- ═══ 已完成（Steam 已完成列表：缩略图 + 已下载量 + 完成时间 + 清除全部） ═══ -->
    <section>
      <div class="mb-3 flex items-center gap-3">
        <h3 class="flex flex-none items-baseline gap-1.5 text-[15px] font-bold text-foreground">
          {{ $t('cache.completed') }} <span class="text-xs font-medium tabular-nums text-muted-foreground">({{ cachedList.length }})</span>
        </h3>
        <span class="h-px min-w-6 flex-1 bg-foreground/10" />
        <!-- Steam 已完成区右上角「清除全部」（二次确认后删除全部缓存） -->
        <template v-if="clearAllConfirm">
          <span class="flex flex-none items-center gap-2">
            <span class="text-[11px] font-medium text-destructive">{{ $t('cache.clearAllConfirm', { n: cachedList.length, size: formatBytes(cache.cachedBytes) }) }}</span>
            <button type="button" @click="clearAllConfirm = false" class="rounded-md border border-border px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground">{{ $t('common.cancel') }}</button>
            <button type="button" :disabled="clearingAll" @click="clearAllCompleted" class="flex items-center gap-1 rounded-md bg-destructive px-2.5 py-1 text-[11px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50">
              <Loader2 v-if="clearingAll" class="h-3 w-3 animate-spin" /> {{ $t('cache.confirmClear') }}
            </button>
          </span>
        </template>
        <button
          v-else
          type="button"
          :disabled="cachedList.length === 0"
          @click="clearAllConfirm = true"
          class="state-layer flex-none rounded-md border border-border bg-muted/60 px-4 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
        >
          {{ $t('cache.clearAll') }}
        </button>
      </div>

      <div v-if="cachedList.length === 0" class="surface flex min-h-[160px] flex-col items-center justify-center gap-2 rounded-2xl p-8 text-center">
        <FolderOpen class="h-10 w-10 text-muted-foreground/30" />
        <p class="text-sm text-muted-foreground">{{ $t('cache.noMoreCache') }}</p>
      </div>

      <div v-else class="flex flex-col gap-2.5">
        <div v-for="b in cachedList" :key="b.id" class="surface overflow-hidden rounded-2xl">
          <!-- 卡片头（折叠/展开按键） -->
          <div class="flex items-center gap-3 p-3 sm:px-4">
            <button type="button" class="shrink-0" @click="ui.openDetail(b.id, b.cover)">
              <CoverImage :src="b.cover" :alt="b.title" ratio="portrait" class="h-16 w-11 sm:h-[72px] sm:w-12" rounded="rounded-lg" />
            </button>
            <button type="button" class="min-w-0 flex-1 text-left" @click="ui.openDetail(b.id, b.cover)">
              <h4 class="line-clamp-1 text-sm font-bold text-foreground hover:text-primary">{{ b.title }}</h4>
              <!-- Steam 已完成条目文案：已下载 N / M 集 · 体积 -->
              <p class="mt-1 text-[11px] tabular-nums text-muted-foreground">
                {{ $t('cache.downloadedN', { n: cachedDone(b), m: b.total_episodes || cachedDone(b) }) }} · {{ formatBytes(cachedSize(b)) }}
                <template v-if="b.episodes.some((e) => e.status === 'downloading')"> · <span class="font-medium text-emerald-500">{{ $t('cache.caching') }}</span></template>
              </p>
            </button>
            <!-- Steam 右侧「完成于：」时间列 -->
            <span class="hidden flex-none text-[11px] tabular-nums text-muted-foreground lg:block">{{ $t('cache.completedAt', { t: fmtCompleted(lastCompletedAt(b)) }) }}</span>
            <button
              type="button"
              @click.stop="cache.openDir(sanitizeName(b.title))"
              class="state-layer flex shrink-0 items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
              v-tip="$t('cache.openFolderTitle')"
            >
              <FolderOpen class="h-3.5 w-3.5" /> <span class="hidden sm:inline">{{ $t('cache.openFolder') }}</span>
            </button>
            <button
              type="button"
              @click.stop="confirmDelete = `b:${b.id}`"
              class="state-layer flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
              v-tip="$t('cache.deleteAllTitle')"
            >
              <Trash2 class="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              @click="toggleCachedExpand(b.id)"
              class="state-layer flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
              :aria-label="expandedCached.has(b.id) ? $t('common.collapse') : $t('common.expand')"
            >
              <ChevronDown v-if="expandedCached.has(b.id)" class="h-4 w-4" />
              <ChevronRight v-else class="h-4 w-4" />
            </button>
          </div>

          <!-- 删除整部确认 -->
          <div v-if="confirmDelete === `b:${b.id}`" class="flex items-center justify-between gap-2 border-t border-destructive/30 bg-destructive/10 px-4 py-2">
            <p class="text-xs text-destructive">{{ $t('cache.deleteConfirm', { t: b.title, n: cachedDone(b), size: formatBytes(cachedSize(b)) }) }}</p>
            <div class="flex shrink-0 items-center gap-2">
              <button type="button" @click="confirmDelete = ''" class="rounded-lg border border-border px-3 py-1 text-[11px] text-muted-foreground hover:text-foreground">{{ $t('common.cancel') }}</button>
              <button type="button" @click="removeBangumi(b.id)" class="rounded-lg bg-destructive px-3 py-1 text-[11px] font-semibold text-white hover:opacity-90">{{ $t('cache.deleteOne') }}</button>
            </div>
          </div>

          <!-- 展开区：单集缓存信息 -->
          <div v-if="expandedCached.has(b.id)" class="border-t border-border/60">
            <div
              v-for="ep in [...b.episodes].sort((x, y) => x.sort - y.sort)"
              :key="ep.sort"
              class="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border/40 px-4 py-2.5 last:border-b-0 hover:bg-foreground/[0.03]"
            >
              <!-- 播放 -->
              <button
                v-if="ep.status === 'done'"
                type="button"
                :disabled="playing === `${b.id}:${ep.sort}`"
                @click="playLocal(b.id, ep.sort, b.title, b.cover, ep.title)"
                class="state-layer flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-opacity hover:opacity-90"
                :aria-label="$t('cache.playEpAria', { n: ep.sort })"
              >
                <Loader2 v-if="playing === `${b.id}:${ep.sort}`" class="h-3.5 w-3.5 animate-spin" />
                <Play v-else class="ml-0.5 h-3 w-3 fill-current" />
              </button>
              <span v-else-if="ep.status === 'downloading'" class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
                <Loader2 class="h-3.5 w-3.5 animate-spin" />
              </span>
              <span v-else class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-destructive/15 text-destructive">
                <AlertCircle class="h-3.5 w-3.5" />
              </span>

              <!-- 标题 -->
              <div class="min-w-0 flex-1 basis-40">
                <p class="line-clamp-1 text-xs font-semibold text-foreground">{{ $t('common.huaNT', { n: ep.sort, t: ep.title }) }}</p>
                <p v-if="ep.status === 'downloading'" class="mt-0.5 text-[10px] tabular-nums text-primary">
                  {{ $t('cache.segments', { a: ep.segments_done, b: ep.segments_total || "…" }) }} · {{ formatBytes(cache.statusOf(b.id, ep.sort).bytes) }}<template v-if="cache.statusOf(b.id, ep.sort).bytesTotal > 0"> / {{ formatBytes(cache.statusOf(b.id, ep.sort).bytesTotal) }}</template> · {{ formatSpeed(cache.statusOf(b.id, ep.sort).speed) || "…" }}
                </p>
                <p v-else-if="ep.status === 'failed'" class="mt-0.5 truncate text-[10px] text-destructive/90" v-tip="ep.error">{{ ep.error || $t('cache.downloadFailed') }}</p>
                <p v-else class="mt-0.5 text-[10px] text-muted-foreground">{{ $t('cache.cachedAt', { t: fmtDate(ep.cached_at) }) }}</p>
              </div>

              <!-- 信息列（更多番剧缓存信息；含 m3u8/MP4 协议标注） -->
              <div class="flex shrink-0 flex-wrap items-center gap-1.5">
                <span v-if="ep.kind" class="rounded px-1.5 py-0.5 text-[10px] font-semibold" :class="protoChipClass(ep.kind === 'mp4' ? 'MP4' : 'm3u8')">{{ ep.kind === "mp4" ? "MP4" : "m3u8" }}</span>
                <span v-if="ep.resolution" class="rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold text-foreground/80">{{ ep.resolution }}</span>
                <span v-if="ep.line_name" class="max-w-[120px] truncate rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground" v-tip="ep.line_name">{{ ep.line_name }}</span>
                <span v-if="ep.duration_sec" class="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-muted-foreground">{{ formatDuration(ep.duration_sec) }}</span>
                <span v-if="ep.bytes" class="rounded bg-muted px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground">{{ formatBytes(ep.bytes) }}</span>
                <span v-if="ep.segments_total" class="rounded bg-muted px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground">{{ $t('cache.segs', { a: ep.segments_done, b: ep.segments_total }) }}</span>
              </div>

              <!-- 删除单集 -->
              <template v-if="ep.status === 'done'">
                <button
                  v-if="confirmDelete !== `e:${b.id}:${ep.sort}`"
                  type="button"
                  @click="confirmDelete = `e:${b.id}:${ep.sort}`"
                  class="state-layer flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                  :aria-label="$t('cache.deleteEpAria', { n: ep.sort })"
                >
                  <Trash2 class="h-3.5 w-3.5" />
                </button>
                <span v-else class="flex shrink-0 items-center gap-1">
                  <button type="button" @click="confirmDelete = ''" class="rounded-md border border-border px-2 py-1 text-[10px] text-muted-foreground hover:text-foreground">{{ $t('common.cancel') }}</button>
                  <button type="button" @click="removeEpisode(b.id, ep.sort)" class="rounded-md bg-destructive px-2 py-1 text-[10px] font-semibold text-white hover:opacity-90">{{ $t('cache.deleteOne') }}</button>
                </span>
              </template>
              <button
                v-else-if="ep.status === 'downloading'"
                type="button"
                @click="cancelOne(b.id, ep.sort)"
                class="state-layer flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                :aria-label="$t('cache.cancelEpAria', { n: ep.sort })"
              >
                <XCircle class="h-3.5 w-3.5" />
              </button>
            </div>
            <div v-if="downloadingAny" class="px-4 py-2 text-[10px] text-muted-foreground">
              {{ $t('cache.tip') }}
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- 全局下载进度坞（贴主界面底部 + Steam 下载列表）已移至 DownloadDock.vue，
         由 NavShell 挂载：任意页面下载时都常驻底部 -->
  </div>
</template>
