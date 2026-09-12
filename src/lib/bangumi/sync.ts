/**
 * AiKF 追番库 ↔ Bangumi 收藏 云同步。
 *
 * 上行（push）：本地追番库条目 → Bangumi 收藏（状态 + 评分 + 章节看过标记）。
 *   条目匹配：本地标题 → POST /v0/search/subjects（动画类）→ 严格匹配
 *   （季数感知：归一化完全相等，或去季数后主体相等且季数一致）。
 *   映射结果持久化到 localStorage，只搜一次。
 *
 * 下行（pull）：Bangumi 收藏列表 → 反查 AniCh → 导入本地追番库
 *   （未匹配到 AniCh 的条目以 bgmOnly 占位入库，详情页惰性重试 + 可手动重绑）。
 *
 * 自动同步（默认开启，无开关）：库变更 → auto-sync.ts 监听 → 防抖后
 * pushEntries 单条推送；pull 期间静音避免原样回推。
 */
import { useLibraryStore, type LibraryEntry, type TrackStatus } from "@/stores/library";
import * as bgm from "./client";
import type { BgmCollectionItem, BgmEpisode, BgmSubject } from "./types";

// ── subject 映射缓存（anichId → bgmSubjectId）──

// v2：v1 旧缓存由宽松算法（includes/唯一结果兜底）生成，可能含误匹配，直接弃用
const MAP_KEY = "aikf:bgm-subject-map:v2";
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

/** 标题归一化：小写 + 去空白/标点（保留季数标记参与比对，避免「剑来 第二季」错配《剑来》第一季） */
function normalizeTitle(t: string): string {
  return (t || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[「」『』()（）\[\]【】·・:：,，。.!?！？'"'"~～\-—_+*]/g, "");
}

// ── 季数感知匹配 ──
// 历史教训：旧算法用「双向 includes + 剥掉季数后缀」导致大量张冠李戴
//（「剑来 第二季」归一化成「剑来」后精确命中第一季；「东京喰种」includes 命中
//《东京喰种:re》）。现改为严格相等 + 季数一致性校验，宁缺毋滥。

function normalizeDigits(s: string): string {
  return s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
}

/** 中文数字 → 阿拉伯数字（支持 一~九十九，解析失败返回 NaN） */
function cnNumToArabic(s: string): number {
  const d: Record<string, number> = { 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  if (s === "十") return 10;
  const m = s.match(/^([一二三四五六七八九])?十(.*)$/);
  if (m) {
    const tens = (m[1] ? d[m[1]] : 1) * 10;
    const ones = m[2] && d[m[2]] !== undefined ? d[m[2]] : 0;
    return tens + ones;
  }
  return d[s] !== undefined ? d[s] : Number.NaN;
}

const ROMAN: Record<string, number> = { II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8, IX: 9, X: 10 };

/** 提取季数：第X季/第X期、Season X、Nnd Season、结尾罗马数字；无标记 → 1 */
function seasonOf(raw: string): number {
  const t = raw || "";
  let m = t.match(/第\s*([0-9０-９一二三四五六七八九十百]+)\s*[季期]/);
  if (m) {
    const n = cnNumToArabic(normalizeDigits(m[1]));
    if (Number.isFinite(n) && n > 0) return n;
  }
  m = t.match(/season\s*(\d+)/i);
  if (m) return parseInt(m[1], 10);
  m = t.match(/(\d+)\s*(?:nd|rd|th)\s*season/i);
  if (m) return parseInt(m[1], 10);
  m = t.match(/(?:^|\s)(II|III|IV|V|VI|VII|VIII|IX|X)$/);
  if (m) return ROMAN[m[1]];
  return 1;
}

/** 去掉季数标记后的标题主体 */
function stripSeason(raw: string): string {
  return (raw || "")
    .replace(/第\s*[0-9０-９一二三四五六七八九十百]+\s*[季期]/g, " ") // i18n-skip: 标题归一化正则（非文案）
    .replace(/\s*season\s*\d+/gi, " ")
    .replace(/\s*(\d+)\s*(?:nd|rd|th)\s*season/gi, " ")
    .replace(/\s+(II|III|IV|V|VI|VII|VIII|IX|X)$/g, "");
}

/**
 * 严格标题匹配：
 * 1) 归一化后完全相等（含季数标记）；或
 * 2) 去掉季数标记后主体相等 且 季数一致。
 * 不再做任何 includes / 唯一结果兜底 —— 误匹配比匹配不到危害大得多。
 */
function titlesMatch(a: string, b: string): boolean {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const sa = seasonOf(a);
  const sb = seasonOf(b);
  if (sa !== sb) return false;
  const ca = normalizeTitle(stripSeason(a));
  const cb = normalizeTitle(stripSeason(b));
  return !!ca && ca === cb;
}

/** 在搜索结果里挑最佳匹配：仅接受严格匹配（先中文名后原名），不再兜底。 */
function pickSubject(title: string, data: BgmSubject[]): BgmSubject | null {
  if (!data?.length) return null;
  for (const s of data) {
    if (s.name_cn && titlesMatch(title, s.name_cn)) return s;
  }
  for (const s of data) {
    if (s.name && titlesMatch(title, s.name)) return s;
  }
  return null;
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
 * 推送指定条目到 Bangumi（自动同步与全量推送共用）。
 * - 有收藏 → 更新状态+评分；无收藏 → 新建（按本地状态）。
 * - watchedEpisodes 非空时：拉章节列表 → 按 order/ep 序号匹配 → 批量标记看过。
 */
export async function pushEntries(
  ids: number[],
  onProgress?: (p: SyncProgress) => void
): Promise<SyncResult> {
  const library = useLibraryStore();
  const result: SyncResult = { pushed: 0, skipped: 0, failed: 0, errors: [] };

  for (let i = 0; i < ids.length; i++) {
    const entry = library.entries[ids[i]];
    if (!entry) continue;
    onProgress?.({ done: i, total: ids.length, current: entry.title });
    try {
      const subject = await findSubjectFor(entry);
      if (!subject) {
        result.skipped++;
        continue;
      }
      const bgmType = bgm.STATUS_TO_BGM[entry.status] ?? 3;
      // 评分一并同步（0 分不覆盖云端已评分）
      await bgm.updateCollection(subject.id, { type: bgmType, rate: entry.score || undefined });

      // 章节进度（仅当本地有观看记录）
      if (entry.watchedEpisodes.length > 0) {
        try {
          const eps = await bgm.getEpisodes(subject.id);
          const idByNum = buildEpisodeIndex(eps);
          const epIds = entry.watchedEpisodes
            .map((n) => idByNum.get(n))
            .filter((x): x is number => typeof x === "number");
          await bgm.markEpisodesSeen(subject.id, epIds);
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
  onProgress?.({ done: ids.length, total: ids.length });
  return result;
}

/** 把整个本地追番库推送到 Bangumi（设置页/追番库手动按钮）。 */
export async function pushAll(onProgress?: (p: SyncProgress) => void): Promise<SyncResult> {
  const library = useLibraryStore();
  return pushEntries(
    library.list.map((e) => e.id),
    onProgress
  );
}

// ── 自动同步静音（pull 期间置位，避免把刚拉取的数据原样推回）──

const muteState = { value: false };

export function setPushMuted(m: boolean) {
  muteState.value = m;
}

export function isPushMuted(): boolean {
  return muteState.value;
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

/**
 * AniCh 搜索并选最佳匹配（季数感知严格比对）。
 * 旧版双向 includes 曾导致「剑来 第二季」绑到第一季、「东京喰种」绑到 :re ——
 * 现在只接受 titlesMatch 严格命中，宁缺毋滥（未命中走 bgmOnly 占位）。
 */
export async function anichSearchFirst(keyword: string, expect: string): Promise<any | null> {
  const { anich } = await import("@/lib/anich/api-client");
  try {
    const res = await anich.search(keyword, 0);
    const items = res.items ?? [];
    for (const it of items) {
      if (titlesMatch(String(it.title || ""), expect)) {
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
