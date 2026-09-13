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
import CacheView from "@/components/views/CacheView.vue";
import LibraryView from "@/components/views/LibraryView.vue";
import DetailView from "@/components/views/DetailView.vue";
import SettingsView from "@/components/views/SettingsView.vue";
import { initThemeOnLoad } from "@/composables/useTheme";
import { useSettingsStore, type AnimLevel } from "@/stores/settings";
import { gsap } from "gsap";
import { watch } from "vue";

const ui = useUIStore();
const settings = useSettingsStore();

// Initialize theme system (watches settings store for live theme switching)
initThemeOnLoad();

// ── 动画等级（任务 29）：设置实时写入 <html data-anim="...">，驱动 globals.css
//    内的全局分级规则（shimmer 扫光降级/hover 缩放关闭/全部关闭/封面载入降级）
const applyAnimLevel = (lv: AnimLevel) => {
  document.documentElement.dataset.anim = lv || "full";
};
watch(() => settings.data.animLevel, applyAnimLevel, { immediate: true });

const viewComponent = () => {
  switch (ui.view) {
    case "discover": return DiscoverView;
    case "calendar": return CalendarView;
    case "browse": return BrowseView;
    case "cache": return CacheView;
    case "library": return LibraryView;
    case "detail": return DetailView;
    case "settings": return SettingsView;
    default: return DiscoverView;
  }
};

// GSAP-powered view transitions (smoother than CSS transitions)
// 动画等级分级（任务 29）：off → 跳过动画直接完成；basic → 仅 opacity 淡入淡出（无 blur/y
// 位移，filter 模糊属于逐帧重绘高开销属性）；full → 默认完整动画。
// ⚠️ off 分支绝不能同步调用 done()：Vue out-in 模式的 leave 同步完成会与组件卸载/
// 重渲染竞态（生产环境实测大量 "Cannot read properties of null (reading 'parentNode')"
// + 整页白屏）。必须用 rAF 异步完成，给 Vue 一个渲染 tick 收尾。
const doneAsync = (done: () => void) => requestAnimationFrame(() => done());
const onEnter = (el: Element, done: () => void) => {
  const lv = settings.data.animLevel ?? "full";
  if (lv === "off") { gsap.set(el, { opacity: 1 }); doneAsync(done); return; }
  if (lv === "basic") {
    gsap.fromTo(el, { opacity: 0 },
      { opacity: 1, duration: 0.18, ease: "power1.out", clearProps: "all", onComplete: done });
    return;
  }
  gsap.fromTo(el,
    { opacity: 0, y: 12, filter: "blur(4px)" },
    // clearProps: "all" —— 残留的内联 transform/filter 会创建 containing block，
    // 导致视图内 fixed 定位元素（如评论页回到顶部按钮）锚定到整个滚动内容
    // 而不是视口右下角；动画结束后必须清干净。
    { opacity: 1, y: 0, filter: "blur(0px)", duration: 0.35, ease: "power2.out", clearProps: "all", onComplete: done }
  );
};
const onLeave = (el: Element, done: () => void) => {
  const lv = settings.data.animLevel ?? "full";
  if (lv === "off") { doneAsync(done); return; }
  if (lv === "basic") {
    gsap.to(el, { opacity: 0, duration: 0.12, ease: "power1.in", onComplete: done });
    return;
  }
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
