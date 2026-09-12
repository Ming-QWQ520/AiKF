import { createApp, watch } from "vue";
import { createPinia } from "pinia";
import { gsap } from "gsap";
import naive from "naive-ui";
import App from "./App.vue";
import "./assets/globals.css";
import { i18n, applyLocale } from "@/i18n";
import { useLibraryStore } from "@/stores/library";
import { useSettingsStore } from "@/stores/settings";
import { registerGlobalUX } from "@/lib/global-ux";
import { registerPreloadImg } from "@/lib/preload-img";
import { refreshRuntimeConfig } from "@/lib/anich/client";
import { AIKF_VERSION, AIKF_BUILD_TAG } from "@/lib/version";

// Startup banner — makes the running build identifiable in the devtools
// console at a glance. If this banner is absent, you are on an old build.
console.log(
  `%c AiKF ${AIKF_VERSION} %c ${AIKF_BUILD_TAG} %c`,
  "background:#e879f9;color:#fff;font-weight:bold;border-radius:3px 0 0 3px;padding:2px 6px",
  "background:#27272a;color:#e4e4e7;padding:2px 6px;border-radius:0 3px 3px 0",
  "color:inherit",
);

// GSAP global performance tuning
gsap.config({ force3D: true, nullTargetWarn: false });
gsap.ticker.lagSmoothing(500); // smooth out frame drops

const app = createApp(App);
const pinia = createPinia();
app.use(pinia);

// 全局错误兜底：组件渲染/生命周期抛错时记录可读日志（避免静默白屏难排查）。
// 注意：不会恢复渲染，但 devtools/日志中会出现 [AiKF] 前缀的完整错误栈。
app.config.errorHandler = (err, _instance, info) => {
  console.error(`[AiKF] Vue error (${info}):`, err);
};

// Naive UI — registered globally so NButton, NIcon, NSlider etc. are
// available inside the player & sidebar templates.
app.use(naive);

// vue-i18n — 多语言支持（默认中文，设置页可切换；持久化在 settings store）
app.use(i18n);

// Hydrate persisted library data before mounting.
useLibraryStore().hydrate();
// Load persisted settings (theme, playback, background) before mounting.
const settingsStore = useSettingsStore();
// 启动时应用持久化的界面语言（默认 zh-CN），并在设置变更时实时切换
applyLocale(settingsStore.data.language);
watch(() => settingsStore.data.language, (lang) => applyLocale(lang));

// Global UX: block web shortcuts + right-click (always on, not configurable),
// spacebar scroll, img draggable=false.
registerGlobalUX(app);
// Image preload directive (fetches ~300px before entering viewport).
registerPreloadImg(app);

// AniCh 域名自愈：启动 + 每 30 分钟拉 /check/api，上游轮换域名时自动切换
// （静默失败，主站优先、固定配置 URL 兜底）。
refreshRuntimeConfig().catch(() => {});
setInterval(() => refreshRuntimeConfig().catch(() => {}), 30 * 60 * 1000);

app.mount("#app");
