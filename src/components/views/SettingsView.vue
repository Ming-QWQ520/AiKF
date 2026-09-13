<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import {
  CircleUserRound,
  Palette,
  Sun,
  Moon,
  Monitor,
  RotateCcw,
  Zap,
  ZapOff,
  Feather,
  Sparkles,
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
  LogIn,
  LogOut,
  Loader2,
  FolderOpen,
  RefreshCw,
  Star,
  Tv,
  BookOpen,
  Music2,
  Gamepad2,
  UsersRound,
  Heart,
  Clock3,
  BadgeCheck,
} from "lucide-vue-next";
import { invoke } from "@tauri-apps/api/core";
import { useSettingsStore, type ThemeMode, type Language, type AnimLevel } from "@/stores/settings";
import { useLibraryStore, STATUS_I18N_KEYS, STATUS_STYLES, type TrackStatus } from "@/stores/library";
import { useUIStore } from "@/stores/ui";
import { LOCALE_OPTIONS } from "@/i18n";
import { AIKF_VERSION } from "@/lib/version";
import { cn } from "@/lib/utils";
import ToggleSwitch from "@/components/ToggleSwitch.vue";
import CoverImage from "@/components/CoverImage.vue";
import BgmEntityDialog from "@/components/BgmEntityDialog.vue";
import { useBangumi } from "@/lib/bangumi/useBangumi";
import * as bgm from "@/lib/bangumi/client";

const settings = useSettingsStore();
const s = computed(() => settings.data);
const bg = computed(() => settings.data.background);
const library = useLibraryStore();
const ui = useUIStore();
const { t, d } = useI18n();

const themeOptions: { value: ThemeMode; labelKey: string; icon: any }[] = [
  { value: "light", labelKey: "theme.light", icon: Sun },
  { value: "dark", labelKey: "theme.dark", icon: Moon },
  { value: "system", labelKey: "theme.system", icon: Monitor },
];

// 动画等级（任务 29：性能消耗可在设置中调节）
const animOptions: { value: AnimLevel; labelKey: string; icon: any }[] = [
  { value: "off", labelKey: "settings.anim.off", icon: ZapOff },
  { value: "basic", labelKey: "settings.anim.basic", icon: Feather },
  { value: "full", labelKey: "settings.anim.full", icon: Sparkles },
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
};

const applyUrl = () => {
  settings.updateBackground("url", urlInput.value);
};

const clearBackground = () => {
  urlInput.value = "";
  pickedFileName.value = "";
  settings.updateBackground("url", "");
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

// ── 运行日志（exe目录\log\yyyy-MM-dd HH-mm.log）──
const openLogDir = async () => {
  try {
    await invoke("log_open_dir");
  } catch (e) {
    console.error("打开日志目录失败:", e);
  }
};

// ── Bangumi 账号（登录/登出；同步本身全自动：修改即推 + 登录/启动拉取）──
const bgmCtx = useBangumi();
const bgmBusy = computed(() => bgmCtx.busy.value !== "idle");
const manualCode = ref("");
const showManualCode = ref(false);

const doBgmLogin = () => bgmCtx.login();
const doBgmLoginManual = () => {
  if (!manualCode.value.trim()) return;
  bgmCtx.login(manualCode.value.trim());
};

// ─────────────────────────────────────────────────────────────
// 我的 —— Bangumi 账户主页（彻底重构：更多官方 API 丰富界面）
//
// 数据源（全部懒加载，进入页面且已登录时并行请求一次）：
// - GET /v0/me                    → 头像/昵称/@username/UID/签名/注册时间
// - GET /v0/users/{u}/collections?subject_type=N&limit=1
//                                 → 各类型云端收藏总数（信封 total，开销极小）
// - GET /v0/users/{u}/collections?subject_type=2&limit=12
//                                 → 最近更新的动画收藏
// - GET /v0/users/{u}/collections/-/characters → 收藏的角色
// - GET /v0/users/{u}/collections/-/persons    → 收藏的人物
// - 本地追番库统计（在看/想看/看过/搁置/抛弃 + 已看集数）为即时计算
// ─────────────────────────────────────────────────────────────
const profile = reactive({
  loading: false,
  loaded: false,
  counts: { anime: 0, book: 0, music: 0, game: 0, real: 0 } as Record<string, number>,
  recent: [] as bgm.BgmCollectionItem[],
  chars: [] as bgm.BgmUserCharacterCollection[],
  persons: [] as bgm.BgmUserPersonCollection[],
});

const localStats = computed(() => {
  const c: Record<string, number> = { watching: 0, planned: 0, completed: 0, onhold: 0, dropped: 0 };
  let eps = 0;
  for (const e of library.list) {
    c[e.status] = (c[e.status] ?? 0) + 1;
    eps += e.watchedEpisodes?.length ?? 0;
  }
  return { c, eps, total: library.list.length };
});

const regDateText = computed(() => {
  const rt = bgmCtx.user.value?.reg_time;
  if (!rt) return "";
  const dt = new Date(rt);
  return Number.isNaN(dt.getTime()) ? "" : d(dt, "long");
});

async function loadProfile(force = false) {
  if (!bgmCtx.loggedIn.value) return;
  if (profile.loading || (profile.loaded && !force)) return;
  profile.loading = true;
  try {
    const [anime, book, music, game, real, recent, chars, persons] = await Promise.allSettled([
      bgm.getCollectionsCount(2),
      bgm.getCollectionsCount(1),
      bgm.getCollectionsCount(3),
      bgm.getCollectionsCount(4),
      bgm.getCollectionsCount(6),
      bgm.getRecentCollections(12),
      bgm.getCharacterCollections(),
      bgm.getPersonCollections(),
    ]);
    if (anime.status === "fulfilled") profile.counts.anime = anime.value;
    if (book.status === "fulfilled") profile.counts.book = book.value;
    if (music.status === "fulfilled") profile.counts.music = music.value;
    if (game.status === "fulfilled") profile.counts.game = game.value;
    if (real.status === "fulfilled") profile.counts.real = real.value;
    if (recent.status === "fulfilled") profile.recent = recent.value.slice(0, 12);
    if (chars.status === "fulfilled") profile.chars = chars.value.slice(0, 24);
    if (persons.status === "fulfilled") profile.persons = persons.value.slice(0, 24);
    profile.loaded = true;
  } finally {
    profile.loading = false;
  }
}

watch(
  () => bgmCtx.loggedIn.value,
  (v) => {
    if (v) void loadProfile();
  },
  { immediate: true }
);

// — 最近收藏卡片辅助 —
const recentCover = (it: bgm.BgmCollectionItem) =>
  it.subject?.images?.large ||
  it.subject?.images?.common ||
  it.subject?.images?.medium ||
  it.images?.large ||
  it.images?.common ||
  it.images?.medium ||
  "";
const recentTitle = (it: bgm.BgmCollectionItem) =>
  it.subject?.name_cn || it.subject?.name || it.name || it.name_cn || `#${it.subject_id ?? it.id ?? ""}`;
const recentStatus = (it: bgm.BgmCollectionItem): TrackStatus =>
  (bgm.BGM_TO_STATUS[Number(it.type)] as TrackStatus) ?? "watching";

function openRecent(it: bgm.BgmCollectionItem) {
  const sid = it.subject?.id ?? it.subject_id;
  if (!sid) return;
  const entry = Object.values(library.entries).find((e) => e.bgmId === sid);
  if (entry) ui.openDetail(entry.id, entry.image);
  else void openExternalUrl(`https://bgm.tv/subject/${sid}`);
}

// — 收藏角色/人物（点击 → BgmEntityDialog 查看详情，与详情页共用）—
const entity = ref<{ kind: "character" | "person"; id: number; name?: string; image?: string } | null>(null);
const openEntity = (kind: "character" | "person", id: number, name?: string, image?: string) => {
  if (id == null) return;
  entity.value = { kind, id, name, image };
};
const charImg = (x: { images?: { large?: string; medium?: string; small?: string; grid?: string } | null }) =>
  x.images?.large || x.images?.medium || x.images?.grid || x.images?.small || "";
const careerText = (p: bgm.BgmUserPersonCollection) =>
  (p.career ?? []).slice(0, 2).join(" / ");
</script>

<template>
  <div class="mx-auto max-w-3xl">
    <!-- ─── 我的（未登录 → 登录入口）─── -->
    <section class="surface mb-4 rounded-2xl p-5">
      <template v-if="!bgmCtx.loggedIn.value">
        <div class="mb-4 flex items-center gap-4">
          <span class="flex h-16 w-16 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground ring-1 ring-border">
            <CircleUserRound class="h-8 w-8" />
          </span>
          <div class="min-w-0 flex-1">
            <h2 class="text-xl font-bold tracking-tight text-foreground">{{ $t('settings.title') }}</h2>
            <p class="mt-0.5 text-xs text-muted-foreground">{{ $t('nav.meNotLoggedIn') }} · {{ $t('settings.profile.hint') }}</p>
          </div>
        </div>
        <p class="mb-3 text-[11px] leading-relaxed text-muted-foreground">{{ $t('settings.bgm.loginHint') }}</p>
        <div class="flex flex-wrap items-center gap-3">
          <button
            @click="doBgmLogin"
            :disabled="bgmBusy"
            class="state-layer flex items-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            <Loader2 v-if="bgmCtx.busy.value === 'login'" class="h-4 w-4 animate-spin" />
            <LogIn v-else class="h-4 w-4" />
            {{ $t('settings.bgm.login') }}
          </button>
          <button
            @click="showManualCode = !showManualCode"
            class="state-layer rounded-lg border border-border px-3 py-2.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >{{ $t('settings.bgm.manualToggle') }}</button>
        </div>
        <!-- 手动粘贴 code 兜底（redirect_uri 不匹配 / 回调监听被拦截时） -->
        <div v-if="showManualCode" class="mt-3 rounded-xl border border-border p-3">
          <p class="mb-2 text-[11px] text-muted-foreground">{{ $t('settings.bgm.manualHint') }}</p>
          <div class="flex gap-2">
            <input
              v-model="manualCode"
              :placeholder="$t('settings.bgm.manualPlaceholder')"
              class="w-full rounded-lg border border-border bg-card px-3 py-2 text-xs text-foreground outline-none focus:border-primary/50"
            />
            <button
              @click="doBgmLoginManual"
              :disabled="bgmBusy || !manualCode.trim()"
              class="state-layer shrink-0 rounded-lg bg-primary/10 px-4 py-2 text-xs font-medium text-primary transition-colors hover:bg-primary/15 disabled:opacity-50"
            >{{ $t('settings.bgm.manualSubmit') }}</button>
          </div>
          <p class="mt-2 break-all font-mono text-[10px] text-muted-foreground/70">{{ $t('settings.bgm.callbackHint') }}</p>
        </div>
      </template>

      <!-- ─── 我的（已登录）─── -->
      <template v-else>
        <!-- 账户横幅：大头像 + 昵称 + @username + UID + 注册时间 + 签名 -->
        <!-- 登出键：文档流内右对齐（此前 absolute 定位被 .state-layer 的
             position:relative 同层覆盖导致掉回文档流错位到左上角，
             改为 flex 行布局，从根上规避层叠冲突且窄屏不再与昵称重叠） -->
        <div class="-m-5 mb-5 overflow-hidden rounded-t-2xl bg-gradient-to-br from-primary/15 via-primary/5 to-transparent p-5">
          <div class="mb-2 flex justify-end">
            <button
              @click="bgmCtx.logout()"
              class="state-layer flex items-center gap-1.5 rounded-lg border border-border bg-card/80 px-3 py-1.5 text-xs text-muted-foreground backdrop-blur transition-colors hover:border-destructive/40 hover:text-destructive"
            >
              <LogOut class="h-3.5 w-3.5" /> {{ $t('settings.bgm.logout') }}
            </button>
          </div>
          <div class="flex items-center gap-4">
            <img
              v-if="bgmCtx.user.value?.avatar?.large"
              :src="bgmCtx.user.value.avatar.large"
              class="h-20 w-20 shrink-0 rounded-full object-cover shadow-lg shadow-black/10 ring-2 ring-background"
              draggable="false"
            />
            <span v-else class="flex h-20 w-20 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground ring-2 ring-background">
              <CircleUserRound class="h-10 w-10" />
            </span>
            <div class="min-w-0 flex-1">
              <h2 class="truncate text-2xl font-extrabold tracking-tight text-foreground">
                {{ bgmCtx.user.value?.nickname || bgmCtx.user.value?.username || $t('settings.bgm.user') }}
              </h2>
              <p v-if="bgmCtx.user.value?.username" class="mt-0.5 truncate text-xs text-muted-foreground">@{{ bgmCtx.user.value.username }}</p>
              <div class="mt-2 flex flex-wrap items-center gap-1.5">
                <span class="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary">
                  <BadgeCheck class="h-3 w-3" />
                  {{ $t('settings.profile.id', { id: bgmCtx.user.value?.id ?? '—' }) }}
                </span>
                <span v-if="regDateText" class="text-[10px] text-muted-foreground">{{ $t('settings.profile.joined', { date: regDateText }) }}</span>
              </div>
            </div>
          </div>
          <p v-if="bgmCtx.user.value?.sign" class="mt-3 line-clamp-3 text-xs leading-relaxed text-foreground/75">{{ bgmCtx.user.value.sign }}</p>
        </div>

        <!-- 数据总览 -->
        <div class="mt-6 mb-2 flex items-center justify-between px-1">
          <h3 class="flex items-center gap-2 text-sm font-semibold text-foreground">
            <Zap class="h-4 w-4 text-primary" /> {{ $t('settings.profile.statsTitle') }}
          </h3>
          <button
            @click="loadProfile(true)"
            class="state-layer flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
            v-tip="$t('settings.profile.refresh')"
          >
            <RefreshCw :class="cn('h-3 w-3', profile.loading && 'animate-spin')" /> {{ $t('settings.profile.refresh') }}
          </button>
        </div>

        <!-- 云端收藏（五类计数） -->
        <div class="grid grid-cols-2 gap-2.5 sm:grid-cols-5">
          <div v-for="c in [
              { k: 'anime', icon: Tv, key: 'cntAnime' },
              { k: 'book', icon: BookOpen, key: 'cntBook' },
              { k: 'music', icon: Music2, key: 'cntMusic' },
              { k: 'game', icon: Gamepad2, key: 'cntGame' },
              { k: 'real', icon: UsersRound, key: 'cntReal' },
            ]" :key="c.k"
            class="surface flex items-center gap-3 rounded-xl p-3"
          >
            <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <component :is="c.icon" class="h-4.5 w-4.5" />
            </span>
            <div class="min-w-0">
              <p class="text-lg font-extrabold leading-none tabular-nums text-foreground">
                <Loader2 v-if="profile.loading && !profile.loaded" class="h-4 w-4 animate-spin text-muted-foreground" />
                <template v-else>{{ profile.counts[c.k] }}</template>
              </p>
              <p class="mt-1 truncate text-[10px] text-muted-foreground">{{ $t(`settings.profile.${c.key}`) }}</p>
            </div>
          </div>
        </div>

        <!-- 本地追番库统计 -->
        <div class="mt-2.5 flex flex-wrap items-center gap-2 rounded-xl surface p-3">
          <span class="mr-1 text-[11px] font-medium text-muted-foreground">{{ $t('settings.profile.localStats') }}</span>
          <span
            v-for="st in (['watching','planned','completed','onhold','dropped'] as TrackStatus[])"
            :key="st"
            :class="cn('flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold', STATUS_STYLES[st].chip)"
          >
            <span :class="cn('h-1.5 w-1.5 rounded-full', STATUS_STYLES[st].dot)" />
            {{ $t(STATUS_I18N_KEYS[st]) }} <span class="tabular-nums opacity-80">{{ localStats.c[st] }}</span>
          </span>
          <span class="ml-auto text-[11px] tabular-nums text-muted-foreground">
            {{ $t('settings.profile.watchedEps', { n: localStats.eps }) }}
          </span>
        </div>

        <!-- 最近更新的收藏 -->
        <div class="mt-5 mb-2 flex items-center gap-2 px-1">
          <h3 class="flex items-center gap-2 text-sm font-semibold text-foreground">
            <Clock3 class="h-4 w-4 text-primary" /> {{ $t('settings.profile.recentTitle') }}
          </h3>
        </div>
        <div v-if="profile.loading && !profile.loaded" class="flex gap-3 overflow-hidden">
          <div v-for="i in 5" :key="i" class="w-[104px] shrink-0"><div class="aspect-[3/4] rounded-xl shimmer" /></div>
        </div>
        <div v-else-if="profile.recent.length === 0" class="rounded-xl surface p-4 text-center text-xs text-muted-foreground">
          {{ $t('settings.profile.recentEmpty') }}
        </div>
        <div v-else class="no-scrollbar flex gap-3 overflow-x-auto pb-1">
          <button
            v-for="(it, i) in profile.recent"
            :key="it.subject?.id ?? it.subject_id ?? i"
            @click="openRecent(it)"
            class="group w-[104px] shrink-0 text-left"
            v-tip="recentTitle(it)"
          >
            <div class="relative overflow-hidden rounded-xl">
              <!-- eager：12 张小图直接加载，避免横向滑动时懒载入重复触发缩放淡入动画（图片刷新摆动） -->
              <CoverImage :src="recentCover(it)" :alt="recentTitle(it)" ratio="portrait" rounded="rounded-xl" eager class="transition-transform group-hover:scale-[1.04]" />
              <span :class="cn('absolute left-1.5 top-1.5 rounded-full px-1.5 py-0.5 text-[9px] font-bold', STATUS_STYLES[recentStatus(it)].chip)">
                {{ $t(STATUS_I18N_KEYS[recentStatus(it)]) }}
              </span>
            </div>
            <p class="mt-1.5 line-clamp-1 text-[11px] font-medium text-foreground transition-colors group-hover:text-primary">{{ recentTitle(it) }}</p>
            <p class="mt-0.5 flex items-center gap-1 text-[10px] tabular-nums text-muted-foreground">
              <template v-if="(it.ep_status ?? 0) > 0">{{ $t('settings.profile.epsN', { n: it.ep_status }) }}</template>
              <template v-if="(it.rate ?? 0) > 0"><Star class="h-2.5 w-2.5 fill-tertiary text-tertiary" />{{ it.rate }}</template>
            </p>
          </button>
        </div>

        <!-- 收藏的角色 -->
        <div class="mt-5 mb-2 flex items-center gap-2 px-1">
          <h3 class="flex items-center gap-2 text-sm font-semibold text-foreground">
            <Heart class="h-4 w-4 text-primary" /> {{ $t('settings.profile.charsTitle') }}
          </h3>
        </div>
        <div v-if="profile.loading && !profile.loaded" class="flex gap-3 overflow-hidden">
          <div v-for="i in 6" :key="i" class="w-24 shrink-0"><div class="aspect-square rounded-xl shimmer" /></div>
        </div>
        <div v-else-if="profile.chars.length === 0" class="rounded-xl surface p-4 text-center text-xs text-muted-foreground">
          {{ $t('settings.profile.charsEmpty') }}
        </div>
        <div v-else class="no-scrollbar flex gap-3 overflow-x-auto pb-1">
          <button
            v-for="c in profile.chars"
            :key="c.id"
            @click="openEntity('character', c.id, c.name, charImg(c))"
            class="group w-24 shrink-0 text-center"
            v-tip="c.name"
          >
            <div class="aspect-square w-full overflow-hidden rounded-xl bg-muted ring-1 ring-transparent transition-shadow group-hover:ring-primary/40">
              <img v-if="charImg(c)" :src="charImg(c)" :alt="c.name" loading="lazy" class="h-full w-full object-cover object-top" @error="($event.target as HTMLElement).style.opacity = '0'" />
              <span v-else class="flex h-full w-full items-center justify-center text-lg font-bold text-muted-foreground">{{ (c.name || '?').slice(0, 1) }}</span>
            </div>
            <p class="mt-1.5 line-clamp-1 text-[11px] font-medium text-foreground transition-colors group-hover:text-primary">{{ c.name }}</p>
          </button>
        </div>

        <!-- 收藏的人物 -->
        <div class="mt-5 mb-2 flex items-center gap-2 px-1">
          <h3 class="flex items-center gap-2 text-sm font-semibold text-foreground">
            <UsersRound class="h-4 w-4 text-primary" /> {{ $t('settings.profile.personsTitle') }}
          </h3>
        </div>
        <div v-if="profile.loading && !profile.loaded" class="flex gap-3 overflow-hidden">
          <div v-for="i in 6" :key="i" class="w-24 shrink-0"><div class="aspect-square rounded-xl shimmer" /></div>
        </div>
        <div v-else-if="profile.persons.length === 0" class="rounded-xl surface p-4 text-center text-xs text-muted-foreground">
          {{ $t('settings.profile.personsEmpty') }}
        </div>
        <div v-else class="no-scrollbar flex gap-3 overflow-x-auto pb-1">
          <button
            v-for="p in profile.persons"
            :key="p.id"
            @click="openEntity('person', p.id, p.name, charImg(p))"
            class="group w-24 shrink-0 text-center"
            v-tip="p.name"
          >
            <div class="aspect-square w-full overflow-hidden rounded-xl bg-muted ring-1 ring-transparent transition-shadow group-hover:ring-primary/40">
              <img v-if="charImg(p)" :src="charImg(p)" :alt="p.name" loading="lazy" class="h-full w-full object-cover object-top" @error="($event.target as HTMLElement).style.opacity = '0'" />
              <span v-else class="flex h-full w-full items-center justify-center text-lg font-bold text-muted-foreground">{{ (p.name || '?').slice(0, 1) }}</span>
            </div>
            <p class="mt-1.5 line-clamp-1 text-[11px] font-medium text-foreground transition-colors group-hover:text-primary">{{ p.name }}</p>
            <p v-if="careerText(p)" class="mt-0.5 line-clamp-1 text-[9px] text-muted-foreground">{{ careerText(p) }}</p>
          </button>
        </div>
      </template>
    </section>

    <!-- ─── 外观 ─── -->
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

      <!-- 动画等级（任务 29：低性能消耗动画，等级可调） -->
      <div>
        <p class="mb-2 text-xs font-medium text-muted-foreground">{{ $t('settings.animLevel') }}</p>
        <div class="grid grid-cols-3 gap-3">
          <button
            v-for="opt in animOptions" :key="opt.value"
            @click="settings.update('animLevel', opt.value)"
            :class="cn('flex flex-col items-center gap-2 rounded-xl px-3 py-4 transition-colors', s.animLevel === opt.value ? 'bg-primary/10 ring-1 ring-primary/40' : 'bg-muted hover:bg-accent')"
          >
            <span :class="cn('flex h-10 w-10 items-center justify-center rounded-lg', s.animLevel === opt.value ? 'bg-primary text-primary-foreground' : 'text-muted-foreground')">
              <component :is="opt.icon" class="h-5 w-5" />
            </span>
            <span :class="cn('text-xs font-semibold', s.animLevel === opt.value ? 'text-primary' : 'text-foreground')">{{ $t(opt.labelKey) }}</span>
          </button>
        </div>
        <p class="mt-1.5 text-[11px] text-muted-foreground">{{ $t('settings.animLevelHint') }}</p>
      </div>
    </section>

    <!-- ─── Custom Background（需求：勾选启用后才展开选图与样式调整）─── -->
    <section class="surface mb-4 rounded-2xl p-5">
      <h3 class="mb-4 flex items-center gap-2 text-sm font-semibold text-foreground">
        <ImageIcon class="h-4 w-4 text-primary" /> {{ $t('settings.background') }}
      </h3>

      <!-- enable toggle（未启用时仅展示此行） -->
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

      <!-- 以下配置仅在启用后展开 -->
      <Transition
        enter-active-class="transition duration-200 ease-out"
        enter-from-class="opacity-0 -translate-y-1.5"
        leave-active-class="transition duration-150 ease-in"
        leave-to-class="opacity-0 -translate-y-1.5"
      >
        <div v-if="bg.enabled">
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
        </div>
      </Transition>
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
        <!-- 运行日志：exe目录\log\yyyy-MM-dd HH-mm.log，排查问题必备 -->
        <div class="flex items-center justify-between">
          <span class="text-muted-foreground">{{ $t('settings.logDir') }}</span>
          <button
            @click="openLogDir"
            class="state-layer flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary"
          >
            <FolderOpen class="h-3.5 w-3.5" /> {{ $t('settings.openLogs') }}
          </button>
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

    <!-- ─── 致谢：Bangumi 番组计划（需求 2026-09-13：页面底部官方徽章，系统浏览器打开）─── -->
    <div class="flex flex-col items-center gap-2 pb-6 pt-1">
      <p class="text-center text-[11px] leading-relaxed text-muted-foreground">{{ $t('settings.thanks') }}</p>
      <button
        @click="openExternalUrl('https://bgm.tv/')"
        class="state-layer rounded-md p-1 transition-opacity hover:opacity-80"
        v-tip="$t('settings.thanksTitle')"
        :aria-label="$t('settings.thanksTitle')"
      >
        <img
          src="https://bgm.tv/img/ico/bgm88-31.gif"
          alt="Bangumi 番组计划"
          class="h-[31px] w-[88px]"
          draggable="false"
          decoding="async"
          @error="($event.target as HTMLElement).style.visibility = 'hidden'"
        />
      </button>
    </div>

    <!-- ─── 收藏角色/人物详情弹窗（与详情页共用组件）─── -->
    <BgmEntityDialog
      v-if="entity"
      :kind="entity.kind"
      :id="entity.id"
      :initial-name="entity.name"
      :initial-image="entity.image"
      @close="entity = null"
    />
  </div>
</template>
