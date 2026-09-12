<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import {
  Settings as SettingsIcon,
  Palette,
  Sun,
  Moon,
  Monitor,
  RotateCcw,
  Zap,
  ImageIcon,
  Upload,
  Eye,
  EyeOff,
  Droplet,
  Focus,
  Maximize2,
  Languages,
  Github,
  ExternalLink,
} from "lucide-vue-next";
import { useSettingsStore, type ThemeMode, type Language } from "@/stores/settings";
import { LOCALE_OPTIONS } from "@/i18n";
import { AIKF_VERSION } from "@/lib/version";
import { cn } from "@/lib/utils";
import ToggleSwitch from "@/components/ToggleSwitch.vue";

const settings = useSettingsStore();
const s = computed(() => settings.data);
const bg = computed(() => settings.data.background);
const { t } = useI18n();

const themeOptions: { value: ThemeMode; labelKey: string; icon: any }[] = [
  { value: "light", labelKey: "theme.light", icon: Sun },
  { value: "dark", labelKey: "theme.dark", icon: Moon },
  { value: "system", labelKey: "theme.system", icon: Monitor },
];

// — Tauri runtime detection —
const isTauri =
  typeof window !== "undefined" &&
  ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);

// — background image selection —
// Uses the Tauri dialog plugin to pick a local file, then converts its path
// to a URL via convertFileSrc (asset: protocol) so the <img>/CSS can load it
// directly from disk — NO data URL, NO file copy.
const urlInput = ref(bg.value.url);
const pickedFileName = ref("");

// Keep urlInput in sync if the store changes elsewhere
watch(() => bg.value.url, (v) => { if (v !== urlInput.value) urlInput.value = v; });

const pickFile = async () => {
  if (!isTauri) {
    // Fallback: use a plain file input (browser/preview)
    fileInput.value?.click();
    return;
  }
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const { convertFileSrc } = await import("@tauri-apps/api/core");
    const selected = await open({
      multiple: false,
      filters: [{ name: t("settings.imageFilter"), extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp", "avif"] }],
    });
    if (typeof selected === "string" && selected) {
      const fileUrl = convertFileSrc(selected);
      urlInput.value = fileUrl;
      // extract just the filename for display
      const parts = selected.replace(/\\/g, "/").split("/").pop() || selected;
      pickedFileName.value = parts;
      settings.updateBackground("url", fileUrl);
      if (!bg.value.enabled) settings.updateBackground("enabled", true);
    }
  } catch (e) {
    console.error("dialog open failed:", e);
  }
};

// Fallback file input handler (browser/preview only)
const fileInput = ref<HTMLInputElement | null>(null);
const onFileChange = (e: Event) => {
  const target = e.target as HTMLInputElement;
  const file = target.files?.[0];
  if (!file) return;
  // In browser, create an object URL (NOT a data URL — no base64 bloat)
  const objUrl = URL.createObjectURL(file);
  urlInput.value = objUrl;
  pickedFileName.value = file.name;
  settings.updateBackground("url", objUrl);
  if (!bg.value.enabled) settings.updateBackground("enabled", true);
};

const applyUrl = () => {
  settings.updateBackground("url", urlInput.value);
  if (urlInput.value && !bg.value.enabled) settings.updateBackground("enabled", true);
};

const clearBackground = () => {
  urlInput.value = "";
  pickedFileName.value = "";
  settings.updateBackground("url", "");
  settings.updateBackground("enabled", false);
};

// — open external URL (GitHub / Douyin) via Tauri opener plugin —
const GITHUB_URL = "https://github.com/Ming-QWQ520/AiKF";
const DOUYIN_URL = "https://v.douyin.com/uMPJmKswYwM";

const openExternalUrl = async (url: string) => {
  if (isTauri) {
    try {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(url);
    } catch (e) {
      console.error("openUrl failed:", e);
      // fallback: open in default browser via window.open
      window.open(url, "_blank");
    }
  } else {
    window.open(url, "_blank");
  }
};
</script>

<template>
  <div class="mx-auto max-w-3xl">
    <!-- Header -->
    <div class="mb-6 flex items-center gap-3">
      <span class="flex h-12 w-12 items-center justify-center rounded-xl bg-muted text-muted-foreground ring-1 ring-border">
        <SettingsIcon class="h-6 w-6" />
      </span>
      <div>
        <h2 class="text-2xl font-bold tracking-tight text-foreground">{{ $t('settings.title') }}</h2>
        <p class="text-sm text-muted-foreground">{{ $t('settings.subtitle') }}</p>
      </div>
    </div>

    <!-- ─── Appearance（主题三态与搜索栏右侧切换按键实时同步）─── -->
    <section class="surface mb-4 rounded-2xl p-5">
      <h3 class="mb-4 flex items-center gap-2 text-sm font-semibold text-foreground">
        <Palette class="h-4 w-4 text-primary" /> {{ $t('settings.appearance') }}
      </h3>

      <!-- language -->
      <div class="mb-4">
        <p class="mb-2 text-xs font-medium text-muted-foreground">{{ $t('settings.language') }}</p>
        <div class="grid grid-cols-2 gap-3">
          <button
            v-for="opt in LOCALE_OPTIONS" :key="opt.value"
            @click="settings.update('language', opt.value as Language)"
            :class="cn('flex items-center justify-center gap-2 rounded-xl px-3 py-3 transition-colors', s.language === opt.value ? 'bg-primary/10 ring-1 ring-primary/40' : 'bg-muted hover:bg-accent')"
          >
            <Languages class="h-4 w-4" :class="s.language === opt.value ? 'text-primary' : 'text-muted-foreground'" />
            <span :class="cn('text-xs font-semibold', s.language === opt.value ? 'text-primary' : 'text-foreground')">{{ opt.label }}</span>
          </button>
        </div>
        <p class="mt-1.5 text-[11px] text-muted-foreground">{{ $t('settings.languageHint') }}</p>
      </div>

      <!-- theme mode -->
      <div class="mb-4">
        <p class="mb-2 text-xs font-medium text-muted-foreground">{{ $t('settings.themeHint') }}</p>
        <div class="grid grid-cols-3 gap-3">
          <button
            v-for="opt in themeOptions" :key="opt.value"
            @click="settings.update('theme', opt.value)"
            :class="cn('flex flex-col items-center gap-2 rounded-xl px-3 py-4 transition-colors', s.theme === opt.value ? 'bg-primary/10 ring-1 ring-primary/40' : 'bg-muted hover:bg-accent')"
          >
            <span :class="cn('flex h-10 w-10 items-center justify-center rounded-lg', s.theme === opt.value ? 'bg-primary text-primary-foreground' : 'text-muted-foreground')">
              <component :is="opt.icon" class="h-5 w-5" />
            </span>
            <span :class="cn('text-xs font-semibold', s.theme === opt.value ? 'text-primary' : 'text-foreground')">{{ $t(opt.labelKey) }}</span>
          </button>
        </div>
      </div>
    </section>

    <!-- ─── Custom Background ─── -->
    <section class="surface mb-4 rounded-2xl p-5">
      <h3 class="mb-4 flex items-center gap-2 text-sm font-semibold text-foreground">
        <ImageIcon class="h-4 w-4 text-primary" /> {{ $t('settings.background') }}
      </h3>
      <p class="mb-4 text-[11px] text-muted-foreground">{{ $t('settings.bgDesc') }}</p>

      <!-- enable toggle -->
      <div class="flex items-center justify-between rounded-2xl px-2 py-3 hover:bg-foreground/5">
        <div class="flex items-center gap-3">
          <span class="flex h-8 w-8 items-center justify-center rounded-lg bg-foreground/5 text-muted-foreground">
            <component :is="bg.enabled ? Eye : EyeOff" class="h-4 w-4" />
          </span>
          <div>
            <p class="text-sm font-medium text-foreground">{{ $t('settings.bgEnable') }}</p>
            <p class="text-[11px] text-muted-foreground">{{ $t('settings.bgEnableHint') }}</p>
          </div>
        </div>
        <ToggleSwitch :on="bg.enabled" @toggle="settings.updateBackground('enabled', !bg.enabled)" />
      </div>

      <!-- image source -->
      <div class="mt-3 rounded-xl bg-muted p-4">
        <!-- preview -->
        <div v-if="bg.url" class="mb-3 overflow-hidden rounded-lg ring-1 ring-border">
          <img :src="bg.url" :alt="$t('settings.bgPreview')" class="h-32 w-full object-cover" draggable="false" />
        </div>

        <!-- picked file name display -->
        <p v-if="pickedFileName" class="mb-2 truncate text-[11px] text-muted-foreground">📁 {{ pickedFileName }}</p>

        <!-- pick from local file (Tauri dialog) -->
        <input ref="fileInput" type="file" accept="image/*" class="hidden" @change="onFileChange" />
        <button
          @click="pickFile"
          class="mb-2 flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90"
        >
          <Upload class="h-4 w-4" /> {{ $t('settings.pickImage') }}
        </button>

        <!-- url input (for remote URLs or pasted asset: URLs) -->
        <div class="flex gap-2">
          <input
            v-model="urlInput"
            @blur="applyUrl"
            @keydown.enter="applyUrl"
            type="text"
            :placeholder="$t('settings.urlPlaceholder')"
            class="min-w-0 flex-1 rounded-lg bg-card px-3 py-2 text-xs text-foreground outline-none ring-1 ring-border placeholder:text-muted-foreground/60 focus:ring-2 focus:ring-primary/40"
          />
          <button
            @click="applyUrl"
            class="shrink-0 rounded-lg bg-foreground px-3 py-2 text-xs font-semibold text-background transition-opacity hover:opacity-90"
          >
            {{ $t('settings.apply') }}
          </button>
        </div>

        <!-- clear -->
        <button
          v-if="bg.url"
          @click="clearBackground"
          class="mt-2 w-full rounded-lg bg-destructive/10 px-4 py-2 text-xs font-medium text-destructive transition-colors hover:bg-destructive/20"
        >
          {{ $t('settings.clearBg') }}
        </button>
      </div>

      <!-- opacity slider -->
      <div class="mt-3 rounded-2xl px-2 py-3">
        <div class="mb-2 flex items-center gap-3">
          <span class="flex h-8 w-8 items-center justify-center rounded-lg bg-foreground/5 text-muted-foreground"><Droplet class="h-4 w-4" /></span>
          <div class="flex-1">
            <div class="flex items-center justify-between">
              <p class="text-sm font-medium text-foreground">{{ $t('settings.opacity') }}</p>
              <span class="text-xs font-mono text-muted-foreground">{{ bg.opacity }}%</span>
            </div>
          </div>
        </div>
        <input
          type="range" min="0" max="100" :value="bg.opacity"
          @input="settings.updateBackground('opacity', Number(($event.target as HTMLInputElement).value))"
          class="ml-11 w-[calc(100%-2.75rem)] accent-primary"
        />
      </div>

      <!-- blur slider -->
      <div class="rounded-2xl px-2 py-3">
        <div class="mb-2 flex items-center gap-3">
          <span class="flex h-8 w-8 items-center justify-center rounded-lg bg-foreground/5 text-muted-foreground"><Focus class="h-4 w-4" /></span>
          <div class="flex-1">
            <div class="flex items-center justify-between">
              <p class="text-sm font-medium text-foreground">{{ $t('settings.blur') }}</p>
              <span class="text-xs font-mono text-muted-foreground">{{ bg.blur }}px</span>
            </div>
          </div>
        </div>
        <input
          type="range" min="0" max="30" :value="bg.blur"
          @input="settings.updateBackground('blur', Number(($event.target as HTMLInputElement).value))"
          class="ml-11 w-[calc(100%-2.75rem)] accent-primary"
        />
      </div>

      <!-- scale slider -->
      <div class="rounded-2xl px-2 py-3">
        <div class="mb-2 flex items-center gap-3">
          <span class="flex h-8 w-8 items-center justify-center rounded-lg bg-foreground/5 text-muted-foreground"><Maximize2 class="h-4 w-4" /></span>
          <div class="flex-1">
            <div class="flex items-center justify-between">
              <p class="text-sm font-medium text-foreground">{{ $t('settings.scale') }}</p>
              <span class="text-xs font-mono text-muted-foreground">{{ bg.scale }}%</span>
            </div>
          </div>
        </div>
        <input
          type="range" min="50" max="200" :value="bg.scale"
          @input="settings.updateBackground('scale', Number(($event.target as HTMLInputElement).value))"
          class="ml-11 w-[calc(100%-2.75rem)] accent-primary"
        />
      </div>
    </section>

    <!-- ─── About ─── -->
    <section class="surface mb-4 rounded-2xl p-5">
      <h3 class="mb-4 flex items-center gap-2 text-sm font-semibold text-foreground">
        <Zap class="h-4 w-4 text-primary" /> {{ $t('settings.about') }}
      </h3>
      <div class="space-y-2.5 px-2 text-sm">
        <div class="flex items-center justify-between">
          <span class="text-muted-foreground">{{ $t('settings.appName') }}</span>
          <span class="font-medium text-foreground">{{ $t('settings.appValue') }}</span>
        </div>
        <div class="flex items-center justify-between">
          <span class="text-muted-foreground">{{ $t('settings.version') }}</span>
          <span class="font-medium text-foreground">{{ AIKF_VERSION }}</span>
        </div>
        <div class="flex items-center justify-between">
          <span class="text-muted-foreground">{{ $t('settings.dataSource') }}</span>
          <span class="font-medium text-foreground">Anich</span>
        </div>
        <div class="flex items-center justify-between">
          <span class="text-muted-foreground">{{ $t('settings.techStack') }}</span>
          <span class="font-medium text-foreground">Tauri 2 + Vue 3</span>
        </div>
        <div class="flex items-center justify-between">
          <span class="text-muted-foreground">{{ $t('settings.license') }}</span>
          <span class="font-medium text-foreground">AGPL-3.0</span>
        </div>
      </div>

      <!-- links -->
      <div class="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <!-- GitHub -->
        <button
          @click="openExternalUrl(GITHUB_URL)"
          class="state-layer flex items-center gap-2.5 rounded-xl bg-muted px-4 py-3 text-left transition-colors hover:bg-accent"
        >
          <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-foreground text-background">
            <Github class="h-4 w-4" />
          </span>
          <div class="min-w-0 flex-1">
            <p class="text-xs font-semibold text-foreground">{{ $t('settings.repo') }}</p>
            <p class="truncate text-[10px] text-muted-foreground">GitHub</p>
          </div>
          <ExternalLink class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        </button>

        <!-- Douyin -->
        <button
          @click="openExternalUrl(DOUYIN_URL)"
          class="state-layer flex items-center gap-2.5 rounded-xl bg-muted px-4 py-3 text-left transition-colors hover:bg-accent"
        >
          <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-foreground text-background">
            <svg viewBox="0 0 24 24" class="h-4 w-4 fill-current" aria-hidden="true">
              <path d="M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-5.2 1.74 2.89 2.89 0 0 1 2.31-4.64 2.93 2.93 0 0 1 .88.13V9.4a6.84 6.84 0 0 0-1-.05A6.33 6.33 0 0 0 5.8 20.1a6.34 6.34 0 0 0 10.86-4.43V8.83a8.16 8.16 0 0 0 4.77 1.52V6.9a4.85 4.85 0 0 1-1.84-.21z"/>
            </svg>
          </span>
          <div class="min-w-0 flex-1">
            <p class="text-xs font-semibold text-foreground">{{ $t('settings.douyin') }}</p>
            <p class="truncate text-[10px] text-muted-foreground">{{ $t('settings.douyinHandle') }}</p>
          </div>
          <ExternalLink class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        </button>
      </div>
    </section>

    <!-- ─── Reset ─── -->
    <div class="flex justify-center pb-4">
      <button
        @click="settings.reset()"
        class="state-layer flex items-center gap-2 rounded-lg border border-border px-5 py-2.5 text-sm font-medium text-muted-foreground transition-colors hover:border-destructive/40 hover:bg-destructive/5 hover:text-destructive"
      >
        <RotateCcw class="h-4 w-4" /> {{ $t('settings.reset') }}
      </button>
    </div>
  </div>
</template>
