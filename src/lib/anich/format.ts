/** Small display helpers shared across the UI. */

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
    return diff > 0 ? `${h}小时后` : `${h}小时前`;
  }
  const d = Math.round(abs / day);
  if (diff > 0) return d === 1 ? "明天" : `${d}天后`;
  return d === 1 ? "昨天" : `${d}天前`;
}

export function formatDuration(sec: number): string {
  if (!sec || sec <= 0) return "";
  const m = Math.round(sec / 60);
  if (m < 60) return `${m}分钟`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h}小时${r}分` : `${h}小时`;
}

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
export function weekdayLabel(sort: number): string {
  return WEEKDAYS[sort % 7] ?? `第${sort}天`;
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
