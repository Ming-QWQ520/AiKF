<script setup lang="ts">
defineProps<{ on: boolean }>();
const emit = defineEmits<{ (e: "toggle"): void }>();
</script>

<template>
  <button
    type="button"
    role="switch"
    :aria-checked="on"
    @click="emit('toggle')"
    :class="['relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors', on ? 'bg-primary' : 'bg-foreground/15']"
  >
    <span
      :class="['inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform', on ? 'translate-x-6' : 'translate-x-1']"
    />
  </button>
</template>
