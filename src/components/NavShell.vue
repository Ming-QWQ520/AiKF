<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, nextTick, watch } from "vue";
import { Compass, CalendarDays, LayoutGrid, Bookmark, Search as SearchIcon, ChevronDown, Settings as SettingsIcon, PanelLeftClose, PanelLeftOpen, HardDriveDownload } from "lucide-vue-next";
import { useUIStore, type ViewKey } from "@/stores/ui";
import { useLibraryStore } from "@/stores/library";
import { useCacheStore } from "@/stores/cache";
import { i18n } from "@/i18n";
import { cn } from "@/lib/utils";
import SearchBar from "./SearchBar.vue";
import ThemeToggle from "./ThemeToggle.vue";
import DownloadDock from "./DownloadDock.vue";
import { NTooltip } from "naive-ui";

const ui = useUIStore();
const library = useLibraryStore();
const cacheStore = useCacheStore();
const libraryCount = computed(() => library.count);
const libraryList = computed(() => library.list.slice(0, 8));
const libraryExpanded = ref(true);

const navItems: { key: ViewKey; labelKey: string; icon: any }[] = [
  { key: "discover", labelKey: "nav.discover", icon: Compass },
  { key: "calendar", labelKey: "nav.calendar", icon: CalendarDays },
  { key: "browse", labelKey: "nav.browse", icon: LayoutGrid },
  { key: "search", labelKey: "nav.search", icon: SearchIcon },
  { key: "cache", labelKey: "nav.cache", icon: HardDriveDownload },
];

// ── Responsive sidebar collapse ──
const winWidth = ref(typeof window !== "undefined" ? window.innerWidth : 1280);
const onResize = () => { winWidth.value = window.innerWidth; };
onMounted(() => window.addEventListener("resize", onResize, { passive: true }));
onBeforeUnmount(() => window.removeEventListener("resize", onResize));

const isMobile = computed(() => winWidth.value < 768);
const sidebarCollapsed = computed(() => !isMobile.value && winWidth.value < 1024);

const manualCollapsed = ref<boolean | null>(null);
const effectiveCollapsed = computed(() => manualCollapsed.value ?? sidebarCollapsed.value);
const toggleSidebar = () => { manualCollapsed.value = !effectiveCollapsed.value; };

// Sync sidebar state to UI store so all views can react to it (e.g. to
// recompute responsive grids when the sidebar toggles, changing main width).
watch(effectiveCollapsed, (collapsed) => {
  ui.setSidebarCollapsed(collapsed);
}, { immediate: true });

const switchView = (key: ViewKey) => {
  if (key === ui.view) return;
  ui.setView(key);
  // Reset scroll position to top on view switch so the user doesn't land
  // mid-page (which would otherwise happen because the previous view's
  // scrollTop is preserved on the shared <main> scroll container).
  nextTick(() => {
    mainRef.value?.scrollTo({ top: 0, left: 0, behavior: "auto" });
  });
};

// 下载进度监听需全局可用（下载坞常驻底部）：应用壳挂载时即初始化缓存 store
// （init 内部有 ready/starting 防重，CacheView 的重复调用无副作用）
onMounted(() => {
  cacheStore.init();
});

// Ref to the main scroll container — used to reset scrollTop on view change.
const mainRef = ref<HTMLElement | null>(null);

// ── Library entry progress helpers ──
// 真实播放数据：currentEpisode 优先，观看数不超过总集数
const currentEp = (entry: { currentEpisode: number; watchedEpisodes: number[]; totalEpisodes: number }): number => {
  const raw = entry.currentEpisode || entry.watchedEpisodes.length || 0;
  return entry.totalEpisodes > 0 ? Math.min(raw, entry.totalEpisodes) : raw;
};
const watchedPct = (entry: { currentEpisode: number; watchedEpisodes: number[]; totalEpisodes: number }): number => {
  const cur = currentEp(entry);
  if (entry.totalEpisodes <= 0) return 0;
  return Math.min(100, Math.round((cur / entry.totalEpisodes) * 100));
};
const progressLabel = (entry: { currentEpisode: number; watchedEpisodes: number[]; totalEpisodes: number }): string => {
  const t = i18n.global.t;
  const cur = currentEp(entry);
  const total = entry.totalEpisodes || 0;
  if (total > 0) return t("common.episodesOf", { cur, total });
  if (cur > 0) return t("common.episodesN", { n: cur });
  return t("common.notStarted");
};
</script>

<template>
  <div class="relative flex min-h-0 flex-1">
    <!-- ════════════════════════════════════════════════════════════
         设计令牌 (单一来源):
         - 侧栏: 透明底 + 右侧发丝线 border-r，区块间以 hairline 分隔
         - 导航项: rounded-lg, px-3 py-2, 激活态 = 柔和强调色底
         - 库条目: rounded-lg, p-1.5
         - 顶栏: 发丝线下边框, 扁平搜索框
         - 文字: 标题 text-sm, 副标题 text-[10px]
         ════════════════════════════════════════════════════════════ -->
    <aside
      :class="cn(
        'hidden h-full shrink-0 flex-col border-r border-border/70 px-3 pb-3 transition-[width] duration-200 ease-out md:flex',
        effectiveCollapsed ? 'w-[64px] items-center' : 'w-[248px]'
      )"
    >
      <!-- ── Logo ── -->
      <div :class="cn('flex shrink-0 items-center pb-3 pt-3', effectiveCollapsed ? 'justify-center' : 'gap-2.5 px-1')">
        <img src="/aikf-logo-128.png" alt="AiKF" class="h-8 w-8 shrink-0 rounded-lg" draggable="false" />
        <div v-if="!effectiveCollapsed" class="min-w-0 leading-tight">
          <p class="truncate text-sm font-semibold tracking-tight text-foreground">AiKF</p>
          <p class="text-[9px] font-medium uppercase tracking-[0.18em] text-muted-foreground">Anich</p>
        </div>
      </div>

      <!-- ── 主导航 ── -->
      <nav :class="cn('flex w-full flex-col gap-0.5', effectiveCollapsed && 'items-center')">
        <NTooltip
          v-for="item in navItems"
          :key="item.key"
          placement="right"
          :disabled="!effectiveCollapsed"
        >
          <template #trigger>
            <button
              type="button"
              :data-nav-key="item.key"
              @click="switchView(item.key)"
              :class="cn(
                'flex w-full items-center rounded-lg text-sm font-medium transition-colors duration-150',
                effectiveCollapsed ? 'justify-center px-0 py-2' : 'gap-2.5 px-3 py-2',
                ui.view === item.key
                  ? 'bg-primary/10 text-primary'
                  : 'text-muted-foreground hover:bg-foreground/5 hover:text-foreground'
              )"
            >
              <component :is="item.icon" class="h-[18px] w-[18px] shrink-0" :stroke-width="ui.view === item.key ? 2.2 : 1.8" />
              <span v-if="!effectiveCollapsed" class="flex-1 text-left">{{ $t(item.labelKey) }}</span>
              <!-- 激活指示条（窄侧栏模式下可见） -->
              <span v-if="ui.view === item.key && effectiveCollapsed" class="absolute left-0 h-5 w-[2.5px] rounded-full bg-primary" />
            </button>
          </template>
          <span>{{ $t(item.labelKey) }}</span>
        </NTooltip>
      </nav>

      <div class="my-3 h-px w-full shrink-0 bg-border/70" />

      <!-- ── 追番库 ── -->
      <div class="flex min-h-0 w-full flex-1 flex-col">
        <NTooltip placement="right" :disabled="!effectiveCollapsed">
          <template #trigger>
            <button
              type="button"
              @click="ui.setView('library')"
              :class="cn(
                'group flex w-full items-center rounded-lg text-left transition-colors duration-150',
                effectiveCollapsed ? 'justify-center px-0 py-2' : 'gap-2.5 px-3 py-2',
                ui.view === 'library'
                  ? 'bg-primary/10 text-primary'
                  : 'text-muted-foreground hover:bg-foreground/5 hover:text-foreground'
              )"
            >
              <span class="relative flex h-[18px] w-[18px] shrink-0 items-center justify-center">
                <component :is="Bookmark" class="h-[18px] w-[18px]" :stroke-width="ui.view === 'library' ? 2.2 : 1.8" />
                <span
                  v-if="libraryCount > 0"
                  class="absolute -right-1.5 -top-1.5 flex h-3.5 min-w-[14px] items-center justify-center rounded-full bg-primary px-1 text-[8px] font-bold leading-none text-primary-foreground"
                >{{ libraryCount > 99 ? '99+' : libraryCount }}</span>
              </span>
              <template v-if="!effectiveCollapsed">
                <span class="flex-1 text-sm font-medium">{{ $t('nav.library') }}</span>
                <span
                  v-if="libraryCount > 0"
                  @click.stop.prevent="libraryExpanded = !libraryExpanded"
                  class="flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground transition-transform duration-200 hover:bg-foreground/10 hover:text-foreground"
                  :class="libraryExpanded ? '' : '-rotate-90'"
                >
                  <ChevronDown class="h-3 w-3" />
                </span>
              </template>
            </button>
          </template>
          <span>{{ $t('nav.libraryCounted', { n: libraryCount }) }}</span>
        </NTooltip>

        <!-- Library entries list -->
        <div
          v-if="!effectiveCollapsed && libraryExpanded && libraryCount > 0"
          class="mt-1 min-h-0 flex-1 overflow-y-auto"
        >
          <div class="flex flex-col gap-0.5">
            <button
              v-for="entry in libraryList"
              :key="entry.id"
              type="button"
              @click="ui.openDetail(entry.id, entry.image)"
              class="group flex w-full items-center gap-2 rounded-lg p-1.5 text-left transition-colors duration-150 hover:bg-foreground/5"
            >
              <img
                v-if="entry.image"
                :src="entry.image"
                :alt="entry.title"
                class="h-11 w-[30px] shrink-0 rounded-md object-cover ring-1 ring-foreground/5"
                draggable="false"
              />
              <div
                v-else
                class="flex h-11 w-[30px] shrink-0 items-center justify-center rounded-md bg-muted"
              >
                <component :is="Bookmark" class="h-3 w-3 text-muted-foreground" />
              </div>
              <div class="min-w-0 flex-1">
                <p class="line-clamp-1 text-xs font-medium text-foreground">{{ entry.title || `#${entry.id}` }}</p>
                <p class="mt-0.5 text-[10px] tabular-nums text-muted-foreground">
                  {{ progressLabel(entry) }}
                </p>
                <!-- Progress bar (inline). Inner bar uses min-w-0 to allow
                     shrinking below content width. -->
                <div class="mt-1 flex items-center gap-1.5">
                  <div class="h-[3px] min-w-0 flex-1 overflow-hidden rounded-full bg-foreground/10">
                    <div
                      class="h-full min-w-0 rounded-full transition-[width] duration-300 ease-out"
                      :class="watchedPct(entry) >= 100 ? 'bg-tertiary' : 'bg-primary'"
                      :style="{ width: watchedPct(entry) + '%' }"
                    />
                  </div>
                  <span class="shrink-0 text-[9px] font-mono tabular-nums text-muted-foreground">{{ watchedPct(entry) }}%</span>
                </div>
              </div>
            </button>
          </div>
        </div>
        <div
          v-else-if="!effectiveCollapsed && libraryExpanded && libraryCount === 0"
          class="mt-2 py-4 text-center"
        >
          <p class="text-[11px] text-muted-foreground">{{ $t('nav.libraryEmpty') }}</p>
        </div>
      </div>

      <!-- ── 设置 ── -->
      <div class="w-full shrink-0 border-t border-border/70 pt-2" :class="effectiveCollapsed && 'flex justify-center border-t-0'">
        <NTooltip placement="right" :disabled="!effectiveCollapsed">
          <template #trigger>
            <button
              type="button"
              @click="ui.setView('settings')"
              :class="cn(
                'flex w-full items-center rounded-lg text-sm font-medium transition-colors duration-150',
                effectiveCollapsed ? 'justify-center px-0 py-2' : 'gap-2.5 px-3 py-2',
                ui.view === 'settings'
                  ? 'bg-primary/10 text-primary'
                  : 'text-muted-foreground hover:bg-foreground/5 hover:text-foreground'
              )"
            >
              <component :is="SettingsIcon" class="h-[18px] w-[18px] shrink-0" :stroke-width="ui.view === 'settings' ? 2.2 : 1.8" />
              <span v-if="!effectiveCollapsed" class="flex-1 text-left">{{ $t('nav.settings') }}</span>
            </button>
          </template>
          <span>{{ $t('nav.settings') }}</span>
        </NTooltip>
      </div>
    </aside>

    <!-- ── main column ── -->
    <div class="flex min-w-0 flex-1 flex-col overflow-hidden">
      <header class="sticky top-0 z-40 shrink-0 border-b border-border/70 bg-background/85 backdrop-blur-md">
        <div class="flex items-center gap-2 px-3 py-2.5 sm:gap-3 sm:px-4 md:px-6">
          <NTooltip placement="bottom">
            <template #trigger>
              <button
                type="button"
                @click="toggleSidebar"
                class="hidden h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground md:flex"
                :aria-label="effectiveCollapsed ? $t('nav.expandSidebar') : $t('nav.collapseSidebar')"
              >
                <PanelLeftOpen v-if="effectiveCollapsed" class="h-4 w-4" />
                <PanelLeftClose v-else class="h-4 w-4" />
              </button>
            </template>
            <span>{{ effectiveCollapsed ? $t('nav.expandSidebar') : $t('nav.collapseSidebar') }}</span>
          </NTooltip>
          <div class="md:hidden">
            <img src="/aikf-logo-128.png" alt="AiKF" class="h-7 w-7 rounded-lg" draggable="false" />
          </div>
          <div class="hidden flex-1 md:block"><SearchBar /></div>
          <div class="ml-auto flex items-center gap-1.5">
            <button
              type="button"
              @click="ui.setView('search')"
              class="flex h-8 items-center gap-2 rounded-lg border border-border px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground md:hidden"
            >
              <SearchIcon class="h-4 w-4" />
              <span class="hidden sm:inline">{{ $t('nav.search') }}</span>
            </button>
            <NTooltip placement="bottom">
              <template #trigger>
                <ThemeToggle />
              </template>
              <span>{{ $t('nav.toggleTheme') }}</span>
            </NTooltip>
          </div>
        </div>
        <div class="px-3 pb-2.5 md:hidden"><SearchBar /></div>
      </header>

      <main ref="mainRef" class="flex-1 min-w-0 overflow-y-auto overflow-x-hidden px-3 pb-28 pt-4 sm:px-4 md:px-6 md:pb-12" style="contain: layout;"><slot /></main>

      <!-- ── 全局下载坞：贴主界面底部，下载时任意页面常驻（Steam 风格） ── -->
      <DownloadDock />
    </div>

      <!-- ── mobile bottom nav ── 支持本地缓存入口 -->
    <nav class="fixed inset-x-0 bottom-0 z-40 border-t border-border/70 bg-background/90 px-3 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-1.5 backdrop-blur-md md:hidden">
      <div class="mx-auto flex max-w-md items-center justify-around">
        <button
          v-for="item in [...navItems, { key: 'library' as ViewKey, labelKey: 'nav.library', icon: Bookmark }]"
          :key="item.key"
          :data-nav-key="item.key"
          type="button"
          @click="switchView(item.key)"
          class="relative flex flex-1 flex-col items-center gap-0.5 rounded-lg py-1.5 text-[10px] font-medium transition-colors duration-150"
        >
          <span
            :class="cn(
              'flex h-8 w-12 items-center justify-center rounded-lg transition-colors duration-150',
              ui.view === item.key ? 'bg-primary/10 text-primary' : 'text-muted-foreground'
            )"
          >
            <component :is="item.icon" class="h-5 w-5" :stroke-width="ui.view === item.key ? 2.2 : 1.8" />
          </span>
          <span :class="ui.view === item.key ? 'text-primary' : 'text-muted-foreground'">{{ $t(item.labelKey) }}</span>
        </button>
      </div>
    </nav>
  </div>
</template>
