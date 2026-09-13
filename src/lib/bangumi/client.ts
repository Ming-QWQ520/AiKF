/**
 * Bangumi 官方 API 客户端（OAuth 授权码流程 + v0 接口）。
 *
 * - 所有请求经 Rust `bgm_fetch` 命令发出（Bangumi 强制自定义 User-Agent，
 *   浏览器 fetch 无法覆盖 UA）。
 * - OAuth（RFC 8252）：打开系统浏览器授权 → bgm.tv 重定向到自定义协议
 *   aikf://auth/callback → 系统拉起/唤醒 AiKF → Rust 校验 state 后 emit
 *   `bgm-oauth-code` 事件 → 此处换 token 并持久化。
 * - 手动兜底：若协议注册异常，用户也可以把浏览器地址栏完整 URL
 *   （或纯 code）粘贴进设置页的兜底输入框完成登录。
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { i18n } from "@/i18n";
import { logError, logInfo, logWarn } from "@/lib/logger";
import type {
  BgmCollectionItem,
  BgmEpisode,
  BgmEpisodeCollectionItem,
  BgmPage,
  BgmSearchBody,
  BgmSearchResult,
  BgmSession,
  BgmTokenResp,
  BgmUser,
  BgmUserCharacterCollection,
  BgmUserPersonCollection,
} from "./types";

export type {
  BgmSession,
  BgmCollectionItem,
  BgmEpisode,
  BgmEpisodeCollectionItem,
  BgmSearchResult,
  BgmUser,
  BgmUserCharacterCollection,
  BgmUserPersonCollection,
};

// ── 应用凭据（Bangumi 开发者后台注册）──
export const BGM_CLIENT_ID = "bgm71176aa5120285808";
export const BGM_CLIENT_SECRET = "8c33136b712c777acc9e2cc4d3995d00";
/** 自定义协议回调地址（须与 Bangumi 开发者后台「回调地址」完全一致）。 */
export const BGM_REDIRECT_URI = "aikf://auth/callback";
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

/** 停止登录流程（清空 Rust 侧预期 state 与 pending code，取消/超时时调用）。 */
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
  return forceRefresh(s);
}

/** 强制用 refresh_token 换新 token（到期续期 / 401 恢复共用）。失败登出并返回 null。 */
async function forceRefresh(old: BgmSession): Promise<BgmSession | null> {
  try {
    const form = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: BGM_CLIENT_ID,
      client_secret: BGM_CLIENT_SECRET,
      refresh_token: old.refreshToken,
      redirect_uri: BGM_REDIRECT_URI,
    });
    const res = await rawRequest("POST", `${BGM_OAUTH}/access_token`, form.toString(), {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    });
    if (!res.ok) throw new Error(`refresh HTTP ${res.status}: ${res.body.slice(0, 200)}`);
    const tok = JSON.parse(res.body) as BgmTokenResp;
    if (!tok?.access_token) {
      throw new Error(`refresh 响应缺少 access_token: ${res.body.slice(0, 200)}`);
    }
    const next: BgmSession = {
      accessToken: tok.access_token,
      refreshToken: tok.refresh_token || old.refreshToken,
      expiresAt: Date.now() + (tok.expires_in || 604800) * 1000,
      user: old.user,
    };
    saveSession(next);
    logInfo("bgm-auth", "token 已自动续期（refresh_token）"); // i18n-skip: 日志文案
    return next;
  } catch (e) {
    logWarn("bgm-auth", `token 刷新失败，需要重新登录: ${String(e)}`); // i18n-skip: 日志文案
    logout();
    return null;
  }
}

async function api<T>(method: string, path: string, body?: unknown, retried = false): Promise<T> {
  const s = await ensureSession();
  if (!s) throw new BgmAPIError("not logged in", 0);
  const headers: Record<string, string> = {
    Accept: "application/json",
    // 关键：Bangumi API 靠 Bearer token 鉴权，缺失会 401 "need Login"
    Authorization: `Bearer ${s.accessToken}`,
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await rawRequest(method, `${BGM_API}${path}`, body !== undefined ? JSON.stringify(body) : undefined, headers);
  if (res.status === 401 && !retried) {
    // token 可能已被服务端吊销：强制刷新一次后重试
    const fresh = await forceRefresh(s);
    if (!fresh) throw new BgmAPIError("unauthorized — please login again", 401);
    return api<T>(method, path, body, true);
  }
  if (!res.ok) throw new BgmAPIError(`Bangumi ${method} ${path} -> HTTP ${res.status}: ${res.body.slice(0, 200)}`, res.status);
  return JSON.parse(res.body) as T;
}

// ── OAuth 登录 ──

interface OauthStartResult {
  authorize_url: string;
  redirect_uri: string;
}

export interface LoginOptions {
  /** 手动粘贴的回调 URL 或 code（免浏览器事件兜底） */
  manualCode?: string;
}

/**
 * 完整登录流程：
 * 1. 优先取 pending 授权码（冷启动回调已就绪时直接登录）
 * 2. 否则打开系统浏览器授权  3. 等待 code（事件 + 轮询兜底，或 manualCode）
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
    // 冷启动场景：授权回调已把应用拉起、code 已在 pending 槽位 → 直接用
    const pending = await invoke<string | null>("bgm_oauth_take_pending").catch(() => null);
    if (pending) {
      code = pending;
      logInfo("bgm-auth", "命中 pending 授权码（冷启动/事件丢失兜底）"); // i18n-skip: 日志文案
    } else {
      const st = await invoke<OauthStartResult>("bgm_oauth_start");
      logInfo("bgm-auth", `打开系统浏览器授权 → ${st.authorize_url}`); // i18n-skip: 日志文案
      await openUrl(st.authorize_url);
      code = await new Promise<string>((resolve, reject) => {
        const timers: ReturnType<typeof setTimeout>[] = [];
        const offs: UnlistenFn[] = [];
        let poll: ReturnType<typeof setInterval> | undefined;
        const cleanup = () => {
          timers.forEach(clearTimeout);
          offs.forEach((off) => off && off());
          if (poll) clearInterval(poll);
        };
        // 5 分钟未完成则放弃（同时清空 Rust 侧 state/pending）
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
        // 轮询兜底：协议拉起新实例时事件可能早于监听器就绪
        poll = setInterval(async () => {
          try {
            const c = await invoke<string | null>("bgm_oauth_take_pending");
            if (c) {
              cleanup();
              resolve(c);
            }
          } catch {
            /* ignore */
          }
        }, 1500);
      });
    }
  }

  // 换 token
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: BGM_CLIENT_ID,
    client_secret: BGM_CLIENT_SECRET,
    code,
    redirect_uri: BGM_REDIRECT_URI,
  });
  logInfo("bgm-auth", "授权码已获取，开始换取 token"); // i18n-skip: 日志文案
  const res = await rawRequest("POST", `${BGM_OAUTH}/access_token`, form.toString(), {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
  });
  if (!res.ok) {
    logError("bgm-auth", `换 token 失败 HTTP ${res.status}: ${res.body.slice(0, 300)}`); // i18n-skip: 日志文案
    throw new BgmAPIError(
      i18n.global.t("bgm.error.tokenFail", { status: res.status, redirect: BGM_REDIRECT_URI }),
      res.status
    );
  }
  const tok = JSON.parse(res.body) as BgmTokenResp;
  if (!tok?.access_token) {
    // HTTP 200 但响应体不是合法 token（bgm.tv 偶发把 OAuth 错误放在 200 里返回）
    logError("bgm-auth", `token 响应异常（无 access_token）: ${res.body.slice(0, 300)}`); // i18n-skip: 日志文案
    throw new BgmAPIError(
      i18n.global.t("bgm.error.tokenFail", { status: res.status, redirect: BGM_REDIRECT_URI }),
      res.status
    );
  }
  logInfo(
    "bgm-auth",
    `token 换取成功（len=${tok.access_token.length} · expires_in=${tok.expires_in ?? 604800}s${tok.user_id ? ` · uid=${tok.user_id}` : ""}）`
  ); // i18n-skip: 日志文案

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
    logInfo("bgm-auth", `登录完成：${me.nickname || me.username || me.id}`); // i18n-skip: 日志文案
  } catch (e) {
    logWarn(
      "bgm-auth",
      `/v0/me 拉取失败（不阻断登录）: ${e instanceof BgmAPIError ? e.message : String(e)}`
    ); // i18n-skip: 日志文案
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

/**
 * 当前用户的路径标识。
 * 读路径（GET 收藏列表/单条）按规范只支持 /v0/users/{username}/...，
 * 不支持 `-` 简写（那是写操作 POST/PATCH 专属）；username 优先，
 * 未设置用户名时回退 uid（规范：设置了用户名后无法用 UID 查询）。
 */
async function currentPathIdent(): Promise<string> {
  let u = cachedUser();
  if (!u) u = await fetchMe();
  if (!u) throw new BgmAPIError("not logged in", 0);
  const name = (u.username ?? "").trim();
  return encodeURIComponent(name || String(u.id));
}

/** 按关键词搜索条目（type=2 动画）。 */
export async function searchSubjects(keyword: string, limit = 5): Promise<BgmSearchResult> {
  const body: BgmSearchBody = { keyword, filter: { type: [2] }, limit };
  return api<BgmSearchResult>("POST", "/v0/search/subjects", body);
}

/** 获取当前用户某条目的收藏（无收藏返回 404 → null）。 */
export async function getMyCollection(subjectId: number): Promise<BgmCollectionItem | null> {
  const ident = await currentPathIdent();
  try {
    return await api<BgmCollectionItem>("GET", `/v0/users/${ident}/collections/${subjectId}`);
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
  return setEpisodesStatus(subjectId, episodeIds, 2);
}

/**
 * 批量设置章节观看状态（EpisodeCollectionType）。
 * 0=未收藏（取消标记）/ 1=想看 / 2=看过 / 3=抛弃。
 * 对应 PATCH /v0/users/-/collections/{subject_id}/episodes（写操作用 `-` 简写）。
 */
export async function setEpisodesStatus(
  subjectId: number,
  episodeIds: number[],
  type: number
): Promise<void> {
  if (!episodeIds.length) return;
  // 分批（每批 100，防超大 payload）
  for (let i = 0; i < episodeIds.length; i += 100) {
    await api<unknown>("PATCH", `/v0/users/-/collections/${subjectId}/episodes`, {
      episode_id: episodeIds.slice(i, i + 100),
      type,
    });
  }
}

/**
 * 获取某条目的逐集观看状态（需求：观看集数不连续时提供准确明细）。
 * 对应 GET /v0/users/-/collections/{subject_id}/episodes（规范允许此读路径用 `-`
 * 简写指代当前用户，与收藏列表的 /v0/users/{username}/... 不同）。
 * 返回：该条目下每话的 { episode, type }（type=0 未收藏也会返回）。
 */
export async function getSubjectEpisodeCollection(
  subjectId: number,
  limit = 1000
): Promise<BgmEpisodeCollectionItem[]> {
  const res = await api<BgmPage<BgmEpisodeCollectionItem>>(
    "GET",
    `/v0/users/-/collections/${subjectId}/episodes?limit=${limit}&offset=0`
  );
  return res.data ?? [];
}

/** 当前用户的动画收藏列表（自动翻页；subject_type=2 为动画）。读路径必须用 username。 */
export async function getMyCollections(
  onBatch?: (batch: BgmCollectionItem[]) => void
): Promise<BgmCollectionItem[]> {
  const ident = await currentPathIdent();
  const all: BgmCollectionItem[] = [];
  const limit = 50;
  let offset = 0;
  for (;;) {
    const res = await api<{ data?: BgmCollectionItem[]; total?: number }>(
      "GET",
      `/v0/users/${ident}/collections?subject_type=2&limit=${limit}&offset=${offset}`
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

/**
 * 某一类型的云端收藏总数（limit=1 只取信封里的 total，开销极小）。
 * subjectType：1 书籍 / 2 动画 / 3 音乐 / 4 游戏 / 6 三次元。
 */
export async function getCollectionsCount(subjectType: number): Promise<number> {
  const ident = await currentPathIdent();
  const res = await api<BgmPage<unknown>>(
    "GET",
    `/v0/users/${ident}/collections?subject_type=${subjectType}&limit=1&offset=0`
  );
  return Number(res.total) || 0;
}

/** 最近更新的动画收藏（单页，不翻页；用于「我的」页最近收藏展示）。 */
export async function getRecentCollections(limit = 12): Promise<BgmCollectionItem[]> {
  const ident = await currentPathIdent();
  const res = await api<BgmPage<BgmCollectionItem>>(
    "GET",
    `/v0/users/${ident}/collections?subject_type=2&limit=${limit}&offset=0`
  );
  return res.data ?? [];
}

/** 收藏的角色（GET /v0/users/{username}/collections/-/characters，规范无分页参数，一次性返回）。 */
export async function getCharacterCollections(): Promise<BgmUserCharacterCollection[]> {
  const ident = await currentPathIdent();
  const res = await api<BgmPage<BgmUserCharacterCollection>>(
    "GET",
    `/v0/users/${ident}/collections/-/characters`
  );
  return res.data ?? [];
}

/** 收藏的人物（GET /v0/users/{username}/collections/-/persons，规范无分页参数，一次性返回）。 */
export async function getPersonCollections(): Promise<BgmUserPersonCollection[]> {
  const ident = await currentPathIdent();
  const res = await api<BgmPage<BgmUserPersonCollection>>(
    "GET",
    `/v0/users/${ident}/collections/-/persons`
  );
  return res.data ?? [];
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
