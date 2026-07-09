<script setup lang="ts">
import { useUIStore } from "@/stores/ui";
import AmbientBackground from "@/components/AmbientBackground.vue";
import NavShell from "@/components/NavShell.vue";
import TitleBar from "@/components/TitleBar.vue";
import PlayerDialog from "@/components/PlayerDialog.vue";
import DiscoverView from "@/components/views/DiscoverView.vue";
import CalendarView from "@/components/views/CalendarView.vue";
import BrowseView from "@/components/views/BrowseView.vue";
import SearchView from "@/components/views/SearchView.vue";
import LibraryView from "@/components/views/LibraryView.vue";
import DetailView from "@/components/views/DetailView.vue";

const ui = useUIStore();

const viewComponent = () => {
  switch (ui.view) {
    case "discover": return DiscoverView;
    case "calendar": return CalendarView;
    case "browse": return BrowseView;
    case "search": return SearchView;
    case "library": return LibraryView;
    case "detail": return DetailView;
    default: return DiscoverView;
  }
};
</script>

<template>
  <div class="flex h-screen flex-col overflow-hidden">
    <TitleBar />
    <div class="relative flex min-h-0 flex-1 overflow-hidden">
      <AmbientBackground />
      <NavShell>
        <Transition name="view" mode="out-in">
          <component :is="viewComponent()" :key="ui.view + (ui.view === 'detail' ? ui.detailId ?? '' : '')" />
        </Transition>
      </NavShell>
    </div>
    <PlayerDialog />
  </div>
</template>

<style>
.view-enter-active,
.view-leave-active { transition: all 0.25s cubic-bezier(0.22, 1, 0.36, 1); }
.view-enter-from { opacity: 0; transform: translateY(8px); }
.view-leave-to { opacity: 0; transform: translateY(-8px); }
</style>
