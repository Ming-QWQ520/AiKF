import { defineStore } from "pinia";
import { ref, watch } from "vue";

/**
 * App-wide settings, persisted to localStorage.
 *
 * Settings currently exposed:
 *  - autoNext       : auto-play the next episode when current one ends
 *  - theme          : "light" | "dark" | "system"
 *  - background     : custom background config (image url + opacity + blur)
 *  - cacheThreads   : m3u8 下载分片线程数（1–32，默认 6；每集内部并发）
 *  - cacheMp4Threads : 并发下载集数（同时缓存几集，m3u8/MP4 全部生效；1–12，默认 3）
 *  - bufferSize     : HLS forward buffer length in seconds (60 | 120 | 300 | 600)
 *  - backBuffer     : HLS backward (played) buffer kept in seconds (0 | 30 | 60)
 *  - danmaku        : 弹幕设置（开关/显示区域/透明度/字号/速度）
 *
 * NOTE: web shortcuts (Ctrl+S/P/F…) and right-click are ALWAYS blocked and
 *       NOT configurable — see src/lib/global-ux.ts.
 */

export type DefaultSource = "auto" | "adkwai" | "anich";
export type BufferSize = 60 | 120 | 300 | 600;
export type BackBuffer = 0 | 30 | 60;
export type ThemeMode = "light" | "dark" | "system";
/** 界面语言（多语言支持：默认简体中文，设置页可切换） */
export type Language = "zh-CN" | "en";

/** 动画等级（任务 29：设置页可调，控制全局动画性能消耗）
 *  - full  : 全部动画（默认观感）
 *  - basic : 只保留低消耗动画（透明度/颜色过渡、spinner），关闭缩放/模糊/位移扫光
 *  - off   : 全部动画关闭（仅保留 spinner，避免加载态看似卡死）
 *  实现约定：<html data-anim="..."> 由 App.vue 按设置实时写入，CSS 见 globals.css */
export type AnimLevel = "off" | "basic" | "full";

/** 弹幕设置（显示区域为画面高度占比：0.25=1/4屏 0.5=半屏 0.75=3/4屏 1=满屏） */
export interface DanmakuSettings {
  enabled: boolean;
  area: 0.25 | 0.5 | 0.75 | 1;
  /** 0–1 */
  opacity: number;
  /** px */
  fontSize: number;
  /** 弹幕持续时间 1–10（数值越大越慢） */
  speed: number;
}

export interface BackgroundSettings {
  enabled: boolean;
  /** image URL or data URL (supports local file via Tauri asset protocol) */
  url: string;
  /** 0–100 opacity of the background image */
  opacity: number;
  /** 0–30 px blur applied to the background image */
  blur: number;
  /** 0–100 scale, >100 zooms in slightly for a parallax feel */
  scale: number;
}

export interface AppSettings {
  autoplay: boolean;
  hardwareAccel: boolean;
  defaultSource: DefaultSource;
  bufferSize: BufferSize;
  backBuffer: BackBuffer;
  autoNext: boolean;
  theme: ThemeMode;
  /** 界面语言（zh-CN = 简体中文默认 / en = English） */
  language: Language;
  /** 动画等级：off 关闭 / basic 基础（低消耗）/ full 完整（默认） */
  animLevel: AnimLevel;
  /** m3u8 下载分片线程数（每集内部，1–32，默认 6） */
  cacheThreads: number;
  /** 并发下载集数（同时缓存几集，全部线路类型通用；1–12，默认 3）。存储键沿用 cacheMp4Threads */
  cacheMp4Threads: number;
  danmaku: DanmakuSettings;
  background: BackgroundSettings;
  /** 弹幕默认值 v2 迁移标记（1/4 屏 + 25% 透明度），仅用于一次性覆盖旧默认 */
  dmDefaultsV2?: boolean;
}

const STORAGE_KEY = "aikf-settings";

const DEFAULTS: AppSettings = {
  autoplay: true,
  hardwareAccel: true,
  defaultSource: "auto",
  bufferSize: 120,
  backBuffer: 0,
  autoNext: true,
  theme: "dark",
  // 需求：多语言支持默认使用中文
  language: "zh-CN",
  // 动画等级默认完整观感（任务 29：设置页可降级省 GPU）
  animLevel: "full",
  cacheThreads: 6,
  // 需求：并发下载默认 3 集（最高可同时缓存三集），最高 12；全部线路类型生效
  cacheMp4Threads: 3,
  // 需求：弹幕默认 1/4 屏显示区域、25% 透明度、标准字号、标准速度
  danmaku: { enabled: true, area: 0.25, opacity: 0.25, fontSize: 22, speed: 5 },
  background: {
    enabled: false,
    url: "",
    opacity: 40,
    blur: 0,
    scale: 100,
  },
  // 注：Bangumi 自动云同步已改为无开关、默认开启（auto-sync.ts 监听库变更），
  // 不再是用户可配置项 —— 旧设置里持久化的 bgmAutoSync 键会被静默忽略。
};

function load(): AppSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS, dmDefaultsV2: true };
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    // 需求：弹幕默认值改为 1/4 屏 + 25% 透明度 —— 老用户已持久化的旧默认
    //（半屏/100% 不透明）也一次性迁移到新默认（之后用户仍可自由修改）
    if (!parsed.dmDefaultsV2) parsed.danmaku = undefined;
    // deep-merge background to avoid missing fields
    const merged: AppSettings = {
      ...DEFAULTS,
      ...parsed,
      background: { ...DEFAULTS.background, ...(parsed.background ?? {}) },
      danmaku: { ...DEFAULTS.danmaku, ...(parsed.danmaku ?? {}) },
      dmDefaultsV2: true,
    };
    // 注：云同步策略变更 —— 自动同步现为无开关常开行为（见 auto-sync.ts），
    // 旧版 bgmAutoSync/bgmAutoSyncV2 迁移逻辑移除，持久化的旧键被静默忽略
    // m3u8 下载分片线程数钳制：1–32，默认 6
    const t = Number(merged.cacheThreads);
    if (!Number.isFinite(t)) merged.cacheThreads = DEFAULTS.cacheThreads;
    else merged.cacheThreads = Math.min(32, Math.max(1, Math.round(t)));
    // 并发下载集数钳制：1–12，默认 3
    const mt = Number(merged.cacheMp4Threads);
    if (!Number.isFinite(mt)) merged.cacheMp4Threads = DEFAULTS.cacheMp4Threads;
    else merged.cacheMp4Threads = Math.min(12, Math.max(1, Math.round(mt)));
    // 弹幕设置钳制
    merged.danmaku.enabled = !!merged.danmaku.enabled;
    merged.danmaku.area = ([0.25, 0.5, 0.75, 1] as const).includes(merged.danmaku.area as any)
      ? merged.danmaku.area : 0.25;
    merged.danmaku.opacity = Math.min(1, Math.max(0, Number.isFinite(Number(merged.danmaku.opacity)) ? Number(merged.danmaku.opacity) : 0.25));
    merged.danmaku.fontSize = Math.min(48, Math.max(12, Math.round(Number(merged.danmaku.fontSize) || 22)));
    merged.danmaku.speed = Math.min(10, Math.max(1, Number(merged.danmaku.speed) || 5));
    // 界面语言钳制：仅接受支持的语言，否则回退默认中文
    if (merged.language !== "zh-CN" && merged.language !== "en") merged.language = DEFAULTS.language;
    // 动画等级钳制：仅接受 off/basic/full，否则回退完整
    if (merged.animLevel !== "off" && merged.animLevel !== "basic" && merged.animLevel !== "full") {
      merged.animLevel = DEFAULTS.animLevel;
    }
    return merged;
  } catch {
    return { ...DEFAULTS };
  }
}

export const useSettingsStore = defineStore("settings", () => {
  const data = ref<AppSettings>(load());

  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data.value));
    } catch {
      /* ignore */
    }
  }

  function update<K extends keyof AppSettings>(key: K, value: AppSettings[K]) {
    data.value[key] = value;
    persist();
  }

  function updateBackground<K extends keyof BackgroundSettings>(key: K, value: BackgroundSettings[K]) {
    data.value.background[key] = value;
    persist();
  }

  /** m3u8 下载分片线程数：1–32，默认 6 */
  function setCacheThreads(n: number) {
    const v = Math.min(32, Math.max(1, Math.round(Number(n) || 6)));
    data.value.cacheThreads = v;
    persist();
  }

  /** 并发下载集数（同时缓存几集）：1–12，默认 3 */
  function setCacheMp4Threads(n: number) {
    const v = Math.min(12, Math.max(1, Math.round(Number(n) || 3)));
    data.value.cacheMp4Threads = v;
    persist();
  }

  /** 弹幕设置局部更新 */
  function updateDanmaku<K extends keyof DanmakuSettings>(key: K, value: DanmakuSettings[K]) {
    data.value.danmaku = { ...data.value.danmaku, [key]: value };
    persist();
  }

  function reset() {
    data.value = { ...DEFAULTS, background: { ...DEFAULTS.background }, dmDefaultsV2: true };
    persist();
  }

  // Persist on any change
  watch(data, persist, { deep: true });

  return { data, update, updateBackground, setCacheThreads, setCacheMp4Threads, updateDanmaku, reset };
});
