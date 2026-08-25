<script setup lang="ts">
// Decorative animated gradient blobs behind all content.
// GSAP drives the floating animation (smoother than CSS keyframes, uses rAF).
import { onMounted, onBeforeUnmount, ref } from "vue";
import { gsap } from "gsap";

const blob1 = ref<HTMLElement | null>(null);
const blob2 = ref<HTMLElement | null>(null);
const blob3 = ref<HTMLElement | null>(null);
let tl: gsap.core.Timeline | null = null;

onMounted(() => {
  // gentle infinite floating using GSAP timeline (GPU-accelerated transforms)
  tl = gsap.timeline({ repeat: -1, yoyo: true });
  if (blob1.value) tl.to(blob1.value, { x: 40, y: -30, scale: 1.05, duration: 16, ease: "sine.inOut" }, 0);
  if (blob2.value) tl.to(blob2.value, { x: -35, y: 25, scale: 0.95, duration: 20, ease: "sine.inOut" }, 0);
  if (blob3.value) tl.to(blob3.value, { x: 25, y: 30, scale: 1.08, duration: 18, ease: "sine.inOut" }, 0);
});

onBeforeUnmount(() => { tl?.kill(); });
</script>

<template>
  <div aria-hidden="true" class="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
    <div class="mesh-bg absolute inset-0" />
    <div ref="blob1" class="absolute -left-24 -top-24 h-[42vh] w-[42vh] rounded-full bg-primary/25 blur-[90px] will-change-transform" />
    <div ref="blob2" class="absolute -right-20 top-1/4 h-[38vh] w-[38vh] rounded-full bg-secondary/20 blur-[90px] will-change-transform" />
    <div ref="blob3" class="absolute bottom-[-12vh] left-1/3 h-[40vh] w-[40vh] rounded-full bg-tertiary/20 blur-[100px] will-change-transform" />
    <div
      class="absolute inset-0 opacity-[0.035] mix-blend-overlay"
      style="background-image: url(&quot;data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E&quot;);"
    />
  </div>
</template>
