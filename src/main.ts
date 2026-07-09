import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";
import "./assets/globals.css";
import { useLibraryStore } from "@/stores/library";
import { registerGlobalUX } from "@/lib/global-ux";
import { registerPreloadImg } from "@/lib/preload-img";

const app = createApp(App);
const pinia = createPinia();
app.use(pinia);

// Hydrate persisted library data before mounting.
useLibraryStore().hydrate();

// Global UX: disable web shortcuts (keep Ctrl+C/V), spacebar scroll, img draggable=false.
registerGlobalUX(app);
// Image preload directive (fetches ~200px before entering viewport).
registerPreloadImg(app);

app.mount("#app");
