import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { i18n } from "@/i18n";

/**
 * 本地缓存 store —— 与 Rust cache.rs 的 JSON 索引一一对应。
 *
 * 检索走 JSON 索引（cache_load_index），不再遍历目录；
 * 下载进度通过 `cache-progress` 事件实时推送。
 */

export interface CacheEpisode {
  sort: number;
  title: string;
  dir: string;
  status: "downloading" | "done" | "failed" | string;
  /** 源类型："hls"（m3u8 分片）| "mp4"（视频直链单文件） */
  kind: "hls" | "mp4" | string;
  segments_done: number;
  segments_total: number;
  bytes: number;
  duration_sec: number;
  resolution: string;
  line_name: string;
  error: string;
  cached_at: number;
  updated_at: number;
}

export interface CacheBangumi {
  id: number;
  title: string;
  cover: string;
  total_episodes: number;
  episodes: CacheEpisode[];
  updated_at: number;
}

export interface ProgressPayload {
  bangumiId: number;
  sort: number;
  title: string;
  status: "downloading" | "done" | "failed" | "cancelled";
  segmentsDone: number;
  segmentsTotal: number;
  bytes: number;
  /** 估算总体积（字节）：平均分片大小 × 总分片数，随进度收敛；0 表示尚无样本 */
  bytesTotal: number;
  speed: number;
  errorMsg: string;
}

export interface LiveProgress {
  sort: number;
  status: ProgressPayload["status"];
  segmentsDone: number;
  segmentsTotal: number;
  bytes: number;
  bytesTotal: number;
  speed: number;
  errorMsg: string;
  updatedAt: number;
  /** 所属番剧标题（来自进度事件，供下载条展示，不依赖索引刷新） */
  title: string;
}

export const isTauriEnv =
  typeof window !== "undefined" &&
  ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);

/** 本地番剧目录名与 Rust 端 sanitize 规则一致（仅用于展示兜底，实际路径由 Rust 提供） */
export function sanitizeName(name: string): string {
  const cleaned = (name || "").replace(/[\\/:*?"<>|\u0000]/g, " ").trim();
  return cleaned ? Array.from(cleaned).slice(0, 64).join("") : "未知"; // i18n-skip: 文件夹名兜底，非界面文案
}

export const useCacheStore = defineStore("cache", () => {
  const ready = ref(false);
  const rootPath = ref("");
  const bangumi = ref<CacheBangumi[]>([]);
  /** 实时下载进度（key = `bangumiId:sort`） */
  const live = ref<Record<string, LiveProgress>>({});
  let starting = false;

  const liveKeys = computed(() => new Set(Object.keys(live.value)));

  function epKey(bangumiId: number, sort: number) {
    return `${bangumiId}:${sort}`;
  }

  async function init() {
    if (!isTauriEnv || ready.value) return;
    if (starting) return;
    starting = true;
    try {
      rootPath.value = await invoke<string>("cache_root_path");
      await refresh();
      // 应用生命周期内常驻的进度监听（ready 防重：避免重复挂监听导致事件重复处理）
      await listen<ProgressPayload>("cache-progress", (e) => onProgress(e.payload));
      ready.value = true;
    } catch (e) {
      console.error("[AiKF Cache] init failed:", e);
    }
    starting = false;
  }

  function onProgress(p: ProgressPayload) {
    const key = epKey(p.bangumiId, p.sort);
    if (p.status === "downloading") {
      live.value = {
        ...live.value,
        [key]: {
          sort: p.sort,
          status: p.status,
          segmentsDone: p.segmentsDone,
          segmentsTotal: p.segmentsTotal,
          bytes: p.bytes,
          bytesTotal: p.bytesTotal ?? 0,
          speed: p.speed,
          errorMsg: "",
          updatedAt: Date.now(),
          title: p.title,
        },
      };
    } else {
      // 终态：移除实时状态并刷新索引
      const next = { ...live.value };
      delete next[key];
      live.value = next;
      refresh();
    }
  }

  /** 按番剧聚合的实时下载进度（修复：下载速度需切页后才显示 ——
   *  此前 UI 只从索引读，而集数条目要等 Rust 解析完播放列表才写入索引，
   *  现在改以实时事件为主、索引为兑底） */
  const liveBangumi = computed(() => {
    const map = new Map<number, { count: number; bytes: number; bytesTotal: number; speed: number; title: string; sorts: number[] }>();
    for (const [key, l] of Object.entries(live.value)) {
      const id = Number(key.split(":")[0]);
      if (!Number.isFinite(id)) continue;
      const cur = map.get(id) ?? { count: 0, bytes: 0, bytesTotal: 0, speed: 0, title: l.title || "", sorts: [] };
      cur.count += 1;
      cur.bytes += l.bytes || 0;
      cur.bytesTotal += l.bytesTotal || 0;
      cur.speed += l.speed || 0;
      cur.sorts.push(l.sort);
      if (!cur.title && l.title) cur.title = l.title;
      map.set(id, cur);
    }
    return map;
  });

  async function refresh() {
    if (!isTauriEnv) return;
    try {
      const idx = await invoke<{ bangumi: CacheBangumi[] }>("cache_load_index");
      bangumi.value = idx?.bangumi ?? [];
    } catch (e) {
      console.error("[AiKF Cache] load index failed:", e);
    }
  }

  async function rescan() {
    if (!isTauriEnv) return;
    try {
      const idx = await invoke<{ bangumi: CacheBangumi[] }>("cache_rescan_index");
      bangumi.value = idx?.bangumi ?? [];
    } catch (e) {
      console.error("[AiKF Cache] rescan failed:", e);
    }
  }

  function byId(id: number): CacheBangumi | undefined {
    return bangumi.value.find((b) => b.id === id);
  }

  function episode(id: number, sort: number): CacheEpisode | undefined {
    return byId(id)?.episodes.find((e) => e.sort === sort);
  }

  /** 某集状态：live（下载中）优先于索引 */
  function statusOf(id: number, sort: number): {
    status: string; pct: number; speed: number; bytes: number; bytesTotal: number; errorMsg: string;
  } {
    const l = live.value[epKey(id, sort)];
    if (l && l.status === "downloading") {
      const pct = l.segmentsTotal > 0 ? Math.round((l.segmentsDone / l.segmentsTotal) * 100) : 0;
      return { status: "downloading", pct, speed: l.speed, bytes: l.bytes, bytesTotal: l.bytesTotal, errorMsg: "" };
    }
    const ep = episode(id, sort);
    if (!ep) return { status: "none", pct: 0, speed: 0, bytes: 0, bytesTotal: 0, errorMsg: "" };
    if (ep.status === "done") return { status: "done", pct: 100, speed: 0, bytes: ep.bytes, bytesTotal: ep.bytes, errorMsg: "" };
    if (ep.status === "failed") return { status: "failed", pct: 0, speed: 0, bytes: 0, bytesTotal: 0, errorMsg: ep.error };
    if (ep.status === "downloading") return { status: "downloading", pct: ep.segments_total > 0 ? Math.round((ep.segments_done / ep.segments_total) * 100) : 0, speed: 0, bytes: ep.bytes, bytesTotal: 0, errorMsg: "" };
    return { status: ep.status, pct: 0, speed: 0, bytes: 0, bytesTotal: 0, errorMsg: ep.error };
  }

  /** 本地播放地址（asset:// URL）；未缓存返回 null */
  async function playUrl(id: number, sort: number): Promise<string | null> {
    if (!isTauriEnv) return null;
    try {
      const path = await invoke<string>("cache_episode_play", { bangumiId: id, sort });
      return convertFileSrc(path);
    } catch {
      return null;
    }
  }

  async function startDownload(payload: {
    bangumiId: number;
    title: string;
    cover: string;
    totalEpisodes: number;
    /** m3u8 分片下载线程数（每集内部，1–32 默认 6） */
    threads: number;
    /** MP4 直链下载并发集数（同时缓存几集，1–12 默认 3） */
    mp4Threads: number;
    episodes: { sort: number; title: string; url: string; lineName: string }[];
  }) {
    if (!isTauriEnv) throw new Error(i18n.global.t("cache.errDesktopOnly"));
    await invoke("cache_download_start", {
      args: {
        bangumiId: payload.bangumiId,
        title: payload.title,
        cover: payload.cover,
        totalEpisodes: payload.totalEpisodes,
        threads: payload.threads,
        mp4Threads: payload.mp4Threads,
        episodes: payload.episodes.map((e) => ({
          sort: e.sort,
          title: e.title,
          url: e.url,
          lineName: e.lineName,
        })),
      },
    });
    // 需求：开始缓存后立即显示下载速度，不等索引刷新 ——
    // 为全部已选集数播种实时条目（速度 0，首帧事件到达后即被覆盖）
    const seeded: Record<string, LiveProgress> = { ...live.value };
    for (const e of payload.episodes) {
      seeded[epKey(payload.bangumiId, e.sort)] = {
        sort: e.sort,
        status: "downloading",
        segmentsDone: 0,
        segmentsTotal: 0,
        bytes: 0,
        bytesTotal: 0,
        speed: 0,
        errorMsg: "",
        updatedAt: Date.now(),
        title: payload.title,
      };
    }
    live.value = seeded;
  }

  async function cancelDownload(bangumiId: number, sort?: number) {
    if (!isTauriEnv) return;
    await invoke("cache_download_cancel", { bangumiId, sort: sort ?? null });
  }

  async function removeCache(bangumiId: number, sort?: number) {
    if (!isTauriEnv) return;
    await invoke("cache_delete", { bangumiId, sort: sort ?? null });
    await refresh();
  }

  async function openDir(bangumiTitle?: string) {
    if (!isTauriEnv) return;
    await invoke("cache_open_dir", { bangumi: bangumiTitle ?? null });
  }

  /** 保存/读取随番剧缓存的弹幕（需求：本地缓存增加缓存弹幕） */
  async function saveDanmaku(args: { bangumiId: number; title: string; sort: number; epTitle: string; json: string }) {
    if (!isTauriEnv) return;
    await invoke("cache_danmaku_save", {
      bangumiId: args.bangumiId,
      title: args.title,
      sort: args.sort,
      epTitle: args.epTitle,
      json: args.json,
    });
  }
  async function loadDanmaku(bangumiId: number, sort: number): Promise<string | null> {
    if (!isTauriEnv) return null;
    try {
      return await invoke<string | null>("cache_danmaku_load", { bangumiId, sort });
    } catch {
      return null;
    }
  }

  const cachedCount = computed(() =>
    bangumi.value.reduce((n, b) => n + b.episodes.filter((e) => e.status === "done").length, 0)
  );
  const cachedBytes = computed(() =>
    bangumi.value.reduce((n, b) => n + b.episodes.filter((e) => e.status === "done").reduce((m, e) => m + (e.bytes || 0), 0), 0)
  );

  return {
    ready,
    rootPath,
    bangumi,
    live,
    liveKeys,
    liveBangumi,
    init,
    refresh,
    rescan,
    byId,
    episode,
    statusOf,
    playUrl,
    startDownload,
    cancelDownload,
    removeCache,
    openDir,
    saveDanmaku,
    loadDanmaku,
    cachedCount,
    cachedBytes,
  };
});

/** 字节数格式化（GB/MB） */
export function formatBytes(n: number): string {
  if (!n || n <= 0) return "0 B";
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

/** 秒 → h:mm:ss */
export function formatDuration(sec: number): string {
  if (!sec || sec <= 0) return "--:--";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** 速度格式化 */
export function formatSpeed(bps: number): string {
  if (!bps || bps <= 0) return "";
  return `${formatBytes(bps)}/s`;
}
