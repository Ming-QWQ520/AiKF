import { defineStore } from "pinia";

export type TrackStatus =
  | "watching"
  | "planned"
  | "completed"
  | "onhold"
  | "dropped";

export const STATUS_LABELS: Record<TrackStatus, string> = {
  watching: "在看",
  planned: "想看",
  completed: "看过",
  onhold: "搁置",
  dropped: "弃番",
};

export const STATUS_ORDER: TrackStatus[] = [
  "watching",
  "planned",
  "completed",
  "onhold",
  "dropped",
];

export const STATUS_STYLES: Record<TrackStatus, { dot: string; chip: string }> = {
  watching: { dot: "bg-secondary", chip: "bg-secondary/15 text-secondary" },
  planned: { dot: "bg-primary", chip: "bg-primary/15 text-primary" },
  completed: { dot: "bg-tertiary", chip: "bg-tertiary/20 text-tertiary-foreground" },
  onhold: { dot: "bg-amber-500", chip: "bg-amber-500/15 text-amber-600 dark:text-amber-400" },
  dropped: { dot: "bg-destructive", chip: "bg-destructive/15 text-destructive" },
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
            this.entries = parsed;
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
      },
      status: TrackStatus
    ) {
      const existing = this.entries[info.id];
      const now = Date.now();
      const entry: LibraryEntry = existing
        ? { ...existing, status, updatedAt: now }
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
          };
      this.entries = { ...this.entries, [info.id]: entry };
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
      if (!e || e.watchedEpisodes.includes(episode)) return;
      const watched = [...e.watchedEpisodes, episode].sort((a, b) => a - b);
      const current = Math.max(e.currentEpisode, episode);
      this.entries = {
        ...this.entries,
        [id]: {
          ...e,
          watchedEpisodes: watched,
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
      this.entries = {
        ...this.entries,
        [id]: { ...e, currentEpisode: episode, updatedAt: Date.now() },
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
