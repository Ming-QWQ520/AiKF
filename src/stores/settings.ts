import { defineStore } from "pinia";
import { ref, watch } from "vue";

/**
 * App-wide settings, persisted to localStorage.
 *
 * Settings currently exposed:
 *  - autoplay       : auto-play video when opening the player
 *  - hardwareAccel  : hint for video hardware acceleration (sets CSS `translateZ(0)` on video)
 *  - defaultSource  : preferred playback source host keyword ("adkwai" | "anich" | "auto")
 *  - bufferSize     : HLS forward buffer length in seconds (60 | 120 | 300 | 600)
 *  - theme          : "light" | "dark" | "system"
 *  - background     : custom background config (image url + opacity + blur)
 *
 * NOTE: web shortcuts (Ctrl+S/P/F…) and right-click are ALWAYS blocked and
 *       NOT configurable — see src/lib/global-ux.ts.
 */

export type DefaultSource = "auto" | "adkwai" | "anich";
export type BufferSize = 60 | 120 | 300 | 600;
export type ThemeMode = "light" | "dark" | "system";

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
  theme: ThemeMode;
  background: BackgroundSettings;
}

const STORAGE_KEY = "aikf-settings";

const DEFAULTS: AppSettings = {
  autoplay: true,
  hardwareAccel: true,
  defaultSource: "auto",
  bufferSize: 120,
  theme: "dark",
  background: {
    enabled: false,
    url: "",
    opacity: 40,
    blur: 0,
    scale: 100,
  },
};

function load(): AppSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    // deep-merge background to avoid missing fields
    return {
      ...DEFAULTS,
      ...parsed,
      background: { ...DEFAULTS.background, ...(parsed.background ?? {}) },
    };
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

  function reset() {
    data.value = { ...DEFAULTS, background: { ...DEFAULTS.background } };
    persist();
  }

  // Persist on any change
  watch(data, persist, { deep: true });

  return { data, update, updateBackground, reset };
});
