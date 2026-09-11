<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { ChevronDown, ChevronUp, Loader2, XCircle } from "lucide-vue-next";
import { useCacheStore, formatBytes, formatSpeed } from "@/stores/cache";
import { useLibraryStore } from "@/stores/library";
import { useUIStore } from "@/stores/ui";
import CoverImage from "@/components/CoverImage.vue";

/**
 * 全局下载坞（Steam 风格）：
 *  - 常驻主界面底部（NavShell 主列最后一个 flex 子元素 → 天然贴底、不遮挡内容）；
 *  - 下载时在任意页面均可见，不局限于本地缓存页；
 *  - 头部 = 总览（部数 / 总速度 / 体积）+ 展开/收起按键；
 *  - 展开列表 = Steam 下载页风格：封面 + 番剧名 + 当前话 · N 集下载中 +
 *    速度/体积 + 整行进度条 + 取消按键；
 *  - 收起时保留一根贴底细进度线（总进度可视化）。
 */
const cache = useCacheStore();
const library = useLibraryStore();
const ui = useUIStore();

// 展开/收起状态记忆（默认展开下载列表）
const expanded = ref(localStorage.getItem("aikf-dock-expanded") !== "0");
watch(expanded, (v) => localStorage.setItem("aikf-dock-expanded", v ? "1" : "0"));

interface DockItem {
  id: number;
  title: string;
  cover: string;
  count: number;
  sorts: number[];
  currentSort: number;
  epTitle: string;
  bytes: number;
  bytesTotal: number;
  speed: number;
  pct: number;
}

const items = computed<DockItem[]>(() => {
  const out: DockItem[] = [];
  for (const [idStr, agg] of cache.liveBangumi) {
    const id = Number(idStr);
    const fromIdx = cache.byId(id);
    // 封面/标题优先取缓存索引，兑底取追番库条目，最后用进度事件携带的标题
    const lib = library.list.find((e) => e.id === id);
    const title = fromIdx?.title || lib?.title || agg.title || `番剧 ${id}`;
    const cover = fromIdx?.cover || lib?.image || "";
    const sorts = [...agg.sorts].sort((a, b) => a - b);
    // 当前话 = 已有实际数据（分片/字节）的第一集，否则取最小集数
    const currentSort =
      sorts.find((s) => {
        const l = cache.live[`${id}:${s}`];
        return l && (l.bytes > 0 || l.segmentsTotal > 0);
      }) ?? sorts[0];
    const cur = currentSort != null ? cache.live[`${id}:${currentSort}`] : undefined;
    const bytes = cur?.bytes ?? 0;
    const bytesTotal = cur?.bytesTotal ?? 0;
    out.push({
      id,
      title,
      cover,
      count: agg.count,
      sorts,
      currentSort: currentSort ?? 0,
      epTitle: fromIdx?.episodes.find((e) => e.sort === currentSort)?.title || "",
      bytes,
      bytesTotal,
      speed: agg.speed,
      pct: bytesTotal > 0 ? Math.min(100, Math.round((bytes / bytesTotal) * 100)) : 0,
    });
  }
  return out.sort((a, b) => b.speed - a.speed);
});

const visible = computed(() => items.value.length > 0);
const totalSpeed = computed(() => items.value.reduce((n, d) => n + d.speed, 0));
const totalBytes = computed(() => items.value.reduce((n, d) => n + d.bytes, 0));
const totalBytesTotal = computed(() => items.value.reduce((n, d) => n + d.bytesTotal, 0));
const totalPct = computed(() =>
  totalBytesTotal.value > 0 ? Math.min(100, Math.round((totalBytes.value / totalBytesTotal.value) * 100)) : 0
);
</script>

<template>
  <div
    v-if="visible"
    data-aikf-dock
    class="shrink-0 border-t border-border/70 bg-background/95 backdrop-blur-md mb-[58px] md:mb-0"
  >
    <!-- 头部总览：点击展开/收起下载列表 -->
    <button
      type="button"
      class="flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-foreground/[0.03] sm:px-4"
      :aria-expanded="expanded"
      @click="expanded = !expanded"
    >
      <Loader2 class="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />
      <span class="shrink-0 text-xs font-semibold text-foreground">
        下载中 <span class="tabular-nums">{{ items.length }}</span> 部
      </span>
      <span class="shrink-0 text-[11px] font-semibold tabular-nums text-emerald-500">
        {{ formatSpeed(totalSpeed) || "连接中…" }}
      </span>
      <span class="ml-auto hidden shrink-0 text-[10px] tabular-nums text-muted-foreground sm:inline">
        {{ formatBytes(totalBytes) }}<template v-if="totalBytesTotal > 0"> / {{ formatBytes(totalBytesTotal) }}</template>
      </span>
      <span
        class="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
        :title="expanded ? '收起下载列表' : '展开下载列表'"
      >
        <ChevronDown v-if="expanded" class="h-3.5 w-3.5" />
        <ChevronUp v-else class="h-3.5 w-3.5" />
      </span>
    </button>

    <!-- 展开列表（Steam 下载页风格：封面 + 名称 + 当前话 + 整行进度条 + 速度/取消） -->
    <div v-if="expanded" class="max-h-[248px] overflow-y-auto px-2 pb-2 sm:px-3">
      <div
        v-for="d in items"
        :key="`dock${d.id}`"
        class="group flex cursor-pointer items-center gap-3 rounded-xl px-1.5 py-2 transition-colors hover:bg-foreground/[0.04]"
        title="查看本地缓存"
        @click="ui.setView('cache')"
      >
        <CoverImage :src="d.cover" :alt="d.title" ratio="portrait" class="h-[52px] w-9 shrink-0" rounded="rounded-md" />
        <div class="min-w-0 flex-1">
          <div class="flex items-center justify-between gap-2">
            <p class="line-clamp-1 text-xs font-bold text-foreground" :title="d.title">{{ d.title }}</p>
            <p class="flex flex-none items-center gap-1.5 text-[10px] tabular-nums text-muted-foreground">
              <span class="font-semibold text-emerald-500">{{ formatSpeed(d.speed) || "连接中…" }}</span>
              <span class="hidden sm:inline">{{ formatBytes(d.bytes) }}<template v-if="d.bytesTotal > 0"> / {{ formatBytes(d.bytesTotal) }}</template></span>
            </p>
          </div>
          <p class="mt-0.5 line-clamp-1 text-[10px] tabular-nums text-muted-foreground">
            第{{ d.currentSort }}话<template v-if="d.epTitle"> {{ d.epTitle }}</template>
            · {{ d.count }} 集下载中<template v-if="d.pct > 0"> · {{ d.pct }}%</template>
          </p>
          <!-- Steam 风格整行进度条（绿色） -->
          <div class="mt-1.5 h-1.5 overflow-hidden rounded-[3px] bg-emerald-500/15">
            <div class="h-full rounded-[3px] bg-gradient-to-r from-emerald-500 to-lime-400 transition-all duration-500" :style="{ width: d.pct + '%' }" />
          </div>
        </div>
        <button
          type="button"
          class="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
          title="取消该番剧全部下载"
          @click.stop="cache.cancelDownload(d.id)"
        >
          <XCircle class="h-4 w-4" />
        </button>
      </div>
    </div>

    <!-- 收起时：贴底细进度线（总进度可视化，Steam 绿） -->
    <div v-else class="h-[3px] w-full bg-emerald-500/15">
      <div class="h-full rounded-r-full bg-gradient-to-r from-emerald-500 to-lime-400 transition-all duration-500" :style="{ width: totalPct + '%' }" />
    </div>
  </div>
</template>
