import { ref, watch } from "vue";

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

// apply on module load (called from App.vue setup to ensure DOM exists)
export function initThemeOnLoad() {
  apply(theme.value);
  watch(theme, apply);
}
