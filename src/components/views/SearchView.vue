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

const SUGGESTIONS = ["鬼灭之刃", "咒术回战", "间谍过家家", "葬送的芙莉莲", "进击的巨人", "海贼王", "名侦探柯南", "药屋少女"];

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
          <span class="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/15 text-primary ring-1 ring-primary/20">
            <SearchIcon class="h-4.5 w-4.5" />
          </span>
          <div>
            <h2 class="text-lg font-bold sm:text-xl">搜索番剧</h2>
            <p class="text-xs text-muted-foreground sm:text-sm">输入番剧名称或关键词</p>
          </div>
        </div>
        <div :class="cn('glass glass-sheen flex items-center gap-2 rounded-2xl px-4 py-3 transition-all ring-1 ring-border/60 focus-within:ring-2 focus-within:ring-primary/40')">
          <SearchIcon class="h-4.5 w-4.5 shrink-0 text-muted-foreground" />
          <input
            v-model="input"
            autofocus
            @keydown.enter="submit(input)"
            placeholder="搜索番剧、动画…"
            class="w-full bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground/70 sm:text-base"
          />
          <Loader2 v-if="isLoading" class="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
        </div>
        <div v-if="!ui.searchQuery" class="flex flex-wrap items-center gap-2">
          <span class="flex items-center gap-1 text-xs text-muted-foreground">
            <TrendingUp class="h-3.5 w-3.5" /> 热门搜索
          </span>
          <button v-for="s in SUGGESTIONS" :key="s" @click="input = s; submit(s)" class="state-layer rounded-full bg-foreground/5 px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-foreground/10 hover:text-foreground">{{ s }}</button>
        </div>
      </div>
    </SectionCard>

    <section v-if="ui.searchQuery" class="flex flex-col gap-4">
      <p class="text-sm text-muted-foreground">{{ isLoading ? "搜索中…" : `“${ui.searchQuery}” 的搜索结果 · ${items.length} 部` }}</p>
      <AnimeGridSkeleton v-if="isLoading" :count="12" />
      <AnimeGrid v-else :items="items" :empty-hint="`没有找到 “${ui.searchQuery}” 相关的番剧`" @select="(id, cover) => ui.openDetail(id, cover)" />
    </section>
  </div>
</template>
