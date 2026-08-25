<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, nextTick } from "vue";
import { Compass, CalendarDays, LayoutGrid, Bookmark, Search as SearchIcon, ChevronDown, Settings as SettingsIcon, PanelLeftClose, PanelLeftOpen } from "lucide-vue-next";
import { useUIStore, type ViewKey } from "@/stores/ui";
import { useLibraryStore } from "@/stores/library";
import { cn } from "@/lib/utils";
import SearchBar from "./SearchBar.vue";
import ThemeToggle from "./ThemeToggle.vue";
import { NTooltip } from "naive-ui";

const ui = useUIStore();
const library = useLibraryStore();
const libraryCount = computed(() => library.count);
const libraryList = computed(() => library.list.slice(0, 8));
const libraryExpanded = ref(true);

const navItems: { key: ViewKey; label: string; icon: any }[] = [
  { key: "discover", label: "发现", icon: Compass },
  { key: "calendar", label: "时间表", icon: CalendarDays },
  { key: "browse", label: "分类", icon: LayoutGrid },
  { key: "search", label: "搜索", icon: SearchIcon },
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

// Ref to the main scroll container — used to reset scrollTop on view change.
const mainRef = ref<HTMLElement | null>(null);

// ── Library entry progress helpers ──
// Use currentEpisode first (highest marked-watched episode, set by markEpisode),
// fall back to watchedEpisodes.length if currentEpisode is 0.
const currentEp = (entry: { currentEpisode: number; watchedEpisodes: number[] }): number => {
  return entry.currentEpisode || entry.watchedEpisodes.length || 0;
};
const watchedPct = (entry: { currentEpisode: number; watchedEpisodes: number[]; totalEpisodes: number }): number => {
  const cur = currentEp(entry);
  if (entry.totalEpisodes <= 0) return 0;
  return Math.min(100, Math.round((cur / entry.totalEpisodes) * 100));
};
const progressLabel = (entry: { currentEpisode: number; watchedEpisodes: number[]; totalEpisodes: number }): string => {
  const cur = currentEp(entry);
  const total = entry.totalEpisodes || 0;
  if (total > 0) return `${cur} / ${total} 话`;
  if (cur > 0) return `${cur} 话`;
  return "未开始";
};
</script>

<template>
  <div class="relative flex min-h-0 flex-1">
    <!-- ════════════════════════════════════════════════════════════
         设计令牌 (单一来源):
         - 外层 glass 卡片圆角: rounded-2xl (1rem)
         - 卡片内 padding: p-2
         - 按钮 (nav 项 / 库头 / 设置): rounded-xl (0.75rem), px-3 py-2
         - 库条目: rounded-lg (0.5rem), p-1.5
         - 间隔: 卡片之间 mt-2, 卡片内按钮之间 space-y-0.5
         - 文字: 标题 text-sm, 副标题 text-[10px]
         ════════════════════════════════════════════════════════════ -->
    <aside
      :class="cn(
        'hidden h-full shrink-0 flex-col p-2 transition-[width] duration-200 ease-out md:flex',
        effectiveCollapsed ? 'w-[68px]' : 'w-[256px]'
      )"
    >
      <!-- ── Logo + 主导航卡片 ── -->
      <div class="glass glass-sheen rounded-2xl p-2">
        <!-- Logo header -->
        <div :class="cn('flex items-center', effectiveCollapsed ? 'justify-center' : 'gap-2 px-1.5 py-1')">
          <img src="/aikf-logo-128.png" alt="AiKF" class="h-8 w-8 shrink-0 rounded-lg shadow-md shadow-primary/20" draggable="false" />
          <div v-if="!effectiveCollapsed" class="min-w-0 leading-tight">
            <p class="truncate text-sm font-bold tracking-tight text-foreground">AiKF</p>
            <p class="text-[9px] font-medium uppercase tracking-[0.18em] text-muted-foreground">Anich</p>
          </div>
        </div>

        <!-- Primary nav items -->
        <nav class="mt-1.5 flex flex-col gap-0.5">
          <NTooltip
            v-for="item in navItems"
            :key="item.key"
            placement="right"
            :disabled="!effectiveCollapsed"
          >
            <template #trigger>
              <!-- 原生 button — 100% 控制圆角/padding/hover, 无 Naive UI wrapper 干扰 -->
              <button
                type="button"
                :data-nav-key="item.key"
                @click="switchView(item.key)"
                :class="cn(
                  'group flex w-full items-center rounded-xl text-sm font-medium transition-colors duration-150',
                  effectiveCollapsed ? 'justify-center px-0 py-2' : 'gap-2.5 px-3 py-2',
                  ui.view === item.key
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:bg-foreground/5 hover:text-foreground'
                )"
              >
                <component :is="item.icon" class="h-[18px] w-[18px] shrink-0" />
                <span v-if="!effectiveCollapsed" class="flex-1 text-left">{{ item.label }}</span>
              </button>
            </template>
            <span>{{ item.label }}</span>
          </NTooltip>
        </nav>
      </div>

      <!-- ── 追番库卡片 ── -->
      <div class="glass glass-sheen mt-2 flex min-h-0 flex-1 flex-col rounded-2xl p-2">
        <!-- Library header button -->
        <NTooltip placement="right" :disabled="!effectiveCollapsed">
          <template #trigger>
            <button
              type="button"
              @click="ui.setView('library')"
              :class="cn(
                'group flex w-full items-center rounded-xl text-left transition-colors duration-150',
                effectiveCollapsed ? 'justify-center px-0 py-2' : 'gap-2.5 px-3 py-2',
                ui.view === 'library'
                  ? 'bg-primary/10 text-primary'
                  : 'text-muted-foreground hover:bg-foreground/5 hover:text-foreground'
              )"
            >
              <span
                :class="cn(
                  'relative flex h-[18px] w-[18px] shrink-0 items-center justify-center'
                )"
              >
                <component :is="Bookmark" class="h-[18px] w-[18px]" />
                <span
                  v-if="libraryCount > 0"
                  class="absolute -right-1.5 -top-1.5 flex h-3.5 min-w-[14px] items-center justify-center rounded-full bg-destructive px-1 text-[8px] font-bold leading-none text-white"
                >{{ libraryCount > 99 ? '99+' : libraryCount }}</span>
              </span>
              <template v-if="!effectiveCollapsed">
                <span class="flex-1 text-sm font-medium">追番库</span>
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
          <span>追番库 ({{ libraryCount }})</span>
        </NTooltip>

        <!-- Library entries list — overflow inside a rounded inner wrapper to keep edges clean -->
        <div
          v-if="!effectiveCollapsed && libraryExpanded && libraryCount > 0"
          class="mt-1.5 min-h-0 flex-1 overflow-y-auto"
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
                class="h-11 w-[30px] shrink-0 rounded-md object-cover"
                draggable="false"
              />
              <div
                v-else
                class="flex h-11 w-[30px] shrink-0 items-center justify-center rounded-md bg-foreground/10"
              >
                <component :is="Bookmark" class="h-3 w-3 text-muted-foreground" />
              </div>
              <div class="min-w-0 flex-1">
                <p class="line-clamp-1 text-xs font-medium text-foreground">{{ entry.title || `#${entry.id}` }}</p>
                <p class="mt-0.5 text-[10px] tabular-nums text-muted-foreground">
                  {{ progressLabel(entry) }}
                </p>
                <!-- Progress bar (inline, no library overhead) -->
                <div class="mt-1 flex items-center gap-1.5">
                  <div class="h-[3px] flex-1 overflow-hidden rounded-full bg-foreground/10">
                    <div
                      class="h-full rounded-full transition-[width] duration-300 ease-out"
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
          <p class="text-[11px] text-muted-foreground">追番库为空</p>
        </div>
      </div>

      <!-- ── 设置卡片 ── (与主导航卡片视觉完全统一) -->
      <NTooltip placement="right" :disabled="!effectiveCollapsed">
        <template #trigger>
          <button
            type="button"
            @click="ui.setView('settings')"
            :class="cn(
              'group flex w-full items-center rounded-2xl text-sm font-medium transition-colors duration-150',
              effectiveCollapsed ? 'mt-2 justify-center px-0 py-2' : 'mt-2 gap-2.5 px-3 py-2',
              ui.view === 'settings'
                ? 'glass glass-sheen bg-primary text-primary-foreground'
                : 'glass glass-sheen text-muted-foreground hover:bg-foreground/5 hover:text-foreground'
            )"
          >
            <component :is="SettingsIcon" class="h-[18px] w-[18px] shrink-0" />
            <span v-if="!effectiveCollapsed" class="flex-1 text-left">设置</span>
          </button>
        </template>
        <span>设置</span>
      </NTooltip>
    </aside>

    <!-- ── main column ── -->
    <div class="flex min-w-0 flex-1 flex-col overflow-hidden">
      <header class="sticky top-0 z-40 px-3 pt-3 sm:px-4 md:px-6">
        <div class="glass glass-sheen flex items-center gap-2 rounded-full p-2 pl-3 sm:gap-3 sm:pl-4">
          <button
            type="button"
            @click="toggleSidebar"
            class="hidden h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground md:flex"
            :aria-label="effectiveCollapsed ? '展开侧栏' : '收起侧栏'"
          >
            <PanelLeftOpen v-if="effectiveCollapsed" class="h-4 w-4" />
            <PanelLeftClose v-else class="h-4 w-4" />
          </button>
          <div class="md:hidden">
            <img src="/aikf-logo-128.png" alt="AiKF" class="h-8 w-8 rounded-lg" draggable="false" />
          </div>
          <div class="hidden flex-1 md:block"><SearchBar /></div>
          <div class="ml-auto flex items-center gap-2">
            <button
              type="button"
              @click="ui.setView('search')"
              class="glass state-layer flex h-9 items-center gap-2 rounded-full px-3 text-xs font-medium md:hidden"
            >
              <SearchIcon class="h-4 w-4" />
              <span class="hidden sm:inline">搜索</span>
            </button>
            <ThemeToggle />
          </div>
        </div>
        <div class="mt-2 md:hidden"><SearchBar /></div>
      </header>

      <main ref="mainRef" class="flex-1 min-w-0 overflow-y-auto overflow-x-hidden px-3 pb-28 pt-4 sm:px-4 md:px-6 md:pb-12"><slot /></main>
    </div>

    <!-- ── mobile bottom nav ── -->
    <nav class="fixed inset-x-0 bottom-0 z-40 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:hidden">
      <div class="glass-strong glass-sheen mx-auto flex max-w-md items-center justify-around rounded-full p-1.5">
        <button
          v-for="item in [...navItems, { key: 'library' as ViewKey, label: '追番库', icon: Bookmark }]"
          :key="item.key"
          :data-nav-key="item.key"
          type="button"
          @click="switchView(item.key)"
          class="state-layer relative flex flex-1 flex-col items-center gap-0.5 rounded-full py-2 text-[10px] font-medium transition-colors duration-150"
        >
          <span
            :class="cn(
              'flex h-8 w-12 items-center justify-center rounded-full transition-colors duration-150',
              ui.view === item.key ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'
            )"
          >
            <component :is="item.icon" class="h-5 w-5" />
          </span>
          <span :class="ui.view === item.key ? 'text-primary' : 'text-muted-foreground'">{{ item.label }}</span>
        </button>
      </div>
    </nav>
  </div>
</template>
