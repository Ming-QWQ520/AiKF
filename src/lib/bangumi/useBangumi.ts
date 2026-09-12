/**
 * Bangumi 账号状态 + 登录/云端拉取的共享 composable（NavShell / 我的 / 追番库共用）。
 *
 * 同步模型（需求 2026-09-12）：
 * - 上行：每次修改自动同步（auto-sync.ts 全局监听，无手动按钮）；
 * - 下行：登录成功后自动从云端拉取一次 + 应用启动已登录时静默拉取一次；
 *   手动「同步到云端 / 从云端恢复」按钮已随需求移除。
 */
import { computed, ref } from "vue";
import * as bgm from "./client";
import { pullAll, setPushMuted, type SyncProgress, type PullResult } from "./sync";
import { logInfo, logWarn } from "@/lib/logger";

const session = ref<bgm.BgmSession | null>(bgm.loadSession());
const user = computed(() => session.value?.user ?? null);
const loggedIn = computed(() => !!session.value);
const busy = ref<"idle" | "login" | "pull">("idle");

const LAST_SYNC_KEY = "aikf:bgm-last-sync";

function touchLastSync() {
  try {
    localStorage.setItem(LAST_SYNC_KEY, String(Date.now()));
  } catch {
    /* ignore */
  }
}

/**
 * 从云端拉取收藏到本地（内部方法，不再暴露手动按钮）。
 * - 拉取期间静音自动同步：pullAll 批量 addOrUpdate 会触发变更监听，
 *   不静音的话刚拉下来的收藏会被原样推回云端（无意义且消耗 API 配额）；
 * - 失败仅记日志，绝不阻断使用。
 */
async function pull(): Promise<PullResult | null> {
  if (!session.value) return null;
  if (busy.value !== "idle") return null;
  busy.value = "pull";
  const progress: SyncProgress = { done: 0, total: 0 };
  setPushMuted(true);
  try {
    const res = await pullAll((p) => Object.assign(progress, p));
    touchLastSync();
    logInfo(
      "bgm-sync",
      `云端拉取完成：导入 ${res.imported} · 跳过 ${res.skipped} · 失败 ${res.failed}` // i18n-skip: 日志文案
    );
    return res;
  } catch (e: any) {
    logWarn("bgm-sync", `云端拉取失败（不影响本地使用）: ${e?.message || e}`); // i18n-skip: 日志文案
    return null;
  } finally {
    setPushMuted(false);
    busy.value = "idle";
  }
}

/** 每次应用运行最多自动拉取一次（登录触发的强拉不受限制）。 */
let autoPulledThisRun = false;

/**
 * 自动从云端拉取（已登录时才生效）。
 * - 登录成功后 force=true 立即拉取；
 * - 应用启动时 force=false 静默补拉一次（会话恢复场景）。
 */
async function autoPullFromCloud(force = false) {
  if (!session.value) return;
  if (!force && autoPulledThisRun) return;
  if (busy.value !== "idle") return;
  autoPulledThisRun = true;
  await pull();
}

async function login(manualCode?: string) {
  busy.value = "login";
  try {
    session.value = await bgm.login(manualCode ? { manualCode } : {});
  } catch (e: any) {
    logWarn("bgm-auth", `登录失败: ${e?.message || e}`); // i18n-skip: 日志文案
    await bgm.stopOAuth().catch(() => {});
  } finally {
    busy.value = "idle";
  }
  // 需求（2026-09-12）：登录成功后自动从云端拉取收藏数据到本地追番库。
  // pull 内部已静音自动推送，拉取的条目不会被原样推回云端。
  if (session.value) void autoPullFromCloud(true);
}

async function logout() {
  bgm.logout();
  session.value = null;
}

export function useBangumi() {
  return {
    session,
    user,
    loggedIn,
    busy,
    login,
    logout,
    fetchMe: bgm.fetchMe,
    autoPullFromCloud,
  };
}

/** 应用启动时调用：已有登录态则静默从云端拉取一次（每次运行最多一次）。 */
export function autoPullOnBoot() {
  void autoPullFromCloud(false);
}
