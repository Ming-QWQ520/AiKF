import { createApp } from "vue";
import { createPinia } from "pinia";
import { gsap } from "gsap";
import naive from "naive-ui";
import App from "./App.vue";
import "./assets/globals.css";
import { useLibraryStore } from "@/stores/library";
import { useSettingsStore } from "@/stores/settings";
import { registerGlobalUX } from "@/lib/global-ux";
import { registerPreloadImg } from "@/lib/preload-img";

// GSAP global performance tuning
gsap.config({ force3D: true, nullTargetWarn: false });
gsap.ticker.lagSmoothing(500); // smooth out frame drops

const app = createApp(App);
const pinia = createPinia();
app.use(pinia);

// Naive UI — registered globally so NButton, NIcon, NSlider etc. are
// available inside the player & sidebar templates.
app.use(naive);

// Hydrate persisted library data before mounting.
useLibraryStore().hydrate();
// Load persisted settings (theme, playback, background) before mounting.
useSettingsStore();

// Global UX: block web shortcuts + right-click (always on, not configurable),
// spacebar scroll, img draggable=false.
registerGlobalUX(app);
// Image preload directive (fetches ~300px before entering viewport).
registerPreloadImg(app);

app.mount("#app");
