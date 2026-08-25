<script setup lang="ts">
import { ref, computed, watch, onBeforeUnmount, onMounted } from "vue";
import Hls from "hls.js";
import { X, Play, Pause, Loader2, ListVideo, ChevronLeft, ChevronRight, ChevronDown, AlertCircle, Link as LinkIcon, Maximize, Minimize, Volume2, VolumeX, RotateCcw, RotateCw, Zap } from "lucide-vue-next";
import { anich } from "@/lib/anich/api-client";
import { useUIStore } from "@/stores/ui";
import { useLibraryStore } from "@/stores/library";
import { useSettingsStore } from "@/stores/settings";
import { useAsync } from "@/composables/useAsync";
import { cn } from "@/lib/utils";
import TitleBar from "@/components/TitleBar.vue";
import {
  NButton,
  NIcon,
  NSlider,
  NTooltip,
  NEmpty,
} from "naive-ui";

// ─── Logging ──────────────────────────────────────────────────────────────
const LOG_PREFIX = "%c[AiKF Player]";
const LOG_STYLE = "color:#e879f9;font-weight:bold";
function log(...args: unknown[]) { console.log(LOG_PREFIX, LOG_STYLE, ...args); }
function logError(...args: unknown[]) { console.error(LOG_PREFIX, LOG_STYLE, ...args); }

type Tab = "episodes";

const ui = useUIStore();
const library = useLibraryStore();
const settings = useSettingsStore();

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
  // Honor the user's default source setting
  const pref = settings.data.defaultSource;
  if (pref === "adkwai") {
    const ks = sources.findIndex((s) => s.url.includes("adkwai.com"));
    if (ks >= 0) return ks;
  } else if (pref === "anich") {
    const an = sources.findIndex((s) => s.url.includes("emmmm.eu.org"));
    if (an >= 0) return an;
  }
  // "auto" or fallback: first HLS source, then direct, then first
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
// mouseInHeaderZone: true when the mouse cursor is in the top ~80px of the
// video container (i.e. over the title bar overlay). When true, controls stay
// visible regardless of mouseIdle — fixes the "hard to click close button"
// issue AND avoids the flicker that comes from using @mouseenter on a
// pointer-events-none element (which never fires).
const mouseInHeaderZone = ref(false);
const mouseIdle = ref(false);
let idleTimer: ReturnType<typeof setTimeout> | null = null;
// Controls visible when:
//   - mouse is over the video AND not idle, OR
//   - mouse is in the top header zone (always visible there)
const controlsVisible = computed(() => (videoHovered.value && !mouseIdle.value) || mouseInHeaderZone.value);
const progressPct = computed(() => (duration.value > 0 ? (currentTime.value / duration.value) * 100 : 0));

// Header zone height — matches the pt-3 + content + pb-10 of the header overlay.
// Anything with clientY < 80 (relative to video container) is "header zone".
const HEADER_ZONE_HEIGHT = 90;

const onVideoMouseMove = (e: MouseEvent) => {
  videoHovered.value = true;
  mouseIdle.value = false;
  // Detect whether the cursor is in the top header zone by checking its
  // Y coordinate relative to the video container. This is more reliable
  // than @mouseenter on the header div (which has pointer-events:none and
  // would never fire, causing the previous fix to be a no-op + flicker).
  const rect = videoContainerRef.value?.getBoundingClientRect();
  if (rect) {
    const relY = e.clientY - rect.top;
    mouseInHeaderZone.value = relY < HEADER_ZONE_HEIGHT;
  }
  // Only arm the idle-hide timer when NOT in the header zone — so moving
  // the mouse up to the close button never triggers a fade-out.
  if (!mouseInHeaderZone.value) {
    if (idleTimer) clearTimeout(idleTimer);
    if (isFullscreen.value) {
      idleTimer = setTimeout(() => { mouseIdle.value = true; }, 3000);
    }
  } else {
    // In header zone: cancel any pending hide so the controls stay put
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  }
};
const onVideoMouseLeave = () => {
  videoHovered.value = false;
  mouseIdle.value = false;
  mouseInHeaderZone.value = false;
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
};
// onHeaderMouseMove — bound to the header overlay div. Even though the div
// itself is pointer-events-none, its pointer-events-auto children (NButton,
// title text) DO receive mousemove, and those events bubble up to this div.
// So when the user moves the mouse anywhere over the header's children, we
// mark mouseInHeaderZone=true, which forces controlsVisible=true. This is
// more reliable than relying on the video container's mousemove alone (which
// doesn't fire while the cursor is over a pointer-events-auto child).
const onHeaderMouseMove = (e: MouseEvent) => {
  // Always treat movement on the header as "in header zone".
  mouseInHeaderZone.value = true;
  videoHovered.value = true;
  mouseIdle.value = false;
  // Cancel any pending idle-hide so the header stays put while hovered.
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  // Stop propagation so the video container's mousemove doesn't ALSO fire
  // and re-evaluate the header zone based on Y coordinate (which could
  // disagree and cause flicker).
  e.stopPropagation();
};

// Auto-save playback progress (throttled)
let lastProgressSave = 0;
const handleTimeUpdate = () => {
  const v = videoRef.value;
  if (!v) return;
  // Always keep duration fresh (needed by seek math)
  duration.value = v.duration || 0;
  // CRITICAL: while the user is dragging the progress bar OR the video element
  // is internally seeking (HLS fragment still loading after v.currentTime = X),
  // do NOT let @timeupdate overwrite currentTime.value — that is what causes the
  // progress fill to "snap back" to the old position during a drag.
  if (seeking || v.seeking) return;
  currentTime.value = v.currentTime;
  const now = Date.now();
  if (now - lastProgressSave > 5000 && bangumiID.value && duration.value > 0) {
    lastProgressSave = now;
    library.savePlaybackProgress(bangumiID.value, episode.value, v.currentTime, v.duration);
  }
};
// When an internal seek finishes, immediately sync currentTime so the fill is accurate
const handleSeeked = () => {
  const v = videoRef.value;
  if (v && !seeking) currentTime.value = v.currentTime;
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
// Volume control
const volume = ref(1);
const showVolumeSlider = ref(false);
// NSlider emits a plain number (not an Event), so use an overload that accepts both.
const setVolume = (val: number | Event) => {
  const v = videoRef.value;
  if (!v) return;
  const n = typeof val === "number" ? val : parseFloat((val.target as HTMLInputElement).value);
  v.volume = n;
  volume.value = n;
  if (n === 0) { v.muted = true; isMuted.value = true; }
  else { v.muted = false; isMuted.value = false; }
};
// Mouse wheel volume control on hover
const onVolumeWheel = (e: WheelEvent) => {
  e.preventDefault();
  const v = videoRef.value;
  if (!v) return;
  const delta = e.deltaY < 0 ? 0.05 : -0.05;
  const newVol = Math.max(0, Math.min(1, volume.value + delta));
  v.volume = newVol;
  volume.value = newVol;
  if (newVol === 0) { v.muted = true; isMuted.value = true; }
  else { v.muted = false; isMuted.value = false; }
};

// Smooth progress bar dragging — YouTube-style:
// • While dragging, only the visual fill (currentTime.value) follows the mouse.
// • The actual video.currentTime is set ONCE on mouseup, avoiding a storm of
//   half-finished HLS seeks that cause jank and "snap-back".
let seeking = false;
let seekBarEl: HTMLElement | null = null;
// Compute target time from a mouse clientX given the seek bar rect
const seekTimeFromClientX = (clientX: number): number => {
  if (!seekBarEl || !duration.value) return 0;
  const rect = seekBarEl.getBoundingClientRect();
  const pct = (clientX - rect.left) / rect.width;
  return Math.max(0, Math.min(1, pct)) * duration.value;
};
// Update only the visual position (no actual video seek) — called on every mousemove
const updateSeekVisual = (clientX: number) => {
  currentTime.value = seekTimeFromClientX(clientX);
};
// Perform the real seek on the video element
const commitSeek = (clientX: number) => {
  const v = videoRef.value;
  if (!v || !duration.value) return;
  const newTime = seekTimeFromClientX(clientX);
  v.currentTime = newTime;
  currentTime.value = newTime; // keep visual in sync until @seeked fires
};
const onProgressMouseDown = (e: MouseEvent) => {
  seeking = true;
  seekBarEl = e.currentTarget as HTMLElement;
  // On initial click: update visual immediately, and also commit the seek so
  // clicking (not dragging) jumps right away.
  updateSeekVisual(e.clientX);
  commitSeek(e.clientX);
  e.preventDefault();
  e.stopPropagation();
};
const onGlobalMouseMove = (e: MouseEvent) => {
  if (!seeking) return;
  // Visual-only update during drag — smooth and lag-free
  updateSeekVisual(e.clientX);
};
const onGlobalMouseUp = (e: MouseEvent) => {
  if (!seeking) return;
  // Commit the final seek position to the video element
  commitSeek(e.clientX);
  seeking = false;
};
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
        // ── continuous buffering (buffer size from user settings) ──
        autoStartLoad: true,
        startLevel: -1,
        maxBufferLength: settings.data.bufferSize,   // forward buffer (60/120/300/600s)
        maxMaxBufferLength: Math.max(600, settings.data.bufferSize * 6), // allow generous growth
        backBufferLength: 0,             // never discard back buffer (instant seek-back)
        maxBufferSize: 200 * 1000 * 1000, // 200MB memory cap — generous for continuous cache
        maxBufferHole: 0.5,              // tolerate small gaps in buffer
        nudgeMaxRetry: 10,               // nudge through stalls
        nudgeOffset: 0.2,
        // ── ABR (prefer higher quality, assume fast connection) ──
        abrEwmaDefaultEstimate: 2e6,     // assume 2 Mbps by default
        abrBandWidthFactor: 0.9,
        abrBandWidthUpFactor: 0.7,
        // ── error recovery ──
        manifestLoadingMaxRetry: 4,
        manifestLoadingRetryDelay: 1000,
        levelLoadingMaxRetry: 4,
        levelLoadingRetryDelay: 1000,
        fragLoadingMaxRetry: 6,
        fragLoadingRetryDelay: 1000,
        // ── preload ──
        startFragPrefetch: true,         // prefetch first fragment while loading manifest
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

    // Auto-play — BUT skip if we have savedVideoState (PiP↔fullscreen switch).
    // In that case restoreVideoState() (called from @loadedmetadata) will handle
    // both the seek AND the play() call, avoiding a "play from start then snap back" jank.
    if (savedVideoState.value) {
      pushLog("savedVideoState present → deferring play() to restoreVideoState()");
    } else {
      pushLog("calling video.play()…");
      video.play().then(() => pushLog("play() succeeded")).catch((e) => pushLog(`play() rejected: ${e?.name || e?.message || e}`));
    }
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
const savedVideoState = ref<{ time: number; paused: boolean; muted: boolean; volume?: number } | null>(null);

const saveVideoState = () => {
  const v = videoRef.value;
  if (v) {
    savedVideoState.value = {
      time: v.currentTime,
      paused: v.paused,
      muted: v.muted,
      volume: v.volume,
    };
    // Also sync isPlaying immediately
    isPlaying.value = !v.paused;
    pushLog(`saveVideoState: time=${Math.round(v.currentTime)}s, paused=${v.paused}, muted=${v.muted}, vol=${v.volume}`);
  }
};
const restoreVideoState = () => {
  const v = videoRef.value;
  if (!v) return;
  // First try saved state (from PiP ↔ fullscreen switch)
  if (savedVideoState.value) {
    const s = savedVideoState.value;
    pushLog(`restoreVideoState: restoring saved state time=${Math.round(s.time)}s, paused=${s.paused}`);
    // Restore volume + mute first (no seeking needed)
    if (typeof s.volume === "number") {
      v.volume = s.volume;
      volume.value = s.volume;
    }
    v.muted = s.muted;
    isMuted.value = s.muted;

    // Seek to saved time BEFORE play/pause — this avoids the "play-from-start
    // then snap back" jank that happens when calling play() before seek.
    // We use a microtask-deferred seek to ensure the HLS manifest is parsed
    // first (setting currentTime before manifestParsed is a no-op for HLS).
    const doSeekAndPlay = () => {
      try {
        if (s.time > 1) {
          v.currentTime = s.time;
        }
      } catch (err) {
        pushLog(`restoreVideoState: seek failed: ${err}`);
      }
      isPlaying.value = !s.paused;
      if (!s.paused) {
        v.play().then(() => { isPlaying.value = true; }).catch((e) => {
          isPlaying.value = false;
          pushLog(`restoreVideoState: play() rejected: ${e?.name || e?.message || e}`);
        });
      } else {
        v.pause();
        isPlaying.value = false;
      }
    };

    // For HLS sources, wait for MANIFEST_PARSED before seeking.
    // For direct media, we can seek immediately after metadata loads.
    if (hls) {
      // Defer to next tick — by then hls.js should have attached + parsed manifest
      setTimeout(doSeekAndPlay, 50);
    } else {
      doSeekAndPlay();
    }

    savedVideoState.value = null;
    return;
  }
  // Otherwise restore from library playback progress (fresh open)
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
  // Reset hover state so PiP starts with controls hidden (clean look)
  videoHovered.value = false;
  mouseIdle.value = false;
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  pipMode.value = true;
  ui.openDetail(bangumiID.value!, ui.player.cover);
};
const exitPip = () => {
  saveVideoState();
  videoHovered.value = false;
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
const pipPos = ref({ x: window.innerWidth - 380, y: window.innerHeight - 220 });
let pipDragging = false;
let pipDragStart = { x: 0, y: 0 };
// PiP width adapts to window size (smaller on narrow screens)
const pipWidth = computed(() => Math.min(360, Math.max(240, Math.floor(window.innerWidth * 0.3))));
const pipHeight = computed(() => Math.floor(pipWidth.value * 9 / 16));
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
  window.addEventListener("mousemove", onGlobalMouseMove);
  window.addEventListener("mouseup", onGlobalMouseUp);
});
onBeforeUnmount(() => {
  window.removeEventListener("mousemove", onPipMouseMove);
  window.removeEventListener("mouseup", onPipMouseUp);
  window.removeEventListener("mousemove", onGlobalMouseMove);
  window.removeEventListener("mouseup", onGlobalMouseUp);
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
    <div v-if="open && bangumiID != null && !pipMode" class="fixed inset-0 z-[100] flex flex-col bg-black">
      <!-- titlebar (same as main app) — transparent overlay, no border -->
      <TitleBar />

      <!-- body — video area extends edge-to-edge, header overlays on top -->
      <div class="flex min-h-0 flex-1 gap-0 md:flex-row">
        <!-- video (fills the entire left area, edge-to-edge) -->
        <div class="relative min-h-0 min-w-0 flex-1 bg-black">
            <!-- top overlay header — transparent, fused with video.
                 Header zone is detected via the onHeaderMouseMove handler
                 below, which sets mouseInHeaderZone=true. This is more
                 reliable than relying on the video container's mousemove
                 (which doesn't fire when the cursor is over NButton children
                 with pointer-events-auto). -->
            <Transition name="controls">
              <div
                v-if="controlsVisible || vodLoading || vodIsError || sources.length === 0"
                @mousemove="onHeaderMouseMove"
                class="pointer-events-none absolute inset-x-0 top-0 z-30 flex items-start justify-between gap-3 bg-gradient-to-b from-black/80 via-black/40 to-transparent px-4 pb-10 pt-3"
              >
                <div class="pointer-events-auto flex min-w-0 items-center gap-3">
                  <NButton
                    circle
                    quaternary
                    :focusable="false"
                    class="!h-9 !w-9 shrink-0 !text-white hover:!bg-white/20"
                    aria-label="最小化"
                    @click="closeOrPip"
                  >
                    <template #icon>
                      <NIcon size="16"><X /></NIcon>
                    </template>
                  </NButton>
                  <!-- 番剧名称 · 第N话 (同一行, 中点分隔) -->
                  <div class="flex min-w-0 items-baseline gap-2">
                    <p class="line-clamp-1 text-sm font-bold text-white drop-shadow">{{ ui.player.title }}</p>
                    <span class="text-white/30">·</span>
                    <p class="shrink-0 text-xs text-white/70">第 {{ episode }} 话</p>
                  </div>
                </div>
                <div class="pointer-events-auto flex items-center gap-2">
                  <NButton
                    size="small"
                    quaternary
                    :focusable="false"
                    class="!rounded-full !px-3 !py-1.5 !text-xs !font-medium !text-white/70 hover:!bg-white/15 hover:!text-white"
                    :class="showLog ? '!bg-tertiary/30 !text-tertiary-foreground' : ''"
                    @click="toggleLog"
                  >
                    日志
                  </NButton>
                  <NButton
                    size="small"
                    quaternary
                    :focusable="false"
                    class="!hidden !rounded-full !px-3 !py-1.5 !text-xs !font-medium !text-white/70 hover:!bg-white/15 hover:!text-white sm:!block"
                    @click="enterPip"
                  >
                    查看详情
                  </NButton>
                </div>
              </div>
            </Transition>

            <!-- Loading / error / empty states -->
            <div v-if="vodLoading" class="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 text-white/70">
              <Loader2 class="h-10 w-10 animate-spin text-primary" />
              <p class="text-sm">正在加载播放源…</p>
            </div>
            <div v-else-if="vodIsError" class="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 px-6 text-center text-white/70">
              <NIcon :size="40" color="var(--destructive)"><AlertCircle /></NIcon>
              <p class="text-sm">播放源加载失败</p>
              <NButton
                size="small"
                :focusable="false"
                class="!rounded-full !bg-white/10 !px-4 !py-1.5 !text-xs !text-white hover:!bg-white/20"
                @click="vodRefetch()"
              >
                重试
              </NButton>
            </div>
            <NEmpty
              v-else-if="sources.length === 0"
              class="absolute inset-0 z-20 !flex flex-col items-center justify-center gap-2 !text-white/60"
              description="暂无可用的播放源"
            >
              <template #icon>
                <NIcon :size="40"><AlertCircle /></NIcon>
              </template>
            </NEmpty>
            <template v-else>
              <div
                ref="videoContainerRef"
                class="absolute inset-0 bg-black"
                @mousemove="onVideoMouseMove"
                @mouseleave="onVideoMouseLeave"
                @fullscreenchange="onFullscreenChange"
              >
                <video ref="videoRef" autoplay playsinline preload="auto" @play="handlePlay" @pause="handlePause" @error="handleVideoError" @timeupdate="handleTimeUpdate" @seeked="handleSeeked" @loadedmetadata="restoreVideoState" @click="togglePlay" class="h-full w-full object-contain" />
                <div v-if="videoError" class="absolute inset-x-0 bottom-16 mx-auto max-w-md rounded-xl bg-destructive/90 px-4 py-2 text-center text-xs text-white">
                  {{ videoError }}
                </div>

                <!-- custom control bar (bottom, visible on hover / non-idle) -->
                <Transition name="controls">
                  <div v-if="controlsVisible" class="absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-black via-black/70 to-transparent pt-10">
                    <!-- progress bar at the very bottom edge (global drag) -->
                    <div
                      class="group relative h-1 w-full cursor-pointer bg-white/15 transition-[height] duration-150 ease-out group-hover:h-2"
                      @mousedown="onProgressMouseDown"
                    >
                      <div class="absolute inset-y-0 left-0 bg-primary/80" :style="{ width: progressPct + '%' }" />
                    </div>
                    <!-- control buttons row -->
                    <div class="flex items-center gap-0.5 px-3 py-2">
                      <!-- play/pause -->
                      <NTooltip placement="top">
                        <template #trigger>
                          <NButton
                            circle
                            quaternary
                            :focusable="false"
                            class="!h-8 !w-8 !text-white hover:!bg-white/15"
                            :aria-label="isPlaying ? '暂停' : '播放'"
                            @click="togglePlay"
                          >
                            <template #icon>
                              <NIcon size="16">
                                <Pause v-if="isPlaying" />
                                <Play v-else class="fill-current" />
                              </NIcon>
                            </template>
                          </NButton>
                        </template>
                        <span>{{ isPlaying ? '暂停' : '播放' }}</span>
                      </NTooltip>
                      <!-- divider -->
                      <div class="mx-1 h-5 w-px bg-white/15" />
                      <!-- volume control with hover slider -->
                      <div
                        class="relative flex items-center"
                        @mouseenter="showVolumeSlider = true"
                        @mouseleave="showVolumeSlider = false"
                        @wheel.prevent="onVolumeWheel"
                      >
                        <NTooltip placement="top">
                          <template #trigger>
                            <NButton
                              circle
                              quaternary
                              :focusable="false"
                              class="!h-8 !w-8 !text-white hover:!bg-white/15"
                              :aria-label="isMuted ? '取消静音' : '静音'"
                              @click="toggleMute"
                            >
                              <template #icon>
                                <NIcon size="16">
                                  <VolumeX v-if="isMuted || volume === 0" />
                                  <Volume2 v-else />
                                </NIcon>
                              </template>
                            </NButton>
                          </template>
                          <span>{{ isMuted ? '取消静音' : '静音' }}</span>
                        </NTooltip>
                        <!-- vertical volume slider (Naive UI NSlider) -->
                        <Transition name="vol-slider">
                          <div v-if="showVolumeSlider" class="absolute bottom-10 left-1/2 -translate-x-1/2 flex flex-col items-center gap-2 rounded-lg bg-black/80 p-2 backdrop-blur-md">
                            <NSlider
                              :value="isMuted ? 0 : volume"
                              :min="0"
                              :max="1"
                              :step="0.05"
                              vertical
                              :tooltip="false"
                              style="height: 80px;"
                              @update:value="setVolume"
                            />
                            <span class="text-[9px] font-mono tabular-nums text-white/70">{{ Math.round((isMuted ? 0 : volume) * 100) }}%</span>
                          </div>
                        </Transition>
                      </div>
                      <!-- seek back/forward -->
                      <NTooltip placement="top">
                        <template #trigger>
                          <NButton
                            circle
                            quaternary
                            :focusable="false"
                            class="!hidden !h-8 !w-8 !text-white hover:!bg-white/15 sm:!flex"
                            aria-label="后退10秒"
                            @click="seekBy(-10)"
                          >
                            <template #icon>
                              <NIcon size="16"><RotateCcw /></NIcon>
                            </template>
                          </NButton>
                        </template>
                        <span>后退10秒</span>
                      </NTooltip>
                      <NTooltip placement="top">
                        <template #trigger>
                          <NButton
                            circle
                            quaternary
                            :focusable="false"
                            class="!hidden !h-8 !w-8 !text-white hover:!bg-white/15 sm:!flex"
                            aria-label="前进10秒"
                            @click="seekBy(10)"
                          >
                            <template #icon>
                              <NIcon size="16"><RotateCw /></NIcon>
                            </template>
                          </NButton>
                        </template>
                        <span>前进10秒</span>
                      </NTooltip>
                      <!-- time display -->
                      <span class="ml-1.5 font-mono text-[11px] tabular-nums text-white/70">{{ fmtTime(currentTime) }} <span class="text-white/30">/</span> {{ fmtTime(duration) }}</span>
                      <!-- spacer -->
                      <div class="flex-1" />
                      <!-- latency test -->
                      <NButton
                        size="tiny"
                        quaternary
                        :focusable="false"
                        :disabled="latencyTesting"
                        class="!h-8 !px-2 !text-[11px] !font-medium !text-white/60 hover:!bg-white/15 hover:!text-white disabled:!opacity-50"
                        aria-label="测速"
                        @click="retestLatency"
                      >
                        <template #icon>
                          <NIcon size="12">
                            <Loader2 v-if="latencyTesting" class="animate-spin" />
                            <Zap v-else />
                          </NIcon>
                        </template>
                        测速
                      </NButton>
                      <!-- fullscreen -->
                      <NTooltip placement="top">
                        <template #trigger>
                          <NButton
                            circle
                            quaternary
                            :focusable="false"
                            class="!h-8 !w-8 !text-white hover:!bg-white/15"
                            :aria-label="isFullscreen ? '退出全屏' : '全屏'"
                            @click="toggleFullscreen"
                          >
                            <template #icon>
                              <NIcon size="16">
                                <Minimize v-if="isFullscreen" />
                                <Maximize v-else />
                              </NIcon>
                            </template>
                          </NButton>
                        </template>
                        <span>{{ isFullscreen ? '退出全屏' : '全屏' }}</span>
                      </NTooltip>
                    </div>
                  </div>
                </Transition>

                <!-- slim progress bar when controls hidden (always at bottom, no time) -->
                <Transition name="progress">
                  <div v-if="!controlsVisible && duration > 0" class="absolute inset-x-0 bottom-0 z-10">
                    <div class="group relative h-1 w-full cursor-pointer bg-white/20 transition-[height] duration-150 ease-out group-hover:h-1.5" @click="(e: any) => { seekBarEl = e.currentTarget; commitSeek(e.clientX); }">
                      <div class="absolute inset-y-0 left-0 bg-primary/80" :style="{ width: progressPct + '%' }" />
                    </div>
                  </div>
                </Transition>
              </div>
            </template>
        </div>

        <!-- side panel (collapsible) — pure native elements for max perf -->
        <div class="relative flex shrink-0 items-stretch">
          <!-- vertical collapse/expand toggle button -->
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
          <!-- header row: 剧集列表 + prev/next in one bar -->
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

          <!-- 播放源 (compact) -->
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
            <!-- current source chip -->
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
            <!-- expanded sources list -->
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
            <!-- latency summary -->
            <div v-if="latencyDone && !latencyTesting && Object.keys(sourceLatencies).length > 0" class="mt-1.5 rounded-md bg-white/5 px-2 py-1 text-[9px] text-white/40">
              <template v-if="Object.values(sourceLatencies).some(v => v !== null)">
                测速完成 · 最低: {{ Math.min(...Object.values(sourceLatencies).filter(v => v !== null) as number[]) }}ms
              </template>
              <template v-else>
                测速完成 · 所有源均无法连接
              </template>
            </div>
          </div>

          <!-- divider -->
          <div class="mx-3 h-px bg-white/5" />

          <!-- episode list (native buttons, custom design) -->
          <div class="min-h-0 flex-1 overflow-y-auto px-2 py-2">
            <!-- log panel (toggleable) -->
            <div v-if="showLog" class="mb-2 rounded-lg bg-black/60 p-2 font-mono text-[10px] leading-relaxed text-green-300 max-h-48 overflow-y-auto">
              <div v-for="(line, i) in logLines" :key="i" class="whitespace-pre-wrap break-all">{{ line }}</div>
            </div>
            <div
              v-if="!episodes || episodes.length === 0"
              class="flex flex-col items-center justify-center gap-2 py-10 text-white/40"
            >
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
                <span
                  :class="cn(
                    'flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[11px] font-semibold tabular-nums transition-colors',
                    ep.sort === episode
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-white/5 text-white/60 group-hover:bg-white/10 group-hover:text-white/80'
                  )"
                >
                  {{ ep.sort }}
                </span>
                <p
                  :class="cn(
                    'min-w-0 flex-1 truncate text-xs',
                    ep.sort === episode ? 'font-semibold text-white' : 'text-white/70'
                  )"
                >
                  {{ ep.title || `第 ${ep.sort} 话` }}
                </p>
                <Play
                  v-if="ep.sort === episode"
                  class="h-3 w-3 shrink-0 fill-current text-primary"
                />
              </button>
            </div>
          </div>
            </div>
          </Transition>
        </div>
      </div>
    </div>
  </Transition>

  <!-- Picture-in-picture floating window (draggable, 16:9) -->
  <Transition name="pip">
    <div
      v-if="open && bangumiID != null && pipMode"
      class="fixed z-[100] overflow-hidden rounded-xl bg-black shadow-2xl ring-1 ring-white/10"
      :style="{ left: pipPos.x + 'px', top: pipPos.y + 'px', width: pipWidth + 'px' }"
    >
      <!-- video (16:9 aspect ratio, fills width) -->
      <div ref="videoContainerRef" class="relative aspect-video w-full bg-black" @mousemove="onVideoMouseMove" @mouseleave="onVideoMouseLeave" @fullscreenchange="onFullscreenChange">
        <video ref="videoRef" autoplay playsinline preload="auto" @play="handlePlay" @pause="handlePause" @error="handleVideoError" @timeupdate="handleTimeUpdate" @seeked="handleSeeked" @loadedmetadata="restoreVideoState" @click="togglePlay" class="h-full w-full" />
        <!-- draggable overlay header — only visible on hover -->
        <Transition name="pip-controls">
          <div
            v-if="videoHovered"
            class="absolute inset-x-0 top-0 z-20 flex cursor-move items-center justify-between bg-gradient-to-b from-black/70 to-transparent px-2 py-1.5"
            @mousedown="onPipMouseDown"
          >
            <span class="line-clamp-1 text-[10px] font-semibold text-white">{{ ui.player.title }} · 第 {{ episode }} 话</span>
            <div class="flex items-center gap-1">
              <NButton
                circle
                quaternary
                :focusable="false"
                class="!h-5 !w-5 !bg-white/20 !text-white hover:!bg-white/40"
                aria-label="展开"
                @click="exitPip"
              >
                <template #icon>
                  <NIcon size="10"><Maximize /></NIcon>
                </template>
              </NButton>
              <NButton
                circle
                quaternary
                :focusable="false"
                class="!h-5 !w-5 !bg-white/20 !text-white hover:!bg-destructive"
                aria-label="关闭"
                @click="closeFromPip"
              >
                <template #icon>
                  <NIcon size="10"><X /></NIcon>
                </template>
              </NButton>
            </div>
          </div>
        </Transition>
        <!-- play/pause indicator (center, shows on click) -->
        <Transition name="pip-controls">
          <div v-if="videoHovered && !isPlaying" class="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div class="flex h-10 w-10 items-center justify-center rounded-full bg-black/50">
              <Play class="h-5 w-5 fill-current text-white" />
            </div>
          </div>
        </Transition>
        <!-- mini progress bar at bottom — only visible on hover -->
        <Transition name="pip-controls">
          <div v-if="videoHovered" class="absolute inset-x-0 bottom-0 h-1 bg-white/20" @click.stop="(e: any) => { seekBarEl = e.currentTarget.parentElement; commitSeek(e.clientX); }">
            <div class="h-full bg-primary/80" :style="{ width: progressPct + '%' }" />
          </div>
        </Transition>
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
.vol-slider-enter-active,
.vol-slider-leave-active { transition: opacity 0.15s ease, transform 0.15s ease; }
.vol-slider-enter-from,
.vol-slider-leave-to { opacity: 0; transform: translateY(8px); }
.pip-controls-enter-active,
.pip-controls-leave-active { transition: opacity 0.2s ease; }
.pip-controls-enter-from,
.pip-controls-leave-to { opacity: 0; }
</style>
