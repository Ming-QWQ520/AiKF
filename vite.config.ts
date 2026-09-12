import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";
import VueI18nPlugin from "@intlify/unplugin-vue-i18n/vite";
import { fileURLToPath, URL } from "node:url";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [
    vue(),
    tailwindcss(),
    // vue-i18n 预编译：构建期把 locales JSON 编译为 AST 函数，
    // ① 消息语法错误（如未转义的 @ / { ）在构建期直接报错，杜绝运行时
    //    tokenizer 崩溃导致的整页白屏（曾因 "@开发者" 触发）；
    // ② 运行时零消息编译，t() 更快，且 vue-i18n 自动切到 runtime-only 版更小。
    VueI18nPlugin({
      include: [fileURLToPath(new URL("./src/i18n/locales", import.meta.url))],
    }),
  ],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  // Vite options tailored for Tauri development
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? { protocol: "ws", host, port: 1421 }
      : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: {
    target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari13",
    minify: !process.env.TAURI_ENV_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
}));
