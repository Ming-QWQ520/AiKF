<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick } from "vue";
import { Compass, CalendarDays, LayoutGrid, Bookmark, Search as SearchIcon, ChevronDown, ChevronRight, Settings as SettingsIcon, PanelLeftClose, PanelLeftOpen } from "lucide-vue-next";
import { gsap } from "gsap";
import { useUIStore, type ViewKey } from "@/stores/ui";
import { useLibraryStore } from "@/stores/library";
import { cn } from "@/lib/utils";
import SearchBar from "./SearchBar.vue";
import ThemeToggle from "./ThemeToggle.vue";

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

// ── GSAP sidebar nav transition animation ──
// When the active view changes, animate the entire nav list with a smooth
// vertical slide: the whole list slides up/down as one block, giving a
// clean "vertical pan" feel rather than per-button pops.
const navRef = ref<HTMLElement | null>(null);
const mobileNavRef = ref<HTMLElement | null>(null);
const prevView = ref<ViewKey>(ui.view);

watch(() => ui.view, (newView, oldView) => {
  if (newView === oldView) return;
  nextTick(() => {
    const containers = [navRef.value, mobileNavRef.value].filter(Boolean) as HTMLElement[];
    for (const container of containers) {
      const buttons = container.querySelectorAll("button[data-nav-key]");
      if (!buttons || buttons.length === 0) continue;

      const activeBtn = container.querySelector(`button[data-nav-key="${newView}"]`) as HTMLElement | null;
      const prevBtn = container.querySelector(`button[data-nav-key="${oldView}"]`) as HTMLElement | null;
      if (!activeBtn || !prevBtn) continue;

      // Determine direction: if the new active item is below the old one,
      // the list slides up (negative y); if above, it slides down (positive y).
      const allBtns = Array.from(buttons) as HTMLElement[];
      const newIdx = allBtns.indexOf(activeBtn);
      const oldIdx = allBtns.indexOf(prevBtn);
      const dir = newIdx > oldIdx ? -1 : 1; // -1 = slide up, 1 = slide down

      // Slide the whole nav list as one block (pure vertical translate, no scale)
      gsap.fromTo(container,
        { y: dir * -16 },   // start offset (opposite of slide direction)
        { y: 0, duration: 0.45, ease: "power2.out", clearProps: "transform" }
      );

      // Each button also gets a subtle individual vertical slide (staggered)
      // to enhance the "items flowing" feel — pure y translate, no scale.
      allBtns.forEach((el, i) => {
        gsap.fromTo(el,
          { y: dir * 8 },
          { y: 0, duration: 0.4, ease: "power2.out", delay: i * 0.025, clearProps: "transform" }
        );
      });
    }
    prevView.value = newView;
  });
});

// Wrapper view switch function that triggers the animation
const switchView = (key: ViewKey) => {
  if (key === ui.view) return;
  ui.setView(key);
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
          <button
            v-for="item in navItems"
            :key="item.key"
            :data-nav-key="item.key"
            type="button"
            @click="switchView(item.key)"
            :title="effectiveCollapsed ? item.label : undefined"
            :class="cn('state-layer group relative flex w-full items-center rounded-2xl text-sm font-medium transition-colors will-change-transform', effectiveCollapsed ? 'justify-center px-2 py-2.5' : 'gap-3 px-3.5 py-2.5', ui.view === item.key ? 'bg-primary text-primary-foreground shadow-lg shadow-primary/25' : 'text-muted-foreground hover:bg-foreground/5 hover:text-foreground')"
          >
            <component :is="item.icon" class="h-5 w-5 shrink-0" />
            <span v-if="!effectiveCollapsed" class="flex-1 text-left">{{ item.label }}</span>
          </button>
        </nav>
      </div>

      <!-- 追番库展开区域 -->
      <div class="glass glass-sheen mt-3 flex min-h-0 flex-1 flex-col rounded-3xl p-2.5">
        <button
          type="button"
          @click="ui.setView('library')"
          :title="effectiveCollapsed ? '追番库' : undefined"
          :class="cn('state-layer flex w-full items-center rounded-2xl text-left', effectiveCollapsed ? 'justify-center px-2 py-2' : 'gap-2 px-2 py-2')"
        >
          <span :class="cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-xl', ui.view === 'library' ? 'bg-primary text-primary-foreground' : 'bg-foreground/5 text-muted-foreground')">
            <Bookmark class="h-4 w-4" />
          </span>
          <template v-if="!effectiveCollapsed">
            <div class="min-w-0 flex-1">
              <p class="text-sm font-semibold text-foreground">追番库</p>
              <p class="text-[10px] text-muted-foreground">{{ libraryCount }} 部</p>
            </div>
            <span
              v-if="libraryCount > 0"
              @click.stop="libraryExpanded = !libraryExpanded"
              class="flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
            >
              <ChevronDown v-if="libraryExpanded" class="h-3 w-3" />
              <ChevronRight v-else class="h-3 w-3" />
            </span>
          </template>
        </button>
        <div v-if="!effectiveCollapsed && libraryExpanded && libraryCount > 0" class="mt-2 min-h-0 flex-1 space-y-1 overflow-y-auto pr-1">
          <button
            v-for="entry in libraryList"
            :key="entry.id"
            type="button"
            @click="ui.openDetail(entry.id, entry.image)"
            class="state-layer flex w-full items-center gap-2.5 rounded-xl p-1.5 text-left hover:bg-foreground/5"
          >
            <img
              v-if="entry.image"
              :src="entry.image"
              :alt="entry.title"
              class="h-10 w-7 shrink-0 rounded-md object-cover ring-1 ring-white/5"
              draggable="false"
            />
            <div v-else class="flex h-10 w-7 shrink-0 items-center justify-center rounded-md bg-foreground/10">
              <Bookmark class="h-3 w-3 text-muted-foreground" />
            </div>
            <div class="min-w-0 flex-1">
              <p class="line-clamp-1 text-xs font-medium text-foreground">{{ entry.title || `#${entry.id}` }}</p>
              <p class="text-[10px] text-muted-foreground">
                {{ entry.watchedEpisodes.length }}{{ entry.totalEpisodes > 0 ? `/${entry.totalEpisodes}` : "" }}话
              </p>
            </div>
          </button>
        </div>
        <div v-else-if="!effectiveCollapsed && libraryExpanded && libraryCount === 0" class="mt-2 py-4 text-center">
          <p class="text-[11px] text-muted-foreground">追番库为空</p>
        </div>
      </div>

      <!-- 设置按钮 (固定在侧边栏底部) -->
      <button
        type="button"
        @click="ui.setView('settings')"
        :title="effectiveCollapsed ? '设置' : undefined"
        :class="cn('state-layer mt-3 flex w-full items-center rounded-2xl text-sm font-medium transition-colors', effectiveCollapsed ? 'justify-center px-2 py-2.5' : 'gap-3 px-3.5 py-2.5', ui.view === 'settings' ? 'bg-primary text-primary-foreground shadow-lg shadow-primary/25' : 'glass glass-sheen text-muted-foreground hover:bg-foreground/5 hover:text-foreground')"
      >
        <SettingsIcon class="h-5 w-5 shrink-0" />
        <span v-if="!effectiveCollapsed" class="flex-1 text-left">设置</span>
      </button>
    </aside>

    <!-- main column (scrollable) -->
    <div class="flex min-w-0 flex-1 flex-col overflow-hidden">
      <header class="sticky top-0 z-40 px-3 pt-3 sm:px-4 md:px-6">
        <div class="glass glass-sheen flex items-center gap-2 rounded-full p-2 pl-3 sm:gap-3 sm:pl-4">
          <!-- sidebar toggle (desktop only) -->
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
            <img src="/aikf-logo-128.png" alt="AiKF" class="h-8 w-8 rounded-xl ring-1 ring-white/10" draggable="false" />
          </div>
          <div class="hidden flex-1 md:block"><SearchBar /></div>
          <div class="ml-auto flex items-center gap-2">
            <button type="button" @click="ui.setView('search')" class="glass state-layer flex h-9 items-center gap-2 rounded-full px-3 text-xs font-medium text-foreground md:hidden">
              <SearchIcon class="h-4 w-4" />
              <span class="hidden sm:inline">搜索</span>
            </button>
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
          class="state-layer relative flex flex-1 flex-col items-center gap-0.5 rounded-full py-2 text-[10px] font-medium will-change-transform"
        >
          <span :class="cn('flex h-8 w-12 items-center justify-center rounded-full transition-all', ui.view === item.key ? 'bg-primary text-primary-foreground shadow-md shadow-primary/30' : 'text-muted-foreground')">
            <component :is="item.icon" class="h-5 w-5" />
          </span>
          <span :class="ui.view === item.key ? 'text-primary' : 'text-muted-foreground'">{{ item.label }}</span>
        </button>
      </div>
    </nav>
  </div>
</template>
