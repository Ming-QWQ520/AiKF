/**
 * AiKF 追番库 ↔ Bangumi 收藏 云同步。
 *
 * 上行（push）：本地追番库条目 → Bangumi 收藏（状态 + 章节看过标记）。
 *   条目匹配：本地标题 → POST /v0/search/subjects（动画类）→ 取最佳匹配
 *   （name/name_cn 与本地标题归一化后完全相等，或本地标题包含对方）。
 *   映射结果持久化到 localStorage，只搜一次。
 *
 * 下行（pull）：Bangumi 收藏列表 → 反查 AniCh → 导入本地追番库
 *   （找不到对应 AniCh 条目的跳过并计数）。
 */
import { useLibraryStore, type LibraryEntry, type TrackStatus } from "@/stores/library";
import * as bgm from "./client";
import type { BgmCollectionItem, BgmEpisode, BgmSubject } from "./types";

// ── subject 映射缓存（anichId → bgmSubjectId）──

const MAP_KEY = "aikf:bgm-subject-map";
interface MapEntry {
  subjectId: number;
  name: string;
  matchedAt: number;
  /** 匹配失败记录（避免反复搜索同一个标题） */
  failed?: boolean;
}

function loadMap(): Record<string, MapEntry> {
  try {
    return JSON.parse(localStorage.getItem(MAP_KEY) || "{}");
  } catch {
    return {};
  }
}

function saveMap(m: Record<string, MapEntry>) {
  try {
    localStorage.setItem(MAP_KEY, JSON.stringify(m));
  } catch {
    /* ignore */
  }
}

/** 标题归一化：去空白/标点/常见前后缀差异，提高匹配成功率 */
function normalizeTitle(t: string): string {
  return (t || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[「」『』()（）\[\]【】·・:：,，。.!?！？'"'"-]/g, "")
    .replace(/第[0-9一二三四五六七八九十百]+季$/, "") // i18n-skip: 标题归一化正则（非文案）
    .replace(/season\s*\d+$/i, "");
}

/** 在搜索结果里挑最佳匹配（完全相等 > 包含 > 第一个）。 */
function pickSubject(title: string, data: BgmSubject[]): BgmSubject | null {
  if (!data?.length) return null;
  const nt = normalizeTitle(title);
  const candidates = data.map((s) => [s, [s.name_cn, s.name].filter((n): n is string => !!n).map(normalizeTitle)] as const);
  for (const [s, names] of candidates) {
    if (names.includes(nt)) return s;
  }
  for (const [s, names] of candidates) {
    if (names.some((n) => n && (nt.includes(n) || n.includes(nt)))) return s;
  }
  // 全部不相似时，仅当结果唯一才接受（避免张冠李戴）
  return data.length === 1 ? data[0] : null;
}

/** 查（并缓存）本地条目对应的 Bangumi 条目。匹配不到返回 null。 */
export async function findSubjectFor(entry: LibraryEntry): Promise<BgmSubject | null> {
  // 已知 Bangumi 条目 ID（云端导入的条目都带 bgmId）→ 免搜索直接用
  if (entry.bgmId) return { id: entry.bgmId, name: entry.title };
  const map = loadMap();
  const hit = map[String(entry.id)];
  if (hit) {
    if (hit.failed) return null;
    return { id: hit.subjectId, name: hit.name };
  }
  try {
    const res = await bgm.searchSubjects(entry.title, 8);
    const subject = pickSubject(entry.title, res.data ?? []);
    map[String(entry.id)] = subject
      ? { subjectId: subject.id, name: subject.name_cn || subject.name || entry.title, matchedAt: Date.now() }
      : { subjectId: 0, name: entry.title, matchedAt: Date.now(), failed: true };
    saveMap(map);
    return subject;
  } catch (e) {
    console.warn("[AiKF] Bangumi 搜索失败:", entry.title, e);
    return null;
  }
}

export function clearSubjectMap() {
  saveMap({});
}

// ── 上行：本地 → 云端 ──

export interface SyncProgress {
  done: number;
  total: number;
  current?: string;
}

export interface SyncResult {
  pushed: number;
  skipped: number;
  failed: number;
  errors: string[];
}

/**
 * 把整个本地追番库推送到 Bangumi。
 * - 有收藏 → 更新状态；无收藏 → 新建（看过的标 done，其它按本地状态）。
 * - watchedEpisodes 非空时：拉章节列表 → 按 order/ep 序号匹配 → 批量标记看过。
 */
export async function pushAll(onProgress?: (p: SyncProgress) => void): Promise<SyncResult> {
  const library = useLibraryStore();
  const entries = library.list;
  const result: SyncResult = { pushed: 0, skipped: 0, failed: 0, errors: [] };

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    onProgress?.({ done: i, total: entries.length, current: entry.title });
    try {
      const subject = await findSubjectFor(entry);
      if (!subject) {
        result.skipped++;
        continue;
      }
      const bgmType = bgm.STATUS_TO_BGM[entry.status] ?? 3;
      await bgm.updateCollection(subject.id, { type: bgmType });

      // 章节进度（仅当本地有观看记录）
      if (entry.watchedEpisodes.length > 0) {
        try {
          const eps = await bgm.getEpisodes(subject.id);
          const idByNum = buildEpisodeIndex(eps);
          const ids = entry.watchedEpisodes
            .map((n) => idByNum.get(n))
            .filter((x): x is number => typeof x === "number");
          await bgm.markEpisodesSeen(subject.id, ids);
        } catch (e) {
          // 章节标记失败不阻断状态同步
          console.warn("[AiKF] 章节标记失败:", entry.title, e);
        }
      }
      result.pushed++;
      // 轻微节流，避免触发 Bangumi 限流
      await sleep(300);
    } catch (e: any) {
      result.failed++;
      result.errors.push(`${entry.title}: ${e?.message || e}`);
      if (e instanceof bgm.BgmAPIError && e.status === 401) throw e; // 登录失效，停止
    }
  }
  onProgress?.({ done: entries.length, total: entries.length });
  return result;
}

/** 章节序号 → episode_id 索引（优先 ep 数值，其次 order 数字前缀）。 */
function buildEpisodeIndex(eps: BgmEpisode[]): Map<number, number> {
  const m = new Map<number, number>();
  for (const ep of eps) {
    if (ep.type !== 0) continue; // 0=普通本篇（跳过 OP/ED/SP/广告）
    let num: number | undefined = typeof ep.ep === "number" ? ep.ep : undefined;
    if (num === undefined && ep.order) {
      const parsed = parseFloat(ep.order);
      if (Number.isFinite(parsed)) num = parsed;
    }
    if (num !== undefined && Number.isInteger(num) && !m.has(num)) {
      m.set(num, ep.id);
    }
  }
  return m;
}

// ── 下行：云端 → 本地 ──

export interface PullResult {
  imported: number;
  skipped: number;
  failed: number;
}

/**
 * 从 Bangumi 拉收藏并导入本地追番库（覆盖本地同 ID 条目的状态/观看集数）。
 * 仅导入类型 1 想看 / 3 在看 / 2 看过 的动画条目。
 * 需求：无论 AniCh 是否有资源都添加至追番库 —— 未匹配到 AniCh 条目时
 * 用 Bangumi 数据入库（负数占位 id + bgmOnly 标记），详情页打开时惰性重试匹配。
 */
export async function pullAll(onProgress?: (p: SyncProgress) => void): Promise<PullResult> {
  const library = useLibraryStore();
  const items = await bgm.getMyCollections();
  const result: PullResult = { imported: 0, skipped: 0, failed: 0 };
  const valid = items.filter((it) => [1, 2, 3].includes(Number(it.type)));

  for (let i = 0; i < valid.length; i++) {
    const item = valid[i];
    const subject = (item.subject ?? item) as BgmCollectionItem["subject"];
    const title = subject?.name_cn || subject?.name || "";
    onProgress?.({ done: i, total: valid.length, current: title });
    if (!title || !subject?.id) {
      result.skipped++;
      continue;
    }
    try {
      const status = (bgm.BGM_TO_STATUS[Number(item.type)] ?? "watching") as TrackStatus;
      // 反查 AniCh（优先中文名；再试原名）
      let match: any = null;
      for (const kw of [subject?.name_cn, subject?.name]) {
        if (!kw) continue;
        const res = await anichSearchFirst(kw, title);
        if (res) {
          match = res;
          break;
        }
        await sleep(250);
      }
      if (match) {
        // 有资源：正常入库并记录 bgmId（推送时免搜索）
        library.addOrUpdate(
          {
            id: match.id,
            title: match.title,
            image: match.image,
            tagline: match.tagline,
            totalEpisodes: match.totalEpisodes,
            bgmId: subject.id,
          },
          status
        );
        result.imported++;
        await sleep(300);
      } else {
        // 无匹配：仍添加至追番库（负数占位 id 避免与 AniCh id 空间冲突）
        library.addOrUpdate(
          {
            id: -subject.id,
            title,
            image: subject.images?.large || subject.images?.common || subject.images?.medium || "",
            tagline: subject.date || "",
            totalEpisodes: subject.eps ?? 0,
            bgmId: subject.id,
            bgmOnly: true,
          },
          status
        );
        result.imported++;
      }
    } catch (e: any) {
      result.failed++;
      if (e instanceof bgm.BgmAPIError && e.status === 401) throw e;
    }
  }
  onProgress?.({ done: valid.length, total: valid.length });
  return result;
}

/** AniCh 搜索并选最佳匹配（标题归一化比对）。 */
export async function anichSearchFirst(keyword: string, expect: string): Promise<any | null> {
  const { anich } = await import("@/lib/anich/api-client");
  try {
    const res = await anich.search(keyword, 0);
    const items = res.items ?? [];
    const ne = normalizeTitle(expect);
    for (const it of items) {
      const t = normalizeTitle(String(it.title || ""));
      if (t === ne || (t && (t.includes(ne) || ne.includes(t)))) {
        return {
          id: it.id,
          title: it.title,
          image: it.image,
          tagline: it.tagline,
          totalEpisodes: it.episodes_total ?? 0,
        };
      }
    }
    return null;
  } catch {
    return null;
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
