import { ref, watch } from "vue";
import { useSettingsStore } from "@/stores/settings";

type Theme = "light" | "dark";
const STORAGE_KEY = "aikf-theme";

const theme = ref<Theme>(initTheme());

function initTheme(): Theme {
  try {
    const saved = localStorage.getItem(STORAGE_KEY) as Theme | null;
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    /* ignore */
  }
  // default dark (matches the Sakura Glass design)
  return "dark";
}

/** Resolve the effective theme from the settings store's theme mode. */
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

export function useTheme() {
  const setTheme = (t: Theme) => {
    theme.value = t;
    try {
      localStorage.setItem(STORAGE_KEY, t);
    } catch {
      /* ignore */
    }
    apply(t);
  };

  const toggle = () => setTheme(theme.value === "dark" ? "light" : "dark");

  return { theme, setTheme, toggle };
}

// apply on module load — also watches the settings store so changing the
// "theme" setting (light/dark/system) in Settings view updates the UI live.
export function initThemeOnLoad() {
  apply(theme.value);

  // Watch the settings store for theme changes
  try {
    const settings = useSettingsStore();
    watch(
      () => settings.data.theme,
      (mode) => {
        const resolved = resolveTheme(mode);
        theme.value = resolved;
        try {
          localStorage.setItem(STORAGE_KEY, resolved);
        } catch {
          /* ignore */
        }
        apply(resolved);
      }
    );

    // Also react to OS theme changes when in "system" mode
    if (window.matchMedia) {
      const mq = window.matchMedia("(prefers-color-scheme: light)");
      mq.addEventListener("change", () => {
        if (settings.data.theme === "system") {
          const resolved = resolveTheme("system");
          theme.value = resolved;
          apply(resolved);
        }
      });
    }
  } catch {
    /* settings store not ready yet — fall back to plain watch */
    watch(theme, apply);
  }
}
