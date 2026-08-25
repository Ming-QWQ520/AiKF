<script setup lang="ts">
import { ref } from "vue";
import { Moon, Sun } from "lucide-vue-next";
import { gsap } from "gsap";
import { useTheme } from "@/composables/useTheme";

const { theme, toggle } = useTheme();
const iconRef = ref<HTMLElement | null>(null);

const onToggle = () => {
  // GSAP spin + scale animation on the icon
  if (iconRef.value) {
    gsap.fromTo(iconRef.value,
      { rotate: -180, scale: 0.4, opacity: 0 },
      { rotate: 0, scale: 1, opacity: 1, duration: 0.4, ease: "back.out(1.7)" }
    );
  }
  toggle();
};
</script>

<template>
  <button
    type="button"
    aria-label="切换主题"
    @click="onToggle"
    class="glass glass-sheen state-layer relative flex h-9 w-9 items-center justify-center rounded-full text-foreground"
  >
    <span ref="iconRef" class="flex items-center justify-center">
      <Moon v-if="theme === 'dark'" class="h-4 w-4" />
      <Sun v-else class="h-4 w-4" />
    </span>
  </button>
</template>
