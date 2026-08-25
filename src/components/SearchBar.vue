<script setup lang="ts">
import { ref, watch, computed } from "vue";
import { Search, X, Loader2 } from "lucide-vue-next";
import { anich } from "@/lib/anich/api-client";
import { useUIStore } from "@/stores/ui";
import { useAsync } from "@/composables/useAsync";
import CoverImage from "./CoverImage.vue";
import { cn } from "@/lib/utils";

const ui = useUIStore();
const value = ref("");
const debounced = ref("");
const focused = ref(false);

let timer: ReturnType<typeof setTimeout> | undefined;
watch(value, (v) => {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => (debounced.value = v.trim()), 350);
});

const onBlur = () => {
  setTimeout(() => (focused.value = false), 150);
};

const { data, isFetching } = useAsync(() => anich.search(debounced.value), {
  source: debounced,
});
const results = computed(() => data.value?.items ?? []);
const showDropdown = computed(() => focused.value && debounced.value.length > 0);

const submit = (q: string) => {
  if (!q.trim()) return;
  ui.setSearchQuery(q.trim());
  ui.setView("search");
  focused.value = false;
};
</script>

<template>
  <div class="relative w-full">
    <div :class="cn('glass glass-sheen flex items-center gap-2 rounded-full px-3.5 py-2 transition-all', focused ? 'ring-2 ring-primary/40' : 'ring-1 ring-border/60')">
      <Search class="h-4 w-4 shrink-0 text-muted-foreground" />
      <input
        v-model="value"
        @focus="focused = true"
        @blur="onBlur"
        @keydown.enter="submit(value)"
        @keydown.escape="($event.target as HTMLInputElement)?.blur()"
        placeholder="搜索番剧、动画…"
        class="w-full bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground/70"
      />
      <Loader2 v-if="isFetching" class="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
      <button v-if="value && !isFetching" type="button" aria-label="清除" @click="value = ''" class="text-muted-foreground hover:text-foreground">
        <X class="h-3.5 w-3.5" />
      </button>
    </div>

    <Transition name="dropdown">
      <div v-if="showDropdown" class="glass-strong glass-sheen absolute z-50 mt-2 max-h-[60vh] w-full overflow-y-auto rounded-2xl p-2">
        <div v-if="results.length === 0 && !isFetching" class="px-3 py-6 text-center text-sm text-muted-foreground">
          没有找到 “{{ debounced }}” 相关结果
        </div>
        <button
          v-for="item in results"
          :key="item.id"
          type="button"
          @mousedown.prevent
          @click="ui.openDetail(item.id, item.image), (focused = false)"
          class="state-layer flex w-full items-center gap-3 rounded-xl p-2 text-left hover:bg-foreground/5"
        >
          <CoverImage :src="item.image" :alt="item.title" ratio="portrait" class="h-12 w-9 shrink-0" rounded="rounded-lg" />
          <div class="min-w-0 flex-1">
            <p class="line-clamp-1 text-sm font-medium text-foreground">{{ item.title }}</p>
            <p class="line-clamp-1 text-xs text-muted-foreground">{{ item.tagline }}</p>
          </div>
        </button>
        <button v-if="debounced.length > 0" type="button" @mousedown.prevent @click="submit(value)" class="state-layer mt-1 w-full rounded-xl bg-primary/10 p-2 text-center text-xs font-medium text-primary hover:bg-primary/15">
          查看全部 “{{ debounced }}” 的结果 →
        </button>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.dropdown-enter-active,
.dropdown-leave-active { transition: all 0.18s ease; }
.dropdown-enter-from,
.dropdown-leave-to { opacity: 0; transform: translateY(-8px); }
</style>
