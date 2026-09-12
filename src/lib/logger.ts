/**
 * 前端日志系统：把 webview 侧日志汇聚到 Rust 文件日志
 * （exe目录\log\yyyy-MM-dd HH-mm.log，经 tauri-plugin-log 落盘）。
 *
 * - initFileLogging()：attachConsole 把 console.* 全量转发给 Rust logger；
 *   并挂 window 全局 error / unhandledrejection 钩子兜底。
 * - logInfo / logWarn / logError / logDebug：带 [tag] 前缀的结构化日志，
 *   桌面端写文件，浏览器开发模式降级 console。
 */
import { attachConsole, debug, error, info, warn } from "@tauri-apps/plugin-log";

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

let initialized = false;

/** 应用启动时调用一次：console 全量转发 + 全局错误兜底写入日志文件。 */
export async function initFileLogging(): Promise<void> {
  if (initialized || !isTauri()) return;
  initialized = true;
  try {
    // console.log/warn/error → Rust logger → 文件（不吞原始控制台输出）
    await attachConsole();
  } catch (e) {
    console.warn("[logger] attachConsole 失败，日志仅输出到控制台:", e);
  }
  window.addEventListener("error", (ev) => {
    void error(`[window.error] ${ev.message} @ ${ev.filename}:${ev.lineno}:${ev.colno}`);
  });
  window.addEventListener("unhandledrejection", (ev) => {
    const reason = (ev as PromiseRejectionEvent).reason;
    const detail = reason instanceof Error ? reason.stack || reason.message : String(reason);
    void error(`[unhandledrejection] ${detail}`);
  });
}

function fmt(tag: string, msg: string): string {
  return `[${tag}] ${msg}`;
}

export function logInfo(tag: string, msg: string): void {
  if (isTauri()) void info(fmt(tag, msg));
  else console.info(`[${tag}]`, msg);
}

export function logWarn(tag: string, msg: string): void {
  if (isTauri()) void warn(fmt(tag, msg));
  else console.warn(`[${tag}]`, msg);
}

export function logError(tag: string, msg: string): void {
  if (isTauri()) void error(fmt(tag, msg));
  else console.error(`[${tag}]`, msg);
}

export function logDebug(tag: string, msg: string): void {
  if (isTauri()) void debug(fmt(tag, msg));
  else console.debug(`[${tag}]`, msg);
}
