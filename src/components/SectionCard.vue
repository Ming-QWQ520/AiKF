<script setup lang="ts">
import { cn } from "@/lib/utils";

defineProps<{
  delay?: number;
}>();
</script>

<template>
  <section
    :style="{ animationDelay: `${delay ?? 0}s` }"
    :class="cn('glass glass-sheen rounded-3xl p-4 sm:p-5 fade-up', $attrs.class as string)"
  >
    <slot />
  </section>
</template>

<style scoped>
.fade-up {
  animation: fadeUp 0.5s cubic-bezier(0.22, 1, 0.36, 1) both;
}
@keyframes fadeUp {
  from { opacity: 0; transform: translateY(16px); }
  to { opacity: 1; transform: translateY(0); }
}
</style>
