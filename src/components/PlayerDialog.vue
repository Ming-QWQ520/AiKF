<script setup lang="ts">
import { ref, computed, watch, onBeforeUnmount, nextTick } from "vue";
import Artplayer from "artplayer";
import artplayerPluginAutoThumbnail from "artplayer-plugin-auto-thumbnail";
import artplayerPluginDanmuku from "artplayer-plugin-danmuku";
import { X, ArrowLeft, Minus, Square, AlertCircle, Loader2, Zap, Heart, ListVideo, MessageSquare, Users, Info, Star, ChevronDown, ChevronLeft, ChevronRight, Lock, LockOpen, PanelRightOpen, PictureInPicture2 } from "lucide-vue-next";
import { invoke } from "@tauri-apps/api/core";
import { anich } from "@/lib/anich/api-client";
import {
  loadServerDanmaku, loadBiliDanmaku, loadDandanDanmaku, loadLocalDanmaku, biliCidOf, mergeDanmaku,
  type DanmakuSource, type DanmakuSourceKey, type PluginDanmu,
} from "@/lib/danmaku";
import { useUIStore } from "@/stores/ui";
import { useLibraryStore } from "@/stores/library";
import { useSettingsStore } from "@/stores/settings";
import { useCacheStore, formatBytes } from "@/stores/cache";
import { i18n } from "@/i18n";
import { useAsync } from "@/composables/useAsync";
import { cn } from "@/lib/utils";
import ToggleSwitch from "@/components/ToggleSwitch.vue";

// ── Stock (unmodified) ArtPlayer ──
// AiKF uses the official `artplayer` npm package as-is. Everything
// specific to this app (back-to-home control, next-episode control,
// resolution badge, hls.js wiring) is configured through the standard
// ArtPlayer `controls` / `customType` / `plugins` options below —
// no customized player bundle involved.

// ─── Logging ──────────────────────────────────────────────────────────────
const LOG_PREFIX = "%c[AiKF Player]";
const LOG_STYLE = "color:#e879f9;font-weight:bold";
function log(...args: unknown[]) { console.log(LOG_PREFIX, LOG_STYLE, ...args); }
function logError(...args: unknown[]) { console.error(LOG_PREFIX, LOG_STYLE, ...args); }

const ui = useUIStore();
const library = useLibraryStore();
const settings = useSettingsStore();
const cacheStore = useCacheStore();
const t = i18n.global.t;

const open = computed(() => ui.player.open);
const bangumiID = computed(() => ui.player.bangumiID);
const episode = computed(() => ui.player.episode);

/** 本地缓存播放模式：localPath 非空（指向该集 index.m3u8 的 asset:// URL） */
const isLocal = computed(() => !!ui.player.localPath);

const sourceIdx = ref(-1);
const videoError = ref<string | null>(null);
let art: Artplayer | null = null;
const triedSources = new Set<number>();
// 用户手动选择线路后，本轮播放内不再被自动测速结果覆盖（换集后重置）
const userPickedSource = ref(false);
// 播放器浮层：线路 / 设置 / 弹幕设置（选集在右侧面板，见 sideOpen/sideTab）
const linePanelOpen = ref(false);
const settingsPanelOpen = ref(false);
const danmakuPanelOpen = ref(false);
const settingsTab = ref<"common" | "buffer">("common");
// 面板收起时点底栏「选集」弹出的旧式选集浮层（双列缩略图网格设计）
const epPopupOpen = ref(false);
const closePanels = () => { linePanelOpen.value = false; settingsPanelOpen.value = false; danmakuPanelOpen.value = false; epPopupOpen.value = false; };
// ─── 右侧详情面板（简介 / 选集 / 评论 / 角色 顶部切换）──────────────────
// 需求：右侧栏默认显示「简介」页 —— 打开播放器或切换番剧时自动回到简介 Tab；
// 同一部番剧内换集保持当前 Tab（避免连播/选集时被打断）。
// 面板是 flex 兄弟节点（非覆盖层）→ 永远不会遮挡窗口控制按键；
// 需求：面板头部不再放置返回键，窗口控制键（最小化/最大化/关闭）
// 直接内嵌在面板头部右侧（与参考图一致），面板收起时控制键回到视频顶栏。
type SideTab = "info" | "ep" | "comments" | "characters";
const sideOpen = ref(true);
const sideTab = ref<SideTab>("info");
// 选集 Tab 内「线路」分区展开态（现位于简介 Tab 下方的折叠行）
const sideLineExpand = ref(false);

/** 面板开合按键（需求：位于视频区域右缘垂直居中，参考截图红圈位置） */
const toggleSide = () => { sideOpen.value = !sideOpen.value; };
/** 旧式选集弹层内「在右侧面板中查看」：展开右侧面板并转到选集页，关闭弹层 */
const expandSideFromPopup = () => { epPopupOpen.value = false; sideOpen.value = true; sideTab.value = "ep"; };

// ─── 播放锁定（需求：画面左侧中间锁定按键；锁定时鼠标滑入视频区域
//      只显示 解锁按键、返回按键和标题）───────────────────────────────
const playerLocked = ref(false);
const lockChrome = ref(false);
let lockChromeTimer: ReturnType<typeof setTimeout> | null = null;
function bumpLockChrome() {
  lockChrome.value = true;
  if (lockChromeTimer) clearTimeout(lockChromeTimer);
  lockChromeTimer = setTimeout(() => { lockChrome.value = false; }, 2600);
}
function lockPlayer() {
  playerLocked.value = true;
  closePanels();
  // 显式隐藏 ArtPlayer 控制栏（art-control-show 控制交互显隐、art-hover 控制底栏透明度；
  // 锁定后遮罩挡住鼠标，二者都不会再被唤出）
  try {
    const $player = (art as unknown as Record<string, any> | null)?.template?.$player as HTMLElement | undefined;
    $player?.classList.remove("art-control-show", "art-hover");
  } catch {}
  bumpLockChrome();
}
function unlockPlayer() {
  playerLocked.value = false;
  lockChrome.value = false;
  if (lockChromeTimer) { clearTimeout(lockChromeTimer); lockChromeTimer = null; }
}
// 锁定期间拦截全部按键（ArtPlayer 热键绑在 document keydown 上，
// capture 捕获阶段拦截即可；保留 Esc 便于从全屏退出）
const lockKeyBlock = (e: KeyboardEvent) => {
  if (e.key === "Escape") return;
  e.stopImmediatePropagation();
};
watch(playerLocked, (v) => {
  if (v) document.addEventListener("keydown", lockKeyBlock, true);
  else document.removeEventListener("keydown", lockKeyBlock, true);
});

// ─── 小窗播放（需求：使用 ArtPlayer 原生 art.mini 可拖动悬浮窗）───
const miniActive = ref(false);
// ArtPlayer 控制栏显隐状态（art "control" 事件，true=显示）：
// 底部控制栏隐藏时，锁定键与面板开合键同步隐藏（需求）
const artControlsVisible = ref(true);
function toggleMini() {
  if (!art) return;
  try { (art as unknown as Record<string, any>).mini = !(art as unknown as Record<string, any>).mini; } catch (e) { pushLog(`mini toggle failed: ${e}`); }
}

// hls.js handle for the currently playing m3u8 source. The stock
// ArtPlayer core does not clean up custom-type resources for us, so we
// keep the reference here and destroy it on source switch / teardown.
// `hls` getter exposes the live instance so buffer settings can be
// applied in real time without recreating the player.
let activeHls: { destroy: () => void; readonly hls: any } | null = null;

// Live DOM node of the line badge control (kept in sync by a watcher).
let lineBadgeEl: HTMLElement | null = null;
// Overlay host cleanup (wheel listeners + outside-click)
let overlayCleanup: (() => void) | null = null;

function pushLog(msg: string) {
  log(msg);
}

pushLog("PlayerDialog (ArtPlayer) mounted");

// ─── Tauri window controls (for the title bar) ─────────────────────
const isTauri = typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
const winMinimize = async () => { if (isTauri) try { await invoke("plugin:window|minimize"); } catch {} };
const winToggleMax = async () => { if (isTauri) try { await invoke("plugin:window|toggle_maximize"); } catch {} };

// 播放器内部全屏状态：真全屏/网页全屏时隐藏窗口控制键（Windows 自带按钮仍可用）
const artFullscreen = ref(false);
const artFullscreenWeb = ref(false);

// ─── Source classification ────────────────────────────────────────────────
function isDirectMedia(url: string) {
  return /\.(mp4|webm|ogg|mov|m4v|mkv)(\?|#|$)/i.test(url);
}
function isHlsMedia(url: string) {
  return /\.m3u8(\?|#|$)/i.test(url) || url.includes("/m3u8/") || url.includes("/parse/m3u8");
}
/** 线路协议标签（m3u8 / MP4） */
function sourceProtoLabel(url: string): string {
  const k = classifySource(url);
  if (k === "hls") return "m3u8";
  if (k === "direct") return "MP4";
  return t("common.unknown");
}
function sourceName(url: string): string {
  // 线路节点名称：原始主机名（不做美化重命名）
  try {
    return new URL(url).hostname;
  } catch { return t("common.unknownSource"); }
}
/** 是否 adkwai 线路（实测播放速度远优于其他低延迟线路，选线时优先）。 */
function isAdkwaiSource(url: string): boolean {
  return url.includes("adkwai.com");
}
/**
 * 线路标题：优先使用 Anich API 返回的 caption 字段（原样展示，
 * 不做美化重命名）；caption 为空时回退到原始主机名。
 */
function rawLineName(s: { url: string; caption?: string }): string {
  const cap = (s.caption || "").trim();
  if (cap) return cap;
  return sourceName(s.url);
}
function classifySource(url: string): string {
  if (isDirectMedia(url)) return "direct";
  if (isHlsMedia(url)) return "hls";
  return "unknown";
}
function pickPreferred(sources: { url: string }[]): number {
  if (!sources.length) return 0;
  const pref = settings.data.defaultSource;
  if (pref === "adkwai") { const ks = sources.findIndex((s) => isAdkwaiSource(s.url)); if (ks >= 0) return ks; }
  else if (pref === "anich") { const an = sources.findIndex((s) => s.url.includes("emmmm.eu.org")); if (an >= 0) return an; }
  else {
    // auto：实测反馈「有些线路延迟低但实际播放很慢，只有 adkwai 的线路很快」
    // → auto 模式下静态预选也直接 adkwai 优先。
    const ks = sources.findIndex((s) => isAdkwaiSource(s.url));
    if (ks >= 0) return ks;
  }
  const h = sources.findIndex((s) => isHlsMedia(s.url)); if (h >= 0) return h;
  const d = sources.findIndex((s) => isDirectMedia(s.url)); if (d >= 0) return d;
  return 0;
}

// ─── Latency testing ──────────────────────────────────────────────────────
const latencyTesting = ref(false);
const sourceLatencies = ref<Record<number, number | null>>({});
const latencyDone = ref<string | null>(null);

async function testLatency(url: string, timeoutMs = 5000): Promise<number | null> {
  return new Promise((resolve) => {
    const start = performance.now();
    let done = false;
    const finish = (ok: boolean) => { if (done) return; done = true; cleanup(); resolve(ok ? Math.round(performance.now() - start) : null); };
    const img = new Image();
    const timer = setTimeout(() => finish(false), timeoutMs);
    const cleanup = () => { clearTimeout(timer); img.onload = null; img.onerror = null; img.src = ""; };
    img.onload = () => finish(true); img.onerror = () => finish(true);
    img.src = url + (url.includes("?") ? "&" : "?") + "_t=" + Date.now();
  });
}

async function pickFastestSource(srcs: { url: string }[], ek: string): Promise<number> {
  latencyTesting.value = true;
  sourceLatencies.value = {};
  pushLog(`Latency test: testing ${srcs.length} sources…`);
  const testable = srcs.map((s, i) => ({ idx: i, url: s.url, kind: classifySource(s.url) })).filter((s) => s.kind === "hls" || s.kind === "direct");
  if (testable.length === 0) { latencyTesting.value = false; return pickPreferred(srcs); }
  const results = await Promise.all(testable.map(async (t) => {
    const ms = await testLatency(t.url);
    sourceLatencies.value = { ...sourceLatencies.value, [t.idx]: ms };
    return { idx: t.idx, ms, kind: t.kind };
  }));
  latencyTesting.value = false;
  latencyDone.value = ek;
  const valid = results.filter((r) => r.ms !== null);
  if (valid.length === 0) return pickPreferred(srcs);
  // 实测反馈：延迟低 ≠ 播放快，只有 adkwai 的线路实际播放很快。
  // → 只要存在可连通的 adkwai 线路，就在其中选延迟最低的一条；
  //   完全没有 adkwai 时才退回全局最低延迟。
  const kwaiValid = valid.filter((r) => isAdkwaiSource(srcs[r.idx]?.url ?? ""));
  const pool = kwaiValid.length > 0 ? [...kwaiValid].sort((a, b) => a.ms! - b.ms!) : [...valid].sort((a, b) => a.ms! - b.ms!);
  pushLog(
    kwaiValid.length > 0
      ? `选线：优选 adkwai（可用 ${kwaiValid.length} 条，取其中最低延迟 ${pool[0].ms}ms）` // i18n-skip: 控制台日志
      : `选线：无可用 adkwai 线路，按延迟选最优 ${pool[0].ms}ms` // i18n-skip: 控制台日志
  );
  return pool[0].idx;
}

const openRef = computed(() => open.value && bangumiID.value != null);
const epKey = computed(() => `${bangumiID.value}-${episode.value}`);

watch(epKey, (nk, ok) => {
  pushLog(`Episode changed: ${ok} → ${nk}; resetting state`);
  sourceIdx.value = -1;
  videoError.value = null;
  videoResolution.value = null;
  userPickedSource.value = false;
  closePanels();
  triedSources.clear();
});

// 需求：右侧栏默认显示「简介」页
//  - 打开播放器 → 自动展开面板并回到简介 Tab；
//  - 切换番剧 → 同样回到简介；
//  - 同番剧内换集 → 保持当前 Tab（epKey watch 不再重置 sideTab）。
watch(open, (v) => {
  if (v) { sideTab.value = "info"; sideOpen.value = true; infoExpanded.value = false; }
  else { unlockPlayer(); }
});
watch(bangumiID, () => {
  if (open.value) { sideTab.value = "info"; infoExpanded.value = false; }
});

const { data: vodData, isLoading: vodLoading, isError: vodIsError, refetch: vodRefetch } = useAsync(
  () => anich.vod(bangumiID.value!, episode.value),
  { enabled: computed(() => openRef.value && !isLocal.value), source: computed(() => isLocal.value ? "local-off" : epKey.value) }
);
const { data: episodes } = useAsync(() => anich.episodes(bangumiID.value!), { enabled: openRef, source: () => "eps" });

const sources = computed(() => vodData.value?.sources ?? []);

const autoPickedFor = ref<string | null>(null);
watch(
  () => [sources.value.length, epKey.value] as const,
  async ([count, ek]) => {
    if (isLocal.value) return;
    if (count > 0 && autoPickedFor.value !== ek) {
      autoPickedFor.value = ek;
      // 1) 先用静态策略立即上屏，不阻塞开播；
      // 2) 同时后台全量测速，完成后自动切换到最快线路（用户未手动选线且尚未开播时）。
      sourceIdx.value = pickPreferred(sources.value);
      const best = await pickFastestSource(sources.value, ek);
      if (ek === epKey.value && !userPickedSource.value && best !== sourceIdx.value) {
        // 需求：如果当前正在播放，测速后不切换路线（避免中断观看）。
        // 修复：旧判定 art.currentTime > 1 过苛 —— 起播 1 秒内测速完成时
        // 被误判为「未开播」→ 自动切线 → 视频重载从 0 重播（用户实测
        // 「播 1 秒重回开头」）。现在只要视频已处于播放状态（含缓冲中，
        // paused=false 即 playing）或已有播放进度，就不再自动切线；
        // 仅在尚未起播（加载中/失败重试中）时才切换。
        const startedPlaying = !!(art && (art.playing || art.currentTime > 0));
        if (startedPlaying) {
          pushLog("自动测速完成：已开始播放，保持当前线路不切换");
        } else {
          pushLog(`自动测速完成：切换到最佳线路 idx=${best}`);
          switchSource(best);
        }
      } else {
        pushLog(`自动测速完成：当前线路已是最优或用户已手动选线`);
      }
    }
  },
  { immediate: true }
);

const effectiveIdx = computed(() => sourceIdx.value < 0 ? pickPreferred(sources.value) : sourceIdx.value);
const currentSource = computed(() => {
  const idx = effectiveIdx.value;
  return idx >= 0 && idx < sources.value.length ? sources.value[idx] : undefined;
});
const episodesList = computed(() => episodes.value ?? []);
const mediaUrl = computed(() => {
  if (isLocal.value) return ui.player.localPath ?? "";
  return currentSource.value?.url ?? "";
});

// ─── 播放器设置面板（非视频区域按键呼出）─────────────────────────
// 常见设置项的运行时状态（跨换集/换线保持，重建播放器后重新应用）
const rateRef = ref(1);
const ratioRef = ref<"default" | "4:3" | "16:9" | "2.35:1">("default");
const flipRef = ref<string>("normal");   // "normal" | "horizontal" | "vertical"

function applyPlaybackPrefs() {
  if (!art) return;
  try { art.playbackRate = rateRef.value; } catch (e) { pushLog(`apply playbackRate failed: ${e}`); }
  try { art.aspectRatio = ratioRef.value; } catch (e) { pushLog(`apply aspectRatio failed: ${e}`); }
  try { art.flip = flipRef.value as any; } catch (e) { pushLog(`apply flip failed: ${e}`); }
}
function setRate(v: number) {
  rateRef.value = v;
  if (art) try { art.playbackRate = v; } catch {}
  pushLog(`设置：播放速度 → ${v}x`);
}
function setRatio(v: "default" | "4:3" | "16:9" | "2.35:1") {
  ratioRef.value = v;
  if (art) try { art.aspectRatio = v; } catch {}
  pushLog(`设置：画面比例 → ${v}`);
}
function setFlip(v: string) {
  flipRef.value = v;
  if (art) try { art.flip = v as any; } catch {}
  pushLog(`设置：画面翻转 → ${v}`);
}
function toggleAutoNext() {
  settings.update("autoNext", !settings.data.autoNext);
  pushLog(`设置：自动连播 → ${settings.data.autoNext ? "开" : "关"}`);
}

// 视频缓冲设置变更：立即应用到当前 HLS 实例（无需换线/换集）
watch(() => [settings.data.bufferSize, settings.data.backBuffer] as const, ([buf, back]) => {
  const hls = activeHls?.hls;
  if (hls && !isLocal.value) {
    try {
      hls.config.maxBufferLength = buf;
      hls.config.maxMaxBufferLength = Math.max(600, buf * 6);
      hls.config.backBufferLength = back;
      pushLog(`缓冲设置已实时应用：预缓冲 ${buf}s / 保留 ${back}s`);
    } catch (e) { pushLog(`apply buffer config failed: ${e}`); }
  }
});

// ─── ArtPlayer instance management ───────────────────────────────────────
const artContainerRef = ref<HTMLElement | null>(null);

interface SavedState { time: number; paused: boolean; muted: boolean; volume: number; }
let savedVideoState: SavedState | null = null;

function saveVideoState() {
  if (!art) return;
  savedVideoState = {
    time: art.currentTime,
    paused: !art.playing,
    muted: art.muted,
    volume: art.volume,
  };
  pushLog(`saveVideoState: time=${Math.round(savedVideoState.time)}s, paused=${savedVideoState.paused}`);
}

function restoreVideoState() {
  if (!art || !savedVideoState) return;
  const s = savedVideoState;
  const a = art;
  pushLog(`restoreVideoState: time=${Math.round(s.time)}s, paused=${s.paused}`);
  a.volume = s.volume;
  a.muted = s.muted;
  nextTick(() => {
    if (s.time > 1) { try { a.currentTime = s.time; } catch (e) { pushLog(`seek failed: ${e}`); } }
    if (!s.paused) { a.play().catch((e: unknown) => pushLog(`play() rejected: ${e}`)); }
  });
  savedVideoState = null;
}

// ─── 卡顿看门狗：长时间 waiting 无进展时重启 HLS 加载 ─────────────
let stallTimer: ReturnType<typeof setInterval> | null = null;
let stallSince = 0;
function stopStallWatchdog() {
  if (stallTimer) { clearInterval(stallTimer); stallTimer = null; }
  stallSince = 0;
}
function setupStallWatchdog() {
  stopStallWatchdog();
  stallTimer = setInterval(() => {
    if (!art) return;
    if (stallSince > 0 && Date.now() - stallSince > 8000 && art.playing) {
      pushLog("卡顿看门狗：缓冲超过 8s 无进展，重启分片加载");
      try { activeHls?.hls?.startLoad(); } catch (e) { pushLog(`startLoad failed: ${e}`); }
      stallSince = Date.now();
    }
  }, 4000);
}

function destroyArt() {
  stopStallWatchdog();
  (window as unknown as Record<string, unknown>).__aikfArt = null;
  if (art) {
    pushLog("destroying ArtPlayer");
    // 小窗模式下 <video> 挂在 body 的 .art-mini-popup 上：先退出原生 mini
    // 让视频元素归位，避免销毁后残留黑色悬浮窗
    try { if ((art as unknown as Record<string, any>).mini) (art as unknown as Record<string, any>).mini = false; } catch {}
    try { art.destroy(); } catch (e) { pushLog(`destroy threw: ${e}`); }
    art = null;
  }
  miniActive.value = false;
  artControlsVisible.value = true;
  // 清理可能残留的 mini 悬浮窗节点（原生 mini 容器挂在 document.body）
  document.querySelectorAll(".art-mini-popup").forEach((n) => n.remove());
  if (activeHls) {
    try { activeHls.destroy(); } catch (e) { pushLog(`Hls destroy threw: ${e}`); }
    activeHls = null;
  }
  if (overlayCleanup) { try { overlayCleanup(); } catch {} overlayCleanup = null; }
  lineBadgeEl = null;
  playerOverlayHost.value = null;
  closePanels();
}

function resolutionLabel(height: number): string {
  if (height >= 2160) return "4K";
  if (height >= 1440) return "2K";
  if (height >= 1080) return "1080P";
  if (height >= 720) return "720P";
  if (height >= 480) return "480P";
  return height > 0 ? `${height}P` : "…";
}

// Vue-side overlay host（顶栏 / 线路弹层 / 设置弹层 Teleport 目标，
// 位于 .art-video-player 内部 → 网页全屏/真全屏均可见，且随控制条自动显隐）
const playerOverlayHost = ref<HTMLElement | null>(null);

function createArt(container: HTMLElement, url: string) {
  pushLog(`Creating ArtPlayer: url=${url.slice(0, 80)}…`);
  destroyArt();
  const kind = classifySource(url);
  const isHls = kind === "hls";
  const localSrc = isLocal.value;

  // 卡顿优化：
  //  - 本地文件读取快 → 用短缓冲（省内存），网络播放 → 沿用设置的长缓冲抗抖动
  //  - 提高 manifest/level/frag 重试次数，弱网更抗断流
  const hlsConfig: Record<string, unknown> = {
    enableWorker: true, lowLatencyMode: false, autoStartLoad: true, startLevel: -1,
    maxBufferLength: localSrc ? 30 : settings.data.bufferSize,
    maxMaxBufferLength: localSrc ? 180 : Math.max(600, settings.data.bufferSize * 6),
    backBufferLength: localSrc ? 30 : settings.data.backBuffer, maxBufferSize: 200 * 1000 * 1000, maxBufferHole: 0.5,
    nudgeMaxRetry: 12, nudgeOffset: 0.2, abrEwmaDefaultEstimate: 3e6,
    abrBandWidthFactor: 0.9, abrBandWidthUpFactor: 0.7,
    manifestLoadingMaxRetry: 6, manifestLoadingRetryDelay: 800,
    levelLoadingMaxRetry: 6, levelLoadingRetryDelay: 800,
    fragLoadingMaxRetry: 8, fragLoadingRetryDelay: 800, startFragPrefetch: true,
    xhrSetup: (xhr: XMLHttpRequest) => { xhr.withCredentials = false; },
  };

  try {
    // Follow the app accent color so the player matches the active theme.
    const appTheme =
      (typeof document !== "undefined"
        ? getComputedStyle(document.documentElement).getPropertyValue("--primary").trim()
        : "") || "#fb7185";

    // ── Stock (unmodified) ArtPlayer options ──
    // All app-specific behavior is wired through the standard `controls` /
    // `customType` / `plugins` option keys — no customized bundle involved.
    const controls: any[] = [
      {
        name: "aikf-episodes",
        position: "right",
        index: 20,
        html: `<span class="aikf-text-btn">${t("player.ctrlEpisodes")}</span>`,
        tooltip: t("player.ctrlEpisodes"),
        click: () => {
          // 需求：面板展开时 → 转至面板选集页；面板收起时 → 弹出模态选集弹层
          // （再次点击可切换关闭）；其它弹层一律先收起
          const wasOpen = epPopupOpen.value;
          closePanels();
          if (sideOpen.value) sideTab.value = "ep";
          else epPopupOpen.value = !wasOpen;
        },
      },
    ];
    // 线路按键：仅网络播放模式显示（本地缓存无线路概念）
    if (!localSrc) {
      controls.push({
        name: "aikf-line",
        position: "right",
        index: 25,
        html: `<span class="aikf-line-badge">${t("player.ctrlLinePending")}</span>`,
        tooltip: t("player.ctrlSwitchLine"),
        click: () => {
          settingsPanelOpen.value = false;
          linePanelOpen.value = !linePanelOpen.value;
        },
        mounted($ref: HTMLElement) {
          lineBadgeEl = $ref.querySelector(".aikf-line-badge");
          updateLineBadge();
        },
      });
    }
    // 弹幕设置按键（需求：只需显示弹幕设置按键，无弹幕发送框）
    controls.push({
      name: "aikf-danmaku",
      position: "right",
      index: 28,
      html: '<span class="aikf-danmaku-btn">' + t("player.ctrlDanmaku") + '</span>',
      tooltip: t("player.ctrlDanmakuTip"),
      click: () => {
        linePanelOpen.value = false;
        settingsPanelOpen.value = false;
        danmakuPanelOpen.value = !danmakuPanelOpen.value;
      },
    });
    controls.push(
      {
        name: "aikf-settings",
        position: "right",
        index: 30,
        html: '<span class="aikf-gear-btn"><svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></span>',
        tooltip: t("player.ctrlSettings"),
        click: () => {
          linePanelOpen.value = false;
          settingsPanelOpen.value = !settingsPanelOpen.value;
        },
      },
      {
        // ArtPlayer 原生小窗（mini 模式）：可拖动悬浮窗，视频元素挂到 body。
        // 按键图标使用 ArtPlayer 内建 PiP 原生 SVG（与官方画中画按键同源）
        name: "aikf-mini",
        position: "right",
        index: 35,
        html: '<span class="aikf-mini-btn"><svg viewBox="0 0 1024 1024" width="22" height="22" fill="currentColor"><path d="M844.8 219.648h-665.6c-6.144 0-10.24 4.608-10.24 10.752v563.2c0 5.632 4.096 10.24 10.24 10.24h256v92.16h-256a102.4 102.4 0 0 1-102.4-102.4v-563.2c0-56.832 45.568-102.4 102.4-102.4h665.6a102.4 102.4 0 0 1 102.4 102.4v204.8h-92.16v-204.8c0-6.144-4.608-10.752-10.24-10.752zM614.4 588.8c-28.672 0-51.2 22.528-51.2 51.2v204.8c0 28.16 22.528 51.2 51.2 51.2h281.6c28.16 0 51.2-23.04 51.2-51.2v-204.8c0-28.672-23.04-51.2-51.2-51.2H614.4z"/></svg></span>',
        tooltip: t("player.ctrlMini"),
        click: () => toggleMini(),
      },
    );

    const options: any = {
      container,
      url,
      type: isHls ? "m3u8" : "",
      customType: {
        m3u8: isHls
          ? (video: HTMLVideoElement, src: string) => {
              // Release the previous Hls instance before attaching a new
              // one (ArtPlayer re-invokes customType on every url change).
              if (activeHls) {
                try { activeHls.destroy(); } catch (e) { pushLog(`Hls destroy threw: ${e}`); }
                activeHls = null;
              }
              let hls: any = null;
              const handle = { destroyed: false };
              activeHls = {
                destroy: () => {
                  handle.destroyed = true;
                  try { hls?.destroy?.(); } catch (e) { pushLog(`Hls destroy threw: ${e}`); }
                },
                get hls() { return hls; },
              };
              // Lazy-import hls.js to keep the initial bundle small for
              // direct-media sources.
              import("hls.js").then((mod) => {
                if (handle.destroyed) return; // source switched meanwhile
                const Hls = mod.default;
                if (Hls.isSupported()) {
                  hls = new Hls(hlsConfig);
                  hls.on(Hls.Events.ERROR, (_e: unknown, data: any) => {
                    if (data.fatal) {
                      pushLog(`HLS fatal: ${data.details || data.type}`);
                      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
                      else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
                      else if (localSrc) {
                        videoError.value = t("player.noticeLocalPlayFail", { d: data.details || data.type });
                      } else {
                        videoError.value = t("player.noticePlayFail", { d: data.details || data.type });
                        tryAutoAdvance(effectiveIdx.value);
                      }
                    }
                  });
                  hls.loadSource(src);
                  hls.attachMedia(video);
                } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
                  video.src = src;
                }
              });
            }
          : undefined,
      },
      autoplay: !savedVideoState,
      volume: 1,
      lang: "zh-cn",
      theme: appTheme,
      hotkey: true,
      // 底栏布局：左［播放/暂停 · 音量(滚轮)］右［选集 · 线路 · 弹幕 · 设置 · 小窗 · 网页全屏 · 全屏］
      // （需求：已移除「下一集」按键；连播由自动连播开关接管）
      play: true,
      time: false,
      setting: false,
      playbackRate: true,
      aspectRatio: true,
      flip: true,
      fullscreen: true,
      fullscreenWeb: true,
      miniProgressBar: true,
      mutex: true,
      backdrop: true,
      autoSize: false,
      autoMini: false,
      autoOrientation: false,
      // Plugins：弹幕（无发送框，需求：只显示弹幕设置按键）+ 缩略图预览
      plugins: [
        artplayerPluginDanmuku({
          danmuku: async () => currentDanmakuItems(),
          emitter: false,
          margin: danmakuMargin(settings.data.danmaku.area),
          opacity: settings.data.danmaku.opacity,
          fontSize: settings.data.danmaku.fontSize,
          speed: settings.data.danmaku.speed,
          antiOverlap: true,
          synchronousPlayback: true,
          visible: settings.data.danmaku.enabled,
          modes: [0, 1, 2],
        }),
        artplayerPluginAutoThumbnail({ width: 160, number: 80, scale: 1 }),
      ],
      controls,
    };

    art = new Artplayer(options);
    // 弹幕不透明度初值（CSS 变量热应用）
    applyDanmakuOpacityVar();
    // 控制栏显隐 → 同步锁定键/面板开合键（需求：底部控制栏隐藏时同步隐藏）。
    // 直接监听 art 根节点 art-control-show 类（控制栏显隐的真实机制）：
    // 不用 "control" 事件——异常重试/悬浮态下该事件会被高频重发导致状态抖动
    const $playerRoot = (art as unknown as { template: { $player: HTMLElement } }).template.$player;
    const syncControlsVisible = () => {
      artControlsVisible.value = $playerRoot.classList.contains("art-control-show");
    };
    const controlsObserver = new MutationObserver(syncControlsVisible);
    controlsObserver.observe($playerRoot, { attributes: true, attributeFilter: ["class"] });
    syncControlsVisible();
    // 冒烟/自动化测试句柄（生产无副作用，仅多一个全局引用）
    (window as unknown as Record<string, unknown>).__aikfArt = art;

    // ── Vue overlay host：挂在 .art-video-player 内部（全屏可见）──
    const playerRoot = (art as unknown as { template: { $player: HTMLElement } }).template.$player;
    const host = document.createElement("div");
    host.className = "aikf-overlay-host";
    playerRoot.appendChild(host);
    playerOverlayHost.value = host;

    // ── 鼠标滚轮调节音量（播放器画面 / 音量控件上滚动 ±5%）──
    const onWheel = (e: WheelEvent) => {
      if (!art) return;
      if ((e.target as Element | null)?.closest?.(".aikf-panel") || (e.target as Element | null)?.closest?.(".aikf-side") || (e.target as Element | null)?.closest?.(".aikf-ep-shield") || (e.target as Element | null)?.closest?.(".aikf-pop-shield")) return; // 弹层/侧面板/遮罩上的滚轮不调节音量
      e.preventDefault();
      const step = e.deltaY > 0 ? -0.05 : 0.05;
      const v = Math.min(1, Math.max(0, Math.round((art.volume + step) * 100) / 100));
      art.volume = v;
      art.notice.show = t("player.noticeVolume", { n: Math.round(v * 100) });
    };
    const onRootClick = (e: MouseEvent) => {
      const t = e.target as Element | null;
      if (t?.closest?.(".aikf-panel") || t?.closest?.(".aikf-side") || t?.closest?.(".art-control-aikf-episodes") || t?.closest?.(".art-control-aikf-line") || t?.closest?.(".art-control-aikf-settings") || t?.closest?.(".art-control-aikf-danmaku") || t?.closest?.(".art-control-aikf-mini")) return;
      if (linePanelOpen.value || settingsPanelOpen.value || danmakuPanelOpen.value) closePanels();
    };
    playerRoot.addEventListener("wheel", onWheel, { passive: false });
    playerRoot.addEventListener("click", onRootClick, true);
    overlayCleanup = () => {
      playerRoot.removeEventListener("wheel", onWheel);
      playerRoot.removeEventListener("click", onRootClick, true);
      // 控制栏类观察器随清理链一并解除
      try { controlsObserver.disconnect(); } catch {}
    };

    // ── Resolution detection (stock events) ──
    const updateResolution = () => {
      if (!art) return;
      const w = art.video.videoWidth;
      const h = art.video.videoHeight;
      if (w && h) {
        const label = resolutionLabel(h);
        const prev = videoResolution.value;
        if (!prev || prev.width !== w || prev.height !== h) {
          videoResolution.value = { width: w, height: h, label };
          pushLog(`resolution → ${label} (${w}×${h})`);
        }
      }
    };
    art.on("video:loadedmetadata", updateResolution);
    art.on("resize", updateResolution);

    // ── Fullscreen state（隐藏窗口控制键）＋ 卡顿看门狗挂钩 ──
    art.on("fullscreen", (v: unknown) => { artFullscreen.value = !!v; });
    art.on("fullscreenWeb", (v: unknown) => { artFullscreenWeb.value = !!v; });
    // 原生小窗状态跟踪（悬浮窗右上角 × 关闭时同步回非小窗布局）
    art.on("mini", (v: unknown) => { miniActive.value = !!v; });
    art.on("video:waiting", () => { if (!stallSince) stallSince = Date.now(); });
    art.on("video:playing", () => { stallSince = 0; });
    setupStallWatchdog();

    // ── Event registration (after construction) ──
    art.on("ready", () => {
      pushLog("ArtPlayer ready");
      // 重新应用用户在设置面板里选择的播放偏好（速度/比例/翻转跨换线保持）
      applyPlaybackPrefs();
      if (savedVideoState) { restoreVideoState(); }
      else if (bangumiID.value) {
        const progress = library.getPlaybackProgress(bangumiID.value, episode.value);
        if (progress && progress.time > 5 && progress.time < progress.duration - 10) {
          pushLog(`Restoring playback progress: ${Math.round(progress.time)}s`);
          try { art!.currentTime = progress.time; } catch (e) { pushLog(`seek failed: ${e}`); }
        }
      }
    });

    art.on("video:play", () => {
      if (bangumiID.value) {
        // 顺带补全追番库条目的总集数（旧数据 totalEpisodes=0 时进度无法显示）。
        // episodes 与 vod 并行加载，video:play 时通常已就绪；未就绪时传
        // undefined，store 侧保持原值不受影响。
        // 播放行为属于用户真实标记 → 走 markPlayedEpisode（记入 played，
        // 云端逐集对齐时不会被顺序假设清理误删）
        library.markPlayedEpisode(bangumiID.value, episode.value, episodesList.value.length || undefined);
      }
    });

    art.on("video:error", () => {
      pushLog("video error event");
      if (!localSrc) tryAutoAdvance(effectiveIdx.value);
    });

    // ── Auto-play next episode when current one ends ──
    art.on("video:ended", () => {
      if (!settings.data.autoNext) {
        pushLog("video ended — auto-next disabled");
        if (art) art.notice.show = t("player.noticeEndedAutoOff");
        return;
      }
      pushLog("video ended — auto-playing next episode");
      if (localSrc) {
        const next = localEpisodes.value.find((e) => e.sort === episode.value + 1);
        if (next) switchLocalEpisode(next.sort);
        return;
      }
      const next = episodesList.value.find((e) => e.sort === episode.value + 1);
      if (next) {
        switchEpisode(next.sort, next.title);
      } else {
        pushLog("no next episode — playback finished");
      }
    });

    let lastProgressSave = 0;
    art.on("video:timeupdate", () => {
      if (!art) return;
      const now = Date.now();
      if (now - lastProgressSave > 5000 && bangumiID.value) {
        lastProgressSave = now;
        library.savePlaybackProgress(bangumiID.value, episode.value, art.currentTime, art.duration);
      }
    });

    pushLog("ArtPlayer instance created successfully");
  } catch (err) {
    logError("ArtPlayer creation failed:", err);
    const msg = err instanceof Error
      ? `${err.name}: ${err.message}`
      : String(err);
    const stack = err instanceof Error && err.stack ? `\n${err.stack.split("\n").slice(0, 4).join("\n")}` : "";
    pushLog(`Error details: ${msg}${stack}`);
    videoError.value = t("player.noticeInitFail", { m: msg });
  }
}

// Re-create ArtPlayer when source URL or container changes
watch(
  () => [artContainerRef.value, mediaUrl.value, open.value, sources.value.length, effectiveIdx.value, isLocal.value] as const,
  ([container, url, isOpen, srcCount, idx, local]) => {
    pushLog(`watch: open=${isOpen}, container=${container ? "ready" : "null"}, url=${url ? url.slice(0, 50) + "…" : "none"}, sources=${srcCount}, idx=${idx}, local=${local}`);
    if (!isOpen) return;
    if (!url) return;
    if (!container) { pushLog("container not mounted — retry next tick"); return; }
    if (!local && srcCount === 0) return;
    if (!local) triedSources.add(idx);
    videoError.value = null;
    createArt(container as HTMLElement, url);
  },
  { flush: "post", immediate: true }
);

function tryAutoAdvance(currentIdx: number) {
  const next = sources.value.findIndex((_, i) => !triedSources.has(i));
  pushLog(`auto-advance: current=${currentIdx}, next=${next}`);
  if (next >= 0 && next !== currentIdx) sourceIdx.value = next;
  else videoError.value = t("player.noticeNoPlayableSource");
}

onBeforeUnmount(() => {
  unlockPlayer();
  destroyArt();
});

const switchEpisode = (sort: number, title: string) => {
  pushLog(`switchEpisode: ${sort} - ${title}`);
  closePanels();
  ui.setPlayerEpisode(sort, title);
};

/** 本地模式切换集数：解析该集缓存路径并切换 */
async function switchLocalEpisode(sort: number) {
  if (bangumiID.value == null) return;
  try {
    const url = await cacheStore.playUrl(bangumiID.value, sort);
    if (!url) {
      if (art) art.notice.show = t("player.noticeNotCached");
      return;
    }
    const ep = cacheStore.episode(bangumiID.value, sort);
    ui.setPlayerLocalEpisode(sort, ep?.title || t("common.epN", { n: sort }), url);
    closePanels();
  } catch (e) {
    pushLog(`switchLocalEpisode failed: ${e}`);
    if (art) art.notice.show = t("player.noticeSwitchFail");
  }
}

/** 切换线路：标记用户选择（本轮不再被自动测速覆盖）并尽量断点续播。 */
function switchSource(idx: number, opts: { user?: boolean } = {}) {
  if (idx < 0 || idx >= sources.value.length) return;
  if (opts.user) userPickedSource.value = true;
  if (art && art.currentTime > 3) saveVideoState(); // 换线不断点
  triedSources.clear();
  triedSources.add(idx);
  sourceIdx.value = idx;
  closePanels();
}

/** 关闭播放器：只返回打开播放器之前的页面（不改变底层视图）。 */
function closePlayerBack() {
  destroyArt();
  ui.closePlayer();
}

// ── Playback resolution (detected from stock video events) ──
const videoResolution = ref<{ width: number; height: number; label: string } | null>(null);

// ── 线路徽标（底栏 aikf-line 控件）：使用线路原始名称（不做美化重命名）──
const lineBadgeText = computed(() => {
  const s = sources.value[effectiveIdx.value];
  if (!s) return t("player.ctrlLinePending");
  return rawLineName(s);
});
function updateLineBadge() {
  if (lineBadgeEl) lineBadgeEl.textContent = lineBadgeText.value;
}
watch(lineBadgeText, updateLineBadge);

// ── 线路节点分辨率探测（需求：节点显示 名称/分辨率/延迟/标题）──────
// HLS master playlist 里带 RESOLUTION=xxxx；直接抓一份 manifest 解析即可，
// 不用真的起播。直链（mp4）无法便宜地拿到分辨率 → 显示「直链」。
const lineResolution = ref<Record<number, string>>({});
const lineProbing = ref(false);
async function probeLineResolutions() {
  if (lineProbing.value || isLocal.value) return;
  const targets = sources.value
    .map((s, i) => ({ s, i }))
    .filter(({ s, i }) => classifySource(s.url) === "hls" && lineResolution.value[i] === undefined);
  if (targets.length === 0) return;
  lineProbing.value = true;
  await Promise.all(targets.map(async ({ s, i }) => {
    try {
      const r = await invoke<{ status: number; ok: boolean; body: number[] }>("anich_fetch", {
        args: { url: s.url, headers: { Accept: "*/*" } },
      });
      if (r.ok) {
        const text = new TextDecoder().decode(new Uint8Array(r.body));
        const m = text.match(/RESOLUTION=(\d+)x(\d+)/i);
        if (m) {
          lineResolution.value = { ...lineResolution.value, [i]: resolutionLabel(Number(m[2])) };
        } else if (text.includes("#EXTINF")) {
          lineResolution.value = { ...lineResolution.value, [i]: t("common.unknown") };
        }
      } else {
        lineResolution.value = { ...lineResolution.value, [i]: "—" };
      }
    } catch {
      lineResolution.value = { ...lineResolution.value, [i]: "—" };
    }
  }));
  lineProbing.value = false;
}
watch(linePanelOpen, (v) => { if (v) probeLineResolutions(); });
// 选集 Tab 展开 / 线路分区展开时同样探测各线路分辨率（线路分区现位于简介 Tab）
watch([sideLineExpand, sideTab, sideOpen], ([exp]) => {
  if (sideOpen.value && exp) probeLineResolutions();
});
/** 线路面板中每一行的分辨率文本 */
function lineResOf(i: number): string {
  if (lineResolution.value[i]) return lineResolution.value[i];
  if (i === effectiveIdx.value && videoResolution.value) return videoResolution.value.label;
  const s = sources.value[i];
  if (s && classifySource(s.url) === "direct") return t("player.directLink");
  return lineProbing.value ? "…" : "—";
}

// ── Source details ──
const currentEpisodeTitle = computed(() => {
  if (isLocal.value) return ui.player.episodeTitle || cacheStore.episode(bangumiID.value ?? -1, episode.value)?.title || "";
  return episodesList.value.find((e) => e.sort === episode.value)?.title ?? "";
});

// ── 本地模式：缓存索引中该番剧的集数列表（选集面板数据源）──
const localEpisodes = computed(() => {
  if (bangumiID.value == null) return [] as { sort: number; title: string; bytes: number; status: string; resolution: string; durationSec: number }[];
  const b = cacheStore.byId(bangumiID.value);
  return (b?.episodes ?? []).map((e) => ({ sort: e.sort, title: e.title, bytes: e.bytes, status: e.status, resolution: e.resolution, durationSec: e.duration_sec }));
});

// ── 选集网格数据（右侧面板选集 Tab 与旧式选集弹层共用）──
interface EpGridItem {
  key: string; sort: number; title: string; img: string;
  badge: string; badgeOk: boolean; badgeBad: boolean;
  dur: string; playing: boolean; playable: boolean; date: string;
}
const epGridItems = computed<EpGridItem[]>(() => {
  if (isLocal.value) {
    return [...localEpisodes.value]
      .sort((a, b) => a.sort - b.sort)
      .map((e) => ({
        key: `l${e.sort}`, sort: e.sort, title: e.title, img: ui.player.cover,
        badge: e.status === "done" ? t("cache.cached") : t("cache.uncached"), badgeOk: e.status === "done", badgeBad: false,
        dur: formatBytes(e.bytes), playing: e.sort === episode.value,
        playable: e.status === "done", date: "",
      }));
  }
  return episodesList.value.map((e) => {
    const st = cacheStore.statusOf(bangumiID.value ?? -1, e.sort).status;
    // 需求：无资源的集数要明确标出「无资源」（此前一律显示有资源/无标注，
    // 点击后才发现在可用播放源）；API 的 ep.status=false 即无资源集
    const noRes = !e.status;
    return {
      key: `${e.sort}`, sort: e.sort, title: e.title, img: e.image || ui.player.cover,
      badge: st === "done" ? t("cache.cached") : noRes ? t("detail.noResource") : t("detail.hasResource"),
      badgeOk: st === "done", badgeBad: st !== "done" && noRes,
      dur: fmtEpDuration(e.duration), playing: e.sort === episode.value,
      playable: st === "done" || !noRes, date: fmtEpDate(e.airdate),
    };
  });
});
/** 点击选集网格卡片：本地模式切本地集（未缓存提示），网络模式切集（无资源提示） */
function clickEpItem(it: EpGridItem) {
  if (!it.playable) {
    if (art) art.notice.show = isLocal.value ? t("player.noticeNotCached") : t("player.noticeNoResourceEp");
    return;
  }
  if (isLocal.value) void switchLocalEpisode(it.sort);
  else switchEpisode(it.sort, it.title);
}

// ─── 弹幕（多源加载 + 显示设置，无发送框）───────────────────────────
// 三个源：服务端（自动加载）/ 哔哩哔哩（有 bili_cid 时自动加载）/ 弹弹（点击加载）。
// 数据按 epKey 缓存在内存；启用/停用源 → 立即重载插件弹幕层。
interface DanmakuSourceState extends DanmakuSource {
  loaded: boolean;
  loading: boolean;
  enabled: boolean;
  available: boolean;
  error: string;
}
const danmakuSources = ref<DanmakuSourceState[]>([]);
const danmakuCache = new Map<string, Map<DanmakuSourceKey, DanmakuSource>>();
let danmakuLoadSeq = 0; // 换集竞态防护
const danmakuActiveEp = ref("");

/** 当前集在 API 中的 sites（用于探测 bili cid） */
const currentEpisodeSites = computed(() => episodesList.value.find((e) => e.sort === episode.value)?.sites ?? []);

function danmakuCacheFor(ek: string): Map<DanmakuSourceKey, DanmakuSource> {
  let m = danmakuCache.get(ek);
  if (!m) { m = new Map(); danmakuCache.set(ek, m); }
  return m;
}

function freshDanmakuStates(cid: string): DanmakuSourceState[] {
  // 注意：不含 local —— 「本地缓存」源仅在线本地播放模式（ensureDanmaku 的
  // isLocal 分支）中按需注入，避免在线播放时多出一行无意义的占位源
  return [
    { key: "server", name: t("player.srcServer"), detail: "", count: 0, items: [], loaded: false, loading: false, enabled: true, available: true, error: "" },
    { key: "bili", name: t("player.srcBili"), detail: "", count: 0, items: [], loaded: false, loading: false, enabled: true, available: !!cid, error: "" },
    { key: "dandan", name: t("player.srcDandan"), detail: "", count: 0, items: [], loaded: false, loading: false, enabled: false, available: true, error: "" },
  ];
}

/**
 * 换集/打开播放器后重建弹幕源状态，并自动加载 server(+bili)。
 * 本地缓存播放模式：弹幕走「本地缓存 + 在线服务端」双源 ——
 * 离线时本地弹幕可用（需求：本地缓存增加缓存弹幕）。
 */
function ensureDanmaku() {
  if (!open.value || bangumiID.value == null) return;
  const ek = epKey.value;
  if (isLocal.value) {
    if (ek === danmakuActiveEp.value) return;
    danmakuActiveEp.value = ek;
    const seq = ++danmakuLoadSeq;
    const cached = danmakuCacheFor(ek);
    const base = (s: DanmakuSourceState): DanmakuSourceState => {
      const hit = cached.get(s.key);
      return hit ? { ...s, ...hit, loaded: true } : s;
    };
    danmakuSources.value = [
      base({ key: "local", name: t("player.srcLocal"), detail: "", count: 0, items: [], loaded: false, loading: false, enabled: true, available: true, error: "" }),
      base({ key: "server", name: t("player.srcServer"), detail: "", count: 0, items: [], loaded: false, loading: false, enabled: true, available: true, error: "" }),
    ];
    void loadDanmakuSrc("local", seq);
    void loadDanmakuSrc("server", seq);
    return;
  }
  const cid = biliCidOf(currentEpisodeSites.value);
  if (ek === danmakuActiveEp.value) {
    // 同一集：集数数据（sites）晚于首次装载到达时，补齐 bili 可用态并自动加载
    const bili = danmakuSources.value.find((s) => s.key === "bili");
    if (bili && !bili.available && cid) {
      bili.available = true;
      void loadDanmakuSrc("bili", danmakuLoadSeq);
    }
    return;
  }
  danmakuActiveEp.value = ek;
  const seq = ++danmakuLoadSeq;
  const cached = danmakuCacheFor(ek);
  danmakuSources.value = freshDanmakuStates(cid).map((s) => {
    const hit = cached.get(s.key);
    return hit ? { ...s, ...hit, loaded: true } : s;
  });
  void loadDanmakuSrc("server", seq);
  if (cid) void loadDanmakuSrc("bili", seq);
}

/** 刷新弹幕源：清空本话内存缓存后重新拉取 */
function refreshDanmaku() {
  if (bangumiID.value == null) return;
  danmakuCache.delete(epKey.value);
  danmakuActiveEp.value = "";
  ensureDanmaku();
}

async function loadDanmakuSrc(key: DanmakuSourceKey, seq: number) {
  const st = danmakuSources.value.find((s) => s.key === key);
  if (!st || st.loaded || st.loading || (key === "bili" && !st.available)) return;
  st.loading = true;
  st.error = "";
  try {
    let src: DanmakuSource;
    if (key === "server") src = await loadServerDanmaku(bangumiID.value!, episode.value);
    else if (key === "bili") src = await loadBiliDanmaku(biliCidOf(currentEpisodeSites.value));
    else if (key === "local") src = await loadLocalDanmaku(bangumiID.value!, episode.value);
    else src = await loadDandanDanmaku(ui.player.title || "", episode.value);
    if (seq !== danmakuLoadSeq) return; // 已换集
    danmakuCacheFor(epKey.value).set(key, src);
    const cur = danmakuSources.value.find((s) => s.key === key);
    if (cur) {
      cur.detail = src.detail;
      cur.count = src.count;
      cur.items = src.items;
      cur.loaded = true;
    }
    reloadDanmukuLayer();
  } catch (e) {
    if (seq !== danmakuLoadSeq) return;
    const cur = danmakuSources.value.find((s) => s.key === key);
    if (cur) cur.error = e instanceof Error ? e.message : String(e);
  } finally {
    if (seq === danmakuLoadSeq) {
      const cur = danmakuSources.value.find((s) => s.key === key);
      if (cur) cur.loading = false;
    }
  }
}

/** 点击弹幕源行：未加载 → 加载并启用；已加载 → 切换启用/停用 */
function toggleDanmakuSource(key: DanmakuSourceKey) {
  const st = danmakuSources.value.find((s) => s.key === key);
  if (!st || st.loading || !st.available) return;
  if (!st.loaded) {
    st.enabled = true;
    void loadDanmakuSrc(key, danmakuLoadSeq);
    return;
  }
  st.enabled = !st.enabled;
  reloadDanmukuLayer();
}

const danmakuAvailableCount = computed(() => danmakuSources.value.filter((s) => s.available).length);
const danmakuTotalCount = computed(() => danmakuSources.value.reduce((n, s) => n + (s.loaded ? s.count : 0), 0));

/** 当前启用的弹幕（插件 danmuku 异步函数的数据源） */
function currentDanmakuItems(): PluginDanmu[] {
  if (!settings.data.danmaku.enabled) return [];
  return mergeDanmaku(danmakuSources.value.filter((s) => s.loaded && s.enabled));
}

/** 显示区域 → 插件 margin（下边距百分比，与插件内建步进一致） */
function danmakuMargin(area: number): [number, `${number}%` | number] {
  if (area <= 0.25) return [10, "75%"];
  if (area <= 0.5) return [10, "50%"];
  if (area <= 0.75) return [10, "25%"];
  return [10, 10];
}

/**
 * artplayer-plugin-danmuku 实例引用。
 * ⚠️ 插件返回对象的 name 字段是 artplayerPluginDanmuku，ArtPlayer 把实例挂在
 * art.plugins.artplayerPluginDanmuku（Plugins 管理器上，见 artplayer types 的
 * plugins: {} & Record<string,unknown>）。此前误用 art.danmuku 访问恒为 undefined，
 * 导致弹幕设置面板（区域/透明度/字号/速度/开关）与弹幕源启用/停用全部静默失效。
 */
interface DanmukuPlugin {
  load: (d?: PluginDanmu[]) => Promise<unknown>;
  config: (o: Record<string, unknown>) => unknown;
  show: () => void;
  hide: () => void;
  reset: () => void;
}
function danmukuPlugin(): DanmukuPlugin | null {
  const a = art as unknown as Record<string, any> | null;
  if (!a) return null;
  const p = (a.plugins as Record<string, any> | undefined)?.artplayerPluginDanmuku
    ?? a.artplayerPluginDanmuku; // 兼容：部分版本直接挂在 art 根上
  return (p as DanmukuPlugin) ?? null;
}

/** 重载插件弹幕层（数据/开关变化时）。无参 load：插件内部会先 reset 清空旧队列，
 *  再重新执行 option.danmuku()（即 currentDanmakuItems）拿最新数据，避免弹幕重复。 */
function reloadDanmukuLayer() {
  const plugin = danmukuPlugin();
  if (!plugin) return;
  try {
    if (!settings.data.danmaku.enabled) { plugin.hide(); return; }
    plugin.show();
    void plugin.load();
  } catch (e) { pushLog(`danmuku reload failed: ${e}`); }
}

// 弹幕设置实时应用（区域/透明度/字号/速度/开关）。
// 性能（需求：修弹幕设置时 UI 卡顿）：插件 config() 只要不传 fontSize
// 就不会触发内部全量 reset —— 此前每次改动都携带 fontSize，每点一下
// 设置就全量重排弹幕。现在只提交真正变化的键；透明度另经 CSS 变量
// （--aikf-dm-opacity 压过每条弹幕的行内透明度）零重排立即生效；
// 仅字号变化才允许插件内部 reset 重排行高。
let prevDm = { ...settings.data.danmaku };
/** 透明度 CSS 变量热应用：对所有已显示/将显示弹幕立即生效，无 DOM 重排 */
function applyDanmakuOpacityVar() {
  const a = art as unknown as Record<string, any> | null;
  if (!a) return;
  try {
    const v = settings.data.danmaku.enabled ? String(settings.data.danmaku.opacity) : "1";
    (a.template.$player as HTMLElement).style.setProperty("--aikf-dm-opacity", v);
  } catch (e) { pushLog(`apply danmaku opacity var failed: ${e}`); }
}
watch(() => ({ ...settings.data.danmaku }), (dm) => {
  const plugin = danmukuPlugin();
  if (plugin) {
    try {
      const patch: Record<string, unknown> = {};
      if (dm.opacity !== prevDm.opacity) patch.opacity = dm.opacity;
      if (dm.speed !== prevDm.speed) patch.speed = dm.speed;
      if (dm.area !== prevDm.area) patch.margin = danmakuMargin(dm.area);
      if (dm.fontSize !== prevDm.fontSize) patch.fontSize = dm.fontSize;
      if (Object.keys(patch).length) plugin.config(patch);
      if (dm.enabled) plugin.show(); else plugin.hide();
    } catch (e) { pushLog(`danmuku config failed: ${e}`); }
  }
  if (dm.opacity !== prevDm.opacity || dm.enabled !== prevDm.enabled) applyDanmakuOpacityVar();
  prevDm = { ...dm };
});

// 打开播放器 / 换集 / sites 就绪 → 装载弹幕
watch(
  () => [open.value, epKey.value, biliCidOf(currentEpisodeSites.value), isLocal.value] as const,
  ([o]) => { if (o) ensureDanmaku(); },
  { immediate: true },
);

// ── 右侧面板：简介 / 评论 / 角色 ──
// 简介（默认 Tab）：详情元信息 + 简介（可展开/收起）+ 分类 + 完整详情跳转
const { data: playerDetail, isLoading: playerDetailLoading } = useAsync(
  () => anich.detail(bangumiID.value!),
  { enabled: openRef, source: computed(() => `pd-${bangumiID.value ?? 0}`) }
);
const infoBestRating = computed(() => playerDetail.value?.rating?.find((r) => r.score > 0));
const infoStarPct = computed(() => {
  const s = infoBestRating.value?.score ?? 0;
  return `${Math.max(0, Math.min(100, (s / 10) * 100))}%`;
});
const infoExpanded = ref(false);
const INFO_LANG_KEYS: Record<string, string> = {
  ja: "common.langNames.ja",
  zh: "common.langNames.zh",
  en: "common.langNames.en",
  ko: "common.langNames.ko",
  other: "common.langNames.other",
};
const infoLangLabel = (l?: string) => (l ? (INFO_LANG_KEYS[l] ? t(INFO_LANG_KEYS[l]) : l) : "");
function fmtCnDate(ts?: number): string {
  if (!ts || ts <= 0) return "—";
  return i18n.global.d(ts, "long");
}
const { data: playerCommentsData, isLoading: commentsLoading } = useAsync(
  () => anich.comments(bangumiID.value!, 1, undefined),
  { enabled: openRef, source: () => "p-comments" }
);
const playerComments = computed(() => playerCommentsData.value?.body?.data ?? []);
const { data: playerCharsData, isLoading: charsLoading } = useAsync(
  () => anich.characters(bangumiID.value!),
  { enabled: openRef, source: () => "p-chars" }
);
const playerChars = computed(() => playerCharsData.value ?? []);

function fmtCDate(ts: number) {
  if (!ts) return "";
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ── Sidebar info strip：详情跳转 + 收藏 ──
const isFav = computed(() => bangumiID.value != null && library.has(bangumiID.value));
function toggleFav() {
  if (bangumiID.value == null) return;
  if (library.has(bangumiID.value)) {
    library.remove(bangumiID.value);
    return;
  }
  library.addOrUpdate(
    { id: bangumiID.value, title: ui.player.title || `Bangumi ${bangumiID.value}`, image: ui.player.cover || "", tagline: "", totalEpisodes: episodesList.value.length || 0 },
    "watching"
  );
}

/** Close the player and jump to the anime detail page (reference-app style "详情 >"). */
function openDetailPage() {
  if (bangumiID.value == null) return;
  destroyArt();
  const id = bangumiID.value;
  const cover = ui.player.cover;
  ui.closePlayer();
  ui.openDetail(id, cover);
}

/** h:mm:ss for episode cards (reference style "0:23:50"). */
function fmtEpDuration(sec?: number): string {
  if (!sec || sec <= 0) return "";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
/** 集数卡片日期 */
function fmtEpDate(ts?: number): string {
  if (!ts || ts <= 0) return "";
  return i18n.global.d(ts, "long");
}
/** 选集缩略图加载失败 → 隐藏破图（留底色占位） */
function onEpImgError(e: Event) {
  (e.target as HTMLElement).style.opacity = "0";
}

const retestLatency = async () => {
  if (latencyTesting.value || sources.value.length === 0) return;
  // 需求：正在播放时测速只刷新延迟数据，不切换线路（避免中断观看）
  const playingNow = !!(art && art.playing && art.currentTime > 1);
  const best = await pickFastestSource(sources.value, epKey.value);
  if (playingNow) {
    pushLog("手动测速完成：当前正在播放，保持线路不切换");
    return;
  }
  if (best !== effectiveIdx.value) switchSource(best);
  pushLog("手动测速完成，已切换到最快线路");
};
</script>

<template>
  <Transition name="player">
    <div v-if="open && bangumiID != null" class="fixed inset-0 z-[100] flex bg-black">
      <!-- ═══ 布局：视频区 + 右侧详情面板（flex 兄弟节点，互不遮挡）═══ -->

      <!-- Video area -->
      <div :class="cn('relative min-h-0 min-w-0 flex-1 bg-black', playerLocked && 'aikf-locked')">
        <!-- Loading / error / empty states（需求：错误/无源态提供返回键 ——
             此时 ArtPlayer 未创建，顶栏（含返回键）不存在，无返回键会困住用户） -->
        <div v-if="!isLocal && vodLoading" class="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 text-white/70">
          <Loader2 class="h-10 w-10 animate-spin text-primary" />
          <p class="text-sm">{{ $t('player.loadSrc') }}</p>
          <button @click="closePlayerBack" class="mt-1 rounded-full bg-white/10 px-4 py-1.5 text-xs text-white hover:bg-white/20">{{ $t('common.back') }}</button>
        </div>
        <div v-else-if="!isLocal && vodIsError" class="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 px-6 text-center text-white/70">
          <AlertCircle class="h-10 w-10 text-destructive" />
          <p class="text-sm">{{ $t('player.loadFailed') }}</p>
          <div class="mt-1 flex items-center gap-2">
            <button @click="vodRefetch()" class="rounded-full bg-primary px-4 py-1.5 text-xs font-semibold text-primary-foreground hover:opacity-90">{{ $t('common.retry') }}</button>
            <button @click="closePlayerBack" class="rounded-full bg-white/10 px-4 py-1.5 text-xs text-white hover:bg-white/20">{{ $t('common.back') }}</button>
          </div>
        </div>
        <div v-else-if="!isLocal && sources.length === 0" class="absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 px-6 text-center text-white/60">
          <AlertCircle class="h-10 w-10" />
          <p class="text-sm">{{ $t('player.noSources') }}</p>
          <p class="text-xs text-white/45">{{ $t('player.noSourcesHint') }}</p>
          <div class="mt-1 flex items-center gap-2">
            <button @click="vodRefetch()" class="rounded-full bg-primary px-4 py-1.5 text-xs font-semibold text-primary-foreground hover:opacity-90">{{ $t('common.retry') }}</button>
            <button @click="closePlayerBack" class="rounded-full bg-white/10 px-4 py-1.5 text-xs text-white hover:bg-white/20">{{ $t('common.back') }}</button>
          </div>
        </div>
        <template v-else>
          <!-- ArtPlayer container — fills the video area. -->
          <div
            ref="artContainerRef"
            class="art-container absolute inset-0 bg-black"
            style="width: 100%; height: 100%;"
          ></div>
          <div v-if="videoError" class="absolute inset-x-0 bottom-16 mx-auto max-w-md rounded-xl bg-destructive/90 px-4 py-2 text-center text-xs text-white">
            {{ videoError }}
          </div>
        </template>

        <!-- 小窗播放中占位提示（视频已移至 ArtPlayer 原生悬浮窗） -->
        <div v-if="miniActive" class="absolute inset-0 z-30 flex flex-col items-center justify-center gap-3 text-white/45">
          <PictureInPicture2 class="h-8 w-8 opacity-50" />
          <p class="text-xs">{{ $t('player.miniActive') }}</p>
          <button type="button" class="rounded-full bg-white/10 px-4 py-1.5 text-xs text-white hover:bg-white/20" @click="toggleMini">{{ $t('player.restore') }}</button>
        </div>

        <!-- 锁定按键（需求：画面左侧中间；锁定时悬停只显示 解锁/返回/标题；
             底部控制栏隐藏时同步隐藏） -->
        <button
          v-if="!playerLocked && !artFullscreen && !artFullscreenWeb"
          type="button"
          :class="cn('aikf-lock-btn', !artControlsVisible && 'aikf-float-hidden')"
          @click="lockPlayer"
          :aria-label="$t('player.lockAria')"
          v-tip="$t('player.lock')"
        >
          <Lock class="h-4 w-4" />
        </button>

        <!-- 面板开合按键（需求：位于视频右缘垂直居中，参考截图红圈位置；
             底部控制栏隐藏时同步隐藏） -->
        <button
          v-if="!playerLocked"
          type="button"
          :class="cn('aikf-edge-toggle', !artControlsVisible && 'aikf-float-hidden')"
          @click="toggleSide"
          :aria-label="sideOpen ? $t('player.panelCollapse') : $t('player.panelExpand')"
          v-tip="sideOpen ? $t('player.panelCollapse') : $t('player.panelExpand')"
        >
          <ChevronRight v-if="sideOpen" class="h-4 w-4" />
          <ChevronLeft v-else class="h-4 w-4" />
        </button>

        <!-- 选集弹层已移回 overlay-host 内（与未改版前一致的旧式浮层），见 Teleport 尾部 -->

        <!-- 锁定遮罩：拦截视频区一切交互；悬停只显示 解锁/返回/标题 -->
        <template v-if="playerLocked">
          <div class="aikf-lock-shield" @mousemove="bumpLockChrome" @click.stop @dblclick.stop @contextmenu.prevent.capture @wheel.stop />
          <div class="aikf-lock-top" :class="{ 'aikf-lock-top-show': lockChrome }" @mousemove="bumpLockChrome">
            <button type="button" class="aikf-top-btn" @click="closePlayerBack" :aria-label="$t('common.back')" v-tip="$t('common.back')">
              <ArrowLeft class="h-4 w-4" />
            </button>
            <div class="aikf-top-titles">
              <p class="aikf-top-title">{{ ui.player.title }}<span v-if="isLocal" class="aikf-local-tag">{{ $t('player.localTag') }}</span></p>
              <p class="aikf-top-sub">{{ $t('common.epN', { n: episode }) }}{{ currentEpisodeTitle ? ` ${currentEpisodeTitle}` : "" }}</p>
            </div>
          </div>
          <button
            type="button"
            class="aikf-lock-btn aikf-lock-unlock"
            :class="{ 'aikf-lock-visible': lockChrome }"
            @mousemove="bumpLockChrome"
            @click="unlockPlayer"
            :aria-label="$t('player.unlockAria')"
            v-tip="$t('player.unlock')"
          >
            <LockOpen class="h-4 w-4" />
          </button>
        </template>

        <!-- ═══ 顶栏 + 线路/设置弹层：Teleport 进 ArtPlayer 根节点 ═══
             右侧面板是 flex 兄弟节点 → 顶栏窗口控制键永远不会被选集面板遮挡。 -->
        <Teleport v-if="playerOverlayHost" :to="playerOverlayHost">
          <!-- 顶栏：返回 + 标题/集数(分辨率) ｜ 窗口控制（与画面融为一体） -->
          <div class="aikf-top">
            <div class="aikf-top-left" data-tauri-drag-region>
              <button
                type="button"
                class="aikf-top-btn"
                @click="closePlayerBack"
                :aria-label="$t('common.back')"
                v-tip="$t('common.back')"
              >
                <ArrowLeft class="h-4 w-4" />
              </button>
              <div class="aikf-top-titles" data-tauri-drag-region>
                <p class="aikf-top-title" data-tauri-drag-region v-tip="ui.player.title">{{ ui.player.title }}<span v-if="isLocal" class="aikf-local-tag">{{ $t('player.localTag') }}</span></p>
                <p class="aikf-top-sub" data-tauri-drag-region>
                  {{ $t('common.epN', { n: episode }) }}{{ currentEpisodeTitle ? ` ${currentEpisodeTitle}` : "" }}<template v-if="videoResolution"> ({{ videoResolution.width }}x{{ videoResolution.height }})</template>
                </p>
              </div>
            </div>
            <div class="aikf-top-right">
              <!-- 真全屏/网页全屏时隐藏窗口控制键；
                   面板开合键已移至视频右缘中部（红圈位置），顶栏不再重复放置 -->
              <template v-if="isTauri && !artFullscreen && !artFullscreenWeb && !sideOpen">
                <button type="button" class="aikf-top-btn" @click="winMinimize" :aria-label="$t('theme.minimize')" v-tip="$t('theme.minimize')">
                  <Minus class="h-4 w-4" />
                </button>
                <button type="button" class="aikf-top-btn" @click="winToggleMax" :aria-label="$t('theme.maximize')" v-tip="$t('theme.maximize')">
                  <Square class="h-3.5 w-3.5" />
                </button>
              </template>
              <button v-if="!sideOpen" type="button" class="aikf-top-btn aikf-top-close" @click="closePlayerBack" :aria-label="$t('common.close')" v-tip="$t('common.close')">
                <X class="h-4 w-4" />
              </button>
            </div>
          </div>

          <!-- 线路弹层：节点显示 标题/节点名称 + 分辨率 + 延迟（+优选标记）；
               透明遮罩：点击弹层外区域关闭，@click.stop 拦截冒泡 —— 点击不会穿透到视频触发暂停/播放 -->
          <div v-if="linePanelOpen" class="aikf-pop-shield" @click.stop="linePanelOpen = false">
          <div class="aikf-panel aikf-panel-line" @click.stop>
            <div class="aikf-panel-title aikf-panel-title-row">
              <span>{{ $t('player.lineCount', { n: sources.length }) }}</span>
              <button
                type="button"
                :disabled="latencyTesting"
                @click="retestLatency"
                class="aikf-retest"
                v-tip="$t('player.speedTestTitle')"
              >
                <Loader2 v-if="latencyTesting" class="h-3 w-3 animate-spin" />
                <Zap v-else class="h-3 w-3" />
                {{ $t('player.speedTest') }}
              </button>
            </div>
            <div class="aikf-panel-list">
              <button
                v-for="(s, i) in sources"
                :key="i"
                type="button"
                @click="switchSource(i, { user: true })"
                :class="cn('aikf-panel-item aikf-line-row', i === effectiveIdx && 'aikf-panel-item-active')"
              >
                <span class="aikf-line-idx">{{ i + 1 }}</span>
                <span class="aikf-line-texts">
                  <span class="aikf-line-title">
                    <span class="min-w-0 truncate">{{ rawLineName(s) }}</span>
                    <span v-if="isAdkwaiSource(s.url)" class="aikf-pick-tag" v-tip="$t('player.speedTestTitle')">{{ $t('cache.preferred') }}</span>
                    <span v-if="i === effectiveIdx" class="aikf-cur-tag">{{ $t('cache.current') }}</span>
                  </span>
                  <span class="aikf-line-host">{{ sourceName(s.url) }}</span>
                </span>
                <span class="aikf-line-meta">
                  <span class="aikf-chip aikf-chip-proto" v-tip="$t('player.protoTip', { p: sourceProtoLabel(s.url) })">{{ sourceProtoLabel(s.url) }}</span>
                  <span class="aikf-chip">{{ lineResOf(i) }}</span>
                  <span
                    v-if="sourceLatencies[i] !== undefined"
                    class="aikf-chip"
                    :class="sourceLatencies[i] !== null ? 'aikf-chip-ok' : 'aikf-chip-bad'"
                  >{{ sourceLatencies[i] !== null ? sourceLatencies[i] + 'ms' : $t('player.timeout') }}</span>
                  <span v-else class="aikf-chip aikf-chip-dim">{{ $t('player.untested') }}</span>
                </span>
              </button>
            </div>
          </div>
          </div>

          <!-- 设置弹层（底栏设置按键呼出）：常见设置 / 视频缓冲设置；
               透明遮罩：点击弹层外区域关闭 + .stop 拦截冒泡（不影响播放） -->
          <div v-if="settingsPanelOpen" class="aikf-pop-shield" @click.stop="settingsPanelOpen = false">
          <div class="aikf-panel aikf-panel-settings" @click.stop>
            <div class="aikf-set-tabs">
              <button
                type="button"
                :class="cn('aikf-set-tab', settingsTab === 'common' && 'aikf-set-tab-active')"
                @click="settingsTab = 'common'"
              >{{ $t('player.setCommon') }}</button>
              <button
                type="button"
                :class="cn('aikf-set-tab', settingsTab === 'buffer' && 'aikf-set-tab-active')"
                @click="settingsTab = 'buffer'"
              >{{ $t('player.setBuffer') }}</button>
            </div>

            <div v-if="settingsTab === 'common'" class="aikf-set-body">
              <div class="aikf-set-row">
                <p class="aikf-set-label">{{ $t('player.rate') }}</p>
                <div class="aikf-seg">
                  <button
                    v-for="r in [0.5, 0.75, 1, 1.25, 1.5, 2]"
                    :key="`r${r}`"
                    type="button"
                    :class="cn('aikf-seg-btn', rateRef === r && 'aikf-seg-on')"
                    @click="setRate(r)"
                  >{{ r }}x</button>
                </div>
              </div>
              <div class="aikf-set-row">
                <p class="aikf-set-label">{{ $t('player.ratio') }}</p>
                <div class="aikf-seg">
                  <button
                    v-for="o in ([{ v: 'default', t: $t('player.ratioDefault') }, { v: '4:3', t: '4:3' }, { v: '16:9', t: '16:9' }, { v: '2.35:1', t: '2.35:1' }] as const)"
                    :key="`o${o.v}`"
                    type="button"
                    :class="cn('aikf-seg-btn', ratioRef === o.v && 'aikf-seg-on')"
                    @click="setRatio(o.v)"
                  >{{ o.t }}</button>
                </div>
              </div>
              <div class="aikf-set-row">
                <p class="aikf-set-label">{{ $t('player.flip') }}</p>
                <div class="aikf-seg">
                  <button
                    v-for="f in [{ v: 'normal', t: $t('player.flipNormal') }, { v: 'horizontal', t: $t('player.flipH') }, { v: 'vertical', t: $t('player.flipV') }]"
                    :key="`f${f.v}`"
                    type="button"
                    :class="cn('aikf-seg-btn', flipRef === f.v && 'aikf-seg-on')"
                    @click="setFlip(f.v)"
                  >{{ f.t }}</button>
                </div>
              </div>
              <div class="aikf-set-row aikf-set-row-flex">
                <p class="aikf-set-label">{{ $t('player.autoNext') }}</p>
                <ToggleSwitch :on="settings.data.autoNext" @toggle="toggleAutoNext" />
              </div>
            </div>

            <div v-else class="aikf-set-body">
              <div class="aikf-set-row">
                <p class="aikf-set-label">{{ $t('player.preBuffer') }}</p>
                <div class="aikf-seg">
                  <button
                    v-for="b in [60, 120, 300, 600]"
                    :key="`b${b}`"
                    type="button"
                    :class="cn('aikf-seg-btn', settings.data.bufferSize === b && 'aikf-seg-on')"
                    @click="settings.update('bufferSize', b as any)"
                  >{{ b }}s</button>
                </div>
                <p class="aikf-set-hint">{{ $t('player.preBufferHint') }}</p>
              </div>
              <div class="aikf-set-row">
                <p class="aikf-set-label">{{ $t('player.backBuffer') }}</p>
                <div class="aikf-seg">
                  <button
                    v-for="b in [0, 30, 60]"
                    :key="`bb${b}`"
                    type="button"
                    :class="cn('aikf-seg-btn', settings.data.backBuffer === b && 'aikf-seg-on')"
                    @click="settings.update('backBuffer', b as any)"
                  >{{ b }}s</button>
                </div>
                <p class="aikf-set-hint">{{ $t('player.backBufferHint') }}</p>
              </div>
            </div>
          </div>
          </div>

          <!-- 弹幕设置弹层（底栏「弹」按键呼出）：开关/显示区域/透明度/字号/速度（无发送框）；
               透明遮罩：点击弹层外区域关闭 + .stop 拦截冒泡（不影响播放） -->
          <div v-if="danmakuPanelOpen" class="aikf-pop-shield" @click.stop="danmakuPanelOpen = false">
          <div class="aikf-panel aikf-panel-danmaku" @click.stop>
            <div class="aikf-panel-title">{{ $t('player.ctrlDanmakuTip') }}</div>
            <div class="aikf-set-body">
              <div class="aikf-set-row aikf-set-row-flex">
                <p class="aikf-set-label">{{ $t('player.dmShow') }}</p>
                <ToggleSwitch :on="settings.data.danmaku.enabled" @toggle="settings.updateDanmaku('enabled', !settings.data.danmaku.enabled)" />
              </div>
              <div class="aikf-set-row">
                <p class="aikf-set-label">{{ $t('player.dmArea') }}</p>
                <div class="aikf-seg">
                  <button
                    v-for="a in ([{ v: 0.25, t: $t('player.dmAreaQuarter') }, { v: 0.5, t: $t('player.dmAreaHalf') }, { v: 0.75, t: $t('player.dmAreaThreeQuarter') }, { v: 1, t: $t('player.dmAreaFull') }] as const)"
                    :key="`da${a.v}`"
                    type="button"
                    :class="cn('aikf-seg-btn', settings.data.danmaku.area === a.v && 'aikf-seg-on')"
                    @click="settings.updateDanmaku('area', a.v)"
                  >{{ a.t }}</button>
                </div>
              </div>
              <div class="aikf-set-row">
                <p class="aikf-set-label">{{ $t('player.dmOpacity') }}</p>
                <div class="aikf-seg">
                  <button
                    v-for="o in ([0.25, 0.5, 0.75, 1] as const)"
                    :key="`do${o}`"
                    type="button"
                    :class="cn('aikf-seg-btn', settings.data.danmaku.opacity === o && 'aikf-seg-on')"
                    @click="settings.updateDanmaku('opacity', o)"
                  >{{ Math.round(o * 100) }}%</button>
                </div>
              </div>
              <div class="aikf-set-row">
                <p class="aikf-set-label">{{ $t('player.dmFont') }}</p>
                <div class="aikf-seg">
                  <button
                    v-for="f in ([{ v: 18, t: $t('player.dmFontS') }, { v: 22, t: $t('player.dmFontM') }, { v: 28, t: $t('player.dmFontL') }, { v: 36, t: $t('player.dmFontXL') }])"
                    :key="`df${f.v}`"
                    type="button"
                    :class="cn('aikf-seg-btn', settings.data.danmaku.fontSize === f.v && 'aikf-seg-on')"
                    @click="settings.updateDanmaku('fontSize', f.v)"
                  >{{ f.t }}</button>
                </div>
              </div>
              <div class="aikf-set-row">
                <p class="aikf-set-label">{{ $t('player.dmSpeed') }}</p>
                <div class="aikf-seg">
                  <button
                    v-for="sp in ([{ v: 3, t: $t('player.dmSpeedSlow') }, { v: 5, t: $t('player.dmSpeedNormal') }, { v: 8, t: $t('player.dmSpeedFast') }])"
                    :key="`ds${sp.v}`"
                    type="button"
                    :class="cn('aikf-seg-btn', settings.data.danmaku.speed === sp.v && 'aikf-seg-on')"
                    @click="settings.updateDanmaku('speed', sp.v)"
                  >{{ sp.t }}</button>
                </div>
                <p class="aikf-set-hint">{{ $t('player.dmSrcHint') }}</p>
              </div>
            </div>
          </div>
          </div>

          <!-- 旧式选集弹层：面板收起时点底栏「选集」弹出（v3.4 双列缩略图网格设计）；
               面板展开时底栏「选集」直接切换到面板选集页，不弹此层。
               透明遮罩：点击弹层以外区域关闭弹层（无视觉变化）；.stop 拦截冒泡不影响播放 -->
          <div v-if="epPopupOpen" class="aikf-ep-shield" @click.stop="epPopupOpen = false">
            <div class="aikf-panel aikf-panel-ep" @click.stop>
              <div class="aikf-panel-title aikf-panel-title-row">
                <span>{{ $t('player.ctrlEpisodes') }}<template v-if="currentEpisodeTitle"> · {{ $t('common.epN', { n: episode }) }}</template></span>
                <div class="flex items-center gap-0.5">
                  <button type="button" class="aikf-side-btn" @click="expandSideFromPopup" :aria-label="$t('player.panelExpand')" v-tip="$t('player.viewInSide')">
                    <PanelRightOpen class="h-3.5 w-3.5" />
                  </button>
                  <button type="button" class="aikf-side-btn" @click="epPopupOpen = false" :aria-label="$t('player.closeEpisodes')" v-tip="$t('common.close')">
                    <X class="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
              <div class="aikf-panel-list">
                <div v-if="epGridItems.length > 0" class="grid grid-cols-2 gap-2">
                  <button
                    v-for="ep in epGridItems"
                    :key="`pp${ep.key}`"
                    type="button"
                    class="aikf-epcard text-left"
                    v-tip="ep.title ? $t('common.epNT', { n: ep.sort, t: ep.title }) : $t('common.epN', { n: ep.sort })"
                    @click="clickEpItem(ep)"
                  >
                    <span :class="cn('aikf-epcard-thumb', ep.playing && 'aikf-epcard-thumb-active', !ep.playable && 'opacity-55')">
                      <img
                        :src="ep.img"
                        :alt="$t('common.epN', { n: ep.sort })"
                        loading="lazy"
                        draggable="false"
                        class="aikf-epcard-img"
                        @error="onEpImgError"
                      />
                      <span v-if="ep.playing" class="aikf-epcard-playing">{{ $t('player.playing') }}</span>
                      <span :class="cn('aikf-epcard-badge', ep.badgeOk && 'aikf-epcard-badge-ok', ep.badgeBad && 'aikf-epcard-badge-bad')">{{ ep.badge }}</span>
                      <span v-if="ep.dur" class="aikf-epcard-dur">{{ ep.dur }}</span>
                    </span>
                    <span :class="cn('aikf-epcard-title', ep.playing && 'text-primary')">
                      {{ $t('common.epNT', { n: ep.sort, t: ep.title }) }}
                    </span>
                  </button>
                </div>
                <div v-else class="flex flex-col items-center justify-center gap-2 py-8 text-white/40">
                  <ListVideo class="h-7 w-7 opacity-40" />
                  <p class="text-xs">{{ $t('player.noEpisodes') }}</p>
                </div>
              </div>
            </div>
          </div>
        </Teleport>
      </div>

      <!-- ═══ 右侧详情面板：Tab 切换 + 窗口控制键（无返回键，参考图样式）═══
           flex 兄弟节点：不会遮挡视频区；面板收起时窗口控制键回到视频顶栏 -->
      <Transition name="sidepanel">
        <div v-show="sideOpen" class="aikf-side">
          <!-- 面板头：顶部切换 + 窗口控制（最小化/最大化/关闭，无返回键）。
               收起键已移至视频右缘中部（红圈位置）；标签收紧内边距，
               保证 300px 窄面板下关闭键不再被挤出窗口（溢出修复） -->
          <div class="flex shrink-0 items-center gap-1 border-b border-white/10 py-2 pl-2 pr-1.5" data-tauri-drag-region>
            <div class="flex min-w-0 flex-1 items-center justify-center gap-0.5 overflow-hidden">
              <button
                type="button"
                @click="sideTab = 'info'"
                :class="cn('aikf-side-tab', sideTab === 'info' && 'aikf-side-tab-active')"
              >
                <Info class="h-3 w-3" /> {{ $t('player.tabInfo') }}
              </button>
              <button
                type="button"
                @click="sideTab = 'ep'"
                :class="cn('aikf-side-tab', sideTab === 'ep' && 'aikf-side-tab-active')"
              >
                <ListVideo class="h-3 w-3" /> {{ $t('player.ctrlEpisodes') }}
              </button>
              <button
                type="button"
                @click="sideTab = 'comments'"
                :class="cn('aikf-side-tab', sideTab === 'comments' && 'aikf-side-tab-active')"
              >
                <MessageSquare class="h-3 w-3" /> {{ $t('detail.tabComments') }}
              </button>
              <button
                type="button"
                @click="sideTab = 'characters'"
                :class="cn('aikf-side-tab', sideTab === 'characters' && 'aikf-side-tab-active')"
              >
                <Users class="h-3 w-3" /> {{ $t('detail.tabCharacters') }}
              </button>
            </div>
            <!-- 窗口控制键：内嵌面板头右侧（参考图 1/2 的 — □ × 位置） -->
            <div class="flex flex-none items-center gap-0">
              <template v-if="isTauri && !artFullscreen && !artFullscreenWeb">
                <button type="button" class="aikf-side-btn" @click="winMinimize" :aria-label="$t('theme.minimize')" v-tip="$t('theme.minimize')">
                  <Minus class="h-4 w-4" />
                </button>
                <button type="button" class="aikf-side-btn" @click="winToggleMax" :aria-label="$t('theme.maximize')" v-tip="$t('theme.maximize')">
                  <Square class="h-3.5 w-3.5" />
                </button>
              </template>
              <button type="button" class="aikf-side-btn aikf-side-close" @click="closePlayerBack" :aria-label="$t('common.close')" v-tip="$t('common.close')">
                <X class="h-4 w-4" />
              </button>
            </div>
          </div>

          <!-- 正在播放信息条：标题(详情›) + 集数·分辨率 + 收藏 -->
          <div class="flex shrink-0 items-center justify-between gap-2 border-b border-white/5 px-3 py-2">
            <div class="min-w-0">
              <button type="button" @click="openDetailPage" class="group flex min-w-0 max-w-full items-center gap-1.5 text-left">
                <span class="min-w-0 truncate text-xs font-bold text-white transition-colors group-hover:text-primary" v-tip="ui.player.title">{{ ui.player.title || $t('player.unknownBangumi') }}</span>
                <span class="shrink-0 text-[10px] text-white/35 transition-colors group-hover:text-primary">{{ $t('player.detailMore') }}</span>
              </button>
              <p class="mt-0.5 truncate text-[10px] text-white/45">
                {{ $t('common.epN', { n: episode }) }} {{ currentEpisodeTitle }}<template v-if="videoResolution"> · {{ videoResolution.label }}</template>
              </p>
            </div>
            <button
              type="button"
              @click="toggleFav"
              :class="cn('aikf-side-btn shrink-0', isFav && 'text-primary')"
              :aria-label="isFav ? $t('player.unfav') : $t('player.fav')"
              v-tip="isFav ? $t('player.unfav') : $t('player.fav')"
            >
              <Heart :class="cn('h-4 w-4', isFav && 'fill-current')" />
            </button>
          </div>

          <!-- 面板主体 -->
          <div class="min-h-0 flex-1 overflow-y-auto">
            <!-- ── 简介（默认显示）── -->
            <div v-if="sideTab === 'info'" class="p-3">
              <div v-if="playerDetailLoading" class="space-y-2">
                <div class="h-3.5 w-2/3 rounded bg-white/5" />
                <div class="h-3 w-1/2 rounded bg-white/5" />
                <div class="h-20 rounded bg-white/5" />
              </div>
              <div v-else-if="!playerDetail" class="py-12 text-center text-xs text-white/40">{{ $t('player.noInfo') }}</div>
              <template v-else>
                <!-- 评分 -->
                <div v-if="infoBestRating" class="flex items-center gap-2">
                  <div class="relative inline-flex h-3.5 w-[77px] shrink-0">
                    <div class="flex gap-0.5">
                      <Star v-for="i in 5" :key="`ib${i}`" class="h-3.5 w-3.5 shrink-0 fill-white/15 text-white/15" />
                    </div>
                    <div class="absolute inset-y-0 left-0 overflow-hidden" :style="{ width: infoStarPct }">
                      <div class="flex gap-0.5">
                        <Star v-for="i in 5" :key="`if${i}`" class="h-3.5 w-3.5 shrink-0 fill-amber-400 text-amber-400" />
                      </div>
                    </div>
                  </div>
                  <span class="text-[10px] text-white/45">{{ infoBestRating.count ? $t('detail.ratedBy', { n: infoBestRating.count }) : "" }}{{ $t('detail.score', { s: infoBestRating.score.toFixed(1) }) }}</span>
                </div>
                <!-- 元信息 -->
                <div class="mt-2.5 space-y-1 text-[11px] leading-relaxed text-white/65">
                  <p><span class="text-white/35">{{ $t('detail.metaTime') }}: </span>{{ fmtCnDate(playerDetail.airdate) }}</p>
                  <p><span class="text-white/35">{{ $t('detail.metaStatus') }}: </span>{{ $t('detail.totalEps', { n: playerDetail.episodesTotal || episodesList.length || "…" }) }}<template v-if="playerDetail.status"> · {{ playerDetail.status }}</template></p>
                  <p v-if="playerDetail.lang"><span class="text-white/35">{{ $t('detail.metaLang') }}: </span>{{ infoLangLabel(playerDetail.lang) }}</p>
                  <p v-if="playerDetail.region?.length"><span class="text-white/35">{{ $t('detail.metaRegion') }}: </span>{{ playerDetail.region.join(" · ") }}</p>
                </div>
                <!-- 简介（长文折叠除外，可展开/收起） -->
                <p
                  class="mt-3 whitespace-pre-line text-[11px] leading-relaxed text-white/75"
                  :class="!infoExpanded && 'line-clamp-4'"
                >{{ playerDetail.overview || $t('detail.noOverview') }}</p>
                <button
                  v-if="(playerDetail.overview || '').length > 72"
                  type="button"
                  @click="infoExpanded = !infoExpanded"
                  class="mt-1 text-[10px] font-medium text-primary hover:underline"
                >{{ infoExpanded ? $t('common.collapse') : $t('common.expand') }}</button>
                <!-- 分类 -->
                <div v-if="playerDetail.genres?.length" class="mt-3">
                  <p class="text-[10px] font-semibold text-white/40">{{ $t('detail.genres') }}</p>
                  <div class="mt-1.5 flex flex-wrap gap-1.5">
                    <span v-for="g in playerDetail.genres" :key="g" class="rounded-full border border-white/10 px-2 py-0.5 text-[10px] text-white/60">{{ g }}</span>
                  </div>
                </div>
                <!-- 需求：选集中的「线路」「弹幕源」分区移至简介下方；去除「查看完整详情」按键 -->
                <template v-if="!isLocal">
                  <!-- 线路分区：折叠行（当前线路）+ 展开列表（协议 m3u8/MP4 · 分辨率 · 延迟） -->
                  <div class="mt-3 border-t border-white/5 pt-2.5">
                    <button type="button" class="flex w-full items-center justify-between gap-2" @click="sideLineExpand = !sideLineExpand">
                      <p class="min-w-0 truncate text-xs font-bold text-white/90">
                        <template v-if="sources.length">{{ $t('player.lineSection', { n: effectiveIdx + 1, name: rawLineName(currentSource ?? sources[0]) }) }}</template>
                        <template v-else>{{ $t('player.lineSectionShort') }}</template>
                      </p>
                      <span class="flex flex-none items-center gap-0.5 text-[10px] tabular-nums text-white/35">
                        <template v-if="sources.length">{{ effectiveIdx + 1 }}/{{ sources.length }}</template>
                        <ChevronDown :class="cn('h-3.5 w-3.5 transition-transform', sideLineExpand && 'rotate-180')" />
                      </span>
                    </button>
                    <div v-if="sideLineExpand" class="mt-1.5">
                      <div class="space-y-0.5">
                        <button
                          v-for="(s, i) in sources"
                          :key="`sl${i}`"
                          type="button"
                          @click="switchSource(i, { user: true })"
                          :class="cn('aikf-panel-item aikf-line-row', i === effectiveIdx && 'aikf-panel-item-active')"
                        >
                          <span class="aikf-line-idx">{{ i + 1 }}</span>
                          <span class="aikf-line-texts">
                            <span class="aikf-line-title">
                              <span class="min-w-0 truncate">{{ rawLineName(s) }}</span>
                              <span v-if="isAdkwaiSource(s.url)" class="aikf-pick-tag" v-tip="$t('player.speedTestTitle')">{{ $t('cache.preferred') }}</span>
                              <span v-if="i === effectiveIdx" class="aikf-cur-tag">{{ $t('cache.current') }}</span>
                            </span>
                            <span class="aikf-line-host">{{ sourceName(s.url) }}</span>
                          </span>
                          <span class="aikf-line-meta">
                            <span class="aikf-chip aikf-chip-proto" v-tip="$t('player.protoTip', { p: sourceProtoLabel(s.url) })">{{ sourceProtoLabel(s.url) }}</span>
                            <span class="aikf-chip">{{ lineResOf(i) }}</span>
                            <span
                              v-if="sourceLatencies[i] !== undefined"
                              class="aikf-chip"
                              :class="sourceLatencies[i] !== null ? 'aikf-chip-ok' : 'aikf-chip-bad'"
                            >{{ sourceLatencies[i] !== null ? sourceLatencies[i] + 'ms' : $t('player.timeout') }}</span>
                            <span v-else class="aikf-chip aikf-chip-dim">{{ $t('player.untested') }}</span>
                          </span>
                        </button>
                        <div v-if="sources.length === 0" class="px-1 py-2 text-[10px] text-white/35">{{ $t('player.noLines') }}</div>
                      </div>
                    </div>
                  </div>

                  <!-- 弹幕源分区：N个弹幕源 · 共X条弹幕（点击行启用/停用） -->
                  <div class="mt-2.5 border-t border-white/5 pt-2.5">
                    <div class="flex items-center justify-between gap-2">
                      <p class="min-w-0 text-xs font-bold text-white/90">
                        {{ $t('player.dmSources', { n: danmakuAvailableCount }) }}<template v-if="danmakuTotalCount > 0"> · {{ $t('player.dmTotal', { n: danmakuTotalCount }) }}</template>
                      </p>
                      <button
                        type="button"
                        class="flex-none text-[10px] text-white/35 transition-colors hover:text-white/70"
                        v-tip="$t('player.refreshTitle')"
                        @click="refreshDanmaku"
                      >{{ $t('player.refresh') }}</button>
                    </div>
                    <div class="mt-1.5 space-y-0.5">
                      <button
                        v-for="s in danmakuSources"
                        :key="s.key"
                        type="button"
                        :disabled="s.loading || !s.available"
                        @click="toggleDanmakuSource(s.key)"
                        :class="cn(
                          'aikf-dm-row',
                          s.loaded && s.enabled && 'aikf-dm-row-on',
                          (!s.available || s.loading) && 'cursor-default opacity-60'
                        )"
                        v-tip="s.error || (s.loaded ? (s.enabled ? $t('player.dmDisableHint') : $t('player.dmEnableHint')) : (s.available ? $t('player.dmLoadHint') : ''))"
                      >
                        <MessageSquare :class="cn('h-3.5 w-3.5 flex-none', s.loaded && s.enabled ? 'text-primary' : 'text-white/35')" />
                        <span class="min-w-0 flex-1 text-left">
                          <span class="block truncate text-[11px] font-semibold text-white/85">
                            {{ s.name }}<template v-if="s.detail"> · {{ s.detail }}</template>
                          </span>
                          <span v-if="s.error" class="block truncate text-[9px] text-rose-300/80">{{ s.error }}</span>
                          <span v-else-if="!s.available" class="block text-[9px] text-white/30">{{ $t('player.dmUnavailable') }}</span>
                          <span v-else-if="s.loading" class="block text-[9px] text-white/40">{{ $t('player.dmLoading') }}</span>
                        </span>
                        <span class="flex flex-none items-center gap-1">
                          <Loader2 v-if="s.loading" class="h-3 w-3 animate-spin text-white/40" />
                          <span v-else-if="s.loaded" :class="cn('aikf-dm-count', s.enabled ? 'text-primary' : 'text-white/30')">
                            {{ s.enabled ? s.count.toLocaleString() : $t('player.dmDisabled') }}
                          </span>
                          <span v-else-if="s.available" class="aikf-dm-count text-white/40">{{ $t('player.dmLoad') }}</span>
                        </span>
                      </button>
                    </div>
                    <p v-if="!settings.data.danmaku.enabled" class="mt-2 rounded-lg bg-amber-500/10 px-2 py-1.5 text-[10px] leading-relaxed text-amber-500/90">
                      {{ $t('player.dmOffNotice') }}
                    </p>
                  </div>
                </template>
              </template>
            </div>

            <!-- ── 选集：占满整个面板的集数网格（需求：选集页面用整个面板显示集数）──
                 线路/弹幕源分区已移至简介 Tab 下方，选集 Tab 只保留集数网格 -->
            <div v-else-if="sideTab === 'ep'" class="p-3">
              <div class="flex items-center justify-between gap-2 pb-2">
                <p class="min-w-0 truncate text-xs font-bold text-white/90">
                  {{ $t('player.ctrlEpisodes') }}<template v-if="currentEpisodeTitle"> · {{ $t('common.epN', { n: episode }) }} {{ currentEpisodeTitle }}</template>
                </p>
                <span class="flex-none text-[10px] tabular-nums text-white/35">{{ $t('common.countEps', { n: epGridItems.length }) }}</span>
              </div>

              <div v-if="epGridItems.length > 0" class="grid grid-cols-2 gap-2">
                <button
                  v-for="ep in epGridItems"
                  :key="ep.key"
                  type="button"
                  class="aikf-epcard text-left"
                  v-tip="ep.title ? $t('common.epNT', { n: ep.sort, t: ep.title }) : $t('common.epN', { n: ep.sort })"
                  @click="clickEpItem(ep)"
                >
                  <span :class="cn('aikf-epcard-thumb', ep.playing && 'aikf-epcard-thumb-active', !ep.playable && 'opacity-55')">
                    <img
                      :src="ep.img"
                      :alt="$t('common.epN', { n: ep.sort })"
                      loading="lazy"
                      draggable="false"
                      class="aikf-epcard-img"
                      @error="onEpImgError"
                    />
                    <span v-if="ep.playing" class="aikf-epcard-playing">{{ $t('player.playing') }}</span>
                    <span :class="cn('aikf-epcard-badge', ep.badgeOk && 'aikf-epcard-badge-ok', ep.badgeBad && 'aikf-epcard-badge-bad')">{{ ep.badge }}</span>
                    <span v-if="ep.dur" class="aikf-epcard-dur">{{ ep.dur }}</span>
                  </span>
                  <span :class="cn('aikf-epcard-title', ep.playing && 'text-primary')">
                    {{ $t('common.epNT', { n: ep.sort, t: ep.title }) }}
                  </span>
                  <span v-if="ep.date" class="aikf-epcard-date">{{ ep.date }}</span>
                </button>
              </div>
              <div v-else class="flex flex-col items-center justify-center gap-2 py-10 text-white/40">
                <ListVideo class="h-8 w-8 opacity-40" />
                <p class="text-xs">{{ $t('player.noEpisodes') }}</p>
              </div>
            </div>

            <!-- ── 评论 ── -->
            <div v-else-if="sideTab === 'comments'" class="space-y-2.5 p-3">
              <div v-if="commentsLoading" class="space-y-2.5">
                <div v-for="i in 3" :key="i" class="h-16 rounded-lg bg-white/5" />
              </div>
              <div v-else-if="playerComments.length === 0" class="py-12 text-center text-xs text-white/40">{{ $t('detail.noComments') }}</div>
              <template v-else>
                <div v-for="c in playerComments.slice(0, 30)" :key="c.id" class="rounded-xl border border-white/5 bg-white/[0.03] p-2.5">
                  <div class="flex items-center gap-2">
                    <img v-if="c.user?.avatar" :src="c.user.avatar" alt="" class="h-6 w-6 rounded-full object-cover" draggable="false" />
                    <div v-else class="flex h-6 w-6 items-center justify-center rounded-full bg-primary/25 text-[10px] font-bold text-primary">{{ (c.user?.name || "?").charAt(0) }}</div>
                    <span class="min-w-0 flex-1 truncate text-[11px] font-semibold text-white/85">{{ c.user?.name || $t('detail.anonymous') }}</span>
                    <span class="shrink-0 text-[9px] text-white/30">{{ fmtCDate(c.date) }}</span>
                  </div>
                  <p class="mt-1.5 line-clamp-4 text-[11px] leading-relaxed text-white/65">{{ c.text }}</p>
                  <div class="mt-1.5 flex items-center gap-3 text-[9px] text-white/30">
                    <span v-if="c.likes_count">♥ {{ c.likes_count }}</span>
                    <span v-if="c.replies_count">{{ $t('detail.replies', { n: c.replies_count }) }}</span>
                    <span v-if="c.address">{{ c.address }}</span>
                  </div>
                </div>
              </template>
            </div>

            <!-- ── 角色 ── -->
            <div v-else class="p-3">
              <div v-if="charsLoading" class="grid grid-cols-3 gap-2.5">
                <div v-for="i in 6" :key="i" class="aspect-square rounded-lg bg-white/5" />
              </div>
              <div v-else-if="playerChars.length === 0" class="py-12 text-center text-xs text-white/40">{{ $t('detail.noCharacters') }}</div>
              <div v-else class="grid grid-cols-3 gap-2.5">
                <div v-for="c in playerChars" :key="c.id" class="min-w-0 text-center">
                  <div class="aspect-square w-full overflow-hidden rounded-lg bg-white/5">
                    <img :src="c.image" :alt="c.name" loading="lazy" class="h-full w-full object-cover object-top" @error="onEpImgError" />
                  </div>
                  <p class="mt-1 line-clamp-1 text-[10px] font-medium text-white/85">{{ c.name }}</p>
                  <p v-if="c.actors[0]" class="line-clamp-1 text-[9px] text-white/35">CV: {{ c.actors[0].name }}</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </Transition>
    </div>
  </Transition>

</template>

<style scoped>
.player-enter-active, .player-leave-active { transition: opacity 0.25s ease; }
.player-enter-from, .player-leave-to { opacity: 0; }
.sidepanel-enter-active, .sidepanel-leave-active { transition: opacity 0.22s ease, transform 0.22s ease; }
.sidepanel-enter-from, .sidepanel-leave-to { opacity: 0; transform: translateX(24px); }
</style>

<style>
/* ── ArtPlayer (stock) global style overrides ── */

/* Player fills container */
.art-video-player {
  width: 100% !important;
  height: 100% !important;
  background: #000;
  font-family: inherit;
}

/* Video fills player with object-contain */
.art-video-player .art-video {
  width: 100% !important;
  height: 100% !important;
  object-fit: contain;
}

/* Slightly slimmer control bar on the stock player */
.art-video-player .art-bottom {
  padding-left: 14px;
  padding-right: 14px;
}
.art-video-player .art-control {
  height: 42px;
}

/* ── 底栏自定义控件 ───────────────────────────────────────────────
   Stock ArtPlayer registers each control element with the class
   `art-control-<name>`（连字符形式）。 */
.art-video-player .art-control-aikf-episodes,
.art-video-player .art-control-aikf-line,
.art-video-player .art-control-aikf-settings,
.art-video-player .art-control-aikf-danmaku,
.art-video-player .art-control-aikf-mini {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 8px;
  width: auto !important;
  cursor: pointer;
}
.art-video-player .aikf-text-btn {
  font-size: 12px;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.88);
  line-height: 1;
  user-select: none;
}
.art-video-player .art-control-aikf-episodes:hover .aikf-text-btn {
  color: #fff;
}
.art-video-player .art-control-aikf-settings,
.art-video-player .art-control-aikf-mini {
  /* 需求：放大「设置」「小窗播放」两个按键 —— 加大点击区与内边距 */
  padding: 0 9px;
}
.art-video-player .aikf-gear-btn,
.art-video-player .aikf-mini-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 30px;
  width: 30px;
  border-radius: 8px;
  color: rgba(255, 255, 255, 0.85);
  transition: background 0.15s ease, color 0.15s ease, transform 0.3s ease;
}
.art-video-player .art-control-aikf-settings:hover .aikf-gear-btn {
  background: rgba(255, 255, 255, 0.14);
  color: #fff;
  transform: rotate(45deg);
}
.art-video-player .art-control-aikf-mini:hover .aikf-mini-btn {
  background: rgba(255, 255, 255, 0.14);
  color: #fff;
}
.art-video-player .aikf-line-badge {
  display: inline-flex;
  align-items: center;
  height: 22px;
  padding: 0 8px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.12);
  border: 1px solid rgba(255, 255, 255, 0.14);
  color: rgba(255, 255, 255, 0.92);
  font-size: 11px;
  line-height: 1;
  letter-spacing: 0.02em;
  white-space: nowrap;
  transition: background 0.15s ease, border-color 0.15s ease;
}
.art-video-player .art-control-aikf-line:hover .aikf-line-badge {
  background: rgba(255, 255, 255, 0.2);
  border-color: rgba(255, 255, 255, 0.26);
}

/* 弹幕设置按键（「弹」字方形徽标） */
.art-video-player .aikf-danmaku-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 22px;
  min-width: 22px;
  padding: 0 5px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.12);
  border: 1px solid rgba(255, 255, 255, 0.16);
  color: rgba(255, 255, 255, 0.92);
  font-size: 11px;
  font-weight: 700;
  line-height: 1;
  user-select: none;
}
.art-video-player .art-control-aikf-danmaku:hover .aikf-danmaku-btn {
  background: rgba(255, 255, 255, 0.2);
  border-color: rgba(255, 255, 255, 0.26);
  color: #fff;
}

/* 插件内建的弹幕设置面板会内嵌在底栏中部（与 AiKF 自有「弹幕设置」弹层重复），
   AiKF 通过底栏「弹」按键呼出自有设置面板，这里隐藏插件内建面板（弹幕渲染层 .art-danmuku 不受影响） */
.art-video-player .art-controls-center .artplayer-plugin-danmuku {
  display: none !important;
}

/* 弹幕不透明度：CSS 变量即时热应用（压过插件给每条弹幕写入的行内透明度）。
   优先级低于插件内建的「模式关闭 opacity:0」规则，模式关闭仍生效 */
.art-video-player .art-danmuku > * {
  opacity: var(--aikf-dm-opacity, 1) !important;
}

/* ── 顶栏 + 弹层宿主（Teleport 进 .art-video-player）──────
   随控制条显隐：ArtPlayer 隐藏控制条时移除根节点上的
   `art-control-show` 类，这里据此淡出整个宿主。 */
.aikf-overlay-host {
  position: absolute;
  inset: 0;
  z-index: 65;
  pointer-events: none;
  transition: opacity 0.2s ease;
}
.art-video-player:not(.art-control-show) .aikf-overlay-host {
  opacity: 0;
  pointer-events: none !important;
}

/* 顶栏：与画面融合的渐变浮层 */
.aikf-top {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  z-index: 2;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 14px 28px;
  background: linear-gradient(to bottom, rgba(0, 0, 0, 0.72), rgba(0, 0, 0, 0.32) 55%, transparent);
}
.aikf-top-left {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 10px;
}
.aikf-top-titles {
  min-width: 0;
}
.aikf-top-title {
  font-size: 13px;
  font-weight: 700;
  color: rgba(255, 255, 255, 0.96);
  line-height: 1.3;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.aikf-local-tag {
  margin-left: 6px;
  border-radius: 4px;
  background: color-mix(in oklab, var(--primary) 22%, transparent);
  color: var(--primary);
  padding: 1px 5px;
  font-size: 9px;
  font-weight: 700;
  vertical-align: 1px;
}
.aikf-top-sub {
  margin-top: 1px;
  font-size: 11px;
  color: rgba(255, 255, 255, 0.6);
  line-height: 1.3;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.aikf-top-right {
  display: flex;
  flex: none;
  align-items: center;
  gap: 2px;
}
.aikf-top-btn {
  display: flex;
  height: 28px;
  width: 28px;
  flex: none;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  color: rgba(255, 255, 255, 0.75);
  transition: background 0.15s ease, color 0.15s ease;
}
.aikf-top-btn:hover {
  background: rgba(255, 255, 255, 0.15);
  color: #fff;
}
.aikf-top-close:hover {
  background: #e11d48;
  color: #fff;
}

/* 顶栏内可点元素恢复事件（宿主本身 pointer-events: none） */
.aikf-top .aikf-top-btn,
.aikf-top .aikf-top-right {
  pointer-events: auto;
}

/* ── 右侧详情面板（简介 / 选集 / 评论 / 角色）────────────────────── */
.aikf-side {
  display: flex;
  width: 300px;
  min-width: 0;
  flex-shrink: 0;
  flex-direction: column;
  background: #0c0c0e;
  border-left: 1px solid rgba(255, 255, 255, 0.08);
}
@media (min-width: 1024px) {
  .aikf-side { width: 340px; }
}
.aikf-side-btn {
  display: flex;
  height: 28px;
  width: 28px;
  flex: none;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  color: rgba(255, 255, 255, 0.6);
  transition: background 0.15s ease, color 0.15s ease;
}
.aikf-side-btn:hover {
  background: rgba(255, 255, 255, 0.1);
  color: #fff;
}
.aikf-side-close:hover {
  background: #e11d48;
  color: #fff;
}
.aikf-side-tab {
  display: flex;
  align-items: center;
  gap: 3px;
  border-radius: 8px;
  /* 4 个 Tab（简介/选集/评论/角色）需在 300px 窄面板内与窗口控制键同排：
     收紧内边距，避免关闭键被挤出窗口（溢出修复） */
  padding: 4px 5px;
  font-size: 11px;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.5);
  transition: background 0.15s ease, color 0.15s ease;
  white-space: nowrap;
  flex: none;
}
.aikf-side-tab:hover {
  color: rgba(255, 255, 255, 0.85);
  background: rgba(255, 255, 255, 0.06);
}
.aikf-side-tab-active {
  color: var(--primary);
  background: color-mix(in oklab, var(--primary) 14%, transparent);
}
.aikf-side-tab-active:hover {
  color: var(--primary);
  background: color-mix(in oklab, var(--primary) 18%, transparent);
}

/* ── 线路 / 设置弹层 ── */
.aikf-panel {
  position: absolute;
  bottom: 52px;
  right: 12px;
  z-index: 3;
  display: flex;
  flex-direction: column;
  width: 250px;
  max-height: min(340px, 62%);
  overflow: hidden;
  border-radius: 12px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: rgba(14, 14, 17, 0.97);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.5);
  pointer-events: auto;
}
.aikf-panel-settings {
  width: 300px;
}
.aikf-panel-danmaku {
  width: 300px;
}
.aikf-panel-line {
  width: min(380px, calc(100% - 24px));
  max-height: min(420px, 70%);
}
.aikf-panel-title {
  flex: none;
  padding: 10px 12px 8px;
  font-size: 11px;
  font-weight: 700;
  color: rgba(255, 255, 255, 0.85);
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}
.aikf-panel-title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.aikf-retest {
  display: flex;
  align-items: center;
  gap: 4px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.07);
  padding: 3px 8px;
  font-size: 10px;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.65);
  transition: background 0.15s ease, color 0.15s ease;
}
.aikf-retest:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.14);
  color: #fff;
}
.aikf-panel-list {
  overflow-y: auto;
  padding: 6px;
}
.aikf-panel-item {
  display: flex;
  width: 100%;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 7px 9px;
  border-radius: 8px;
  font-size: 11px;
  text-align: left;
  color: rgba(255, 255, 255, 0.75);
  transition: background 0.12s ease, color 0.12s ease;
}
.aikf-panel-item:hover {
  background: rgba(255, 255, 255, 0.08);
  color: #fff;
}
.aikf-panel-item-active {
  background: color-mix(in oklab, var(--primary) 16%, transparent);
  color: var(--primary);
}

/* ── 线路节点行：标题 / 节点名 / 分辨率 / 延迟 ── */
.aikf-line-row {
  gap: 8px;
}
.aikf-line-idx {
  flex: none;
  display: inline-flex;
  min-width: 16px;
  height: 16px;
  align-items: center;
  justify-content: center;
  border-radius: 5px;
  background: rgba(255, 255, 255, 0.08);
  font-size: 9px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: rgba(255, 255, 255, 0.55);
}
.aikf-line-texts {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  gap: 1px;
}
.aikf-line-title {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 4px;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.88);
}
.aikf-panel-item-active .aikf-line-title {
  color: var(--primary);
}
.aikf-line-host {
  font-size: 9px;
  color: rgba(255, 255, 255, 0.32);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.aikf-line-meta {
  flex: none;
  display: flex;
  align-items: center;
  gap: 4px;
}
.aikf-chip {
  flex: none;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.08);
  padding: 2px 5px;
  font-size: 9px;
  font-weight: 600;
  line-height: 1.3;
  font-variant-numeric: tabular-nums;
  color: rgba(255, 255, 255, 0.6);
}
.aikf-chip-ok {
  background: rgba(16, 185, 129, 0.16);
  color: rgb(110, 231, 183);
}
.aikf-chip-bad {
  background: rgba(225, 29, 72, 0.16);
  color: rgb(253, 164, 175);
}
.aikf-chip-dim {
  background: rgba(255, 255, 255, 0.05);
  color: rgba(255, 255, 255, 0.28);
}
.aikf-pick-tag {
  flex: none;
  border-radius: 4px;
  background: rgba(16, 185, 129, 0.18);
  padding: 1px 4px;
  font-size: 9px;
  font-weight: 700;
  line-height: 1.3;
  color: rgb(110, 231, 183);
}
.aikf-cur-tag {
  flex: none;
  border-radius: 4px;
  background: color-mix(in oklab, var(--primary) 20%, transparent);
  padding: 1px 4px;
  font-size: 9px;
  font-weight: 700;
  line-height: 1.3;
  color: var(--primary);
}

/* ── 选集集数网格（面板选集 Tab + 旧式选集弹层共用，v3.4 双列缩略图卡片设计）── */
.aikf-epcard {
  display: block;
  min-width: 0;
}
.aikf-epcard-thumb {
  position: relative;
  display: block;
  width: 100%;
  aspect-ratio: 16 / 9;
  overflow: hidden;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.05);
  outline: 1px solid rgba(255, 255, 255, 0.1);
  outline-offset: -1px;
  transition: outline-color 0.15s ease;
}
.aikf-epcard-thumb-active {
  outline: 2px solid var(--primary);
}
.aikf-epcard-img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
  transition: filter 0.18s ease;
}
/* hover：只让图片有轻微亮度变化（需求：不要大幅动画） */
.aikf-epcard:hover .aikf-epcard-img {
  filter: brightness(1.12);
}
.aikf-epcard-playing {
  pointer-events: none;
  position: absolute;
  left: 4px;
  top: 4px;
  border-radius: 4px;
  background: color-mix(in oklab, var(--primary) 88%, transparent);
  padding: 1px 5px;
  font-size: 9px;
  font-weight: 700;
  line-height: 1.4;
  color: #fff;
}
.aikf-epcard-badge {
  pointer-events: none;
  position: absolute;
  left: 4px;
  bottom: 4px;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.65);
  padding: 1px 5px;
  font-size: 9px;
  font-weight: 700;
  line-height: 1.4;
  color: rgba(255, 255, 255, 0.88);
}
.aikf-epcard-badge-ok {
  background: rgba(16, 185, 129, 0.88);
  color: #fff;
}
/* 无资源集数角标（需求：无资源番剧要在选集页明确标出） */
.aikf-epcard-badge-bad {
  background: rgba(239, 68, 68, 0.85);
  color: #fff;
}
.aikf-epcard-dur {
  pointer-events: none;
  position: absolute;
  right: 4px;
  bottom: 4px;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.65);
  padding: 1px 4px;
  font-family: ui-monospace, monospace;
  font-size: 9px;
  font-variant-numeric: tabular-nums;
  color: rgba(255, 255, 255, 0.82);
}
.aikf-epcard-title {
  display: -webkit-box;
  -webkit-line-clamp: 1;
  -webkit-box-orient: vertical;
  overflow: hidden;
  margin-top: 5px;
  font-size: 10px;
  font-weight: 600;
  line-height: 1.35;
  color: rgba(255, 255, 255, 0.9);
}
.aikf-epcard-date {
  display: block;
  margin-top: 1px;
  font-size: 9px;
  color: rgba(255, 255, 255, 0.32);
}

/* 弹层透明遮罩（选集/线路/设置/弹幕四处通用）：仅捕获弹层以外的点击用于关闭，
   无视觉变化；配合模板上的 @click.stop 拦截冒泡 —— 点击遮罩不会穿透到视频
   触发暂停/播放；弹层放回 overlay-host 内（与未改版前一致） */
.aikf-ep-shield,
.aikf-pop-shield {
  position: absolute;
  inset: 0;
  z-index: 4;
  pointer-events: auto; /* overlay-host 本身是 none，遮罩需显式开启接收弹层外点击 */
}
/* 旧式选集弹层（面板收起时从底栏弹出） */
.aikf-panel-ep {
  width: min(360px, calc(100% - 24px));
  max-height: min(480px, 78%);
}

/* ── 弹幕源分区（参考图 2：源名 · 标识 ｜ 条数）── */
.aikf-dm-row {
  display: flex;
  width: 100%;
  align-items: center;
  gap: 7px;
  border-radius: 8px;
  padding: 6px 7px;
  transition: background 0.12s ease;
}
.aikf-dm-row:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.06);
}
.aikf-dm-row-on {
  background: color-mix(in oklab, var(--primary) 8%, transparent);
}
.aikf-dm-row-on:hover:not(:disabled) {
  background: color-mix(in oklab, var(--primary) 12%, transparent);
}
.aikf-dm-count {
  font-size: 10px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

/* ── 线路协议 chip（m3u8 / MP4）── */
.aikf-chip-proto {
  background: rgba(96, 165, 250, 0.14);
  color: rgb(147, 197, 253);
}

/* ── 设置弹层：常见设置 / 视频缓冲设置 ── */
.aikf-set-tabs {
  flex: none;
  display: flex;
  gap: 4px;
  padding: 8px 10px 0;
}
.aikf-set-tab {
  flex: 1;
  border-radius: 8px 8px 0 0;
  padding: 7px 0 8px;
  font-size: 11px;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.5);
  border-bottom: 2px solid transparent;
  transition: color 0.15s ease, border-color 0.15s ease;
}
.aikf-set-tab:hover {
  color: rgba(255, 255, 255, 0.8);
}
.aikf-set-tab-active {
  color: var(--primary);
  border-bottom-color: var(--primary);
}
.aikf-set-body {
  overflow-y: auto;
  padding: 10px 12px 12px;
}
.aikf-set-row {
  padding: 6px 0;
}
.aikf-set-row + .aikf-set-row {
  border-top: 1px solid rgba(255, 255, 255, 0.06);
}
.aikf-set-row-flex {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.aikf-set-label {
  margin-bottom: 6px;
  font-size: 11px;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.82);
}
.aikf-set-row-flex .aikf-set-label {
  margin-bottom: 0;
}
.aikf-seg {
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: 1fr;
  gap: 3px;
}
.aikf-seg-btn {
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.07);
  padding: 4px 0;
  font-size: 10px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: rgba(255, 255, 255, 0.6);
  transition: background 0.12s ease, color 0.12s ease;
}
.aikf-seg-btn:hover {
  background: rgba(255, 255, 255, 0.14);
  color: #fff;
}
.aikf-seg-on {
  background: color-mix(in oklab, var(--primary) 22%, transparent);
  color: var(--primary);
}
.aikf-set-hint {
  margin-top: 5px;
  font-size: 9px;
  line-height: 1.5;
  color: rgba(255, 255, 255, 0.32);
}

/* ── Slim mini progress bar shown when controls are hidden ── */
.art-video-player .art-mini-progress-bar {
  border-radius: 0 !important;
}

/* ── Thumbnail tooltip on progress hover ── */
.art-video-player .art-progress-tip {
  border-radius: 8px !important;
  overflow: hidden !important;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4) !important;
}

/* 面板开合按键：视频右缘垂直居中（需求：参考截图红圈位置） */
.aikf-edge-toggle {
  position: absolute;
  right: 0;
  top: 50%;
  transform: translateY(-50%);
  z-index: 80;
  display: flex;
  height: 56px;
  width: 22px;
  align-items: center;
  justify-content: center;
  border-radius: 10px 0 0 10px;
  background: rgba(0, 0, 0, 0.45);
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-right: none;
  color: rgba(255, 255, 255, 0.85);
  transition: background 0.15s ease, color 0.15s ease, width 0.15s ease, opacity 0.2s ease;
}
.aikf-edge-toggle:hover {
  width: 26px;
  background: color-mix(in oklab, var(--primary) 85%, transparent);
  color: #fff;
}

/* 锁定键/面板开合键随控制栏显隐（需求：底部控制栏隐藏时同步隐藏）。
   显隐状态由 art "control" 事件驱动（artControlsVisible） */
.aikf-float-hidden {
  opacity: 0 !important;
  pointer-events: none !important;
}

/* ── 播放锁定（画面左侧中间；锁定时只显示 解锁/返回/标题）── */
/* 锁定时结构性隐藏 ArtPlayer 全部交互层（底栏/中心遮罩/内建锁层），
   不依赖 art-control-show/art-hover 类的时序 */
.aikf-locked .art-video-player .art-bottom,
.aikf-locked .art-video-player .art-mask,
.aikf-locked .art-video-player .art-layer-lock {
  display: none !important;
  pointer-events: none !important;
}
/* 锁定时正常显示鼠标指针（需求修正：锁定仅锁操作，不隐藏鼠标） */
.aikf-lock-btn {
  position: absolute;
  left: 10px;
  top: 50%;
  transform: translateY(-50%);
  z-index: 80;
  display: flex;
  height: 34px;
  width: 34px;
  align-items: center;
  justify-content: center;
  border-radius: 9999px;
  background: rgba(0, 0, 0, 0.45);
  border: 1px solid rgba(255, 255, 255, 0.16);
  color: rgba(255, 255, 255, 0.85);
  opacity: 0.55;
  transition: background 0.15s ease, color 0.15s ease, opacity 0.2s ease;
}
.aikf-lock-btn:hover {
  opacity: 1;
  background: rgba(0, 0, 0, 0.62);
  color: #fff;
}
.aikf-lock-shield {
  position: absolute;
  inset: 0;
  z-index: 75;
  background: transparent;
}
.aikf-lock-top {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  z-index: 78;
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 14px 28px;
  background: linear-gradient(to bottom, rgba(0, 0, 0, 0.72), rgba(0, 0, 0, 0.32) 55%, transparent);
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.2s ease;
}
.aikf-lock-top-show {
  opacity: 1;
}
.aikf-lock-top .aikf-top-btn {
  pointer-events: auto;
}
.aikf-lock-unlock {
  opacity: 0;
  pointer-events: none;
}
.aikf-lock-unlock.aikf-lock-visible {
  opacity: 1;
  pointer-events: auto;
}
</style>

