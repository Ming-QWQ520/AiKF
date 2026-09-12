import { createI18n } from "vue-i18n";
import zhCN from "./locales/zh-CN.json";
import en from "./locales/en.json";
import type { Language } from "@/stores/settings";

/**
 * vue-i18n（intlify）全局实例。
 *
 * - 默认语言：简体中文（zh-CN）—— 需求「默认使用中文」；
 * - 语言切换：设置页 → 语言（写入 settings store 的 language 字段，
 *   main.ts 中 watch 同步到本模块 → 全界面即时生效）；
 * - 模板中直接用 $t / $d；<script setup> 内 useI18n() 或
 *   `import { i18n } from "@/i18n"` 后 i18n.global.t（纯 TS 模块同此）。
 */
export const i18n = createI18n({
  legacy: false,
  globalInjection: true,
  locale: "zh-CN",
  fallbackLocale: "zh-CN",
  messages: {
    "zh-CN": zhCN,
    en,
  },
  // 日期格式化（$d / i18n.global.d）：长日期 + 长日期带时间 两档
  datetimeFormats: {
    "zh-CN": {
      long: { year: "numeric", month: "long", day: "numeric" },
      longTime: {
        year: "numeric", month: "long", day: "numeric",
        hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
      },
    },
    en: {
      long: { year: "numeric", month: "short", day: "numeric" },
      longTime: {
        year: "numeric", month: "short", day: "numeric",
        hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
      },
    },
  },
  missingWarn: false,
  fallbackWarn: false,
});

/** 支持的语言列表（label 使用该语言的母语写法，不随界面语言变化） */
export const LOCALE_OPTIONS: { value: Language; label: string }[] = [
  { value: "zh-CN", label: "简体中文" },
  { value: "en", label: "English" },
];

/** 应用语言：切换 i18n locale 并同步 <html lang>（供字体/CSS 伪类使用） */
export function applyLocale(lang: Language) {
  i18n.global.locale.value = lang;
  if (typeof document !== "undefined") document.documentElement.lang = lang;
}
