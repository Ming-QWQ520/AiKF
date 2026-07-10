<script setup lang="ts">
import { useUIStore } from "@/stores/ui";
import AmbientBackground from "@/components/AmbientBackground.vue";
import CustomBackground from "@/components/CustomBackground.vue";
import NavShell from "@/components/NavShell.vue";
import TitleBar from "@/components/TitleBar.vue";
import PlayerDialog from "@/components/PlayerDialog.vue";
import DiscoverView from "@/components/views/DiscoverView.vue";
import CalendarView from "@/components/views/CalendarView.vue";
import BrowseView from "@/components/views/BrowseView.vue";
import SearchView from "@/components/views/SearchView.vue";
import LibraryView from "@/components/views/LibraryView.vue";
import DetailView from "@/components/views/DetailView.vue";
import SettingsView from "@/components/views/SettingsView.vue";
import { initThemeOnLoad } from "@/composables/useTheme";
import { gsap } from "gsap";

const ui = useUIStore();

// Initialize theme system (watches settings store for live theme switching)
initThemeOnLoad();

const viewComponent = () => {
  switch (ui.view) {
    case "discover": return DiscoverView;
    case "calendar": return CalendarView;
    case "browse": return BrowseView;
    case "search": return SearchView;
    case "library": return LibraryView;
    case "detail": return DetailView;
    case "settings": return SettingsView;
    default: return DiscoverView;
  }
};

// GSAP-powered view transitions (smoother than CSS transitions)
const onEnter = (el: Element, done: () => void) => {
  gsap.fromTo(el,
    { opacity: 0, y: 12, filter: "blur(4px)" },
    { opacity: 1, y: 0, filter: "blur(0px)", duration: 0.35, ease: "power2.out", clearProps: "filter", onComplete: done }
  );
};
const onLeave = (el: Element, done: () => void) => {
  gsap.to(el,
    { opacity: 0, y: -8, filter: "blur(4px)", duration: 0.22, ease: "power2.in", onComplete: done }
  );
};
</script>

<template>
  <!-- custom user background — rendered first, fixed to viewport, behind everything -->
  <CustomBackground />
  <AmbientBackground />
  <div class="relative flex h-screen flex-col overflow-hidden">
    <TitleBar />
    <div class="relative flex min-h-0 flex-1 overflow-hidden">
      <NavShell>
        <Transition mode="out-in" :css="false" @enter="onEnter" @leave="onLeave">
          <component :is="viewComponent()" :key="ui.view + (ui.view === 'detail' ? ui.detailId ?? '' : '')" />
        </Transition>
      </NavShell>
    </div>
    <PlayerDialog />
  </div>
</template>
