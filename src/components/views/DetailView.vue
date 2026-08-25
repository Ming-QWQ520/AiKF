<script setup lang="ts">
import { computed, ref } from "vue";
import { ArrowLeft, Play, BookmarkCheck, Star, Calendar, Globe, Film, Heart, ChevronDown } from "lucide-vue-next";
import { anich } from "@/lib/anich/api-client";
import { useUIStore } from "@/stores/ui";
import { useLibraryStore, STATUS_LABELS, STATUS_ORDER } from "@/stores/library";
import { useAsync } from "@/composables/useAsync";
import CoverImage from "@/components/CoverImage.vue";
import { formatDate } from "@/lib/anich/format";
import { cn } from "@/lib/utils";

const ui = useUIStore();
const library = useLibraryStore();

const idRef = computed(() => ui.detailId);
const { data: detail, isLoading: detailLoading } = useAsync(() => anich.detail(idRef.value!), { enabled: idRef, source: idRef });
const { data: episodes } = useAsync(() => anich.episodes(idRef.value!), { enabled: idRef, source: idRef });
const { data: related } = useAsync(() => anich.related(idRef.value!), { enabled: idRef, source: idRef });
const { data: characters } = useAsync(() => anich.characters(idRef.value!), { enabled: idRef, source: idRef });

// Comments — fetch for episode 1 + comment count
const { data: commentsData, isLoading: commentsLoading } = useAsync(
  () => anich.comments(idRef.value!, 1, undefined),
  { enabled: idRef, source: idRef }
);
const { data: commentCountData } = useAsync(
  () => anich.commentCount(idRef.value!, 1),
  { enabled: idRef, source: idRef }
);
const comments = computed(() => commentsData.value?.body?.data ?? []);
const commentCount = computed(() => commentCountData.value?.body?.data ?? 0);

// Expanded comment replies
const expandedReplies = ref<Set<string>>(new Set());
const repliesCache = ref<Record<string, any[]>>({});
const repliesLoading = ref<Set<string>>(new Set());

const toggleReplies = async (commentId: string) => {
  if (expandedReplies.value.has(commentId)) {
    expandedReplies.value.delete(commentId);
    return;
  }
  expandedReplies.value.add(commentId);
  if (!repliesCache.value[commentId]) {
    repliesLoading.value.add(commentId);
    try {
      const res = await anich.commentReplies(commentId);
      repliesCache.value[commentId] = res.body?.data ?? [];
    } catch { repliesCache.value[commentId] = []; }
    repliesLoading.value.delete(commentId);
  }
};

const entry = computed(() => (ui.detailId != null ? library.entries[ui.detailId] : undefined));
const cover = computed(() => detail.value?.image || ui.detailCover);
const bestRating = computed(() => detail.value?.rating?.find((r) => r.score > 0));
const activeTab = ref<"episodes" | "comments" | "related">("episodes");

const handlePlay = (episode: number) => {
  if (!entry.value && detail.value) {
    library.addOrUpdate(
      { id: detail.value.id, title: detail.value.title, image: detail.value.image, tagline: detail.value.genres.join("/"), totalEpisodes: detail.value.episodesTotal },
      "watching"
    );
  }
  ui.openPlayer({ bangumiID: ui.detailId!, episode, title: detail.value?.title ?? "", cover: cover.value });
};

const addToLibrary = () => {
  if (!detail.value) return;
  library.addOrUpdate(
    { id: detail.value.id, title: detail.value.title, image: detail.value.image, tagline: detail.value.genres.join("/"), totalEpisodes: detail.value.episodesTotal },
    "planned"
  );
};

const fmtCommentDate = (ts: number) => {
  if (!ts) return "";
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
</script>

<template>
  <div v-if="ui.detailId == null" class="mx-auto mt-20 max-w-md rounded-2xl bg-card p-10 text-center text-muted-foreground">未选择番剧</div>
  <div v-else class="mx-auto max-w-[1200px]">
    <button @click="ui.setView('discover')" class="mb-4 flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
      <ArrowLeft class="h-4 w-4" /> 返回
    </button>

    <!-- Hero: poster + info -->
    <div class="flex flex-col gap-6 sm:flex-row sm:gap-8">
      <div class="mx-auto w-40 shrink-0 sm:mx-0 sm:w-48">
        <template v-if="detailLoading"><div class="aspect-[3/4] w-full rounded-xl shimmer" /></template>
        <CoverImage v-else :src="cover" :alt="detail?.title ?? ''" ratio="portrait" rounded="rounded-xl" class="shadow-xl" />
      </div>
      <div class="flex min-w-0 flex-1 flex-col">
        <template v-if="detailLoading">
          <div class="space-y-3"><div class="h-7 w-3/4 rounded-lg shimmer" /><div class="h-4 w-1/2 rounded shimmer" /><div class="h-8 w-full rounded-lg shimmer" /></div>
        </template>
        <template v-else>
          <h1 class="text-xl font-extrabold tracking-tight text-foreground sm:text-2xl">{{ detail?.title }}</h1>
          <p v-if="detail?.titles?.length" class="mt-1 line-clamp-1 text-xs text-muted-foreground">{{ detail.titles.slice(0, 2).join(" · ") }}</p>

          <div v-if="bestRating" class="mt-3 flex items-center gap-2">
            <Star class="h-5 w-5 fill-tertiary text-tertiary" />
            <span class="text-lg font-bold text-foreground">{{ bestRating.score.toFixed(1) }}</span>
            <span class="text-xs text-muted-foreground">{{ bestRating.site }}</span>
          </div>

          <div class="mt-3 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
            <span v-if="detail?.airdate" class="flex items-center gap-1"><Calendar class="h-3 w-3" />{{ formatDate(detail.airdate) }}</span>
            <span v-if="detail?.lang" class="flex items-center gap-1"><Globe class="h-3 w-3" />{{ detail.lang }}</span>
            <span v-if="detail?.episode" class="flex items-center gap-1"><Film class="h-3 w-3" />更新至{{ detail.episode }}话</span>
            <span v-if="detail?.region?.length">{{ detail.region.join(" · ") }}</span>
            <span v-if="detail?.status">{{ detail.status }}</span>
          </div>

          <div v-if="detail?.genres?.length" class="mt-3 flex flex-wrap gap-1.5">
            <span v-for="g in detail.genres" :key="g" class="rounded-full bg-primary/10 px-3 py-0.5 text-[11px] font-medium text-primary">{{ g }}</span>
          </div>

          <div v-if="detail?.marks?.length" class="mt-2 flex flex-wrap gap-1.5">
            <span v-for="m in detail.marks" :key="m.name" class="rounded-full bg-foreground/5 px-2.5 py-0.5 text-[10px] text-muted-foreground">{{ m.name }} ({{ m.count }})</span>
          </div>

          <div class="mt-5 flex flex-wrap items-center gap-3">
            <button v-if="episodes && episodes.length > 0" @click="handlePlay(1)" class="flex items-center gap-2 rounded-lg bg-foreground px-6 py-2.5 text-sm font-bold text-background hover:bg-foreground/90">
              <Play class="h-4 w-4 fill-current" /> 播放第1集
            </button>
            <details v-if="entry" class="relative">
              <summary class="flex cursor-pointer list-none items-center gap-2 rounded-lg border border-border px-5 py-2.5 text-sm font-medium text-foreground">
                <BookmarkCheck class="h-4 w-4 text-primary" />{{ STATUS_LABELS[entry.status] }}
              </summary>
              <div class="absolute z-50 mt-2 w-40 rounded-xl border border-border bg-popover p-2 shadow-lg">
                <button v-for="s in STATUS_ORDER" :key="s" @click="library.setStatus(ui.detailId!, s)" class="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-foreground/5">
                  <span :class="cn('h-2 w-2 rounded-full', s === entry.status ? 'bg-primary' : 'bg-muted-foreground/30')" />{{ STATUS_LABELS[s] }}
                </button>
                <div class="my-1 h-px bg-border" />
                <button @click="library.remove(ui.detailId!)" class="w-full rounded-lg px-2 py-1.5 text-left text-sm text-destructive hover:bg-destructive/10">移出追番库</button>
              </div>
            </details>
            <button v-else @click="addToLibrary" class="flex items-center gap-2 rounded-lg border border-border px-5 py-2.5 text-sm font-medium text-foreground hover:bg-foreground/5">
              <Heart class="h-4 w-4" /> 收藏
            </button>
          </div>

          <p v-if="detail?.overview" class="mt-4 whitespace-pre-line text-sm leading-relaxed text-muted-foreground">{{ detail.overview }}</p>
        </template>
      </div>
    </div>

    <!-- Tabs -->
    <div class="mt-8 border-b border-border">
      <div class="flex gap-6">
        <button @click="activeTab = 'episodes'" :class="cn('border-b-2 pb-3 text-sm font-medium transition-colors', activeTab === 'episodes' ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground')">
          选集 <span v-if="episodes?.length" class="text-xs">({{ episodes.length }})</span>
        </button>
        <button @click="activeTab = 'comments'" :class="cn('border-b-2 pb-3 text-sm font-medium transition-colors', activeTab === 'comments' ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground')">
          评论 <span class="text-xs">({{ commentCount }})</span>
        </button>
        <button @click="activeTab = 'related'" :class="cn('border-b-2 pb-3 text-sm font-medium transition-colors', activeTab === 'related' ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground')">
          相关推荐 <span v-if="related?.length" class="text-xs">({{ related.length }})</span>
        </button>
      </div>
    </div>

    <!-- Tab content -->
    <div class="mt-6">
      <!-- Episodes -->
      <div v-if="activeTab === 'episodes'">
        <div v-if="!episodes || episodes.length === 0" class="py-8 text-center text-sm text-muted-foreground">暂无剧集</div>
        <div v-else class="flex flex-wrap gap-2">
          <button v-for="ep in episodes" :key="ep.sort" @click="handlePlay(ep.sort)" :class="cn('flex h-10 min-w-[2.5rem] items-center justify-center rounded-lg px-3 text-sm font-medium transition-colors', ep.sort === 1 ? 'bg-primary text-primary-foreground' : 'bg-foreground/5 text-foreground hover:bg-foreground/10')">{{ ep.sort }}</button>
        </div>
        <!-- Characters -->
        <div v-if="characters && characters.length > 0" class="mt-8">
          <h4 class="mb-3 text-sm font-bold text-foreground">角色 · 声优</h4>
          <div class="no-scrollbar flex gap-3 overflow-x-auto pb-1">
            <div v-for="c in characters" :key="c.id" class="glass w-28 shrink-0 rounded-xl p-2 text-center">
              <CoverImage :src="c.image" :alt="c.name" ratio="square" class="mx-auto w-full" rounded="rounded-lg" />
              <p class="mt-1 line-clamp-1 text-xs font-semibold text-foreground">{{ c.name }}</p>
              <p class="line-clamp-1 text-[10px] text-primary">{{ c.role }}</p>
              <p v-if="c.actors[0]" class="line-clamp-1 text-[10px] text-muted-foreground">CV: {{ c.actors[0].name }}</p>
            </div>
          </div>
        </div>
      </div>

      <!-- Comments with replies -->
      <div v-if="activeTab === 'comments'">
        <div v-if="commentsLoading" class="space-y-3"><div v-for="i in 3" :key="i" class="h-20 rounded-lg shimmer" /></div>
        <div v-else-if="comments.length === 0" class="py-8 text-center text-sm text-muted-foreground">暂无评论</div>
        <div v-else class="space-y-4">
          <div v-for="c in comments" :key="c.id" class="rounded-lg bg-card p-4">
            <div class="flex items-center gap-2">
              <img v-if="c.user?.avatar" :src="c.user.avatar" alt="" class="h-7 w-7 rounded-full object-cover" draggable="false" />
              <div v-else class="flex h-7 w-7 items-center justify-center rounded-full bg-primary/20 text-xs font-bold text-primary">{{ (c.user?.name || "?").charAt(0) }}</div>
              <div class="flex-1">
                <span class="text-sm font-semibold text-foreground">{{ c.user?.name || "匿名" }}</span>
                <span v-if="c.user?.issp" class="ml-1 rounded bg-tertiary/30 px-1 text-[9px] text-tertiary-foreground">UP</span>
              </div>
              <span class="text-[10px] text-muted-foreground">{{ fmtCommentDate(c.date) }}</span>
            </div>
            <p class="mt-2 text-sm leading-relaxed text-foreground/80">{{ c.text }}</p>
            <div class="mt-2 flex items-center gap-4 text-[11px] text-muted-foreground">
              <span v-if="c.likes_count" class="flex items-center gap-1">♥ {{ c.likes_count }}</span>
              <button v-if="c.replies_count > 0" @click="toggleReplies(c.id)" class="flex items-center gap-1 hover:text-foreground">
                {{ expandedReplies.has(c.id) ? "收起" : "展开" }} {{ c.replies_count }} 条回复
                <ChevronDown :class="cn('h-3 w-3 transition-transform', expandedReplies.has(c.id) && 'rotate-180')" />
              </button>
              <span v-if="c.address" class="text-muted-foreground/50">{{ c.address }}</span>
            </div>
            <!-- Replies -->
            <div v-if="expandedReplies.has(c.id) && repliesCache[c.id]" class="mt-3 ml-9 space-y-3 border-l border-border/40 pl-4">
              <div v-if="repliesLoading.has(c.id)" class="text-xs text-muted-foreground">加载中…</div>
              <div v-for="r in repliesCache[c.id]" :key="r.id" class="rounded-lg bg-foreground/5 p-2.5">
                <div class="flex items-center gap-2">
                  <img v-if="r.user?.avatar" :src="r.user.avatar" alt="" class="h-5 w-5 rounded-full object-cover" />
                  <span class="text-xs font-semibold text-foreground">{{ r.user?.name || "匿名" }}</span>
                  <span class="text-[10px] text-muted-foreground">{{ fmtCommentDate(r.date) }}</span>
                </div>
                <p class="mt-1 text-xs leading-relaxed text-foreground/70">{{ r.text }}</p>
              </div>
              <div v-if="repliesCache[c.id].length === 0" class="text-xs text-muted-foreground">暂无回复</div>
            </div>
          </div>
        </div>
      </div>

      <!-- Related -->
      <div v-if="activeTab === 'related'">
        <div v-if="!related || related.length === 0" class="py-8 text-center text-sm text-muted-foreground">暂无相关推荐</div>
        <div v-else class="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
          <button v-for="item in related.slice(0, 12)" :key="item.id" @click="ui.openDetail(item.id, item.image)" class="group flex flex-col text-left">
            <CoverImage :src="item.image" :alt="item.title" ratio="portrait" rounded="rounded-lg" class="transition-transform group-hover:scale-[1.03]" />
            <p class="mt-1.5 line-clamp-1 text-xs font-medium text-foreground">{{ item.title }}</p>
            <p v-if="item.type" class="text-[10px] text-muted-foreground">{{ item.type }}</p>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
