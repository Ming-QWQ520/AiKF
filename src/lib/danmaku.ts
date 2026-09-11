/**
 * 弹幕多源加载器（服务端 / 哔哩哔哩 / 弹弹）。
 *
 * 数据来源（均逆向自 anichsdk，见 upload/anichsdk）：
 *  1. 服务端  — Anich /danmaku?bangumi=&episode=&skip= （protobuf，页大小 3000）
 *  2. 哔哩哔哩 — 云端代理 /?type=1&oid={bili_cid}&segment_index=N
 *     （protobuf DmSegMobileReply，每段 6 分钟，直到空段为止）
 *  3. 弹弹    — dandanplay 代理 /api/v2/search/anime → /api/v2/bangumi/{id}
 *     → /api/v2/comment/{episodeId}（JSON，p="time,mode,color[,uid]" m="文本"）
 *
 * 输出统一为 artplayer-plugin-danmuku 的 Danmu 格式：
 *   { text, time(秒), mode(0=滚动 1=顶部 2=底部), color("#rrggbb") }
 */

import { invoke } from "@tauri-apps/api/core";
import { getAllDanmaku, fetchExternalBytes, fetchExternalText } from "./anich/client";
import { parseBilibiliDanmakuSegment } from "./anich/parsers";
import type { DanmakuItem } from "./anich/types";
import { isTauriEnv } from "@/stores/cache";

export type DanmuMode = 0 | 1 | 2;
export interface PluginDanmu {
  text: string;
  time: number;
  mode?: DanmuMode;
  color?: string;
  border?: boolean;
}

export type DanmakuSourceKey = "server" | "bili" | "dandan" | "local";

export interface DanmakuSource {
  key: DanmakuSourceKey;
  /** 展示名（参考 AniCh：服务端 / 哔哩哔哩 / 弹弹） */
  name: string;
  /** 详情（集数标识 / cid / 匹配到的番剧话次） */
  detail: string;
  count: number;
  items: PluginDanmu[];
}

/** bilibili 模式 → ArtPlayer 模式（1-3 滚动 / 4 底部 / 5 顶部 / 6-7 逆向滚动） */
function biliMode(m: number): DanmuMode {
  if (m === 5) return 1;
  if (m === 4) return 2;
  return 0;
}

/** RGB 十进制 → #rrggbb */
function rgbIntToHex(n: number): string {
  return `#${Math.max(0, Math.min(0xffffff, n >>> 0)).toString(16).padStart(6, "0")}`;
}

function isValidDanmu(d: PluginDanmu): boolean {
  return !!d.text && d.text.trim().length > 0 && Number.isFinite(d.time) && d.time >= 0;
}

/* ─── 1. 服务端（Anich） ─────────────────────────────────────────────── */

export async function loadServerDanmaku(bangumiID: number, episode: number): Promise<DanmakuSource> {
  const raw: DanmakuItem[] = await getAllDanmaku(bangumiID, episode);
  const items: PluginDanmu[] = raw
    .map((d) => ({
      text: d.text,
      time: d.time,
      // AniCh 服务端 Type 为 Bilibili 风格枚举：1-3=滚动 4=底部 5=顶部（0 视为滚动）。
      // 此前按 DPlayer 语义（1=顶 2=底）映射，导致滚动弹幕全部静止在顶部/底部，
      // 表现为「弹幕不是从页面右侧飘动至左侧」。
      mode: (d.type === 4 ? 2 : d.type === 5 ? 1 : 0) as DanmuMode,
      color: d.color || "#ffffff",
    }))
    .filter(isValidDanmu);
  return { key: "server", name: "服务端", detail: `${bangumiID}·第${episode}话`, count: items.length, items };
}

/* ─── 2. 哔哩哔哩（protobuf 分段代理） ──────────────────────────────── */

const BILI_DM_HOSTS = [
  "https://dm.bili.i.me.cdn.cloudflare.net",
  "https://bili-dm.emmmm.eu.org",
];
/** 每段 6 分钟；上限 80 段 ≈ 8 小时，足够任何单集 */
const BILI_MAX_SEGMENTS = 80;

/** 从 episode.sites 中提取 Bilibili cid（site = bili_cid / bili_hmt_cid） */
export function biliCidOf(sites: { site: string; id: string }[] | undefined): string {
  if (!sites?.length) return "";
  const hit = sites.find((s) => s.site === "bili_cid" && s.id)
    ?? sites.find((s) => s.site === "bili_hmt_cid" && s.id);
  return hit?.id ?? "";
}

export async function loadBiliDanmaku(cid: string): Promise<DanmakuSource> {
  if (!cid) throw new Error("本话没有哔哩哔哩弹幕源");
  const oid = Number(cid);
  if (!Number.isFinite(oid) || oid <= 0) throw new Error("哔哩哔哩 cid 无效");

  let lastErr: unknown = null;
  for (const host of BILI_DM_HOSTS) {
    try {
      const items: PluginDanmu[] = [];
      for (let seg = 1; seg <= BILI_MAX_SEGMENTS; seg++) {
        const url = `${host}/?type=1&oid=${oid}&segment_index=${seg}`;
        const bytes = await fetchExternalBytes(url);
        const list = parseBilibiliDanmakuSegment(bytes);
        if (!list.length) break; // 空段 = 弹幕到头
        for (const d of list) {
          items.push({
            text: d.content,
            time: Math.max(0, d.progress / 1000),
            mode: biliMode(d.mode),
            color: rgbIntToHex(d.color),
          });
        }
      }
      const valid = items.filter(isValidDanmu);
      return { key: "bili", name: "哔哩哔哩", detail: `cid·${cid}`, count: valid.length, items: valid };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("哔哩哔哩弹幕拉取失败");
}

/* ─── 3. 弹弹（dandanplay 代理，JSON） ──────────────────────────────── */

const DANDAN_BASE = "https://dandan.emmmm.eu.org";

interface DandanSearchAnime { animeId: number; animeTitle: string; type: string; typeDescription: string }
interface DandanEpisode { episodeId: number; episodeTitle: string; episodeNumber: string | number }

export async function loadDandanDanmaku(title: string, episode: number): Promise<DanmakuSource> {
  const kw = (title || "").trim();
  if (!kw) throw new Error("缺少番剧标题，无法匹配弹弹弹幕");
  // 1) 搜索番剧（取第一个结果，与 AniCh 客户端行为一致）
  const searchTxt = await fetchExternalText(`${DANDAN_BASE}/api/v2/search/anime?keyword=${encodeURIComponent(kw)}`);
  const search = JSON.parse(searchTxt) as { animes?: DandanSearchAnime[] };
  const anime = search.animes?.[0];
  if (!anime?.animeId) throw new Error("弹弹未匹配到该番剧");
  // 2) 拉取分集列表，按集数匹配
  const detailTxt = await fetchExternalText(`${DANDAN_BASE}/api/v2/bangumi/${anime.animeId}`);
  const detail = JSON.parse(detailTxt) as { bangumi?: { animeTitle?: string; episodes?: DandanEpisode[] } };
  const eps = detail.bangumi?.episodes ?? [];
  const target =
    eps.find((e) => String(e.episodeNumber) === String(episode)) ??
    eps[episode - 1];
  if (!target?.episodeId) throw new Error("弹弹未找到对应话次");
  // 3) 拉取弹幕
  const cmtTxt = await fetchExternalText(`${DANDAN_BASE}/api/v2/comment/${target.episodeId}?withRelated=false&chConvert=1`);
  const cmt = JSON.parse(cmtTxt) as { count?: number; comments?: { cid: number; p: string; m: string }[] };
  const items: PluginDanmu[] = (cmt.comments ?? [])
    .map((c) => {
      const parts = (c.p || "").split(",");
      const time = Number(parts[0]);
      const mode = Number(parts[1]);
      const color = Number(parts[2]);
      return {
        text: c.m,
        time: Number.isFinite(time) ? time : 0,
        mode: (mode === 5 ? 1 : mode === 4 ? 2 : 0) as DanmuMode,
        color: Number.isFinite(color) && color > 0 ? rgbIntToHex(color) : "#ffffff",
      };
    })
    .filter(isValidDanmu);
  const animeTitle = detail.bangumi?.animeTitle || anime.animeTitle;
  return {
    key: "dandan",
    name: "弹弹",
    detail: `${animeTitle} 第${episode}话·${target.episodeId}`,
    count: items.length,
    items,
  };
}

/* ─── 汇总 ──────────────────────────────────────────────────────────── */

/** 按当前启用的源合并弹幕（插件按 time 自动排序）。
 *  按「时间+文本」去重：多源（服务端/bilibili/弹弹）之间存在大量重复弹幕，
 *  会让插件队列膨胀，是弹幕设置操作时 UI 卡顿的主要原因之一。 */
export function mergeDanmaku(sources: DanmakuSource[]): PluginDanmu[] {
  const out: PluginDanmu[] = [];
  const seen = new Set<string>();
  for (const s of sources) {
    for (const d of s.items) {
      const key = `${Math.round(d.time * 10) / 10}|${d.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(d);
    }
  }
  return out;
}

/* ─── 4. 本地缓存（已随番剧下载到本地的弹幕，离线可用） ──────────────── */

/** 读取缓存目录中该集的 danmaku.json（需求：本地缓存增加缓存弹幕） */
export async function loadLocalDanmaku(bangumiId: number, sort: number): Promise<DanmakuSource> {
  if (!isTauriEnv) throw new Error("本地弹幕仅桌面端可用");
  const txt = await invoke<string | null>("cache_danmaku_load", { bangumiId, sort });
  if (!txt) throw new Error("本地无缓存弹幕");
  const items = JSON.parse(txt) as PluginDanmu[];
  const valid = (Array.isArray(items) ? items : []).filter(isValidDanmu);
  return { key: "local", name: "本地缓存", detail: "已随番剧缓存", count: valid.length, items: valid };
}
