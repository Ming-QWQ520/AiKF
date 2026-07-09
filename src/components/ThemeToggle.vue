<script setup lang="ts">
import { Moon, Sun } from "lucide-vue-next";
import { useTheme } from "@/composables/useTheme";

const { theme, toggle } = useTheme();
</script>

<template>
  <button
    type="button"
    aria-label="切换主题"
    @click="toggle"
    class="glass glass-sheen state-layer relative flex h-9 w-9 items-center justify-center rounded-full text-foreground"
  >
    <Transition name="theme-icon" mode="out-in">
      <Moon v-if="theme === 'dark'" key="moon" class="h-4 w-4" />
      <Sun v-else key="sun" class="h-4 w-4" />
    </Transition>
  </button>
</template>

<style scoped>
.theme-icon-enter-active,
.theme-icon-leave-active {
  transition: all 0.25s ease;
}
.theme-icon-enter-from { transform: rotate(-90deg) scale(0.6); opacity: 0; }
.theme-icon-leave-to { transform: rotate(90deg) scale(0.6); opacity: 0; }
</style>
