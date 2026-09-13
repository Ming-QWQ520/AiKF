<script setup lang="ts">
// 极简静态背景层。
// 仅提供纯色底 + 顶部极淡的品牌色渐晕，无动画、无噪点、无漂浮光斑，
// 让内容层级完全依靠表面与边框表达（Mono Minimal 设计体系）。
</script>

<template>
  <div aria-hidden="true" class="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
    <div class="mesh-bg absolute inset-0" />
  </div>
</template>
