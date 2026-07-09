<script setup lang="ts">
import { ref, computed, watch, onBeforeUnmount, onMounted } from "vue";
import Hls from "hls.js";
import { X, Play, Pause, Loader2, ListVideo, ChevronLeft, ChevronRight, ChevronDown, AlertCircle, Link as LinkIcon, Maximize, Minimize, Volume2, VolumeX, RotateCcw, RotateCw, Zap } from "lucide-vue-next";
import { anich } from "@/lib/anich/api-client";
import { useUIStore } from "@/stores/ui";
import { useLibraryStore } from "@/stores/library";
import { useAsync } from "@/composables/useAsync";
import { cn } from "@/lib/utils";
import TitleBar from "@/components/TitleBar.vue";

// ─── Logging ──────────────────────────────────────────────────────────────
const LOG_PREFIX = "%c[AiKF Player]";
const LOG_STYLE = "color:#e879f9;font-weight:bold";
function log(...args: unknown[]) { console.log(LOG_PREFIX, LOG_STYLE, ...args); }
function logError(...args: unknown[]) { console.error(LOG_PREFIX, LOG_STYLE, ...args); }

type Tab = "episodes";

const ui = useUIStore();
const library = useLibraryStore();

const open = computed(() => ui.player.open);
const bangumiID = computed(() => ui.player.bangumiID);
const episode = computed(() => ui.player.episode);

const activeTab = ref<Tab>("episodes");
const sourceIdx = ref(-1); // -1 = auto-pick preferred
const videoError = ref<string | null>(null);
const videoRef = ref<HTMLVideoElement | null>(null);
const logLines = ref<string[]>([]);
let hls: Hls | null = null;
const triedSources = new Set<number>();

function pushLog(msg: string) {
  const ts = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  const line = `[${ts}] ${msg}`;
  logLines.value.push(line);
  if (logLines.value.length > 200) logLines.value.shift();
  log(msg);
}

pushLog("PlayerDialog component mounted");
pushLog(`Tauri runtime: ${typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window)}`);

// HLS capability (client-only)
const HLS_CAP = (() => {
  if (typeof window === "undefined") {
    pushLog("SSR: skipping HLS capability check");
    return { native: false, hls: false, ready: false };
  }
  const v = document.createElement("video");
  const native = v.canPlayType("application/vnd.apple.mpegurl") !== "";
  const hls = Hls.isSupported();
  pushLog(`HLS capability: native=${native}, hls.js=${hls}`);
  return { native, hls, ready: true };
})();

function isDirectMedia(url: string) {
  return /\.(mp4|webm|ogg|mov|m4v|mkv)(\?|#|$)/i.test(url);
}
function isHlsMedia(url: string) {
  return /\.m3u8(\?|#|$)/i.test(url) || url.includes("/m3u8/") || url.includes("/parse/m3u8");
}
/** Extract a human-readable source name from a playback URL's hostname. */
function sourceName(url: string): string {
  try {
    const host = new URL(url).hostname;
    // map known hosts to short names
    const map: Record<string, string> = {
      "v1.adkwai.com": "快手",
      "vo-cdn.emmmm.eu.org": "Anich直连",
      "v-cdn.emmmm.eu.org": "Anich CDN",
      "app.emmmm.eu.org.cdn.cloudflare.net": "Anich代理",
      "vod-cdn.sends.eu.org.cdn.cloudflare.net": "Sends CDN",
      "m3u8132.yhdmm3u8.top": "樱花M3U8",
      "m3u8.cyz.app": "CYZ",
      "yun.92cj.com": "92影视",
      "xgct-video.vzcdn.net": "西瓜视频",
      "aigua.emmmm.eu.org": "艾瓜",
      "dc.xhscdn.com": "小红书",
      "lf3-static.bytednsdoc.com": "字节CDN",
    };
    return map[host] || host.replace(/^www\./, "").split(".")[0];
  } catch {
    return "未知源";
  }
}
/** Build the full source label: episode caption + source name + quality hint. */
function sourceLabel(s: { url: string; caption: string }): string {
  const name = sourceName(s.url);
  const cap = s.caption || "";
  // extract quality from caption if present (e.g. "第01集(全高清-1080P)" → "1080P")
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
  // Default to 快手 (adkwai) source
  const ks = sources.findIndex((s) => s.url.includes("adkwai.com"));
  if (ks >= 0) return ks;
  // Fallback: first HLS source
  const h = sources.findIndex((s) => isHlsMedia(s.url));
  if (h >= 0) return h;
  const d = sources.findIndex((s) => isDirectMedia(s.url));
  if (d >= 0) return d;
  return 0;
}

// ─── Latency testing ──────────────────────────────────────────────────────
// Tests each source URL's latency via a HEAD/range request and picks the
// fastest one. Falls back to pickPreferred if all tests fail.
const latencyTesting = ref(false);
const sourceLatencies = ref<Record<number, number | null>>({});
const latencyDone = ref<string | null>(null); // epKey when done

/** Test a single URL's latency (ms). Uses Image ping (cross-origin safe, no CORS).
 *  For HLS URLs, tests the m3u8 endpoint. Falls back gracefully on error. */
async function testLatency(url: string, timeoutMs = 5000): Promise<number | null> {
  return new Promise((resolve) => {
    const start = performance.now();
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      cleanup();
      resolve(ok ? Math.round(performance.now() - start) : null);
    };
    const img = new Image();
    const timer = setTimeout(() => finish(false), timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      img.onload = null;
      img.onerror = null;
      img.src = "";
    };
    // Image onerror still means the server responded (just not an image),
    // which is enough to measure latency. onload = actual image returned.
    img.onload = () => finish(true);
    img.onerror = () => finish(true); // server responded with non-image = still reachable
    // Add cache-busting query param to avoid cached responses
    img.src = url + (url.includes("?") ? "&" : "?") + "_t=" + Date.now();
  });
}

/** Test all sources concurrently and pick the lowest-latency source. */
async function pickFastestSource(srcs: { url: string }[], ek: string): Promise<number> {
  latencyTesting.value = true;
  sourceLatencies.value = {};
  pushLog(`Latency test: testing ${srcs.length} sources…`);

  // Only test HLS + direct sources (skip unknown/extensionless that aren't playable)
  const testable = srcs
    .map((s, i) => ({ idx: i, url: s.url, kind: classifySource(s.url) }))
    .filter((s) => s.kind === "hls" || s.kind === "direct");

  if (testable.length === 0) {
    pushLog("Latency test: no testable sources, falling back to pickPreferred");
    latencyTesting.value = false;
    return pickPreferred(srcs);
  }

  // Test all concurrently
  const results = await Promise.all(
    testable.map(async (t) => {
      const ms = await testLatency(t.url);
      sourceLatencies.value = { ...sourceLatencies.value, [t.idx]: ms };
      pushLog(`Latency [${t.idx}] ${sourceName(t.url)}: ${ms !== null ? ms + "ms" : "FAIL"}`);
      return { idx: t.idx, ms, kind: t.kind };
    })
  );

  latencyTesting.value = false;
  latencyDone.value = ek;

  // Sort by latency ascending (nulls go last)
  const valid = results
    .filter((r) => r.ms !== null)
    .sort((a, b) => (a.ms! - b.ms!));

  if (valid.length === 0) {
    pushLog("Latency test: all sources failed, falling back to pickPreferred");
    return pickPreferred(srcs);
  }

  // Pick the absolute lowest-latency source (prefer HLS only as tiebreaker)
  const chosen = valid[0];
  pushLog(`Latency test: picked [${chosen.idx}] ${sourceName(srcs[chosen.idx].url)} at ${chosen.ms}ms`);
  return chosen.idx;
}

const openRef = computed(() => open.value && bangumiID.value != null);
const epKey = computed(() => `${bangumiID.value}-${episode.value}`);

// reset on episode change
watch(epKey, (nk, ok) => {
  pushLog(`Episode changed: ${ok} → ${nk}; resetting state`);
  sourceIdx.value = -1;
  videoError.value = null;
  triedSources.clear();
});

const { data: vodData, isLoading: vodLoading, isError: vodIsError, refetch: vodRefetch, error: vodErrorObj } = useAsync(
  () => anich.vod(bangumiID.value!, episode.value),
  { enabled: openRef, source: epKey }
);
watch(() => vodData.value, (d) => {
  if (d) pushLog(`VOD loaded: ${d.sources.length} sources`);
}, { immediate: true });
watch(() => vodErrorObj.value, (e) => {
  if (e) logError("VOD fetch error:", e);
});

const { data: episodes } = useAsync(() => anich.episodes(bangumiID.value!), { enabled: openRef, source: () => "eps" });
// Current video time
const currentTime = ref(0);
const duration = ref(0);
const isPlaying = ref(false);
const isMuted = ref(false);
const isFullscreen = ref(false);
const videoHovered = ref(false);
const mouseIdle = ref(false);
let idleTimer: ReturnType<typeof setTimeout> | null = null;
// Controls visible when: mouse is over the video AND not idle (3s of no movement in fullscreen)
const controlsVisible = computed(() => videoHovered.value && !mouseIdle.value);
const progressPct = computed(() => (duration.value > 0 ? (currentTime.value / duration.value) * 100 : 0));

const onVideoMouseMove = () => {
  videoHovered.value = true;
  mouseIdle.value = false;
  if (idleTimer) clearTimeout(idleTimer);
  // In fullscreen, auto-hide controls after 3s of no mouse movement
  if (isFullscreen.value) {
    idleTimer = setTimeout(() => { mouseIdle.value = true; }, 3000);
  }
};
const onVideoMouseLeave = () => {
  videoHovered.value = false;
  mouseIdle.value = false;
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
};

// Auto-save playback progress (throttled)
let lastProgressSave = 0;
const handleTimeUpdate = () => {
  const v = videoRef.value;
  if (v) {
    currentTime.value = v.currentTime;
    duration.value = v.duration || 0;
    const now = Date.now();
    if (now - lastProgressSave > 5000 && bangumiID.value && duration.value > 0) {
      lastProgressSave = now;
      library.savePlaybackProgress(bangumiID.value, episode.value, v.currentTime, v.duration);
    }
  }
};

const handlePlay = () => {
  isPlaying.value = true;
  pushLog("video @play event — marking episode watched");
  if (bangumiID.value) library.markEpisode(bangumiID.value, episode.value);
};
const handlePause = () => { isPlaying.value = false; };

const togglePlay = () => {
  const v = videoRef.value;
  if (!v) return;
  if (v.paused) v.play(); else v.pause();
};
const toggleMute = () => {
  const v = videoRef.value;
  if (!v) return;
  v.muted = !v.muted;
  isMuted.value = v.muted;
};
// Smooth progress bar dragging
let seeking = false;
const seekTo = (e: MouseEvent) => {
  const v = videoRef.value;
  if (!v || !duration.value) return;
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  const pct = (e.clientX - rect.left) / rect.width;
  v.currentTime = Math.max(0, Math.min(1, pct)) * duration.value;
};
const onProgressMouseDown = (e: MouseEvent) => {
  seeking = true;
  seekTo(e);
};
const onProgressMouseMove = (e: MouseEvent) => {
  if (!seeking) return;
  seekTo(e);
};
const onProgressMouseUp = () => { seeking = false; };
const seekBy = (delta: number) => {
  const v = videoRef.value;
  if (!v) return;
  v.currentTime = Math.max(0, Math.min(duration.value, v.currentTime + delta));
};
const videoContainerRef = ref<HTMLElement | null>(null);
const toggleFullscreen = async () => {
  const el = videoContainerRef.value;
  if (!el) return;
  if (!document.fullscreenElement) {
    await el.requestFullscreen?.();
    isFullscreen.value = true;
  } else {
    await document.exitFullscreen?.();
    isFullscreen.value = false;
  }
};
const onFullscreenChange = () => {
  isFullscreen.value = !!document.fullscreenElement;
  // When entering fullscreen, start the idle timer to auto-hide controls
  if (isFullscreen.value) {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { mouseIdle.value = true; }, 3000);
  } else {
    mouseIdle.value = false;
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  }
};
const fmtTime = (s: number) => {
  if (!s || !isFinite(s)) return "0:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
};

const sources = computed(() => vodData.value?.sources ?? []);

// Auto-pick default source (快手) when sources first load or episode changes
const autoPickedFor = ref<string | null>(null);
watch(
  () => [sources.value.length, epKey.value] as const,
  ([count, ek]) => {
    if (count > 0 && autoPickedFor.value !== ek) {
      autoPickedFor.value = ek;
      const pref = pickPreferred(sources.value);
      pushLog(`Default source: index=${pref} (${sourceName(sources.value[pref].url)})`);
      sourceIdx.value = pref;
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

// ─── Media attachment: re-run whenever videoRef, source url, or open state changes ───
const mediaUrl = computed(() => currentSource.value?.url);
// Use watch (not watchEffect) so only the explicitly-listed sources are tracked.
// This prevents pushLog() from creating a reactive dependency on logLines (which
// would cause an infinite loop: log → modify logLines → re-run effect → log → …).
watch(
  () => [videoRef.value, mediaUrl.value, open.value, sources.value.length, effectiveIdx.value] as const,
  ([video, url, isOpen, srcCount, idx]) => {
    pushLog(`watch: open=${isOpen}, video=${video ? "ready" : "null"}, url=${url ? url.slice(0, 50) + "…" : "none"}, sources=${srcCount}, idx=${idx}`);

    if (!isOpen) return;
    if (srcCount === 0) return;
    if (!url) return;
    if (!video) {
      pushLog("video element not yet mounted — will retry on next tick");
      return;
    }

    // mark this source as tried
    triedSources.add(idx);
    videoError.value = null;

    // cleanup previous hls
    if (hls) {
      pushLog("destroying previous hls.js instance");
      hls.destroy();
      hls = null;
    }

    const kind = classifySource(url);
    pushLog(`Attaching media: idx=${idx}, kind=${kind}, url=${url.slice(0, 80)}…`);

    if (kind === "direct") {
      pushLog("→ direct media: setting video.src");
      video.src = url;
    } else if (HLS_CAP.native) {
      pushLog("→ native HLS: setting video.src");
      video.src = url;
    } else if (HLS_CAP.hls) {
      pushLog("→ hls.js: creating instance (custom config)");
      hls = new Hls({
        enableWorker: true,
        lowLatencyMode: false,
        // ── playback tuning (preload + buffer) ──
        autoStartLoad: true,
        startLevel: -1,
        maxBufferLength: 60,        // buffer up to 60s ahead for smoother playback
        maxMaxBufferLength: 120,    // hard cap
        backBufferLength: 30,
        // ── ABR ──
        abrEwmaDefaultEstimate: 1e6,
        abrBandWidthFactor: 0.95,
        abrBandWidthUpFactor: 0.7,
        // ── error recovery ──
        manifestLoadingMaxRetry: 4,
        manifestLoadingRetryDelay: 1000,
        levelLoadingMaxRetry: 4,
        levelLoadingRetryDelay: 1000,
        fragLoadingMaxRetry: 6,
        fragLoadingRetryDelay: 1000,
        // ── preload ──
        startFragPrefetch: true,    // prefetch first fragment while loading manifest
        xhrSetup: (xhr) => {
          xhr.withCredentials = false;
        },
      });
      hls.on(Hls.Events.MEDIA_ATTACHED, () => pushLog("hls.js: MEDIA_ATTACHED"));
      hls.on(Hls.Events.MANIFEST_PARSED, (_e, d) => pushLog(`hls.js: MANIFEST_PARSED (${d?.levels?.length ?? 0} levels)`));
      hls.on(Hls.Events.LEVEL_LOADED, (_e, d) => pushLog(`hls.js: LEVEL_LOADED (level=${d?.level})`));
      hls.on(Hls.Events.FRAG_LOADED, (_e, d) => pushLog(`hls.js: FRAG_LOADED (sn=${d?.frag?.sn})`));
      hls.on(Hls.Events.ERROR, (_e, data) => {
        const fatal = data.fatal;
        const det = data.details || data.type;
        pushLog(`hls.js ERROR: fatal=${fatal}, details=${det}, url=${data.url?.slice(0, 60) ?? "-"}`);
        if (fatal) {
          // attempt recovery before giving up
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
            pushLog("hls.js: attempting network error recovery…");
            hls?.startLoad();
          } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            pushLog("hls.js: attempting media error recovery…");
            hls?.recoverMediaError();
          } else {
            logError("hls.js fatal error (unrecoverable):", data);
            videoError.value = `播放失败：${det}`;
            tryAutoAdvance(idx);
          }
        }
      });
      hls.loadSource(url);
      hls.attachMedia(video);
    } else {
      pushLog("→ no HLS support available");
      videoError.value = "当前浏览器不支持 HLS 播放";
    }

    pushLog("calling video.play()…");
    video.play().then(() => pushLog("play() succeeded")).catch((e) => pushLog(`play() rejected: ${e?.name || e?.message || e}`));
  },
  { flush: "post", immediate: true }
);

function tryAutoAdvance(currentIdx: number) {
  const next = sources.value.findIndex((_, i) => !triedSources.has(i));
  pushLog(`auto-advance: current=${currentIdx}, next=${next}, tried={[...triedSources].join(",")}`);
  if (next >= 0 && next !== currentIdx) {
    sourceIdx.value = next;
  } else {
    videoError.value = "所有播放源均无法播放，请稍后重试或更换剧集";
  }
}

onBeforeUnmount(() => {
  pushLog("PlayerDialog unmounting — destroying hls");
  if (hls) { hls.destroy(); hls = null; }
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
});

const handleVideoError = () => {
  const v = videoRef.value;
  const err = v?.error;
  pushLog(`video @error event: code=${err?.code}, message=${err?.message}`);
  tryAutoAdvance(effectiveIdx.value);
};
const switchEpisode = (sort: number, title: string) => {
  pushLog(`switchEpisode: ${sort} - ${title}`);
  ui.setPlayerEpisode(sort, title);
  activeTab.value = "episodes";
};

const showLog = ref(false);
const toggleLog = () => { showLog.value = !showLog.value; pushLog(`log panel ${showLog.value ? "opened" : "closed"}`); };
const sidebarCollapsed = ref(false);
const sourcesExpanded = ref(false);
// Picture-in-picture mode: player shrinks to bottom-right corner
const pipMode = ref(false);
// Saved video state for PiP <-> fullscreen sync
const savedVideoState = ref<{ time: number; paused: boolean; muted: boolean } | null>(null);

const saveVideoState = () => {
  const v = videoRef.value;
  if (v) {
    savedVideoState.value = { time: v.currentTime, paused: v.paused, muted: v.muted };
  }
};
const restoreVideoState = () => {
  const v = videoRef.value;
  if (!v) return;
  // First try saved state (from PiP switch)
  if (savedVideoState.value) {
    v.currentTime = savedVideoState.value.time;
    v.muted = savedVideoState.value.muted;
    if (!savedVideoState.value.paused) {
      v.play().catch(() => {});
    }
    savedVideoState.value = null;
    return;
  }
  // Otherwise restore from library playback progress
  if (bangumiID.value) {
    const progress = library.getPlaybackProgress(bangumiID.value, episode.value);
    if (progress && progress.time > 5 && progress.time < progress.duration - 10) {
      pushLog(`Restoring playback progress: ${Math.round(progress.time)}s / ${Math.round(progress.duration)}s`);
      v.currentTime = progress.time;
    }
  }
};

const enterPip = () => {
  saveVideoState();
  pipMode.value = true;
  ui.openDetail(bangumiID.value!, ui.player.cover);
};
const exitPip = () => {
  saveVideoState();
  pipMode.value = false;
  ui.setView("detail");
};
const closeFromPip = () => {
  pipMode.value = false;
  ui.closePlayer();
};
// X button → PiP instead of close
const closeOrPip = () => {
  if (pipMode.value) {
    closeFromPip();
  } else {
    enterPip();
  }
};

// PiP dragging
const pipPos = ref({ x: window.innerWidth - 340, y: window.innerHeight - 260 });
let pipDragging = false;
let pipDragStart = { x: 0, y: 0 };
const onPipMouseDown = (e: MouseEvent) => {
  if ((e.target as HTMLElement).closest("button")) return;
  pipDragging = true;
  pipDragStart = { x: e.clientX - pipPos.value.x, y: e.clientY - pipPos.value.y };
  e.preventDefault();
};
const onPipMouseMove = (e: MouseEvent) => {
  if (!pipDragging) return;
  pipPos.value = {
    x: Math.max(0, Math.min(window.innerWidth - 320, e.clientX - pipDragStart.x)),
    y: Math.max(0, Math.min(window.innerHeight - 200, e.clientY - pipDragStart.y)),
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

/** Manual re-test: run latency test, show results (do NOT auto-switch source). */
const retestLatency = async () => {
  if (latencyTesting.value || sources.value.length === 0) return;
  await pickFastestSource(sources.value, epKey.value);
  pushLog("测速完成，用户手动选择源");
};
</script>

<template>
  <Transition name="player">
    <div v-if="open && bangumiID != null && !pipMode" class="fixed inset-0 z-[100] flex flex-col bg-black/90 backdrop-blur-2xl">
      <!-- titlebar (same as main app) -->
      <TitleBar />
      <!-- player header -->
      <div class="flex items-center justify-between gap-3 px-4 py-3">
        <div class="flex min-w-0 items-center gap-3">
          <button @click="closeOrPip" class="state-layer glass flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-white hover:bg-white/20" aria-label="最小化">
            <X class="h-4 w-4" />
          </button>
          <div class="min-w-0">
            <p class="line-clamp-1 text-sm font-bold text-white">{{ ui.player.title }}</p>
            <p class="text-xs text-white/50">第 {{ episode }} 话</p>
          </div>
        </div>
        <div class="flex items-center gap-2">
          <button @click="toggleLog" :class="cn('rounded-full px-3 py-1.5 text-xs font-medium transition-colors', showLog ? 'bg-tertiary text-tertiary-foreground' : 'glass text-white/80 hover:bg-white/20')">
            日志
          </button>
          <button @click="enterPip" class="state-layer glass hidden rounded-full px-3 py-1.5 text-xs font-medium text-white/80 hover:bg-white/20 sm:block">
            查看详情
          </button>
        </div>
      </div>

      <!-- body -->
      <div class="flex min-h-0 flex-1 flex-col gap-4 px-4 pb-4 sm:px-6 lg:flex-row">
        <!-- video -->
        <div class="relative flex min-h-0 flex-1 items-center justify-center">
          <div class="relative aspect-video w-full max-w-6xl overflow-hidden rounded-2xl bg-black shadow-2xl ring-1 ring-white/5">
            <div v-if="vodLoading" class="flex h-full flex-col items-center justify-center gap-3 text-white/70">
              <Loader2 class="h-10 w-10 animate-spin text-primary" />
              <p class="text-sm">正在加载播放源…</p>
            </div>
            <div v-else-if="vodIsError" class="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-white/70">
              <AlertCircle class="h-10 w-10 text-destructive" />
              <p class="text-sm">播放源加载失败</p>
              <button @click="vodRefetch()" class="rounded-full bg-white/10 px-4 py-1.5 text-xs text-white hover:bg-white/20">重试</button>
            </div>
            <div v-else-if="sources.length === 0" class="flex h-full flex-col items-center justify-center gap-2 text-white/60">
              <AlertCircle class="h-10 w-10" />
              <p class="text-sm">暂无可用的播放源</p>
            </div>
            <template v-else>
              <div
                ref="videoContainerRef"
                class="relative h-full w-full bg-black"
                @mousemove="onVideoMouseMove"
                @mouseleave="onVideoMouseLeave"
                @fullscreenchange="onFullscreenChange"
              >
                <video ref="videoRef" autoplay playsinline preload="auto" @play="handlePlay" @pause="handlePause" @error="handleVideoError" @timeupdate="handleTimeUpdate" @loadedmetadata="restoreVideoState" @click="togglePlay" class="h-full w-full" />
                <div v-if="videoError" class="absolute inset-x-0 bottom-16 mx-auto max-w-md rounded-xl bg-destructive/90 px-4 py-2 text-center text-xs text-white">
                  {{ videoError }}
                </div>

                <!-- custom control bar (bottom, visible on hover / non-idle) -->
                <Transition name="controls">
                  <div v-if="controlsVisible" class="absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-black via-black/70 to-transparent pt-10">
                    <!-- progress bar at the very bottom edge (smooth drag) -->
                    <div
                      class="group relative h-1 w-full cursor-pointer bg-white/15"
                      @mousedown="onProgressMouseDown"
                      @mousemove="onProgressMouseMove"
                      @mouseup="onProgressMouseUp"
                      @mouseleave="onProgressMouseUp"
                    >
                      <div class="absolute inset-y-0 left-0 bg-primary/80 transition-all group-hover:h-1.5" :style="{ width: progressPct + '%' }" />
                      <div class="absolute top-1/2 h-3 w-3 -translate-y-1/2 rounded-full bg-white opacity-0 shadow-md transition-opacity group-hover:opacity-100" :style="{ left: `calc(${progressPct}% - 6px)` }" />
                    </div>
                    <!-- control buttons row -->
                    <div class="flex items-center gap-0.5 px-3 py-2">
                      <!-- play/pause -->
                      <button @click="togglePlay" class="state-layer flex h-8 w-8 items-center justify-center rounded-full text-white hover:bg-white/15" :aria-label="isPlaying ? '暂停' : '播放'">
                        <Pause v-if="isPlaying" class="h-4 w-4" />
                        <Play v-else class="h-4 w-4 fill-current" />
                      </button>
                      <!-- divider -->
                      <div class="mx-1 h-5 w-px bg-white/15" />
                      <!-- mute -->
                      <button @click="toggleMute" class="state-layer flex h-8 w-8 items-center justify-center rounded-full text-white hover:bg-white/15" :aria-label="isMuted ? '取消静音' : '静音'">
                        <VolumeX v-if="isMuted" class="h-4 w-4" />
                        <Volume2 v-else class="h-4 w-4" />
                      </button>
                      <!-- seek back/forward -->
                      <button @click="seekBy(-10)" class="state-layer hidden h-8 w-8 items-center justify-center rounded-full text-white hover:bg-white/15 sm:flex" aria-label="后退10秒">
                        <RotateCcw class="h-4 w-4" />
                      </button>
                      <button @click="seekBy(10)" class="state-layer hidden h-8 w-8 items-center justify-center rounded-full text-white hover:bg-white/15 sm:flex" aria-label="前进10秒">
                        <RotateCw class="h-4 w-4" />
                      </button>
                      <!-- time display -->
                      <span class="ml-1.5 font-mono text-[11px] tabular-nums text-white/70">{{ fmtTime(currentTime) }} <span class="text-white/30">/</span> {{ fmtTime(duration) }}</span>
                      <!-- spacer -->
                      <div class="flex-1" />
                      <!-- latency test -->
                      <button @click="retestLatency" :disabled="latencyTesting" class="state-layer flex h-8 items-center gap-1 rounded-full px-2 text-[11px] font-medium text-white/60 hover:bg-white/15 hover:text-white disabled:opacity-50" aria-label="测速">
                        <Loader2 v-if="latencyTesting" class="h-3 w-3 animate-spin" />
                        <Zap v-else class="h-3 w-3" /> 测速
                      </button>
                      <!-- fullscreen -->
                      <button @click="toggleFullscreen" class="state-layer flex h-8 w-8 items-center justify-center rounded-full text-white hover:bg-white/15" :aria-label="isFullscreen ? '退出全屏' : '全屏'">
                        <Minimize v-if="isFullscreen" class="h-4 w-4" />
                        <Maximize v-else class="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                </Transition>

                <!-- slim progress bar when controls hidden (always at bottom, no time) -->
                <Transition name="progress">
                  <div v-if="!controlsVisible && duration > 0" class="absolute inset-x-0 bottom-0 z-10">
                    <div class="group relative h-1 w-full cursor-pointer bg-white/20" @click="seekTo">
                      <div class="absolute inset-y-0 left-0 bg-primary/80" :style="{ width: progressPct + '%' }" />
                    </div>
                  </div>
                </Transition>
              </div>
            </template>
          </div>
        </div>

        <!-- side panel (collapsible) -->
        <div class="relative flex shrink-0 items-stretch">
          <!-- vertical collapse/expand toggle button (rectangle) -->
          <button
            @click="sidebarCollapsed = !sidebarCollapsed"
            class="glass-strong glass-sheen state-layer my-3 hidden w-6 shrink-0 items-center justify-center rounded-l-xl text-white/70 hover:text-white lg:flex"
            :aria-label="sidebarCollapsed ? '展开侧栏' : '收起侧栏'"
          >
            <ChevronRight v-if="sidebarCollapsed" class="h-4 w-4" />
            <ChevronLeft v-else class="h-4 w-4" />
          </button>
          <Transition name="sidebar">
            <div v-show="!sidebarCollapsed" class="glass-strong glass-sheen flex min-h-0 w-full flex-col rounded-2xl lg:w-96">
          <div class="flex gap-1 p-2.5">
            <button class="state-layer flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-primary py-2.5 text-xs font-semibold text-primary-foreground">
              <ListVideo class="h-3.5 w-3.5" /> 剧集列表
            </button>
          </div>

          <!-- 播放源 (vertical expandable list) -->
          <div v-if="sources.length > 0" class="px-3 pb-3">
            <!-- title row -->
            <div class="flex items-center justify-between">
              <span class="flex items-center gap-1.5 text-[11px] font-bold text-white/70"><LinkIcon class="h-3.5 w-3.5" /> 播放源</span>
              <div class="flex items-center gap-2">
                <button
                  @click="retestLatency"
                  :disabled="latencyTesting"
                  class="state-layer flex items-center gap-1 rounded-full bg-white/10 px-2.5 py-1 text-[10px] font-medium text-white/70 hover:text-white disabled:opacity-50"
                >
                  <Loader2 v-if="latencyTesting" class="h-3 w-3 animate-spin" />
                  <Zap v-else class="h-3 w-3" />
                  测速
                </button>
                <button
                  @click="sourcesExpanded = !sourcesExpanded"
                  class="state-layer flex items-center gap-1 rounded-full bg-white/10 px-2.5 py-1 text-[10px] font-medium text-white/70 hover:text-white"
                >
                  {{ sourcesExpanded ? "收起" : `展开(${sources.length})` }}
                  <ChevronDown v-if="sourcesExpanded" class="h-3 w-3" />
                  <ChevronRight v-else class="h-3 w-3" />
                </button>
              </div>
            </div>
            <!-- current source (always visible) -->
            <button
              v-if="currentSource"
              @click="sourceIdx = effectiveIdx; triedSources.clear(); triedSources.add(effectiveIdx)"
              class="state-layer mt-2 flex w-full items-center justify-between rounded-xl bg-primary/20 px-3 py-2 text-left ring-1 ring-primary/40"
            >
              <div class="min-w-0 flex-1">
                <p class="text-xs font-semibold text-white">{{ sourceLabel(currentSource) }}</p>
                <p class="text-[10px] text-white/50">当前播放源</p>
              </div>
              <span v-if="sourceLatencies[effectiveIdx] !== undefined" class="ml-2 shrink-0 text-[10px] font-medium" :class="sourceLatencies[effectiveIdx] !== null ? 'text-secondary' : 'text-destructive'">
                {{ sourceLatencies[effectiveIdx] !== null ? sourceLatencies[effectiveIdx] + 'ms' : '✕' }}
              </span>
            </button>
            <!-- expanded list (all sources) -->
            <Transition name="source-list">
              <div v-if="sourcesExpanded" class="mt-2 max-h-64 space-y-1 overflow-y-auto pr-1">
                <button
                  v-for="(s, i) in sources"
                  :key="i"
                  @click="sourceIdx = i; triedSources.clear(); triedSources.add(i); sourcesExpanded = false"
                  :class="cn('state-layer flex w-full items-center justify-between rounded-lg px-3 py-2 text-left transition-colors', i === effectiveIdx ? 'bg-primary/15 ring-1 ring-primary/30' : 'bg-white/5 hover:bg-white/10')"
                >
                  <div class="min-w-0 flex-1">
                    <p class="text-[11px] font-medium text-white/90">{{ sourceLabel(s) }}</p>
                  </div>
                  <span v-if="sourceLatencies[i] !== undefined" class="ml-2 shrink-0 text-[10px]" :class="sourceLatencies[i] !== null ? 'text-secondary' : 'text-destructive'">
                    {{ sourceLatencies[i] !== null ? sourceLatencies[i] + 'ms' : '✕' }}
                  </span>
                </button>
              </div>
            </Transition>
            <!-- latency test result summary -->
            <div v-if="latencyDone && !latencyTesting && Object.keys(sourceLatencies).length > 0" class="mt-2 rounded-lg bg-white/5 px-3 py-1.5 text-[10px] text-white/50">
              <template v-if="Object.values(sourceLatencies).some(v => v !== null)">
                测速完成 · 最低延迟: {{ Math.min(...Object.values(sourceLatencies).filter(v => v !== null) as number[]) }}ms
              </template>
              <template v-else>
                测速完成 · 所有源均无法连接
              </template>
            </div>
          </div>

          <div v-if="episodesList.length > 0" class="flex items-center justify-between px-3 pb-3 text-xs text-white/60">
            <button :disabled="episode <= 1" @click="(() => { const prev = episodesList.find((e) => e.sort === episode - 1); if (prev) switchEpisode(prev.sort, prev.title); })()" class="state-layer flex items-center gap-1 disabled:opacity-30">
              <ChevronLeft class="h-3.5 w-3.5" /> 上一话
            </button>
            <button :disabled="episode >= episodesList.length" @click="(() => { const next = episodesList.find((e) => e.sort === episode + 1); if (next) switchEpisode(next.sort, next.title); })()" class="state-layer flex items-center gap-1 disabled:opacity-30">
              下一话 <ChevronRight class="h-3.5 w-3.5" />
            </button>
          </div>

          <div class="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
            <!-- log panel (toggleable) -->
            <div v-if="showLog" class="mb-2 rounded-xl bg-black/60 p-2 font-mono text-[10px] leading-relaxed text-green-300 max-h-64 overflow-y-auto">
              <div v-for="(line, i) in logLines" :key="i" class="whitespace-pre-wrap break-all">{{ line }}</div>
            </div>
            <div v-if="!episodes || episodes.length === 0" class="py-8 text-center text-xs text-white/50">暂无剧集</div>
            <div v-else class="space-y-1 p-1">
              <button v-for="ep in episodesList" :key="ep.sort" @click="switchEpisode(ep.sort, ep.title)" :class="cn('state-layer flex w-full items-center gap-2.5 rounded-xl p-2 text-left transition-colors', ep.sort === episode ? 'bg-primary/20 ring-1 ring-primary/40' : 'hover:bg-white/10')">
                <span :class="cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-xs font-bold', ep.sort === episode ? 'bg-primary text-primary-foreground' : 'bg-white/10 text-white/70')">{{ ep.sort }}</span>
                <div class="min-w-0 flex-1">
                  <p :class="cn('line-clamp-1 text-xs font-medium', ep.sort === episode ? 'text-white' : 'text-white/80')">{{ ep.title || `第 ${ep.sort} 话` }}</p>
                </div>
                <Play v-if="ep.sort === episode" class="h-3 w-3 shrink-0 fill-current text-primary" />
              </button>
            </div>
          </div>
            </div>
          </Transition>
        </div>
      </div>
    </div>
  </Transition>

  <!-- Picture-in-picture floating window (draggable) -->
  <Transition name="pip">
    <div
      v-if="open && bangumiID != null && pipMode"
      class="fixed z-[100] w-[320px] overflow-hidden rounded-2xl bg-black shadow-2xl ring-1 ring-white/10"
      :style="{ left: pipPos.x + 'px', top: pipPos.y + 'px' }"
    >
      <!-- draggable header bar -->
      <div
        class="flex cursor-move items-center justify-between bg-black/80 px-2 py-1.5"
        @mousedown="onPipMouseDown"
      >
        <span class="line-clamp-1 text-[11px] font-semibold text-white">{{ ui.player.title }} · 第{{ episode }}话</span>
        <div class="flex items-center gap-1">
          <button @click="exitPip" class="flex h-6 w-6 items-center justify-center rounded-full bg-white/20 text-white hover:bg-white/30" aria-label="展开">
            <Maximize class="h-3 w-3" />
          </button>
          <button @click="closeFromPip" class="flex h-6 w-6 items-center justify-center rounded-full bg-white/20 text-white hover:bg-destructive" aria-label="关闭">
            <X class="h-3 w-3" />
          </button>
        </div>
      </div>
      <!-- video -->
      <div ref="videoContainerRef" class="relative aspect-video w-full bg-black" @mousemove="onVideoMouseMove" @mouseleave="onVideoMouseLeave" @fullscreenchange="onFullscreenChange">
        <video ref="videoRef" autoplay playsinline @play="handlePlay" @pause="handlePause" @error="handleVideoError" @timeupdate="handleTimeUpdate" @loadedmetadata="restoreVideoState" @click="togglePlay" class="h-full w-full" />
        <!-- mini progress bar at bottom -->
        <div class="absolute inset-x-0 bottom-0 h-0.5 bg-white/20">
          <div class="h-full bg-primary/80" :style="{ width: progressPct + '%' }" />
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.player-enter-active,
.player-leave-active { transition: opacity 0.25s ease; }
.player-enter-from,
.player-leave-to { opacity: 0; }
.controls-enter-active,
.controls-leave-active { transition: opacity 0.25s ease, transform 0.25s ease; }
.controls-enter-from,
.controls-leave-to { opacity: 0; transform: translateY(10px); }
.progress-enter-active,
.progress-leave-active { transition: opacity 0.3s ease; }
.progress-enter-from,
.progress-leave-to { opacity: 0; }
.sidebar-enter-active,
.sidebar-leave-active { transition: opacity 0.25s ease, width 0.25s ease; }
.sidebar-enter-from,
.sidebar-leave-to { opacity: 0; }
.pip-enter-active,
.pip-leave-active { transition: opacity 0.3s ease, transform 0.3s ease; }
.pip-enter-from,
.pip-leave-to { opacity: 0; transform: scale(0.8) translateY(20px); }
.source-list-enter-active,
.source-list-leave-active { transition: all 0.25s ease; }
.source-list-enter-from,
.source-list-leave-to { opacity: 0; max-height: 0; }
</style>
