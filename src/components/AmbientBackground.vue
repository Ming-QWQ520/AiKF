<script setup lang="ts">
// Decorative animated gradient blobs behind all content.
</script>

<template>
  <div aria-hidden="true" class="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
    <div class="mesh-bg absolute inset-0" />
    <div class="animate-float-slow absolute -left-24 -top-24 h-[42vh] w-[42vh] rounded-full bg-primary/25 blur-[90px]" />
    <div class="animate-float-slower absolute -right-20 top-1/4 h-[38vh] w-[38vh] rounded-full bg-secondary/20 blur-[90px]" />
    <div class="animate-float-slow absolute bottom-[-12vh] left-1/3 h-[40vh] w-[40vh] rounded-full bg-tertiary/20 blur-[100px]" />
    <div
      class="absolute inset-0 opacity-[0.035] mix-blend-overlay"
      style="background-image: url(&quot;data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E&quot;);"
    />
  </div>
</template>
