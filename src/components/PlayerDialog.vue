<script setup lang="ts">
import { ref, computed, watch, onBeforeUnmount, onMounted, nextTick } from "vue";
import Artplayer from "artplayer";
import artplayerPluginAutoThumbnail from "artplayer-plugin-auto-thumbnail";
import artplayerPluginDanmuku from "artplayer-plugin-danmuku";
import { X, ListVideo, ChevronLeft, ChevronRight, ChevronDown, AlertCircle, Link as LinkIcon, Zap, Loader2, Home, Maximize } from "lucide-vue-next";
import { anich } from "@/lib/anich/api-client";
import type { DanmakuItem } from "@/lib/anich/types";
import { useUIStore } from "@/stores/ui";
import { useLibraryStore } from "@/stores/library";
import { useSettingsStore } from "@/stores/settings";
import { useAsync } from "@/composables/useAsync";
import { cn } from "@/lib/utils";
import { Minus, Square } from "lucide-vue-next";
import { invoke } from "@tauri-apps/api/core";

// ─── Logging ──────────────────────────────────────────────────────────────
const LOG_PREFIX = "%c[AiKF Player]";
const LOG_STYLE = "color:#e879f9;font-weight:bold";
function log(...args: unknown[]) { console.log(LOG_PREFIX, LOG_STYLE, ...args); }
function logError(...args: unknown[]) { console.error(LOG_PREFIX, LOG_STYLE, ...args); }

const ui = useUIStore();
const library = useLibraryStore();
const settings = useSettingsStore();

const open = computed(() => ui.player.open);
const bangumiID = computed(() => ui.player.bangumiID);
const episode = computed(() => ui.player.episode);

const sourceIdx = ref(-1);
const videoError = ref<string | null>(null);
const logLines = ref<string[]>([]);
let art: Artplayer | null = null;
const triedSources = new Set<number>();

function pushLog(msg: string) {
  const ts = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  const line = `[${ts}] ${msg}`;
  logLines.value.push(line);
  if (logLines.value.length > 200) logLines.value.shift();
  log(msg);
}

pushLog("PlayerDialog (ArtPlayer) mounted");

// ─── Tauri window controls (for the title bar) ─────────────────────
const isTauri = typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
const winMinimize = async () => { if (isTauri) try { await invoke("plugin:window|minimize"); } catch {} };
const winToggleMax = async () => { if (isTauri) try { await invoke("plugin:window|toggle_maximize"); } catch {} };

// ─── Source classification ────────────────────────────────────────────────
function isDirectMedia(url: string) {
  return /\.(mp4|webm|ogg|mov|m4v|mkv)(\?|#|$)/i.test(url);
}
function isHlsMedia(url: string) {
  return /\.m3u8(\?|#|$)/i.test(url) || url.includes("/m3u8/") || url.includes("/parse/m3u8");
}
function sourceName(url: string): string {
  try {
    const host = new URL(url).hostname;
    const map: Record<string, string> = {
      "v1.adkwai.com": "快手", "vo-cdn.emmmm.eu.org": "Anich直连", "v-cdn.emmmm.eu.org": "Anich CDN",
      "app.emmmm.eu.org.cdn.cloudflare.net": "Anich代理", "vod-cdn.sends.eu.org.cdn.cloudflare.net": "Sends CDN",
      "m3u8132.yhdmm3u8.top": "樱花M3U8", "m3u8.cyz.app": "CYZ", "yun.92cj.com": "92影视",
      "xgct-video.vzcdn.net": "西瓜视频", "aigua.emmmm.eu.org": "艾瓜", "dc.xhscdn.com": "小红书",
      "lf3-static.bytednsdoc.com": "字节CDN",
    };
    return map[host] || host.replace(/^www\./, "").split(".")[0];
  } catch { return "未知源"; }
}
function sourceLabel(s: { url: string; caption: string }): string {
  const name = sourceName(s.url);
  const cap = s.caption || "";
  const q = cap.match(/(\d{3,4}P|2K|4K|高清|全高清)/i)?.[1] || "";
  const parts = [name];
  if (q) parts.push(q);
  return parts.join(" · ");
}
function classifySource(url: string): string {
  if (isDirectMedia(url)) return "direct";
  if (isHlsMedia(url)) return "hls";
  return "unknown";
}
function pickPreferred(sources: { url: string }[]): number {
  if (!sources.length) return 0;
  const pref = settings.data.defaultSource;
  if (pref === "adkwai") { const ks = sources.findIndex((s) => s.url.includes("adkwai.com")); if (ks >= 0) return ks; }
  else if (pref === "anich") { const an = sources.findIndex((s) => s.url.includes("emmmm.eu.org")); if (an >= 0) return an; }
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
  const valid = results.filter((r) => r.ms !== null).sort((a, b) => (a.ms! - b.ms!));
  if (valid.length === 0) return pickPreferred(srcs);
  return valid[0].idx;
}

const openRef = computed(() => open.value && bangumiID.value != null);
const epKey = computed(() => `${bangumiID.value}-${episode.value}`);

watch(epKey, (nk, ok) => {
  pushLog(`Episode changed: ${ok} → ${nk}; resetting state`);
  sourceIdx.value = -1;
  videoError.value = null;
  triedSources.clear();
});

const { data: vodData, isLoading: vodLoading, isError: vodIsError, refetch: vodRefetch } = useAsync(
  () => anich.vod(bangumiID.value!, episode.value),
  { enabled: openRef, source: epKey }
);
const { data: episodes } = useAsync(() => anich.episodes(bangumiID.value!), { enabled: openRef, source: () => "eps" });

const sources = computed(() => vodData.value?.sources ?? []);

const autoPickedFor = ref<string | null>(null);
watch(
  () => [sources.value.length, epKey.value] as const,
  ([count, ek]) => {
    if (count > 0 && autoPickedFor.value !== ek) {
      autoPickedFor.value = ek;
      sourceIdx.value = pickPreferred(sources.value);
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
const mediaUrl = computed(() => currentSource.value?.url);

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

function destroyArt() {
  if (art) { pushLog("destroying ArtPlayer"); art.destroy(false); art = null; }
}

function createArt(container: HTMLElement, url: string) {
  pushLog(`Creating ArtPlayer: url=${url.slice(0, 80)}…`);
  destroyArt();
  const kind = classifySource(url);
  const isHls = kind === "hls";

  const hlsConfig: Record<string, unknown> = {
    enableWorker: true, lowLatencyMode: false, autoStartLoad: true, startLevel: -1,
    maxBufferLength: settings.data.bufferSize,
    maxMaxBufferLength: Math.max(600, settings.data.bufferSize * 6),
    backBufferLength: 0, maxBufferSize: 200 * 1000 * 1000, maxBufferHole: 0.5,
    nudgeMaxRetry: 10, nudgeOffset: 0.2, abrEwmaDefaultEstimate: 2e6,
    abrBandWidthFactor: 0.9, abrBandWidthUpFactor: 0.7,
    manifestLoadingMaxRetry: 4, manifestLoadingRetryDelay: 1000,
    levelLoadingMaxRetry: 4, levelLoadingRetryDelay: 1000,
    fragLoadingMaxRetry: 6, fragLoadingRetryDelay: 1000, startFragPrefetch: true,
    xhrSetup: (xhr: XMLHttpRequest) => { xhr.withCredentials = false; },
  };

  try {
    // ── Minimal custom controls ──
    // We disable ALL of ArtPlayer's built-in control buttons and only add
    // the ones we actually need, in a clean order. This avoids the clutter
    // (multiple volume buttons, screenshot, flip, fast-forward, etc.) that
    // was overwhelming the control bar.
    //
    // Layout (left → right):
    //   [Play/Pause] [Volume]    [progress bar fills middle]    [Time]
    //   [Next Ep] [PiP] [Fullscreen] [Settings]
    const controls: any[] = [
      // ── Left side: play/pause + volume ──
      {
        position: "left",
        html: '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
        tooltip: "播放/暂停",
        click: function () { art?.toggle(); },
      },
      {
        position: "left",
        html: '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>',
        tooltip: "音量",
        click: function () { (art as any)?.toggleMute?.(); },
      },
      // ── Right side: next episode + danmaku toggle + PiP + fullscreen + settings ──
      {
        position: "right",
        html: '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 4 15 12 5 20 5 4"/><line x1="19" y1="5" x2="19" y2="19"/></svg>',
        tooltip: "下一话",
        click: function () {
          const next = episodesList.value.find((e) => e.sort === episode.value + 1);
          if (next) switchEpisode(next.sort, next.title);
        },
      },
      // Danmaku (弹幕) toggle — switches danmaku visibility on/off
      {
        position: "right",
        html: '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>',
        tooltip: "弹幕",
        style: { opacity: 1 },
        click: function () {
          danmakuEnabled.value = !danmakuEnabled.value;
          if (art && (art as any).danmuku) {
            if (danmakuEnabled.value) {
              (art as any).danmuku.show();
              pushLog("Danmaku enabled");
            } else {
              (art as any).danmuku.hide();
              pushLog("Danmaku disabled");
            }
          }
        },
      },
      {
        position: "right",
        html: '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="14" rx="2"/><path d="M7 21h10"/></svg>',
        tooltip: "网页全屏",
        click: function () { (art as any)?.fullscreenWeb?.toggle?.(); },
      },
      {
        position: "right",
        html: '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/></svg>',
        tooltip: "全屏",
        click: function () { (art as any)?.fullscreen?.toggle?.(); },
      },
      {
        position: "right",
        html: '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
        tooltip: "设置",
        click: function () { (art as any)?.setting?.show?.(); },
      },
    ];

    // Settings panel — playback rate only
    const settings: any[] = [
      {
        html: "播放速度",
        icon: '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
        selector: [
          { html: "0.5x", value: 0.5 },
          { html: "0.75x", value: 0.75 },
          { html: "1x (默认)", value: 1, default: true },
          { html: "1.25x", value: 1.25 },
          { html: "1.5x", value: 1.5 },
          { html: "2x", value: 2 },
        ],
        onSelect: function (item: { html: string; value: number }) {
          if (art) art.playbackRate = item.value;
          return item.html;
        },
      },
    ];

    const options: any = {
      container: container,
      url: url,
      type: isHls ? "m3u8" : "",
      customType: isHls ? {
        m3u8: function (video: HTMLVideoElement, src: string) {
          import("hls.js").then((mod) => {
            const Hls = mod.default;
            if (Hls.isSupported()) {
              const h = new Hls(hlsConfig);
              h.on(Hls.Events.ERROR, (_e, data) => {
                if (data.fatal) {
                  pushLog(`HLS fatal: ${data.details || data.type}`);
                  if (data.type === Hls.ErrorTypes.NETWORK_ERROR) h.startLoad();
                  else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) h.recoverMediaError();
                  else {
                    videoError.value = `播放失败：${data.details || data.type}`;
                    tryAutoAdvance(effectiveIdx.value);
                  }
                }
              });
              h.loadSource(src);
              h.attachMedia(video);
            } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
              video.src = src;
            }
          });
        },
      } : {},
      autoplay: !savedVideoState,
      autoSize: false,
      autoMini: false,
      // ── Disable ALL ArtPlayer built-in buttons to avoid clutter ──
      // We add our own controls via the `controls` array below.
      screenshot: false,    // remove screenshot button (clutter)
      setting: false,       // we add our own settings button
      loop: false,
      flip: false,          // remove flip
      playbackRate: false,  // we add our own in settings
      aspectRatio: false,   // not needed for anime
      fullscreen: false,    // we add our own fullscreen button
      fullscreenWeb: false, // we add our own web-fullscreen button
      pip: false,           // we use our own custom PiP (more reliable)
      airplay: false,
      fastForward: false,   // remove fast-forward (we have +/- 10s in hotkeys)
      hotkey: true,          // keep keyboard shortcuts (space, arrows, etc.)
      theme: "#fb7185",
      volume: 1,
      lang: "zh-cn",
      title: "",
      controls: controls,
      settings: settings,
      // ── Plugins ──
      plugins: [
        // Auto-generate video thumbnails for progress bar hover preview
        artplayerPluginAutoThumbnail({
          width: 160,
          number: 80,
          scale: 1,
        }),
        // Danmaku (弹幕) plugin — displays scrolling comments over the video.
        // Danmaku data is loaded asynchronously via anich.danmaku() and
        // pushed to the plugin via art.danmuku.load().
        artplayerPluginDanmuku({
          danmuku: [],  // initial empty — loaded async in watch(epKey)
          speed: 5,        // pixels per second
          opacity: 1,      // 0-1
          fontSize: 16,    // base font size (px)
          color: "#ffffff",
          mode: 0,         // 0=scroll, 1=top, 2=bottom
          antiOverlap: true,
          fontFamily: "inherit",
          disable: false,   // controlled via toggle button
        } as any),
      ],
    };

    art = new Artplayer(options);

    // ── Event registration (after construction) ──
    art.on("ready", () => {
      pushLog("ArtPlayer ready");
      if (savedVideoState) { restoreVideoState(); }
      else if (bangumiID.value) {
        const progress = library.getPlaybackProgress(bangumiID.value, episode.value);
        if (progress && progress.time > 5 && progress.time < progress.duration - 10) {
          pushLog(`Restoring playback progress: ${Math.round(progress.time)}s`);
          try { art!.currentTime = progress.time; } catch (e) { pushLog(`seek failed: ${e}`); }
        }
      }
      // Push any already-loaded danmaku to the plugin (race condition: the
      // watch(epKey) above may have fired and loaded danmaku before ArtPlayer
      // was ready, so we check and push here).
      if (danmakuEnabled.value && danmakuList.value.length > 0 && (art as any).danmuku) {
        pushLog(`Pushing ${danmakuList.value.length} pre-loaded danmaku to ArtPlayer`);
        (art as any).danmuku.load(toArtDanmaku(danmakuList.value));
      }
    });

    art.on("video:play", () => {
      if (bangumiID.value) library.markEpisode(bangumiID.value, episode.value);
    });

    art.on("video:error", () => {
      pushLog("video error event");
      tryAutoAdvance(effectiveIdx.value);
    });

    // ── Auto-play next episode when current one ends ──
    art.on("video:ended", () => {
      pushLog("video ended — auto-playing next episode");
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
    pushLog(`Error details: ${err instanceof Error ? err.message : String(err)}`);
    videoError.value = `播放器初始化失败: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// Re-create ArtPlayer when source URL or container changes
watch(
  () => [artContainerRef.value, mediaUrl.value, open.value, sources.value.length, effectiveIdx.value] as const,
  ([container, url, isOpen, srcCount, idx]) => {
    pushLog(`watch: open=${isOpen}, container=${container ? "ready" : "null"}, url=${url ? url.slice(0, 50) + "…" : "none"}, sources=${srcCount}, idx=${idx}`);
    if (!isOpen) return;
    if (srcCount === 0) return;
    if (!url) return;
    if (!container) { pushLog("container not mounted — retry next tick"); return; }
    triedSources.add(idx);
    videoError.value = null;
    createArt(container as HTMLElement, url);
  },
  { flush: "post", immediate: true }
);

function tryAutoAdvance(currentIdx: number) {
  const next = sources.value.findIndex((_, i) => !triedSources.has(i));
  pushLog(`auto-advance: current=${currentIdx}, next=${next}`);
  if (next >= 0 && next !== currentIdx) sourceIdx.value = next;
  else videoError.value = "所有播放源均无法播放，请稍后重试或更换剧集";
}

onBeforeUnmount(() => { destroyArt(); });

const switchEpisode = (sort: number, title: string) => {
  pushLog(`switchEpisode: ${sort} - ${title}`);
  ui.setPlayerEpisode(sort, title);
};

const showLog = ref(false);
const toggleLog = () => { showLog.value = !showLog.value; pushLog(`log panel ${showLog.value ? "opened" : "closed"}`); };
const sidebarCollapsed = ref(false);
const sourcesExpanded = ref(false);

// ── Danmaku (弹幕) state ──
const danmakuEnabled = ref(true);  // ON by default
const danmakuLoading = ref(false);
const danmakuList = ref<DanmakuItem[]>([]);
// Danmaku input (for posting — requires token, disabled for now)
// const danmakuInput = ref("");
// const danmakuInputType = ref(0);  // 0=scroll, 1=top, 2=bottom
// const danmakuInputColor = ref("#ffffff");

/** Convert API DanmakuItem[] → ArtPlayer danmuku plugin format. */
function toArtDanmaku(items: DanmakuItem[]): any[] {
  return items.map((item) => ({
    text: item.text,
    time: item.time,
    mode: item.type === 1 ? "top" : item.type === 2 ? "bottom" : "scroll",
    color: item.color || "#ffffff",
    border: false,
  }));
}

// Load danmaku when episode changes (debounced — don't block video playback).
watch(epKey, async (newKey, oldKey) => {
  if (newKey === oldKey || !bangumiID.value || !episode.value) return;
  if (!danmakuEnabled.value) return;
  danmakuLoading.value = true;
  try {
    pushLog(`Loading danmaku for ${newKey}…`);
    const list = await anich.danmaku(bangumiID.value, episode.value);
    danmakuList.value = list;
    pushLog(`Danmaku loaded: ${list.length} items`);
    // If ArtPlayer already exists, update its danmaku
    if (art && (art as any).danmuku) {
      (art as any).danmuku.load(toArtDanmaku(list));
      pushLog("Danmaku pushed to ArtPlayer");
    }
  } catch (e: any) {
    pushLog(`Danmaku load failed: ${e?.message || e}`);
    danmakuList.value = [];
  } finally {
    danmakuLoading.value = false;
  }
}, { immediate: true });

// ── PiP mode (custom, not ArtPlayer's built-in) ──
const pipMode = ref(false);
const pipPos = ref({ x: typeof window !== "undefined" ? window.innerWidth - 380 : 0, y: typeof window !== "undefined" ? window.innerHeight - 220 : 0 });
let pipDragging = false;
let pipDragStart = { x: 0, y: 0 };
const pipWidth = computed(() => Math.min(360, Math.max(240, Math.floor((typeof window !== "undefined" ? window.innerWidth : 1280) * 0.3))));
const pipHeight = computed(() => Math.floor(pipWidth.value * 9 / 16));

const enterPip = () => {
  if (art) saveVideoState();
  pipMode.value = true;
  ui.openDetail(bangumiID.value!, ui.player.cover);
};
const exitPip = () => {
  if (art) saveVideoState();
  pipMode.value = false;
  ui.setView("detail");
};
const closeFromPip = () => { pipMode.value = false; ui.closePlayer(); };
const closeOrPip = () => { if (pipMode.value) closeFromPip(); else enterPip(); };

// ── Return to home from PiP ──
const goHomeFromPip = () => {
  pipMode.value = false;
  ui.setView("discover");
};

// ── Header visibility ──
// Title bar is ALWAYS visible so the user can always see the title + close
// button + window controls. No hover-based hide behavior anymore.
const headerVisible = computed(() => true);

const onPipMouseDown = (e: MouseEvent) => {
  if ((e.target as HTMLElement).closest("button")) return;
  pipDragging = true;
  pipDragStart = { x: e.clientX - pipPos.value.x, y: e.clientY - pipPos.value.y };
  e.preventDefault();
};
const onPipMouseMove = (e: MouseEvent) => {
  if (!pipDragging) return;
  pipPos.value = {
    x: Math.max(0, Math.min(window.innerWidth - pipWidth.value, e.clientX - pipDragStart.x)),
    y: Math.max(0, Math.min(window.innerHeight - pipHeight.value, e.clientY - pipDragStart.y)),
  };
};
const onPipMouseUp = () => { pipDragging = false; };

onMounted(() => {
  window.addEventListener("mousemove", onPipMouseMove);
  window.addEventListener("mouseup", onPipMouseUp);
});
onBeforeUnmount(() => {
  window.removeEventListener("mousemove", onPipMouseMove);
  window.removeEventListener("mouseup", onPipMouseUp);
});

const retestLatency = async () => {
  if (latencyTesting.value || sources.value.length === 0) return;
  await pickFastestSource(sources.value, epKey.value);
  pushLog("测速完成，用户手动选择源");
};
</script>

<template>
  <Transition name="player">
    <div v-if="open && bangumiID != null && !pipMode" class="fixed inset-0 z-[100] flex flex-col bg-black">
      <!-- ═══ Title bar (always visible, integrated with the dark player background) ═══ -->
      <!-- A real fixed-height bar (h-10) so it occupies layout space, not floating.
           Video area starts below it. Drag region covers the empty center area. -->
      <div
        v-if="headerVisible"
        data-tauri-drag-region
        class="relative z-40 flex h-10 shrink-0 items-center justify-between gap-3 bg-black px-2 sm:px-3"
      >
        <!-- Left: logo + title + episode -->
        <div class="flex min-w-0 items-center gap-2.5" data-tauri-drag-region>
          <img src="/aikf-logo-128.png" alt="AiKF" class="h-5 w-5 shrink-0 rounded-md" draggable="false" data-tauri-drag-region />
          <span data-tauri-drag-region class="text-xs font-bold tracking-tight text-white/90">AiKF</span>
          <span class="text-white/20">·</span>
          <div class="flex min-w-0 items-baseline gap-2" data-tauri-drag-region>
            <p class="line-clamp-1 text-sm font-bold text-white" :title="ui.player.title">{{ ui.player.title }}</p>
            <span class="text-white/30">·</span>
            <p class="shrink-0 text-xs text-white/70">第 {{ episode }} 话</p>
          </div>
        </div>

        <!-- Right: action buttons + window controls in one row -->
        <div class="flex shrink-0 items-center gap-1">
          <button
            type="button"
            @click="toggleLog"
            :class="cn('flex h-7 items-center rounded-md px-2 text-xs font-medium transition-colors', showLog ? 'bg-tertiary/30 text-tertiary-foreground' : 'text-white/70 hover:bg-white/15 hover:text-white')"
          >
            日志
          </button>
          <button
            type="button"
            @click="enterPip"
            class="hidden h-7 items-center rounded-md px-2 text-xs font-medium text-white/70 transition-colors hover:bg-white/15 hover:text-white sm:flex"
            title="画中画"
          >
            画中画
          </button>
          <!-- Window controls (min/max/close) -->
          <button
            v-if="isTauri"
            type="button"
            @click="winMinimize"
            aria-label="最小化窗口"
            class="flex h-8 w-9 items-center justify-center rounded-md text-white/70 transition-colors hover:bg-white/15 hover:text-white"
          >
            <Minus class="h-4 w-4" />
          </button>
          <button
            v-if="isTauri"
            type="button"
            @click="winToggleMax"
            aria-label="最大化/还原"
            class="flex h-8 w-9 items-center justify-center rounded-md text-white/70 transition-colors hover:bg-white/15 hover:text-white"
          >
            <Square class="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            @click="closeOrPip"
            aria-label="关闭"
            class="flex h-8 w-9 items-center justify-center rounded-md text-white/70 transition-colors hover:bg-destructive hover:text-white"
          >
            <X class="h-4 w-4" />
          </button>
        </div>
      </div>

      <!-- Body — video + sidebar (below the title bar) -->
      <div class="flex min-h-0 flex-1 gap-0 md:flex-row">
        <!-- Video area -->
        <div class="relative min-h-0 min-w-0 flex-1 bg-black">
          <!-- Loading / error / empty states -->
          <div v-if="vodLoading" class="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 text-white/70">
            <Loader2 class="h-10 w-10 animate-spin text-primary" />
            <p class="text-sm">正在加载播放源…</p>
          </div>
          <div v-else-if="vodIsError" class="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 px-6 text-center text-white/70">
            <AlertCircle class="h-10 w-10 text-destructive" />
            <p class="text-sm">播放源加载失败</p>
            <button @click="vodRefetch()" class="rounded-full bg-white/10 px-4 py-1.5 text-xs text-white hover:bg-white/20">重试</button>
          </div>
          <div v-else-if="sources.length === 0" class="absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 text-white/60">
            <AlertCircle class="h-10 w-10" />
            <p class="text-sm">暂无可用的播放源</p>
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
        </div>

        <!-- Side panel (collapsible) — native elements for max perf -->
        <div class="relative flex shrink-0 items-stretch">
          <button
            type="button"
            @click="sidebarCollapsed = !sidebarCollapsed"
            :aria-label="sidebarCollapsed ? '展开侧栏' : '收起侧栏'"
            class="state-layer hidden w-6 shrink-0 items-center justify-center border-l border-white/5 bg-black/40 text-white/50 transition-colors hover:bg-white/5 hover:text-white md:flex"
          >
            <ChevronRight v-if="sidebarCollapsed" class="h-4 w-4" />
            <ChevronLeft v-else class="h-4 w-4" />
          </button>
          <Transition name="sidebar">
            <div v-show="!sidebarCollapsed" class="flex min-h-0 w-full flex-col bg-black/70 backdrop-blur-xl md:w-80 lg:w-96">
              <div class="flex items-center justify-between gap-2 px-3 py-3">
                <span class="flex items-center gap-1.5 text-xs font-bold tracking-wide text-white/80">
                  <ListVideo class="h-3.5 w-3.5" /> 剧集列表
                </span>
                <div v-if="episodesList.length > 0" class="flex items-center gap-1">
                  <button
                    type="button"
                    :disabled="episode <= 1"
                    @click="(() => { const prev = episodesList.find((e) => e.sort === episode - 1); if (prev) switchEpisode(prev.sort, prev.title); })()"
                    class="state-layer flex h-6 items-center gap-0.5 rounded-md px-1.5 text-[10px] text-white/50 transition-colors hover:bg-white/10 hover:text-white disabled:opacity-30 disabled:hover:bg-transparent"
                  >
                    <ChevronLeft class="h-3 w-3" /> 上一话
                  </button>
                  <button
                    type="button"
                    :disabled="episode >= episodesList.length"
                    @click="(() => { const next = episodesList.find((e) => e.sort === episode + 1); if (next) switchEpisode(next.sort, next.title); })()"
                    class="state-layer flex h-6 items-center gap-0.5 rounded-md px-1.5 text-[10px] text-white/50 transition-colors hover:bg-white/10 hover:text-white disabled:opacity-30 disabled:hover:bg-transparent"
                  >
                    下一话 <ChevronRight class="h-3 w-3" />
                  </button>
                </div>
              </div>

              <div v-if="sources.length > 0" class="px-3 pb-3">
                <div class="flex items-center justify-between">
                  <span class="flex items-center gap-1.5 text-[11px] font-medium text-white/60">
                    <LinkIcon class="h-3 w-3" /> 播放源
                  </span>
                  <div class="flex items-center gap-1.5">
                    <button
                      type="button"
                      :disabled="latencyTesting"
                      @click="retestLatency"
                      class="state-layer flex h-5 items-center gap-1 rounded-md bg-white/5 px-2 text-[10px] font-medium text-white/60 transition-colors hover:bg-white/10 hover:text-white disabled:opacity-50"
                    >
                      <Loader2 v-if="latencyTesting" class="h-2.5 w-2.5 animate-spin" />
                      <Zap v-else class="h-2.5 w-2.5" />
                      测速
                    </button>
                    <button
                      type="button"
                      @click="sourcesExpanded = !sourcesExpanded"
                      class="state-layer flex h-5 items-center gap-1 rounded-md bg-white/5 px-2 text-[10px] font-medium text-white/60 transition-colors hover:bg-white/10 hover:text-white"
                    >
                      {{ sourcesExpanded ? "收起" : `${sources.length}源` }}
                      <ChevronDown v-if="sourcesExpanded" class="h-2.5 w-2.5" />
                      <ChevronRight v-else class="h-2.5 w-2.5" />
                    </button>
                  </div>
                </div>
                <button
                  v-if="currentSource"
                  type="button"
                  @click="sourceIdx = effectiveIdx; triedSources.clear(); triedSources.add(effectiveIdx)"
                  class="state-layer mt-2 flex w-full items-center justify-between gap-2 rounded-lg bg-primary/15 px-2.5 py-1.5 text-left ring-1 ring-primary/30 transition-colors hover:bg-primary/20"
                >
                  <div class="min-w-0 flex-1">
                    <p class="truncate text-[11px] font-medium text-white">{{ sourceLabel(currentSource) }}</p>
                    <p class="text-[9px] text-white/40">当前播放源</p>
                  </div>
                  <span
                    v-if="sourceLatencies[effectiveIdx] !== undefined"
                    class="shrink-0 rounded px-1 py-0.5 text-[9px] font-mono tabular-nums"
                    :class="sourceLatencies[effectiveIdx] !== null ? 'bg-secondary/20 text-secondary' : 'bg-destructive/20 text-destructive'"
                  >
                    {{ sourceLatencies[effectiveIdx] !== null ? sourceLatencies[effectiveIdx] + 'ms' : '✕' }}
                  </span>
                </button>
                <Transition name="source-list">
                  <div v-if="sourcesExpanded" class="mt-1.5 max-h-56 space-y-0.5 overflow-y-auto pr-1">
                    <button
                      v-for="(s, i) in sources"
                      :key="i"
                      type="button"
                      @click="sourceIdx = i; triedSources.clear(); triedSources.add(i); sourcesExpanded = false"
                      :class="cn(
                        'state-layer flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left transition-colors',
                        i === effectiveIdx ? 'bg-primary/10 ring-1 ring-primary/20' : 'hover:bg-white/5'
                      )"
                    >
                      <p class="truncate text-[10px] font-medium text-white/80">{{ sourceLabel(s) }}</p>
                      <span
                        v-if="sourceLatencies[i] !== undefined"
                        class="shrink-0 rounded px-1 py-0.5 text-[9px] font-mono tabular-nums"
                        :class="sourceLatencies[i] !== null ? 'text-secondary' : 'text-destructive'"
                      >
                        {{ sourceLatencies[i] !== null ? sourceLatencies[i] + 'ms' : '✕' }}
                      </span>
                    </button>
                  </div>
                </Transition>
                <div v-if="latencyDone && !latencyTesting && Object.keys(sourceLatencies).length > 0" class="mt-1.5 rounded-md bg-white/5 px-2 py-1 text-[9px] text-white/40">
                  <template v-if="Object.values(sourceLatencies).some(v => v !== null)">
                    测速完成 · 最低: {{ Math.min(...Object.values(sourceLatencies).filter(v => v !== null) as number[]) }}ms
                  </template>
                  <template v-else>
                    测速完成 · 所有源均无法连接
                  </template>
                </div>
              </div>

              <div class="mx-3 h-px bg-white/5" />

              <div class="min-h-0 flex-1 overflow-y-auto px-2 py-2">
                <div v-if="showLog" class="mb-2 rounded-lg bg-black/60 p-2 font-mono text-[10px] leading-relaxed text-green-300 max-h-48 overflow-y-auto">
                  <div v-for="(line, i) in logLines" :key="i" class="whitespace-pre-wrap break-all">{{ line }}</div>
                </div>
                <div v-if="!episodes || episodes.length === 0" class="flex flex-col items-center justify-center gap-2 py-10 text-white/40">
                  <ListVideo class="h-8 w-8 opacity-40" />
                  <p class="text-xs">暂无剧集</p>
                </div>
                <div v-else class="space-y-0.5">
                  <button
                    v-for="ep in episodesList"
                    :key="ep.sort"
                    type="button"
                    @click="switchEpisode(ep.sort, ep.title)"
                    :class="cn(
                      'group flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors',
                      ep.sort === episode ? 'bg-primary/15' : 'hover:bg-white/5'
                    )"
                  >
                    <span :class="cn('flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[11px] font-semibold tabular-nums transition-colors', ep.sort === episode ? 'bg-primary text-primary-foreground' : 'bg-white/5 text-white/60 group-hover:bg-white/10 group-hover:text-white/80')">
                      {{ ep.sort }}
                    </span>
                    <p :class="cn('min-w-0 flex-1 truncate text-xs', ep.sort === episode ? 'font-semibold text-white' : 'text-white/70')">
                      {{ ep.title || `第 ${ep.sort} 话` }}
                    </p>
                  </button>
                </div>
              </div>
            </div>
          </Transition>
        </div>
      </div>
    </div>
  </Transition>

  <!-- ═══ Picture-in-picture floating window ═══ -->
  <!-- Shows anime title + a "back to home" button at the top. -->
  <Transition name="pip">
    <div
      v-if="open && bangumiID != null && pipMode"
      class="fixed z-[100] overflow-hidden rounded-xl bg-black shadow-2xl ring-1 ring-white/10"
      :style="{ left: pipPos.x + 'px', top: pipPos.y + 'px', width: pipWidth + 'px' }"
    >
      <!-- PiP header — title + home + close (draggable) -->
      <div
        class="flex cursor-move items-center justify-between gap-1 bg-gradient-to-b from-black/80 to-transparent px-2 py-1.5"
        @mousedown="onPipMouseDown"
      >
        <div class="flex min-w-0 items-center gap-1.5">
          <img src="/aikf-logo-128.png" alt="" class="h-3.5 w-3.5 shrink-0 rounded-sm" draggable="false" />
          <p class="line-clamp-1 text-[10px] font-semibold text-white" :title="`${ui.player.title} · 第${episode}话`">
            {{ ui.player.title }} · 第{{ episode }}话
          </p>
        </div>
        <div class="flex shrink-0 items-center gap-0.5">
          <button @click="goHomeFromPip" class="flex h-5 w-5 items-center justify-center rounded text-white/70 transition-colors hover:bg-white/20 hover:text-white" aria-label="回到主页" title="回到主页">
            <Home class="h-3 w-3" />
          </button>
          <button @click="exitPip" class="flex h-5 w-5 items-center justify-center rounded text-white/70 transition-colors hover:bg-white/20 hover:text-white" aria-label="展开" title="展开">
            <Maximize class="h-2.5 w-2.5" />
          </button>
          <button @click="closeFromPip" class="flex h-5 w-5 items-center justify-center rounded text-white/70 transition-colors hover:bg-destructive hover:text-white" aria-label="关闭" title="关闭">
            <X class="h-2.5 w-2.5" />
          </button>
        </div>
      </div>
      <!-- PiP video container — the ArtPlayer instance lives here -->
      <div ref="artContainerRef" class="art-container relative aspect-video w-full bg-black" style="width: 100%;"></div>
    </div>
  </Transition>
</template>

<style scoped>
.player-enter-active, .player-leave-active { transition: opacity 0.25s ease; }
.player-enter-from, .player-leave-to { opacity: 0; }
.controls-enter-active, .controls-leave-active { transition: opacity 0.25s ease, transform 0.25s ease; }
.controls-enter-from, .controls-leave-to { opacity: 0; transform: translateY(-10px); }
.sidebar-enter-active, .sidebar-leave-active { transition: opacity 0.25s ease, width 0.25s ease; }
.sidebar-enter-from, .sidebar-leave-to { opacity: 0; }
.pip-enter-active, .pip-leave-active { transition: opacity 0.3s ease, transform 0.3s ease; }
.pip-enter-from, .pip-leave-to { opacity: 0; transform: scale(0.8) translateY(20px); }
.source-list-enter-active, .source-list-leave-active { transition: all 0.25s ease; }
.source-list-enter-from, .source-list-leave-to { opacity: 0; max-height: 0; }
</style>

<style>
/* ── ArtPlayer global style overrides ── */

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

/* Theme color = AiKF primary (sakura rose) */
.art-video-player .art-progress .art-progress-played,
.art-video-player .art-progress .art-progress-loaded,
.art-video-player .art-icon:hover,
.art-video-player .art-setting .art-setting-item-hover {
  background-color: #fb7185 !important;
}
.art-video-player .art-icon-hover svg,
.art-video-player .art-control svg {
  transition: transform 0.15s ease, color 0.15s ease;
}

/* ── Slim progress bar at bottom when controls are hidden ──
   When the user isn't hovering, ArtPlayer hides the full control bar but
   leaves a tiny 2px progress indicator so the user can still see how far
   into the video they are. This matches the user's request.
*/
.art-video-player.art-state-hide-control .art-progress-bar {
  height: 3px !important;
  bottom: 0 !important;
  border-radius: 0 !important;
  background: rgba(255, 255, 255, 0.15) !important;
  transition: height 0.2s ease !important;
}
.art-video-player.art-state-hide-control:hover .art-progress-bar {
  height: 6px !important;
}

/* ── Volume control: drag-to-seek style ──
   Make the volume popup wider and easier to drag, with a visible fill.
*/
.art-video-player .art-control-volume-panel {
  width: 80px !important;
}
.art-video-player .art-control-volume-panel .art-control-volume-inner {
  width: 60px !important;
}
.art-video-player .art-volume-slider-handle {
  width: 12px !important;
  height: 12px !important;
  background: #fb7185 !important;
  border: 2px solid #fff !important;
}

/* ── Thumbnail tooltip on progress hover ──
   The auto-thumbnail plugin generates a sprite sheet and writes to
   art.thumbnails. ArtPlayer displays it automatically when hovering the
   progress bar — no extra CSS needed, but we style the popup.
*/
.art-video-player .art-progress-tip {
  border-radius: 8px !important;
  overflow: hidden !important;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4) !important;
}
</style>
