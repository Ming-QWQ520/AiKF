<script setup lang="ts">
defineProps<{
  title: string;
  subtitle?: string;
}>();
</script>

<template>
  <div class="flex items-end justify-between gap-4">
    <div class="flex items-center gap-3">
      <span v-if="$slots.icon" class="flex h-9 w-9 items-center justify-center rounded-lg bg-muted text-muted-foreground ring-1 ring-border">
        <slot name="icon" />
      </span>
      <div>
        <h2 class="text-lg font-semibold tracking-tight text-foreground sm:text-xl">{{ title }}</h2>
        <p v-if="subtitle" class="mt-0.5 text-xs text-muted-foreground sm:text-sm">{{ subtitle }}</p>
      </div>
    </div>
    <slot name="action" />
  </div>
</template>
