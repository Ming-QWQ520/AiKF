/** Small display helpers shared across the UI. */
import { i18n } from "@/i18n";

export function formatDate(ts: number | undefined | null): string {
  if (!ts || ts <= 0) return "—";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

export function formatRelative(ts: number | undefined | null): string {
  if (!ts || ts <= 0) return "";
  const now = Date.now();
  const diff = ts - now;
  const abs = Math.abs(diff);
  const day = 86400000;
  if (abs < day) {
    const h = Math.round(abs / 3600000);
    return diff > 0 ? i18n.global.t("time.hoursLater", { n: h }) : i18n.global.t("time.hoursAgo", { n: h });
  }
  const d = Math.round(abs / day);
  if (diff > 0) return d === 1 ? i18n.global.t("time.tomorrow") : i18n.global.t("time.daysLater", { n: d });
  return d === 1 ? i18n.global.t("time.yesterday") : i18n.global.t("time.daysAgo", { n: d });
}

export function formatDuration(sec: number): string {
  if (!sec || sec <= 0) return "";
  const m = Math.round(sec / 60);
  if (m < 60) return i18n.global.t("time.minutes", { n: m });
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? i18n.global.t("time.hoursMin", { h, m: r }) : i18n.global.t("time.hours", { h });
}

/** 星期显示（key 形式供 i18n 查询；sort 越界时按 dayN 带序号） */
const WEEKDAY_KEYS = ["time.w0", "time.w1", "time.w2", "time.w3", "time.w4", "time.w5", "time.w6"];
export function weekdayLabel(sort: number): string {
  const key = WEEKDAY_KEYS[sort % 7];
  return key ? i18n.global.t(key) : i18n.global.t("time.dayN", { n: sort });
}

export function pickBestImage(image?: string): string {
  if (!image) return "";
  return image;
}

export function clampScore(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(10, n));
}

/** Year extraction from a tagline like "2026/奇幻/动画". */
export function yearFromTagline(tagline?: string): string {
  if (!tagline) return "";
  const m = tagline.match(/(19\d{2}|20\d{2})/);
  return m ? m[1] : "";
}

export function genresFromTagline(tagline?: string): string[] {
  if (!tagline) return [];
  return tagline
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s && !/^\d{4}$/.test(s));
}
