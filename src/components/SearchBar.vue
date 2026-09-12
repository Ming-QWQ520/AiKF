<script setup lang="ts">
import { ref, watch, computed } from "vue";
import { Search, X, Loader2, Clock, Flame, Trash2 } from "lucide-vue-next";
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

// ── 搜索历史（localStorage 持久化，最多 12 条，新词置顶去重）──
const HISTORY_KEY = "aikf:search-history";
const history = ref<string[]>(loadHistory());

function loadHistory(): string[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((x) => typeof x === "string" && x.trim()).slice(0, 12) : [];
  } catch {
    return [];
  }
}
function persistHistory() {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(history.value)); } catch {}
}
function recordHistory(q: string) {
  const t = q.trim();
  if (!t) return;
  history.value = [t, ...history.value.filter((x) => x !== t)].slice(0, 12);
  persistHistory();
}
function removeHistory(q: string) {
  history.value = history.value.filter((x) => x !== q);
  persistHistory();
}
function clearHistory() {
  history.value = [];
  try { localStorage.removeItem(HISTORY_KEY); } catch {}
}

// ── 热门搜索（真实热搜榜 /bangumi/search_trends，无鉴权 1.5.24 新接口；
//    此前为 list(type=tv) 模拟，现在换成官方真实热榜，仅聚焦时拉取）──
const { data: trendData, isFetching: hotFetching } = useAsync(() => anich.searchTrends(), {
  enabled: focused,
  source: () => "trends",
});
const hotTerms = computed(() => (trendData.value ?? []).slice(0, 8).map((t) => t.value));

// 网络优化：仅在有实际关键词时才发起搜索请求 ——
// 此前无 enabled 限制，应用每次启动都会白发一次空关键词搜索。
const { data, isFetching } = useAsync(() => anich.search(debounced.value), {
  source: debounced,
  enabled: computed(() => debounced.value.length > 0),
});
const results = computed(() => data.value?.items ?? []);

// ── 输入联想（/bangumi/autocomplete，无鉴权新接口；≥2 字符触发）──
const { data: acData, isFetching: acFetching } = useAsync(() => anich.autocomplete(debounced.value), {
  source: debounced,
  enabled: computed(() => debounced.value.length >= 2),
});
const acItems = computed(() => (acData.value ?? []).slice(0, 6));

const showSuggest = computed(() => focused.value && debounced.value.length === 0);
const showResults = computed(() => focused.value && debounced.value.length > 0);

const submit = (q: string) => {
  const t = q.trim();
  if (!t) return;
  recordHistory(t);
  ui.setSearchQuery(t);
  ui.setView("search");
  focused.value = false;
};
</script>

<template>
  <div class="relative w-full">
    <div :class="cn('flex items-center gap-2 rounded-lg border bg-card px-3.5 py-2 transition-all', focused ? 'border-primary/50 ring-2 ring-primary/15' : 'border-border hover:border-foreground/20')">
      <Search class="h-4 w-4 shrink-0 text-muted-foreground" />
      <input
        v-model="value"
        @focus="focused = true"
        @blur="onBlur"
        @keydown.enter="submit(value)"
        @keydown.escape="($event.target as HTMLInputElement)?.blur()"
        :placeholder="$t('searchBar.placeholder')"
        class="w-full bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground/70"
      />
      <Loader2 v-if="isFetching" class="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
      <button v-if="value && !isFetching" type="button" :aria-label="$t('searchBar.clear')" @click="value = ''" class="text-muted-foreground hover:text-foreground">
        <X class="h-3.5 w-3.5" />
      </button>
    </div>

    <!-- 空输入：历史搜索 + 热门搜索 -->
    <Transition name="dropdown">
      <div v-if="showSuggest" class="surface absolute z-50 mt-2 max-h-[60vh] w-full overflow-y-auto rounded-xl p-3 shadow-lg shadow-black/5 dark:shadow-black/40">
        <!-- 历史搜索 -->
        <div v-if="history.length > 0">
          <div class="mb-2 flex items-center justify-between">
            <span class="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
              <Clock class="h-3.5 w-3.5" /> {{ $t('searchBar.history') }}
            </span>
            <button
              type="button"
              @mousedown.prevent
              @click="clearHistory"
              class="flex items-center gap-1 text-[11px] text-muted-foreground/70 transition-colors hover:text-foreground"
              :title="$t('searchBar.clearAllTitle')"
            >
              <Trash2 class="h-3 w-3" /> {{ $t('searchBar.clearAll') }}
            </button>
          </div>
          <div class="flex flex-wrap gap-1.5">
            <span v-for="h in history" :key="h" class="group relative inline-flex">
              <button
                type="button"
                @mousedown.prevent
                @click="submit(h)"
                class="max-w-[160px] truncate rounded-full bg-muted px-3 py-1 text-xs text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
              >{{ h }}</button>
              <button
                type="button"
                @mousedown.prevent
                @click.stop="removeHistory(h)"
                :aria-label="$t('searchBar.removeItem')"
                class="absolute -right-1 -top-1 hidden h-4 w-4 items-center justify-center rounded-full bg-foreground/70 text-background transition-colors hover:bg-destructive group-hover:flex"
              >
                <X class="h-2.5 w-2.5" />
              </button>
            </span>
          </div>
        </div>

        <!-- 热门搜索 -->
        <div v-if="hotTerms.length > 0" :class="cn(history.length > 0 && 'mt-3 border-t border-border/60 pt-3')">
          <div class="mb-2 flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
            <Flame class="h-3.5 w-3.5 text-primary" /> {{ $t('searchBar.hot') }}
          </div>
          <div class="grid grid-cols-2 gap-x-3">
            <button
              v-for="(t, i) in hotTerms"
              :key="t"
              type="button"
              @mousedown.prevent
              @click="submit(t)"
              class="flex min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-foreground/5"
            >
              <span class="w-4 shrink-0 text-center text-xs font-bold tabular-nums" :class="i < 3 ? 'text-primary' : 'text-muted-foreground/50'">{{ i + 1 }}</span>
              <span class="min-w-0 truncate text-xs text-foreground/85">{{ t }}</span>
              <Flame v-if="i === 0" class="h-3 w-3 shrink-0 text-primary/60" />
            </button>
          </div>
        </div>

        <div v-if="history.length === 0 && hotTerms.length === 0 && hotFetching" class="py-4 text-center text-xs text-muted-foreground">
          {{ $t('searchBar.hotLoading') }}
        </div>
      </div>
    </Transition>

    <!-- 输入中：实时搜索结果 -->
    <Transition name="dropdown">
      <div v-if="showResults" class="surface absolute z-50 mt-2 max-h-[60vh] w-full overflow-y-auto rounded-xl p-1.5 shadow-lg shadow-black/5 dark:shadow-black/40">
        <div v-if="results.length === 0 && !isFetching" class="px-3 py-6 text-center text-sm text-muted-foreground">
          {{ $t('searchBar.noResults', { q: debounced }) }}
        </div>
        <!-- 输入联想（官方 autocomplete 接口） -->
        <div v-if="acItems.length > 0">
          <div class="flex items-center gap-1.5 px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
            {{ $t('searchBar.suggest') }}
            <Loader2 v-if="acFetching" class="h-3 w-3 animate-spin" />
          </div>
          <button
            v-for="ac in acItems"
            :key="`ac-${ac.id}`"
            type="button"
            @mousedown.prevent
            @click="ui.openDetail(ac.id, ''), (focused = false)"
            class="state-layer flex w-full items-center gap-2.5 rounded-lg px-3 py-1.5 text-left hover:bg-foreground/5"
          >
            <Search class="h-3 w-3 shrink-0 text-muted-foreground/60" />
            <span class="min-w-0 flex-1 truncate text-xs text-foreground/90">{{ ac.title }}</span>
            <span v-if="ac.type || ac.lang" class="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[9px] text-muted-foreground">{{ [ac.type, ac.lang].filter(Boolean).join(' · ') }}</span>
          </button>
          <div v-if="results.length > 0" class="mx-3 my-1 border-t border-border/60" />
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
        <button v-if="debounced.length > 0" type="button" @mousedown.prevent @click="submit(value)" class="state-layer mt-1 w-full rounded-lg bg-primary/10 p-2 text-center text-xs font-medium text-primary hover:bg-primary/15">
          {{ $t('searchBar.viewAll', { q: debounced }) }}
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
