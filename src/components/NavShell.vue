<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch } from "vue";
import { Compass, CalendarDays, LayoutGrid, Bookmark, Search as SearchIcon, ChevronDown, Settings as SettingsIcon, PanelLeftClose, PanelLeftOpen } from "lucide-vue-next";
import { useUIStore, type ViewKey } from "@/stores/ui";
import { useLibraryStore } from "@/stores/library";
import { cn } from "@/lib/utils";
import SearchBar from "./SearchBar.vue";
import ThemeToggle from "./ThemeToggle.vue";
import {
  NButton,
  NIcon,
  NBadge,
  NTooltip,
  NProgress,
} from "naive-ui";

const ui = useUIStore();
const library = useLibraryStore();
const libraryCount = computed(() => library.count);
const libraryList = computed(() => library.list.slice(0, 8));
const libraryExpanded = ref(true);

// Navigation items definition (kept in plain TS for both desktop + mobile)
const navItems: { key: ViewKey; label: string; icon: any }[] = [
  { key: "discover", label: "发现", icon: Compass },
  { key: "calendar", label: "时间表", icon: CalendarDays },
  { key: "browse", label: "分类", icon: LayoutGrid },
  { key: "search", label: "搜索", icon: SearchIcon },
];

// ── Responsive sidebar collapse ──
// Track window width to auto-collapse the sidebar on narrow desktops.
// - < 768px  : mobile (bottom nav, no sidebar)
// - 768–1023 : collapsed sidebar (icons only)
// - ≥ 1024   : expanded sidebar (icons + labels)
const winWidth = ref(typeof window !== "undefined" ? window.innerWidth : 1280);
const onResize = () => { winWidth.value = window.innerWidth; };
onMounted(() => window.addEventListener("resize", onResize, { passive: true }));
onBeforeUnmount(() => window.removeEventListener("resize", onResize));

const isMobile = computed(() => winWidth.value < 768);
const sidebarCollapsed = computed(() => !isMobile.value && winWidth.value < 1024);

// User can also manually toggle the sidebar (overrides auto-collapse on desktop)
const manualCollapsed = ref<boolean | null>(null);
const effectiveCollapsed = computed(() => manualCollapsed.value ?? sidebarCollapsed.value);
const toggleSidebar = () => { manualCollapsed.value = !effectiveCollapsed.value; };

// ── Lightweight nav animation (CSS-based, replaces GSAP) ──
// Previously used GSAP to slide the whole nav list + a per-button staggered
// animation on every view switch. That caused noticeable jank on lower-end
// devices because:
//   1. The container-level transform invalidated layout for the whole nav.
//   2. The per-button stagger compounding caused many simultaneous tweens.
//   3. `clearProps: "transform"` forced a reflow at animation end.
//
// New approach: pure CSS transitions on `background-color`, `transform`, and
// `box-shadow`. The active button gets a brief scale "pop" via a one-shot
// animation class, which is much cheaper than repositioning the whole list.
const popKey = ref(0);  // bump to retrigger CSS keyframe animation on active button
watch(() => ui.view, (newView, oldView) => {
  if (newView === oldView) return;
  // Force restart of the pop animation by toggling the key
  popKey.value = (popKey.value + 1) % 1000000;
});

// Wrapper view switch function that triggers the animation
const switchView = (key: ViewKey) => {
  if (key === ui.view) return;
  ui.setView(key);
};

// ── Library entry progress helpers ──
// Watched progress (for the bottom progress bar): percentage of total
// episodes already watched, rounded to nearest integer.
const watchedPct = (entry: { watchedEpisodes: number[]; totalEpisodes: number }): number => {
  if (entry.totalEpisodes <= 0) return 0;
  return Math.min(100, Math.round((entry.watchedEpisodes.length / entry.totalEpisodes) * 100));
};
// Compact progress label: "当前 X / Y 话" or "X / Y 话" when no current ep
const progressLabel = (entry: { currentEpisode: number; totalEpisodes: number }): string => {
  const cur = entry.currentEpisode || 0;
  const total = entry.totalEpisodes || 0;
  if (total > 0) return `当前 ${cur} / ${total} 话`;
  if (cur > 0) return `当前 ${cur} 话`;
  return "未开始";
};
</script>

<template>
  <div class="relative flex min-h-0 flex-1">
    <!-- desktop sidebar (adaptive width: collapsed = 72px, expanded = 260px) -->
    <aside
      :class="cn(
        'hidden h-full shrink-0 flex-col p-3 transition-[width] duration-200 ease-out md:flex',
        effectiveCollapsed ? 'w-[72px]' : 'w-[260px] p-4'
      )"
    >
      <div class="glass glass-sheen rounded-3xl p-2.5">
        <div :class="cn('flex items-center', effectiveCollapsed ? 'justify-center' : 'gap-2.5 px-1.5 py-1')">
          <img src="/aikf-logo-128.png" alt="AiKF" class="h-9 w-9 shrink-0 rounded-2xl shadow-lg shadow-primary/20 ring-1 ring-white/10" draggable="false" />
          <div v-if="!effectiveCollapsed" class="min-w-0 leading-tight">
            <p class="truncate text-base font-extrabold tracking-tight text-foreground">AiKF</p>
            <p class="text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground">Anich</p>
          </div>
        </div>
        <nav ref="navRef" class="mt-2.5 flex flex-col gap-1">
          <!--
            Each nav entry is a Naive UI NButton. The active state is set via
            inline class binding (primary fill) — CSS `transition-colors`
            handles the smooth background-color shift, no JS animation needed.

            The active button also gets a one-shot `pop` keyframe animation
            (see <style> block below) — much cheaper than repositioning the
            whole list with GSAP.
          -->
          <NTooltip
            v-for="item in navItems"
            :key="item.key"
            placement="right"
            :disabled="!effectiveCollapsed"
          >
            <template #trigger>
              <NButton
                :data-nav-key="item.key"
                quaternary
                :type="ui.view === item.key ? 'primary' : 'default'"
                :focusable="false"
                :class="cn(
                  'nav-btn state-layer group relative flex w-full items-center rounded-2xl text-sm font-medium',
                  'transition-[background-color,color,box-shadow,transform] duration-200 ease-out',
                  'will-change-[background-color,transform]',
                  effectiveCollapsed ? 'justify-center !px-2 !py-2.5' : 'gap-3 !px-3.5 !py-2.5',
                  ui.view === item.key
                    ? '!bg-primary !text-primary-foreground shadow-lg shadow-primary/25 nav-pop'
                    : 'text-muted-foreground hover:!bg-foreground/5 hover:text-foreground'
                )"
                :data-pop-key="popKey"
                @click="switchView(item.key)"
              >
                <template #icon>
                  <NIcon size="20"><component :is="item.icon" /></NIcon>
                </template>
                <span v-if="!effectiveCollapsed" class="flex-1 text-left">{{ item.label }}</span>
              </NButton>
            </template>
            <span>{{ item.label }}</span>
          </NTooltip>
        </nav>
      </div>

      <!-- 追番库展开区域 -->
      <div class="glass glass-sheen mt-3 flex min-h-0 flex-1 flex-col rounded-3xl p-2.5">
        <NTooltip placement="right" :disabled="!effectiveCollapsed">
          <template #trigger>
            <NButton
              quaternary
              :focusable="false"
              :class="cn(
                'state-layer flex w-full items-center rounded-2xl text-left transition-colors duration-200',
                effectiveCollapsed ? 'justify-center !px-2 !py-2' : 'gap-2 !px-2 !py-2',
                ui.view === 'library' ? 'nav-pop' : ''
              )"
              @click="ui.setView('library')"
            >
              <template #icon>
                <NBadge :value="libraryCount" :max="99" :color="'#fb7185'" :offset="[-4, 4]">
                  <span
                    :class="cn(
                      'flex h-8 w-8 shrink-0 items-center justify-center rounded-xl transition-colors duration-200',
                      ui.view === 'library' ? 'bg-primary text-primary-foreground' : 'bg-foreground/5 text-muted-foreground'
                    )"
                  >
                    <NIcon size="16"><Bookmark /></NIcon>
                  </span>
                </NBadge>
              </template>
              <template v-if="!effectiveCollapsed">
                <div class="min-w-0 flex-1">
                  <p class="text-sm font-semibold text-foreground">追番库</p>
                  <p class="text-[10px] text-muted-foreground">{{ libraryCount }} 部</p>
                </div>
                <span
                  v-if="libraryCount > 0"
                  @click.stop="libraryExpanded = !libraryExpanded"
                  class="flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground transition-transform duration-200 hover:bg-foreground/10 hover:text-foreground"
                  :class="libraryExpanded ? '' : '-rotate-90'"
                >
                  <ChevronDown class="h-3 w-3 transition-transform duration-200" />
                </span>
              </template>
            </NButton>
          </template>
          <span>追番库 ({{ libraryCount }})</span>
        </NTooltip>

        <!-- Library entries with progress display -->
        <div v-if="!effectiveCollapsed && libraryExpanded && libraryCount > 0" class="mt-2 min-h-0 flex-1 space-y-1.5 overflow-y-auto pr-1">
          <NButton
            v-for="entry in libraryList"
            :key="entry.id"
            quaternary
            :focusable="false"
            class="lib-entry state-layer !w-full !justify-start !gap-2.5 !rounded-xl !p-1.5 !text-left transition-colors duration-200 hover:!bg-foreground/5"
            @click="ui.openDetail(entry.id, entry.image)"
          >
            <img
              v-if="entry.image"
              :src="entry.image"
              :alt="entry.title"
              class="h-12 w-8 shrink-0 rounded-md object-cover ring-1 ring-white/5"
              draggable="false"
            />
            <div v-else class="flex h-12 w-7 shrink-0 items-center justify-center rounded-md bg-foreground/10">
              <NIcon size="12" color="var(--muted-foreground)"><Bookmark /></NIcon>
            </div>
            <div class="min-w-0 flex-1">
              <p class="line-clamp-1 text-xs font-medium text-foreground">{{ entry.title || `#${entry.id}` }}</p>
              <p class="mt-0.5 text-[10px] text-muted-foreground">
                {{ progressLabel(entry) }}
              </p>
              <!-- Progress bar with percentage at bottom -->
              <div class="mt-1.5 flex items-center gap-1.5">
                <NProgress
                  type="line"
                  :percentage="watchedPct(entry)"
                  :height="4"
                  :border-radius="2"
                  :show-indicator="false"
                  :color="entry.totalEpisodes > 0 && entry.watchedEpisodes.length >= entry.totalEpisodes ? 'var(--tertiary)' : 'var(--primary)'"
                  :rail-color="'var(--foreground)'"
                  class="flex-1 !min-w-0"
                />
                <span class="shrink-0 text-[9px] font-mono tabular-nums text-muted-foreground">{{ watchedPct(entry) }}%</span>
              </div>
            </div>
          </NButton>
        </div>
        <div v-else-if="!effectiveCollapsed && libraryExpanded && libraryCount === 0" class="mt-2 py-4 text-center">
          <p class="text-[11px] text-muted-foreground">追番库为空</p>
        </div>
      </div>

      <!-- 设置按钮 (固定在侧边栏底部) -->
      <NTooltip placement="right" :disabled="!effectiveCollapsed">
        <template #trigger>
          <NButton
            quaternary
            :focusable="false"
            :type="ui.view === 'settings' ? 'primary' : 'default'"
            :class="cn(
              'state-layer mt-3 flex w-full items-center rounded-2xl text-sm font-medium',
              'transition-[background-color,color,box-shadow,transform] duration-200 ease-out',
              effectiveCollapsed ? 'justify-center !px-2 !py-2.5' : 'gap-3 !px-3.5 !py-2.5',
              ui.view === 'settings'
                ? '!bg-primary !text-primary-foreground shadow-lg shadow-primary/25 nav-pop'
                : 'glass glass-sheen text-muted-foreground hover:!bg-foreground/5 hover:text-foreground'
            )"
            @click="ui.setView('settings')"
          >
            <template #icon>
              <NIcon size="20"><SettingsIcon /></NIcon>
            </template>
            <span v-if="!effectiveCollapsed" class="flex-1 text-left">设置</span>
          </NButton>
        </template>
        <span>设置</span>
      </NTooltip>
    </aside>

    <!-- main column (scrollable) -->
    <div class="flex min-w-0 flex-1 flex-col overflow-hidden">
      <header class="sticky top-0 z-40 px-3 pt-3 sm:px-4 md:px-6">
        <div class="glass glass-sheen flex items-center gap-2 rounded-full p-2 pl-3 sm:gap-3 sm:pl-4">
          <!-- sidebar toggle (desktop only) -->
          <NButton
            circle
            quaternary
            :focusable="false"
            class="hidden !h-8 !w-8 md:flex"
            :aria-label="effectiveCollapsed ? '展开侧栏' : '收起侧栏'"
            @click="toggleSidebar"
          >
            <template #icon>
              <NIcon size="16">
                <PanelLeftOpen v-if="effectiveCollapsed" />
                <PanelLeftClose v-else />
              </NIcon>
            </template>
          </NButton>
          <div class="md:hidden">
            <img src="/aikf-logo-128.png" alt="AiKF" class="h-8 w-8 rounded-xl ring-1 ring-white/10" draggable="false" />
          </div>
          <div class="hidden flex-1 md:block"><SearchBar /></div>
          <div class="ml-auto flex items-center gap-2">
            <NButton
              quaternary
              circle
              :focusable="false"
              class="glass state-layer !h-9 !px-3 !text-xs font-medium md:hidden"
              @click="ui.setView('search')"
            >
              <template #icon>
                <NIcon size="16"><SearchIcon /></NIcon>
              </template>
              <span class="hidden sm:inline">搜索</span>
            </NButton>
            <ThemeToggle />
          </div>
        </div>
        <div class="mt-2 md:hidden"><SearchBar /></div>
      </header>

      <main class="flex-1 overflow-y-auto px-3 pb-28 pt-4 sm:px-4 md:px-6 md:pb-12"><slot /></main>
    </div>

    <!-- mobile bottom nav -->
    <nav ref="mobileNavRef" class="fixed inset-x-0 bottom-0 z-40 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:hidden">
      <div class="glass-strong glass-sheen mx-auto flex max-w-md items-center justify-around rounded-full p-1.5">
        <button
          v-for="item in [...navItems, { key: 'library' as ViewKey, label: '追番库', icon: Bookmark }]"
          :key="item.key"
          :data-nav-key="item.key"
          type="button"
          @click="switchView(item.key)"
          class="state-layer relative flex flex-1 flex-col items-center gap-0.5 rounded-full py-2 text-[10px] font-medium transition-colors duration-200"
        >
          <span :class="cn('flex h-8 w-12 items-center justify-center rounded-full transition-all duration-200', ui.view === item.key ? 'bg-primary text-primary-foreground shadow-md shadow-primary/30' : 'text-muted-foreground')">
            <component :is="item.icon" class="h-5 w-5" />
          </span>
          <span :class="ui.view === item.key ? 'text-primary' : 'text-muted-foreground'">{{ item.label }}</span>
        </button>
      </div>
    </nav>
  </div>
</template>

<style scoped>
/* Naive UI NButton overrides for nav layout */
.nav-btn :deep(.n-button__content) {
  width: 100%;
  justify-content: flex-start;
}
.nav-btn :deep(.n-button__icon) {
  margin-right: 0;
}
.lib-entry :deep(.n-button__content) {
  width: 100%;
  justify-content: flex-start;
  align-items: stretch;
}
.lib-entry :deep(.n-button__icon) {
  margin: 0;
  align-self: flex-start;
}

/* One-shot pop animation for active nav buttons.
   Triggered by toggling `nav-pop` class + `data-pop-key` attribute. */
.nav-pop {
  animation: nav-pop-anim 280ms cubic-bezier(0.22, 1, 0.36, 1);
}

@keyframes nav-pop-anim {
  0%   { transform: scale(0.94); opacity: 0.5; }
  60%  { transform: scale(1.04); opacity: 1; }
  100% { transform: scale(1); opacity: 1; }
}

/* Reduce-motion accessibility: disable the pop animation entirely. */
@media (prefers-reduced-motion: reduce) {
  .nav-pop {
    animation: none;
  }
}
</style>
