<script setup lang="ts">
/**
 * BgmEntityDialog —— 角色 / 制作人员详情弹窗（需求：角色/制作可点击查看详情）。
 * 数据源：AniCh 代理的 Bangumi 端点（/bangumi/character/{id}、/bangumi/person/{id}），
 * 无需 Bangumi 登录，所有条目均可用。
 * 弹窗内附「关联作品」网格（该角色/人员参与的其他番剧），点击直接跳转应用内详情页。
 */
import { ref, computed, watch } from "vue";
import { X, Loader2, ChevronDown } from "lucide-vue-next";
import { anich, type BangumiCharacterDetail, type BangumiPersonDetail, type BangumiWork } from "@/lib/anich/api-client";
import { useUIStore } from "@/stores/ui";

const props = defineProps<{
  kind: "character" | "person";
  id: number;
  /** 弹窗打开瞬间的兜底名称/图片（详情未返回前先显示，避免空白闪烁） */
  initialName?: string;
  initialImage?: string;
}>();

const emit = defineEmits<{ (e: "close"): void }>();
const ui = useUIStore();

const detail = ref<BangumiCharacterDetail | BangumiPersonDetail | null>(null);
const detailLoading = ref(false);
const works = ref<BangumiWork[]>([]);
const worksNext = ref(false);
const worksLoading = ref(false);
let worksReqId = 0;

const displayName = computed(() => detail.value?.name || props.initialName || "—");
const displayImage = computed(() => detail.value?.image || props.initialImage || "");
const akaText = computed(() => {
  const aka = (detail.value?.aka ?? []).filter((s) => s && s.trim() && s.trim() !== detail.value?.name);
  return aka.join(" / ");
});
const genderText = computed(() => (detail.value?.gender || "").trim());
/** 角色专属：配音演员列表 */
const cvNames = computed(() =>
  props.kind === "character" ? ((detail.value as BangumiCharacterDetail | null)?.actors ?? []).map((a) => a.name).filter(Boolean) : []
);

async function loadWorks(skip = 0) {
  if (props.id == null) return;
  const req = ++worksReqId;
  worksLoading.value = true;
  try {
    const res =
      props.kind === "character" ? await anich.characterWorks(props.id, skip) : await anich.personWorks(props.id, skip);
    if (req !== worksReqId) return; // 竞态保护
    const items = res?.data ?? [];
    works.value = skip > 0 ? [...works.value, ...items] : items;
    worksNext.value = !!res?.next;
  } catch {
    if (req === worksReqId) worksNext.value = false;
  } finally {
    if (req === worksReqId) worksLoading.value = false;
  }
}

watch(
  () => [props.kind, props.id] as const,
  async ([kind, id]) => {
    detail.value = null;
    works.value = [];
    worksNext.value = false;
    if (id == null) return;
    detailLoading.value = true;
    try {
      detail.value = kind === "character" ? await anich.characterDetail(id) : await anich.personDetail(id);
    } catch {
      detail.value = null; // 详情拉取失败：仍显示兜底名称/图片与作品列表
    } finally {
      detailLoading.value = false;
    }
    loadWorks(0);
  },
  { immediate: true }
);

const openWork = (w: BangumiWork) => {
  if (!w?.id) return;
  ui.openDetail(w.id, w.image || "");
  emit("close");
};
</script>

<template>
  <Teleport to="body">
    <div class="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" @click.self="emit('close')">
      <div class="flex max-h-[82vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl shadow-black/30">
        <!-- 标题栏 -->
        <div class="flex shrink-0 items-center justify-between gap-2 border-b border-border/70 px-4 py-3">
          <h3 class="flex min-w-0 items-center gap-2 text-sm font-semibold text-foreground">
            <span class="shrink-0 rounded-md bg-primary/10 px-1.5 py-0.5 text-[10px] font-bold text-primary">
              {{ $t(props.kind === 'character' ? 'entity.character' : 'entity.person') }}
            </span>
            <span class="truncate">{{ displayName }}</span>
          </h3>
          <button
            @click="emit('close')"
            class="shrink-0 rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
            v-tip="$t('common.close')"
            :aria-label="$t('common.close')"
          >
            <X class="h-4 w-4" />
          </button>
        </div>

        <!-- 正文 -->
        <div class="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          <!-- 顶部：图片 + 元信息 -->
          <div class="flex gap-4">
            <div class="h-32 w-24 shrink-0 overflow-hidden rounded-xl bg-muted ring-1 ring-foreground/10">
              <img
                v-if="displayImage"
                :src="displayImage"
                :alt="displayName"
                loading="lazy"
                class="h-full w-full object-cover object-top"
                draggable="false"
                @error="($event.target as HTMLElement).style.opacity = '0'"
              />
            </div>
            <div class="min-w-0 flex-1 space-y-1.5 text-xs">
              <template v-if="detailLoading">
                <div class="h-5 w-2/3 rounded shimmer" />
                <div class="h-3.5 w-1/2 rounded shimmer" />
                <div class="h-3.5 w-3/4 rounded shimmer" />
              </template>
              <template v-else>
                <p class="text-base font-bold leading-snug text-foreground">{{ displayName }}</p>
                <p v-if="akaText" class="leading-relaxed text-muted-foreground">
                  <span class="text-muted-foreground/70">{{ $t('entity.aka') }}: </span>{{ akaText }}
                </p>
                <p v-if="genderText" class="text-muted-foreground">
                  <span class="text-muted-foreground/70">{{ $t('entity.gender') }}: </span>{{ genderText }}
                </p>
                <p v-if="cvNames.length" class="leading-relaxed text-muted-foreground">
                  <span class="shrink-0 text-muted-foreground/70">{{ $t('entity.cv') }}: </span
                  ><span class="text-foreground/85">{{ cvNames.join(' / ') }}</span>
                </p>
              </template>
            </div>
          </div>

          <!-- 简介 -->
          <div class="mt-4">
            <h4 class="mb-1.5 text-sm font-bold text-foreground">{{ $t('entity.summary') }}</h4>
            <p v-if="detail?.summary" class="whitespace-pre-line text-xs leading-6 text-foreground/80">{{ detail.summary }}</p>
            <p v-else-if="!detailLoading" class="text-xs text-muted-foreground">{{ $t('entity.noSummary') }}</p>
          </div>

          <!-- 关联作品 -->
          <div class="mt-4">
            <h4 class="mb-2 text-sm font-bold text-foreground">{{ $t('entity.works') }}</h4>
            <div v-if="works.length === 0 && worksLoading" class="grid grid-cols-3 gap-2.5">
              <div v-for="i in 3" :key="i" class="aspect-[3/4] rounded-lg shimmer" />
            </div>
            <p v-else-if="works.length === 0" class="text-xs text-muted-foreground">{{ $t('entity.noWorks') }}</p>
            <template v-else>
              <div class="grid grid-cols-3 gap-2.5 sm:grid-cols-4">
                <button
                  v-for="w in works"
                  :key="w.id"
                  @click="openWork(w)"
                  class="group min-w-0 overflow-hidden rounded-lg text-left ring-1 ring-foreground/5 transition-colors hover:ring-primary/40"
                  v-tip="w.title"
                >
                  <div class="aspect-[3/4] w-full overflow-hidden bg-muted">
                    <img
                      v-if="w.image"
                      :src="w.image"
                      :alt="w.title"
                      loading="lazy"
                      class="h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.04]"
                      draggable="false"
                    />
                  </div>
                  <div class="px-1 py-1">
                    <p class="line-clamp-1 text-[11px] font-medium text-foreground">{{ w.title }}</p>
                    <p v-if="w.episodesTotal > 0" class="text-[10px] tabular-nums text-muted-foreground">
                      {{ $t('detail.totalEps', { n: w.episodesTotal }) }}
                    </p>
                  </div>
                </button>
              </div>
              <button
                v-if="worksNext"
                @click="loadWorks(works.length)"
                :disabled="worksLoading"
                class="state-layer mx-auto mt-3 flex items-center gap-1.5 rounded-lg border border-border px-3.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
              >
                <Loader2 v-if="worksLoading" class="h-3 w-3 animate-spin" />
                <ChevronDown v-else class="h-3 w-3" />
                {{ $t('entity.loadMore') }}
              </button>
            </template>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>
