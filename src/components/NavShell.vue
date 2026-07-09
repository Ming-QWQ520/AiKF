<script setup lang="ts">
import { ref, computed } from "vue";
import { Compass, CalendarDays, LayoutGrid, Bookmark, Search as SearchIcon, ChevronDown, ChevronRight } from "lucide-vue-next";
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
</script>

<template>
  <div class="relative flex min-h-0 flex-1">
    <!-- desktop sidebar (fixed, always visible) -->
    <aside class="hidden h-full w-[260px] shrink-0 flex-col p-4 md:flex">
      <div class="glass glass-sheen rounded-3xl p-3">
        <div class="flex items-center gap-2.5 px-2 py-1.5">
          <img src="/aikf-logo-128.png" alt="AiKF" class="h-9 w-9 rounded-2xl shadow-lg shadow-primary/20 ring-1 ring-white/10" draggable="false" />
          <div class="leading-tight">
            <p class="text-base font-extrabold tracking-tight text-foreground">AiKF</p>
            <p class="text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground">Anich</p>
          </div>
        </div>
        <nav class="mt-3 flex flex-col gap-1">
          <button
            v-for="item in navItems"
            :key="item.key"
            type="button"
            @click="ui.setView(item.key)"
            :class="cn('state-layer group relative flex w-full items-center gap-3 rounded-2xl px-3.5 py-2.5 text-sm font-medium transition-colors', ui.view === item.key ? 'bg-primary text-primary-foreground shadow-lg shadow-primary/25' : 'text-muted-foreground hover:bg-foreground/5 hover:text-foreground')"
          >
            <component :is="item.icon" class="h-5 w-5 shrink-0" />
            <span class="flex-1 text-left">{{ item.label }}</span>
          </button>
        </nav>
      </div>

      <!-- 追番库展开区域 (默认展开) -->
      <div class="glass glass-sheen mt-3 flex min-h-0 flex-1 flex-col rounded-3xl p-3">
        <button
          type="button"
          @click="ui.setView('library')"
          class="state-layer flex w-full items-center gap-2 rounded-2xl px-2 py-2 text-left"
        >
          <span :class="cn('flex h-8 w-8 items-center justify-center rounded-xl', ui.view === 'library' ? 'bg-primary text-primary-foreground' : 'bg-foreground/5 text-muted-foreground')">
            <Bookmark class="h-4 w-4" />
          </span>
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
        </button>
        <div v-if="libraryExpanded && libraryCount > 0" class="mt-2 min-h-0 flex-1 space-y-1 overflow-y-auto pr-1">
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
        <div v-else-if="libraryExpanded && libraryCount === 0" class="mt-2 py-4 text-center">
          <p class="text-[11px] text-muted-foreground">追番库为空</p>
        </div>
      </div>
    </aside>

    <!-- main column (scrollable) -->
    <div class="flex min-w-0 flex-1 flex-col overflow-hidden">
      <header class="sticky top-0 z-40 px-4 pt-4 md:px-6">
        <div class="glass glass-sheen flex items-center gap-3 rounded-full p-2 pl-4">
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

      <main class="flex-1 overflow-y-auto px-4 pb-28 pt-4 md:px-6 md:pb-12"><slot /></main>
    </div>

    <!-- mobile bottom nav -->
    <nav class="fixed inset-x-0 bottom-0 z-40 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:hidden">
      <div class="glass-strong glass-sheen mx-auto flex max-w-md items-center justify-around rounded-full p-1.5">
        <button
          v-for="item in [...navItems, { key: 'library' as ViewKey, label: '追番库', icon: Bookmark }]"
          :key="item.key"
          type="button"
          @click="ui.setView(item.key)"
          class="state-layer relative flex flex-1 flex-col items-center gap-0.5 rounded-full py-2 text-[10px] font-medium"
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
