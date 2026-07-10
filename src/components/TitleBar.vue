<script setup lang="ts">
import { Minus, Square, X } from "lucide-vue-next";
import { invoke } from "@tauri-apps/api/core";

const isTauri =
  typeof window !== "undefined" &&
  ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);

const minimize = async () => {
  if (!isTauri) return;
  try { await invoke("plugin:window|minimize"); } catch (e) { console.error("minimize:", e); }
};
const toggleMaximize = async () => {
  if (!isTauri) return;
  try { await invoke("plugin:window|toggle_maximize"); } catch (e) { console.error("maximize:", e); }
};
const close = async () => {
  if (!isTauri) return;
  try { await invoke("plugin:window|close"); } catch (e) { console.error("close:", e); }
};
</script>

<template>
  <div
    data-tauri-drag-region
    class="flex h-10 shrink-0 select-none items-center justify-between border-b border-border/20 bg-transparent px-4"
  >
    <div data-tauri-drag-region class="flex items-center gap-2.5">
      <img src="/aikf-logo-128.png" alt="AiKF" class="h-5 w-5 rounded-md ring-1 ring-white/10" draggable="false" />
      <span data-tauri-drag-region class="text-xs font-bold tracking-tight text-foreground">AiKF</span>
    </div>
    <div class="flex items-center gap-0.5">
      <button
        v-if="isTauri"
        type="button"
        @click="minimize"
        aria-label="最小化"
        class="flex h-8 w-10 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
      >
        <Minus class="h-4 w-4" />
      </button>
      <button
        v-if="isTauri"
        type="button"
        @click="toggleMaximize"
        aria-label="最大化/还原"
        class="flex h-8 w-10 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
      >
        <Square class="h-3.5 w-3.5" />
      </button>
      <button
        v-if="isTauri"
        type="button"
        @click="close"
        aria-label="关闭"
        class="flex h-8 w-10 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-destructive hover:text-destructive-foreground"
      >
        <X class="h-4 w-4" />
      </button>
    </div>
  </div>
</template>
