/**
 * 追番库自动云同步（需求：默认开启，无开关，每次修改都自动同步）。
 *
 * - 通过 Pinia $onAction 监听追番库 store 的全部变更 action；
 * - 收集被修改的条目 id → 3s 防抖 → pushEntries 只推送变更条目
 *   （不做全量推送：登录时全量推曾在误匹配时期污染用户云端收藏）；
 * - pull 期间 sync.ts 静音位生效，fire 时直接丢弃待推队列；
 * - 未登录时静默跳过；失败仅记日志，绝不阻断用户操作。
 *
 * 刻意不同步的变更：
 * - remove/clearAll（取消收藏/清空库）：云端删除是破坏性操作，
 *   误触无法恢复，同步只做「新增/修改」不做「删除」。
 */
import { useLibraryStore } from "@/stores/library";
import { isLoggedIn } from "./client";
import { pushEntries, isPushMuted } from "./sync";
import { logInfo, logWarn } from "@/lib/logger";

const DEBOUNCE_MS = 3_000;

/** 会改变条目内容/状态的 action（参数[0] 均为条目 id 或含 id 的 info） */
const WATCHED_ACTIONS = new Set([
  "addOrUpdate",
  "setStatus",
  "markEpisode",
  "markPlayedEpisode",
  "unmarkEpisode",
  "toggleEpisode",
  "setCurrentEpisode",
  "setScore",
  "upgradeBgmOnly",
  "rebindEntry",
  "reconcileEpisodes",
]);

const pending = new Set<number>();
let timer: ReturnType<typeof setTimeout> | undefined;
let firing = false;

function extractEntryId(name: string, args: unknown[]): number | undefined {
  const first = args[0] as any;
  if (first == null) return undefined;
  if (typeof first === "number") return first;
  if (typeof first === "object" && typeof first.id === "number") return first.id;
  console.warn(`[AiKF][auto-sync] 未能从 ${name}(${args.map(String)}) 提取条目 id`); // i18n-skip: 日志文案
  return undefined;
}

async function fire() {
  timer = undefined;
  if (firing) return;
  if (isPushMuted()) {
    pending.clear();
    return;
  }
  const ids = Array.from(pending);
  pending.clear();
  if (ids.length === 0) return;
  if (!isLoggedIn()) return;
  firing = true;
  try {
    const res = await pushEntries(ids);
    if (res.pushed > 0 || res.failed > 0) {
      logInfo(
        "auto-sync",
        `自动同步完成：推送 ${res.pushed} · 跳过 ${res.skipped} · 失败 ${res.failed}` // i18n-skip: 日志文案
      );
    }
    if (res.skipped > 0) {
      logWarn(
        "auto-sync",
        `${res.skipped} 条未同步（Bangumi 严格匹配未命中，可稍后手动重绑）` // i18n-skip: 日志文案
      );
    }
  } catch (e: any) {
    logWarn("auto-sync", `自动同步失败（不影响使用）: ${e?.message || e}`); // i18n-skip: 日志文案
  } finally {
    firing = false;
  }
}

function schedule(id: number | undefined) {
  if (typeof id === "number") pending.add(id);
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void fire(), DEBOUNCE_MS);
}

/** 在 pinia 安装后调用一次；内部拿到 library store 并挂 action 监听。 */
export function setupAutoSync() {
  const library = useLibraryStore();
  library.$onAction(({ name, args, after }) => {
    if (!WATCHED_ACTIONS.has(name)) return;
    const id = extractEntryId(name, args);
    after(() => {
      if (isPushMuted()) return;
      schedule(id);
    });
  });
  logInfo("auto-sync", "追番库自动云同步已就绪（默认开启，修改后约 3 秒推送）"); // i18n-skip: 日志文案
}
