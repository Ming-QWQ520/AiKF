import { defineStore } from "pinia";

export type TrackStatus =
  | "watching"
  | "planned"
  | "completed"
  | "onhold"
  | "dropped";

/** 追番状态 → i18n key（显示文案经 $t()/t() 翻译，支持多语言） */
export const STATUS_I18N_KEYS: Record<TrackStatus, string> = {
  watching: "library.status.watching",
  planned: "library.status.planned",
  completed: "library.status.completed",
  onhold: "library.status.onhold",
  dropped: "library.status.dropped",
};

export const STATUS_ORDER: TrackStatus[] = [
  "watching",
  "planned",
  "completed",
  "onhold",
  "dropped",
];

export const STATUS_STYLES: Record<TrackStatus, { dot: string; chip: string }> = {
  watching: { dot: "bg-sky-500", chip: "bg-sky-500/10 text-sky-600 dark:text-sky-400" },
  planned: { dot: "bg-primary", chip: "bg-primary/10 text-primary" },
  completed: { dot: "bg-emerald-500", chip: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" },
  onhold: { dot: "bg-amber-500", chip: "bg-amber-500/10 text-amber-600 dark:text-amber-400" },
  dropped: { dot: "bg-destructive", chip: "bg-destructive/10 text-destructive" },
};

export interface LibraryEntry {
  id: number;
  title: string;
  image: string;
  tagline: string;
  totalEpisodes: number;
  status: TrackStatus;
  currentEpisode: number;
  watchedEpisodes: number[];
  score: number;
  addedAt: number;
  updatedAt: number;
  // Playback progress: { [episode: number]: { time: number, duration: number } }
  playbackProgress?: Record<number, { time: number; duration: number }>;
  /** 关联的 Bangumi 条目 ID（用于免搜索直接推送收藏；已匹配与 bgmOnly 条目均有） */
  bgmId?: number;
  /** 无 AniCh 资源：来自 Bangumi 导入、尚未匹配到 AniCh 条目（id 为负数占位，详情页打开时惰性重试匹配） */
  bgmOnly?: boolean;
}

interface LibraryState {
  entries: Record<number, LibraryEntry>;
  _hydrated: boolean;
}

const STORAGE_KEY = "anich-library-v1";

export const useLibraryStore = defineStore("library", {
  state: (): LibraryState => ({
    entries: {},
    _hydrated: false,
  }),
  getters: {
    list: (state) => Object.values(state.entries).sort((a, b) => b.updatedAt - a.updatedAt),
    count: (state) => Object.keys(state.entries).length,
    has: (state) => (id: number) => !!state.entries[id],
    get: (state) => (id: number) => state.entries[id],
    /** 真实观看数（≤ 总集数）：仅统计真实播放产生的标记 */
    watchedCount: (state) => (id: number) => {
      const e = state.entries[id];
      if (!e) return 0;
      const total = e.totalEpisodes;
      const watched = total > 0 ? e.watchedEpisodes.filter((x) => x <= total) : e.watchedEpisodes;
      return Math.min(watched.length, total > 0 ? total : watched.length);
    },
    /** 当前看到第几话（≤ 总集数） */
    currentEp: (state) => (id: number) => {
      const e = state.entries[id];
      if (!e) return 0;
      const total = e.totalEpisodes;
      const cur = e.currentEpisode || e.watchedEpisodes.length || 0;
      return total > 0 ? Math.min(cur, total) : cur;
    },
  },
  actions: {
    /** Hydrate from localStorage. Call once at app startup. */
    hydrate() {
      if (this._hydrated) return;
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === "object") {
            // 归一化：观看集数不能超过总集数（历史数据可能越界）
            for (const key of Object.keys(parsed)) {
              const e = parsed[key] as LibraryEntry;
              const total = e.totalEpisodes ?? 0;
              if (total > 0) {
                e.watchedEpisodes = Array.from(new Set(e.watchedEpisodes ?? []))
                  .filter((x) => x >= 1 && x <= total)
                  .sort((a, b) => a - b);
                if ((e.currentEpisode ?? 0) > total) e.currentEpisode = total;
              } else {
                e.watchedEpisodes = Array.from(new Set(e.watchedEpisodes ?? [])).sort((a, b) => a - b);
              }
              // playbackProgress 只保留存在的集数键
              if (e.playbackProgress && total > 0) {
                for (const k of Object.keys(e.playbackProgress)) {
                  if (Number(k) > total) delete e.playbackProgress[Number(k)];
                }
              }
            }
            this.entries = parsed;
            this._persist();
          }
        }
      } catch {
        /* ignore corrupt storage */
      }
      this._hydrated = true;
    },
    _persist() {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(this.entries));
      } catch {
        /* storage full / unavailable */
      }
    },
    addOrUpdate(
      info: {
        id: number;
        title: string;
        image: string;
        tagline?: string;
        totalEpisodes?: number;
        bgmId?: number;
        bgmOnly?: boolean;
      },
      status: TrackStatus
    ) {
      const existing = this.entries[info.id];
      const now = Date.now();
      const entry: LibraryEntry = existing
        ? {
            ...existing,
            status,
            // Always refresh metadata from the latest API response so the
            // library entry stays in sync (title/image/tagline/totalEpisodes
            // can change between seasons or after backend data fixes).
            title: info.title || existing.title,
            image: info.image || existing.image,
            tagline: info.tagline ?? existing.tagline,
            totalEpisodes: info.totalEpisodes ?? existing.totalEpisodes,
            bgmId: info.bgmId ?? existing.bgmId,
            bgmOnly: info.bgmOnly ?? existing.bgmOnly,
            updatedAt: now,
          }
        : {
            id: info.id,
            title: info.title,
            image: info.image,
            tagline: info.tagline ?? "",
            totalEpisodes: info.totalEpisodes ?? 0,
            status,
            currentEpisode: 0,
            watchedEpisodes: [],
            score: 0,
            addedAt: now,
            updatedAt: now,
            bgmId: info.bgmId,
            bgmOnly: info.bgmOnly,
          };
      this.entries = { ...this.entries, [info.id]: entry };
      this._persist();
    },
    /**
     * bgmOnly 条目（负数占位 id）匹配到真实 AniCh 条目后升级：
     * 重新建键为正数 id、摘除 bgmOnly 标记、记录 bgmId。
     * 若库中已存在同 AniCh id 的条目则合并（保留原键，观看记录取并集）。
     */
    upgradeBgmOnly(
      oldId: number,
      hit: { id: number; title?: string; image?: string; tagline?: string; totalEpisodes?: number }
    ) {
      const bgmEntry = this.entries[oldId];
      if (!bgmEntry?.bgmOnly) return;
      const existing = hit.id > 0 ? this.entries[hit.id] : undefined;
      const now = Date.now();
      if (existing) {
        // 已有同 AniCh 条目：合并观看记录/播放进度，状态以云端导入的为准
        const merged: LibraryEntry = {
          ...existing,
          status: bgmEntry.status,
          watchedEpisodes: Array.from(
            new Set([...existing.watchedEpisodes, ...bgmEntry.watchedEpisodes])
          ).sort((a, b) => a - b),
          playbackProgress: { ...(bgmEntry.playbackProgress ?? {}), ...(existing.playbackProgress ?? {}) },
          bgmId: existing.bgmId ?? bgmEntry.bgmId,
          updatedAt: now,
        };
        const next = { ...this.entries };
        delete next[oldId];
        next[hit.id] = merged;
        this.entries = next;
      } else {
        const { bgmOnly: _drop, ...rest } = bgmEntry;
        const upgraded: LibraryEntry = {
          ...rest,
          id: hit.id,
          title: hit.title || rest.title,
          image: hit.image || rest.image,
          tagline: hit.tagline ?? rest.tagline,
          totalEpisodes: hit.totalEpisodes || rest.totalEpisodes,
          updatedAt: now,
        };
        const next = { ...this.entries, [hit.id]: upgraded };
        delete next[oldId];
        this.entries = next;
      }
      this._persist();
    },
    /**
     * Sync metadata (title/image/tagline/totalEpisodes) for an existing
     * library entry from the latest API response. Used to repair legacy
     * entries that were created before the API returned episodesTotal.
     *
     * Unlike addOrUpdate, this does NOT change the entry's status — it only
     * fills in missing/stale metadata. Safe to call repeatedly.
     */
    syncMeta(
      id: number,
      meta: {
        title?: string;
        image?: string;
        tagline?: string;
        totalEpisodes?: number;
      }
    ) {
      const e = this.entries[id];
      if (!e) return;
      const updated: LibraryEntry = {
        ...e,
        title: meta.title ?? e.title,
        image: meta.image ?? e.image,
        tagline: meta.tagline ?? e.tagline,
        totalEpisodes: meta.totalEpisodes ?? e.totalEpisodes,
        updatedAt: Date.now(),
      };
      // Only persist + reassign if something actually changed (avoid needless writes)
      if (
        updated.title === e.title &&
        updated.image === e.image &&
        updated.tagline === e.tagline &&
        updated.totalEpisodes === e.totalEpisodes
      ) {
        return;
      }
      this.entries = { ...this.entries, [id]: updated };
      this._persist();
    },
    remove(id: number) {
      const next = { ...this.entries };
      delete next[id];
      this.entries = next;
      this._persist();
    },
    setStatus(id: number, status: TrackStatus) {
      const e = this.entries[id];
      if (!e) return;
      this.entries = { ...this.entries, [id]: { ...e, status, updatedAt: Date.now() } };
      this._persist();
    },
    markEpisode(id: number, episode: number, totalEpisodes?: number) {
      const e = this.entries[id];
      if (!e) return;
      const total = totalEpisodes ?? e.totalEpisodes;
      // 观看集数不能超过总集数
      if (total > 0 && (episode > total || episode < 1)) return;
      if (e.watchedEpisodes.includes(episode)) return;
      const watched = [...e.watchedEpisodes, episode].sort((a, b) => a - b);
      const cappedWatched = total > 0 ? watched.filter((x) => x <= total) : watched;
      const currentRaw = Math.max(e.currentEpisode, episode);
      const current = total > 0 ? Math.min(currentRaw, total) : currentRaw;
      this.entries = {
        ...this.entries,
        [id]: {
          ...e,
          watchedEpisodes: cappedWatched,
          currentEpisode: current,
          totalEpisodes: totalEpisodes ?? e.totalEpisodes,
          updatedAt: Date.now(),
        },
      };
      this._persist();
    },
    unmarkEpisode(id: number, episode: number) {
      const e = this.entries[id];
      if (!e) return;
      this.entries = {
        ...this.entries,
        [id]: {
          ...e,
          watchedEpisodes: e.watchedEpisodes.filter((x) => x !== episode),
          updatedAt: Date.now(),
        },
      };
      this._persist();
    },
    toggleEpisode(id: number, episode: number, totalEpisodes?: number) {
      const e = this.entries[id];
      if (!e) {
        this.addOrUpdate({ id, title: "", image: "", totalEpisodes }, "watching");
        this.markEpisode(id, episode, totalEpisodes);
        return;
      }
      if (e.watchedEpisodes.includes(episode)) {
        this.unmarkEpisode(id, episode);
      } else {
        this.markEpisode(id, episode, totalEpisodes);
      }
    },
    setCurrentEpisode(id: number, episode: number) {
      const e = this.entries[id];
      if (!e) return;
      // 不能超过总集数
      const current = e.totalEpisodes > 0 ? Math.min(Math.max(0, episode), e.totalEpisodes) : Math.max(0, episode);
      this.entries = {
        ...this.entries,
        [id]: { ...e, currentEpisode: current, updatedAt: Date.now() },
      };
      this._persist();
    },
    setScore(id: number, score: number) {
      const e = this.entries[id];
      if (!e) return;
      this.entries = {
        ...this.entries,
        [id]: { ...e, score: Math.max(0, Math.min(10, score)), updatedAt: Date.now() },
      };
      this._persist();
    },
    clearAll() {
      this.entries = {};
      this._persist();
    },
    savePlaybackProgress(id: number, episode: number, time: number, duration: number) {
      const e = this.entries[id];
      if (!e) return;
      if (duration > 0 && time / duration > 0.9) {
        // 真实看完（>90%）才计入观看数据（markEpisode 内部有总集数钳制）
        this.markEpisode(id, episode);
      }
      if (!e.playbackProgress) e.playbackProgress = {};
      e.playbackProgress[episode] = { time, duration };
      this._persist();
    },
    getPlaybackProgress(id: number, episode: number): { time: number; duration: number } | null {
      const e = this.entries[id];
      if (!e || !e.playbackProgress) return null;
      return e.playbackProgress[episode] ?? null;
    },
  },
});
