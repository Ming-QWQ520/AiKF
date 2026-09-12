/**
 * Bangumi 官方 API 客户端（OAuth 授权码流程 + v0 接口）。
 *
 * - 所有请求经 Rust `bgm_fetch` 命令发出（Bangumi 强制自定义 User-Agent，
 *   浏览器 fetch 无法覆盖 UA）。
 * - OAuth：打开系统浏览器授权 → Rust 本地回调服务器（127.0.0.1:27420）
 *   截获 code 并 emit `bgm-oauth-code` 事件 → 此处换 token 并持久化。
 * - 手动兜底：授权完成后浏览器会停在回调页，用户也可以把地址栏完整 URL
 *   （或纯 code）粘贴进设置页的兜底输入框完成登录。
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { i18n } from "@/i18n";
import type {
  BgmCollectionItem,
  BgmEpisode,
  BgmSearchBody,
  BgmSearchResult,
  BgmSession,
  BgmTokenResp,
  BgmUser,
} from "./types";

export type { BgmSession, BgmCollectionItem, BgmEpisode, BgmSearchResult, BgmUser };

// ── 应用凭据（Bangumi 开发者后台注册）──
export const BGM_CLIENT_ID = "bgm71176aa5120285808";
export const BGM_CLIENT_SECRET = "8c33136b712c777acc9e2cc4d3995d00";
export const BGM_REDIRECT_URI = "http://localhost:27420/callback";
const BGM_API = "https://api.bgm.tv";
const BGM_OAUTH = "https://bgm.tv/oauth";
const SESSION_KEY = "aikf:bgm-session";

export class BgmAPIError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "BgmAPIError";
    this.status = status;
  }
}

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

// ── 会话持久化 ──

export function loadSession(): BgmSession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as BgmSession;
    return s?.accessToken ? s : null;
  } catch {
    return null;
  }
}

function saveSession(s: BgmSession | null) {
  try {
    if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
    else localStorage.removeItem(SESSION_KEY);
  } catch {
    /* ignore */
  }
}

let currentUser: BgmUser | null = null;
let userFetched = false;

/** 当前登录用户（未登录或尚未拉取时为 null / 缓存值）。 */
export function cachedUser(): BgmUser | null {
  return currentUser ?? loadSession()?.user ?? null;
}

export function isLoggedIn(): boolean {
  return !!loadSession();
}

export function logout() {
  saveSession(null);
  currentUser = null;
  userFetched = false;
}

/** 停止本地 OAuth 回调监听（登录取消/超时时调用）。 */
export async function stopOAuth() {
  try {
    await invoke("bgm_oauth_stop");
  } catch {
    /* ignore */
  }
}

// ── 底层请求（自动携带 + 自动刷新 token）──

interface BgmFetchResult {
  status: number;
  ok: boolean;
  body: string;
}

async function rawRequest(
  method: string,
  url: string,
  body?: string,
  headers: Record<string, string> = {}
): Promise<BgmFetchResult> {
  const res = await invoke<BgmFetchResult>("bgm_fetch", {
    args: { method, url, body: body ?? null, headers },
  });
  return res;
}

/** 确保会话有效（过期前 5 分钟自动用 refresh_token 续期）。失败返回 null。 */
async function ensureSession(): Promise<BgmSession | null> {
  const s = loadSession();
  if (!s) return null;
  if (Date.now() < s.expiresAt - 5 * 60 * 1000) return s;
  // 过期：尝试刷新
  try {
    const form = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: BGM_CLIENT_ID,
      client_secret: BGM_CLIENT_SECRET,
      refresh_token: s.refreshToken,
      redirect_uri: BGM_REDIRECT_URI,
    });
    const res = await rawRequest("POST", `${BGM_OAUTH}/access_token`, form.toString(), {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    });
    if (!res.ok) throw new Error(`refresh HTTP ${res.status}`);
    const tok = JSON.parse(res.body) as BgmTokenResp;
    const next: BgmSession = {
      accessToken: tok.access_token,
      refreshToken: tok.refresh_token || s.refreshToken,
      expiresAt: Date.now() + (tok.expires_in || 604800) * 1000,
      user: s.user,
    };
    saveSession(next);
    return next;
  } catch (e) {
    console.warn("[AiKF] Bangumi token 刷新失败，需要重新登录:", e);
    return s; // 仍返回旧会话，让请求 401 后走登出处理
  }
}

async function api<T>(method: string, path: string, body?: unknown, retried = false): Promise<T> {
  const s = await ensureSession();
  if (!s) throw new BgmAPIError("not logged in", 0);
  const headers: Record<string, string> = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await rawRequest(method, `${BGM_API}${path}`, body !== undefined ? JSON.stringify(body) : undefined, headers);
  if (res.status === 401 && !retried) {
    // token 可能已被服务端吊销：强制刷新一次后重试
    logout();
    throw new BgmAPIError("unauthorized — please login again", 401);
  }
  if (!res.ok) throw new BgmAPIError(`Bangumi ${method} ${path} -> HTTP ${res.status}: ${res.body.slice(0, 200)}`, res.status);
  return JSON.parse(res.body) as T;
}

// ── OAuth 登录 ──

export function buildAuthorizeUrl(): string {
  const q = new URLSearchParams({
    client_id: BGM_CLIENT_ID,
    response_type: "code",
    redirect_uri: BGM_REDIRECT_URI,
  });
  return `https://bgm.tv/oauth/authorize?${q.toString()}`;
}

export interface LoginOptions {
  /** 手动粘贴的回调 URL 或 code（免浏览器事件兜底） */
  manualCode?: string;
}

/**
 * 完整登录流程：
 * 1. 启动本地回调服务器  2. 打开系统浏览器授权  3. 等待 code（或用 manualCode）
 * 4. 换 token  5. 拉 /v0/me 存档。
 */
export async function login(opts: LoginOptions = {}): Promise<BgmSession> {
  if (!isTauri()) throw new BgmAPIError("Bangumi login requires the desktop app", 0);

  let code = opts.manualCode?.trim();
  if (code) {
    // 支持粘贴完整回调 URL / 或裸 code
    const m = code.match(/[?&]code=([^&\s]+)/);
    if (m) code = decodeURIComponent(m[1]);
  }

  if (!code) {
    await invoke("bgm_oauth_start");
    const url = buildAuthorizeUrl();
    await openUrl(url);
    code = await new Promise<string>((resolve, reject) => {
      const timers: ReturnType<typeof setTimeout>[] = [];
      const offs: UnlistenFn[] = [];
      const cleanup = () => {
        timers.forEach(clearTimeout);
        offs.forEach((off) => off && off());
      };
      // 5 分钟未完成则放弃（同时停掉本地监听）
      timers.push(
        setTimeout(async () => {
          cleanup();
          await invoke("bgm_oauth_stop").catch(() => {});
          reject(new BgmAPIError(i18n.global.t("bgm.error.timeout"), 0));
        }, 5 * 60 * 1000)
      );
      listen<string>("bgm-oauth-code", (ev) => {
        cleanup();
        resolve(ev.payload);
      }).then((off) => offs.push(off));
      listen<string>("bgm-oauth-error", (ev) => {
        cleanup();
        reject(new BgmAPIError(i18n.global.t("bgm.error.authFailed", { msg: ev.payload }), 0));
      }).then((off) => offs.push(off));
    });
  }

  // 换 token
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: BGM_CLIENT_ID,
    client_secret: BGM_CLIENT_SECRET,
    code,
    redirect_uri: BGM_REDIRECT_URI,
  });
  const res = await rawRequest("POST", `${BGM_OAUTH}/access_token`, form.toString(), {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
  });
  if (!res.ok) {
    throw new BgmAPIError(
      i18n.global.t("bgm.error.tokenFail", { status: res.status, redirect: BGM_REDIRECT_URI }),
      res.status
    );
  }
  const tok = JSON.parse(res.body) as BgmTokenResp;

  const session: BgmSession = {
    accessToken: tok.access_token,
    refreshToken: tok.refresh_token || "",
    expiresAt: Date.now() + (tok.expires_in || 604800) * 1000,
  };
  saveSession(session);

  // 拉取用户信息
  try {
    const me = await api<BgmUser>("GET", "/v0/me");
    session.user = me;
    currentUser = me;
    userFetched = true;
    saveSession(session);
  } catch {
    /* me 失败不阻断登录 */
  }
  return session;
}

/** 拉取当前用户（带缓存）。未登录返回 null。 */
export async function fetchMe(): Promise<BgmUser | null> {
  if (!loadSession()) return null;
  if (userFetched && currentUser) return currentUser;
  try {
    currentUser = await api<BgmUser>("GET", "/v0/me");
    userFetched = true;
    const s = loadSession();
    if (s) {
      s.user = currentUser;
      saveSession(s);
    }
    return currentUser;
  } catch {
    return null;
  }
}

// ── v0 接口 ──

/** 按关键词搜索条目（type=2 动画）。 */
export async function searchSubjects(keyword: string, limit = 5): Promise<BgmSearchResult> {
  const body: BgmSearchBody = { keyword, filter: { type: [2] }, limit };
  return api<BgmSearchResult>("POST", "/v0/search/subjects", body);
}

/** 获取当前用户某条目的收藏（无收藏返回 404 → null）。 */
export async function getMyCollection(subjectId: number): Promise<BgmCollectionItem | null> {
  try {
    return await api<BgmCollectionItem>("GET", `/v0/users/-/collections/${subjectId}`);
  } catch (e) {
    if (e instanceof BgmAPIError && e.status === 404) return null;
    throw e;
  }
}

/** 新增 / 更新收藏（所有字段可选）。 */
export async function updateCollection(
  subjectId: number,
  payload: { type?: number; rate?: number; comment?: string; private?: boolean }
): Promise<void> {
  await api<unknown>("POST", `/v0/users/-/collections/${subjectId}`, payload);
}

/** 章节列表（type=0 普通/1 SP/2 OP/3 ED/4 广告...，这里取全部再由调用方过滤）。 */
export async function getEpisodes(subjectId: number, limit = 200): Promise<BgmEpisode[]> {
  const out: BgmEpisode[] = [];
  let offset = 0;
  for (;;) {
    const res = await api<{ data?: BgmEpisode[] }>(
      "GET",
      `/v0/episodes?subject_id=${subjectId}&limit=${limit}&offset=${offset}`
    );
    const batch = res.data ?? [];
    out.push(...batch);
    if (batch.length < limit) break;
    offset += limit;
  }
  return out;
}

/** 批量标记章节看过（type=2）。 */
export async function markEpisodesSeen(subjectId: number, episodeIds: number[]): Promise<void> {
  if (!episodeIds.length) return;
  // 分批（每批 100，防超大 payload）
  for (let i = 0; i < episodeIds.length; i += 100) {
    await api<unknown>("PATCH", `/v0/users/-/collections/${subjectId}/episodes`, {
      episode_id: episodeIds.slice(i, i + 100),
      type: 2,
    });
  }
}

/** 当前用户的动画收藏列表（自动翻页；type=2 subject_type 为动画）。 */
export async function getMyCollections(
  onBatch?: (batch: BgmCollectionItem[]) => void
): Promise<BgmCollectionItem[]> {
  const all: BgmCollectionItem[] = [];
  const limit = 50;
  let offset = 0;
  for (;;) {
    const res = await api<{ data?: BgmCollectionItem[] }>(
      "GET",
      `/v0/users/-/collections?subject_type=2&limit=${limit}&offset=${offset}`
    );
    const batch = res.data ?? [];
    all.push(...batch);
    onBatch?.(batch);
    if (batch.length < limit) break;
    offset += limit;
    if (offset > 2000) break; // 安全上限
  }
  return all;
}

// ── 本地 TrackStatus ↔ Bangumi 收藏类型 ──

export const STATUS_TO_BGM: Record<string, number> = {
  watching: 3, // 在看
  planned: 1, // 想看
  completed: 2, // 看过
  onhold: 4, // 搁置
  dropped: 5, // 抛弃
};

export const BGM_TO_STATUS: Record<number, string> = {
  3: "watching",
  1: "planned",
  2: "completed",
  4: "onhold",
  5: "dropped",
};
