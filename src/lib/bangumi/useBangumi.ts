/** Bangumi 账号状态 + 同步动作的共享 composable（Settings / Library 共用）。 */
import { computed, ref } from "vue";
import * as bgm from "./client";
import { pushAll, pullAll, type SyncProgress, type SyncResult, type PullResult } from "./sync";

const session = ref<bgm.BgmSession | null>(bgm.loadSession());
const user = computed(() => session.value?.user ?? null);
const loggedIn = computed(() => !!session.value);
const busy = ref<"idle" | "login" | "push" | "pull">("idle");
const progress = ref<SyncProgress | null>(null);
const lastError = ref("");
const lastResult = ref<SyncResult | PullResult | null>(null);
const lastSyncAt = ref<number>(Number(localStorage.getItem("aikf:bgm-last-sync") || 0));

function setLastSync() {
  lastSyncAt.value = Date.now();
  try {
    localStorage.setItem("aikf:bgm-last-sync", String(lastSyncAt.value));
  } catch {
    /* ignore */
  }
}

/** 重新从持久化读取会话（登录/登出后调用，跨组件同步状态）。 */
function refreshSession() {
  session.value = bgm.loadSession();
}

async function login(manualCode?: string) {
  busy.value = "login";
  lastError.value = "";
  try {
    session.value = await bgm.login(manualCode ? { manualCode } : {});
  } catch (e: any) {
    lastError.value = String(e?.message || e);
    await bgm.stopOAuth().catch(() => {});
  } finally {
    busy.value = "idle";
  }
  // 需求：授权登录成功后自动把本地追番库同步到 Bangumi（无需手动推送）
  if (session.value) void push();
}

async function logout() {
  bgm.logout();
  refreshSession();
  lastResult.value = null;
}

async function push() {
  busy.value = "push";
  lastError.value = "";
  progress.value = { done: 0, total: 0 };
  try {
    lastResult.value = await pushAll((p) => (progress.value = p));
    setLastSync();
  } catch (e: any) {
    lastError.value = String(e?.message || e);
  } finally {
    busy.value = "idle";
    progress.value = null;
  }
}

async function pull() {
  busy.value = "pull";
  lastError.value = "";
  progress.value = { done: 0, total: 0 };
  try {
    lastResult.value = await pullAll((p) => (progress.value = p));
    setLastSync();
  } catch (e: any) {
    lastError.value = String(e?.message || e);
  } finally {
    busy.value = "idle";
    progress.value = null;
  }
}

export function useBangumi() {
  return {
    session,
    user,
    loggedIn,
    busy,
    progress,
    lastError,
    lastResult,
    lastSyncAt,
    login,
    logout,
    push,
    pull,
    refreshSession,
    fetchMe: bgm.fetchMe,
  };
}
