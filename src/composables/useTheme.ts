import { computed, watch } from "vue";
import { useSettingsStore } from "@/stores/settings";

/**
 * 主题系统（v0.1.0 统一重构）：
 *
 * 单一数据源 = settings store 的 `theme` 字段（"light" | "dark" | "system"）。
 * - 设置页「外观」三选项直接改 settings.theme
 * - 搜索栏右侧的切换按键也写 settings.theme（在 dark/light 之间翻转；
 *   若当前是「跟随系统」则按当前生效主题取反）
 * → 两处状态永远同步，不再出现各存各的localStorage导致的不一致。
 */

type Theme = "light" | "dark";

function resolveTheme(mode: "light" | "dark" | "system"): Theme {
  if (mode === "system") {
    return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  return mode;
}

function apply(t: Theme) {
  const root = document.documentElement;
  if (t === "dark") root.classList.add("dark");
  else root.classList.remove("dark");
}

/** 当前生效主题（由 settings.theme 解析而来，只读） */
const theme = computed<Theme>(() => resolveTheme(useSettingsStore().data.theme));

export function useTheme() {
  const settings = useSettingsStore();

  const setMode = (mode: "light" | "dark" | "system") => {
    settings.update("theme", mode);
  };

  const setTheme = (t: Theme) => {
    settings.update("theme", t);
  };

  /** 切换深色/浅色（跟随系统时按当前生效主题取反） */
  const toggle = () => {
    settings.update("theme", theme.value === "dark" ? "light" : "dark");
  };

  return { theme, setTheme, setMode, toggle };
}

// Apply on module load — watches the settings store so theme changes from
// ANY entry point (settings page / toggle button) update the UI live.
export function initThemeOnLoad() {
  apply(theme.value);

  watch(theme, (t) => apply(t));

  // React to OS theme changes while in "system" mode
  if (window.matchMedia) {
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    mq.addEventListener("change", () => {
      if (useSettingsStore().data.theme === "system") apply(theme.value);
    });
  }
}
