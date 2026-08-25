<script setup lang="ts">
defineProps<{ count?: number }>();
</script>

<template>
  <div class="grid grid-cols-2 gap-x-3 gap-y-4 sm:grid-cols-3 sm:gap-x-4 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
    <div v-for="i in (count ?? 12)" :key="i" class="flex flex-col gap-2">
      <div class="aspect-[3/4] w-full rounded-2xl shimmer" />
      <div class="h-3 w-3/4 rounded-full shimmer" />
      <div class="h-2.5 w-1/2 rounded-full shimmer" />
    </div>
  </div>
</template>
