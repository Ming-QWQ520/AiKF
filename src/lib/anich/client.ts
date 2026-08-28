/**
 * Anich API client — dual mode.
 *
 * Tauri mode: uses a custom Rust command `anich_fetch` that does HTTP requests
 *   from Rust (reqwest). No Origin header is sent → Anich API returns 200.
 *   This bypasses all Tauri HTTP plugin JS issues.
 *
 * Browser mode: uses the Next.js proxy at localhost:3000 (server-side fetch, no
 *   Origin header → API returns 200).
 */

import { invoke } from "@tauri-apps/api/core";
import Artplayer from "artplayer";
import {
  parseBangumiCharacters,
  parseBangumiLatest,
  parseBangumiPersons,
  parseBangumiRelated,
  parseEpisodes,
} from "./parsers";

// ── Anich SDK parsers come from the customized ArtPlayer bundle ──
// AiKF delegates VOD / danmaku / bangumi-list / playback-URL decoding
// to the `Artplayer.anich` namespace shipped inside the vendored
// ArtPlayer Anich Edition (`third_party/artplayer-anich`). This keeps
// a single source of truth for the wire-format decoders — the JS port
// is shipped inside ArtPlayer, and AiKF simply calls into it.
const anich = Artplayer.anich;
const {
  parseVOD,
  parseDanmakuPage,
  parseBangumiList,
  decodePlaybackURL,
} = anich;
import type {
  BangumiCalendar,
  BangumiCharacterDetail,
  BangumiDetail,
  BangumiListOptions,
  BangumiPersonDetail,
  BangumiTag,
  BangumiTagType,
  BangumiWorksPage,
  CommentCount,
  CommentList,
  VOD,
} from "./types";

function isTauri(): boolean {
  return typeof window !== "undefined" &&
    ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
}

const ANICH_BASE_URL = "https://anich.sends.eu.org".replace(/\/$/, "");
const PROXY_BASE = (
  (import.meta as any).env?.VITE_ANICH_PROXY ?? "http://localhost:3000/api/anich"
).replace(/\/$/, "");

export class AnichAPIError extends Error {
  status: number;
  url: string;
  body: string;
  constructor(message: string, status: number, url: string, body: string) {
    super(message);
    this.name = "AnichAPIError";
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

/* ── Tauri mode: custom Rust fetch command (no Origin header) ── */

function buildUrl(path: string, query?: Record<string, string | number | undefined>): string {
  const url = new URL(ANICH_BASE_URL + path);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

async function rustFetch(url: string, accept: string): Promise<{ bytes: Uint8Array; text: string }> {
  try {
    const result = await invoke<{ status: number; ok: boolean; body: number[]; headers: Record<string, string> }>("anich_fetch", {
      args: { url, headers: { Accept: accept } },
    });
    if (!result.ok) {
      const text = new TextDecoder().decode(new Uint8Array(result.body));
      throw new AnichAPIError(`GET failed (HTTP ${result.status})`, result.status, url, text.slice(0, 512));
    }
    const bytes = new Uint8Array(result.body);
    const text = new TextDecoder().decode(bytes);
    return { bytes, text };
  } catch (e: any) {
    // If the invoke itself failed (Rust error string), wrap it
    if (e instanceof AnichAPIError) throw e;
    throw new AnichAPIError(
      typeof e === "string" ? e : (e?.message || "invoke failed"),
      0, url, ""
    );
  }
}

async function fetchBytes(path: string, query?: Record<string, string | number | undefined>): Promise<Uint8Array> {
  const url = buildUrl(path, query);
  const { bytes } = await rustFetch(url, "*/*");
  return bytes;
}

async function fetchJSON<T>(path: string, query?: Record<string, string | number | undefined>): Promise<T> {
  const url = buildUrl(path, query);
  const { text } = await rustFetch(url, "application/json");
  return JSON.parse(text) as T;
}

/* ── Browser mode: Next.js proxy (server-side, no Origin header) ── */

async function proxyGet<T>(path: string): Promise<T> {
  const res = await fetch(`${PROXY_BASE}${path}`, { headers: { Accept: "application/json" } });
  const json = (await res.json().catch(() => ({}))) as { ok?: boolean; data?: T; error?: string };
  if (!json.ok) throw new AnichAPIError(json.error || `proxy ${path} failed`, res.status, path, "");
  return json.data as T;
}

/* ── Playback URL decoding ──
 * `decodePlaybackURL` and `decodeBase64Flex` are now provided by
 * `Artplayer.anich` from the vendored ArtPlayer Anich Edition bundle.
 * The bundled JS implementation is byte-for-byte compatible with the
 * previous TS port (both were derived from anichsdk Go source). We
 * re-export it here so existing call sites that import from this
 * module keep working.
 */
export { decodePlaybackURL };

/* ── Public API (dual-mode) ── */

export async function getBangumiList(opts: BangumiListOptions = {}): Promise<{ items: any[]; prev: number; next: number }> {
  if (isTauri()) {
    const data = await fetchBytes("/bangumi/list", {
      skip: opts.skip, type: opts.type, lang: opts.lang, year: opts.year, genre: opts.genre, mark: opts.mark,
    });
    return parseBangumiList(data);
  }
  const q = new URLSearchParams();
  if (opts.skip) q.set("skip", String(opts.skip));
  if (opts.type) q.set("type", opts.type);
  if (opts.lang) q.set("lang", opts.lang);
  if (opts.year) q.set("year", opts.year);
  if (opts.genre) q.set("genre", opts.genre);
  if (opts.mark) q.set("mark", opts.mark);
  return proxyGet(`/list${q.toString() ? `?${q}` : ""}`);
}

export async function getBangumiLatest(): Promise<{ items: any[] }> {
  if (isTauri()) return parseBangumiLatest(await fetchBytes("/bangumi/latest"));
  return proxyGet("/latest");
}

export async function getBangumiTags(type: BangumiTagType = "genre", skip = 0): Promise<BangumiTag[]> {
  if (isTauri()) return fetchJSON<BangumiTag[]>("/bangumi/tag", { type, skip });
  return proxyGet(`/tags?type=${type}&skip=${skip}`);
}

export async function getBangumiDetail(id: number): Promise<BangumiDetail> {
  if (isTauri()) return fetchJSON<BangumiDetail>(`/bangumi/detail/${id}`);
  return proxyGet(`/detail/${id}`);
}

export async function getBangumiCalendar(): Promise<BangumiCalendar> {
  if (isTauri()) return fetchJSON<BangumiCalendar>("/bangumi/calendar");
  return proxyGet("/calendar");
}

export async function searchBangumi(keyword: string, skip = 0): Promise<{ items: any[]; prev: number; next: number }> {
  if (isTauri()) return parseBangumiList(await fetchBytes("/bangumi/search", { keyword, skip }));
  return proxyGet(`/search?keyword=${encodeURIComponent(keyword)}&skip=${skip}`);
}

export async function getEpisodes(id: number): Promise<any[]> {
  if (isTauri()) return parseEpisodes(await fetchBytes(`/bangumi/episodes/${id}`));
  return proxyGet(`/episodes/${id}`);
}

export async function getBangumiRelated(id: number): Promise<any[]> {
  if (isTauri()) return parseBangumiRelated(await fetchBytes(`/bangumi/related/${id}`));
  return proxyGet(`/related/${id}`);
}

export async function getBangumiCharacters(id: number): Promise<any[]> {
  if (isTauri()) return parseBangumiCharacters(await fetchBytes(`/bangumi/characters/${id}`));
  return proxyGet(`/characters/${id}`);
}

export async function getBangumiPersons(id: number): Promise<any[]> {
  if (isTauri()) return parseBangumiPersons(await fetchBytes(`/bangumi/persons/${id}`));
  return proxyGet(`/persons/${id}`);
}

export async function getBangumiCharacter(id: number): Promise<BangumiCharacterDetail> {
  if (isTauri()) return fetchJSON<BangumiCharacterDetail>(`/bangumi/character/${id}`);
  return proxyGet(`/character/${id}`);
}

export async function getBangumiCharacterWorks(id: number, skip = 0): Promise<BangumiWorksPage> {
  if (isTauri()) return fetchJSON<BangumiWorksPage>(`/bangumi/character/${id}/bangumi`, { skip });
  return proxyGet(`/character/${id}/works?skip=${skip}`);
}

export async function getBangumiPerson(id: number): Promise<BangumiPersonDetail> {
  if (isTauri()) return fetchJSON<BangumiPersonDetail>(`/bangumi/person/${id}`);
  return proxyGet(`/person/${id}`);
}

export async function getBangumiPersonWorks(id: number, skip = 0): Promise<BangumiWorksPage> {
  if (isTauri()) return fetchJSON<BangumiWorksPage>(`/bangumi/person/${id}/bangumi`, { skip });
  return proxyGet(`/person/${id}/works?skip=${skip}`);
}

export async function getPlaybackSources(id: number, episode: number): Promise<VOD> {
  try {
    let vod: VOD;
    if (isTauri()) {
      const bytes = await fetchBytes(`/vod/${id}/${episode}`);
      vod = parseVOD(bytes);
      for (const s of vod.sources) s.url = decodePlaybackURL(s.rawURL);
    } else {
      vod = await proxyGet<VOD>(`/vod/${id}/${episode}`);
    }
    return vod;
  } catch (e) {
    console.error("[AiKF] getPlaybackSources FAILED:", e);
    throw e;
  }
}

export async function getEpisodeComments(bangumiID: number, episode: number, skip?: string): Promise<CommentList> {
  if (isTauri()) {
    return fetchJSON<CommentList>("/comment", { type: "bangumi_episode", id: `${bangumiID}|${episode}`, skip });
  }
  return proxyGet<CommentList>(`/comments?bangumiID=${bangumiID}&episode=${episode}${skip ? `&skip=${skip}` : ""}`);
}

export async function getEpisodeCommentCount(bangumiID: number, episode: number): Promise<CommentCount> {
  if (isTauri()) {
    return fetchJSON<CommentCount>("/comment/count", { type: "bangumi_episode", id: `${bangumiID}|${episode}` });
  }
  return proxyGet<CommentCount>(`/comment-count?bangumiID=${bangumiID}&episode=${episode}`);
}

export async function getCommentReplies(commentID: string, skip?: string): Promise<CommentList> {
  if (isTauri()) return fetchJSON<CommentList>(`/comment/${encodeURIComponent(commentID)}/replies`, { skip });
  return proxyGet<CommentList>(`/comments/${encodeURIComponent(commentID)}/replies${skip ? `?skip=${skip}` : ""}`);
}

/* ── Danmaku (弹幕) ── */

// `parseDanmakuPage` is provided by the bundled `Artplayer.anich`
// namespace — see the destructuring at the top of this file.
import type { DanmakuItem, DanmakuPage, PostDanmakuRequest } from "./types";

const DANMAKU_PAGE_SIZE = 3000;

/** Get a single page of danmaku for a bangumi episode. */
export async function getDanmakuPage(bangumiID: number, episode: number, skip: number): Promise<DanmakuPage> {
  if (isTauri()) {
    const bytes = await fetchBytes("/danmaku", { bangumi: bangumiID, episode, skip });
    return parseDanmakuPage(bytes);
  }
  // Browser proxy fallback — returns JSON (not protobuf) in proxy mode
  return proxyGet<DanmakuPage>(`/danmaku?bangumiID=${bangumiID}&episode=${episode}&skip=${skip}`);
}

/** Get ALL danmaku for a bangumi episode (paginates through all pages). */
export async function getAllDanmaku(bangumiID: number, episode: number): Promise<DanmakuItem[]> {
  const all: DanmakuItem[] = [];
  for (let skip = 0; ; skip += DANMAKU_PAGE_SIZE) {
    const page = await getDanmakuPage(bangumiID, episode, skip);
    all.push(...page.items);
    if (page.items.length < DANMAKU_PAGE_SIZE) return all;
  }
}

/** Post a new danmaku. Requires a token (user auth). */
export async function postDanmaku(req: PostDanmakuRequest): Promise<Record<string, unknown>> {
  if (!req.bangumiID || !req.episode || !req.text) {
    throw new Error("invalid post danmaku request");
  }
  // POST /danmaku?bangumi=ID&episode=EP with JSON body {text, type, time, color}
  // Note: rustFetch currently only does GET. For POST, we'd need a new Rust command.
  // For now, throw a clear error — POST support requires Rust backend changes.
  throw new Error("post danmaku requires Rust POST support (not yet implemented)");
}
