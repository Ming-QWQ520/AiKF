<script setup lang="ts">
import { ref, computed } from "vue";
import { Search as SearchIcon, Loader2, TrendingUp } from "lucide-vue-next";
import { anich } from "@/lib/anich/api-client";
import { useUIStore } from "@/stores/ui";
import { useAsync } from "@/composables/useAsync";
import AnimeGrid from "@/components/AnimeGrid.vue";
import AnimeGridSkeleton from "@/components/AnimeGridSkeleton.vue";
import SectionCard from "@/components/SectionCard.vue";
import { cn } from "@/lib/utils";

const ui = useUIStore();
const input = ref(ui.searchQuery);

const queryRef = computed(() => ui.searchQuery);
const { data, isLoading } = useAsync(() => anich.search(ui.searchQuery, 0), {
  enabled: queryRef,
  source: queryRef,
});
const items = computed(() => data.value?.items ?? []);

const SUGGESTIONS = ["鬼灭之刃", "咒术回战", "间谍过家家", "葬送的芙莉莲", "进击的巨人", "海贼王", "名侦探柯南", "药屋少女"]; // i18n-skip: 作品名（专有名词）不翻译

const submit = (val: string) => {
  const v = val.trim();
  if (!v) return;
  ui.setSearchQuery(v);
};
</script>

<template>
  <div class="mx-auto flex max-w-[1400px] flex-col gap-5">
    <SectionCard>
      <div class="flex flex-col gap-4">
        <div class="flex items-center gap-3">
          <span class="flex h-9 w-9 items-center justify-center rounded-lg bg-muted text-muted-foreground ring-1 ring-border">
            <SearchIcon class="h-4.5 w-4.5" />
          </span>
          <div>
            <h2 class="text-lg font-semibold sm:text-xl">{{ $t('search.title') }}</h2>
            <p class="text-xs text-muted-foreground sm:text-sm">{{ $t('search.subtitle') }}</p>
          </div>
        </div>
        <div :class="cn('flex items-center gap-2 rounded-xl border bg-card px-4 py-3 transition-all focus-within:border-primary/50 focus-within:ring-2 focus-within:ring-primary/15', 'border-border')">
          <SearchIcon class="h-4.5 w-4.5 shrink-0 text-muted-foreground" />
          <input
            v-model="input"
            autofocus
            @keydown.enter="submit(input)"
            :placeholder="$t('search.placeholder')"
            class="w-full bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground/70 sm:text-base"
          />
          <Loader2 v-if="isLoading" class="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
        </div>
        <div v-if="!ui.searchQuery" class="flex flex-wrap items-center gap-2">
          <span class="flex items-center gap-1 text-xs text-muted-foreground">
            <TrendingUp class="h-3.5 w-3.5" /> {{ $t('searchBar.hot') }}
          </span>
          <!-- i18n-skip: SUGGESTIONS 为作品名（专有名词），多语言下保持原样 -->
          <button v-for="s in SUGGESTIONS" :key="s" @click="input = s; submit(s)" class="state-layer rounded-full bg-muted px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground">{{ s }}</button>
        </div>
      </div>
    </SectionCard>

    <section v-if="ui.searchQuery" class="flex flex-col gap-4">
      <p class="text-sm text-muted-foreground">{{ isLoading ? $t('search.searching') : $t('search.resultCount', { q: ui.searchQuery, n: items.length }) }}</p>
      <AnimeGridSkeleton v-if="isLoading" :count="12" />
      <AnimeGrid v-else :items="items" :empty-hint="$t('search.empty', { q: ui.searchQuery })" @select="(id, cover) => ui.openDetail(id, cover)" />
    </section>
  </div>
</template>
