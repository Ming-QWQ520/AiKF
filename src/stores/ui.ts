import { defineStore } from "pinia";
import type { BangumiLang, BangumiType } from "@/lib/anich/types";

export type ViewKey =
  | "discover"
  | "calendar"
  | "browse"
  | "search"
  | "cache"
  | "library"
  | "detail"
  | "settings";

export interface PlayerState {
  open: boolean;
  bangumiID: number | null;
  episode: number;
  title: string;
  cover: string;
  /** 当前集标题（本地播放 / 顶栏副标题） */
  episodeTitle?: string;
  /**
   * 本地缓存播放模式：指向该集 index.m3u8 的绝对路径（非空 = 本地模式）。
   * 网络播放时为空，走 anich VOD 线路。
   */
  localPath?: string | null;
}

export interface BrowseFilters {
  type?: BangumiType;
  lang?: BangumiLang;
  year?: string;
  genre?: string;
  mark?: string;
  skip: number;
}

interface UIState {
  view: ViewKey;
  detailId: number | null;
  detailCover: string;
  searchQuery: string;
  browseFilters: BrowseFilters;
  player: PlayerState;
  // Sidebar collapsed state — shared so all views can react to it (e.g. to
  // recompute responsive grids when the sidebar toggles, changing main width).
  sidebarCollapsed: boolean;
}

export const useUIStore = defineStore("ui", {
  state: (): UIState => ({
    view: "discover",
    detailId: null,
    detailCover: "",
    searchQuery: "",
    browseFilters: { skip: 0 },
    player: { open: false, bangumiID: null, episode: 1, title: "", cover: "", episodeTitle: "", localPath: null },
    sidebarCollapsed: false,
  }),
  actions: {
    setView(v: ViewKey) {
      this.view = v;
    },
    openDetail(id: number, cover = "") {
      this.view = "detail";
      this.detailId = id;
      this.detailCover = cover;
    },
    setSearchQuery(q: string) {
      this.searchQuery = q;
    },
    setBrowseFilters(f: Partial<BrowseFilters>) {
      this.browseFilters = { ...this.browseFilters, ...f };
    },
    resetBrowseSkip() {
      this.browseFilters = { ...this.browseFilters, skip: 0 };
    },
    openPlayer(p: { bangumiID: number; episode: number; title: string; cover: string; episodeTitle?: string }) {
      this.player = {
        open: true,
        bangumiID: p.bangumiID,
        episode: p.episode,
        title: p.title,
        cover: p.cover,
        episodeTitle: p.episodeTitle ?? "",
        localPath: null,
      };
    },
    /** 本地缓存播放：打开播放器并直接指向本地 index.m3u8 */
    openLocalPlayer(p: {
      bangumiID: number;
      episode: number;
      title: string;
      cover: string;
      episodeTitle?: string;
      localPath: string;
    }) {
      this.player = {
        open: true,
        bangumiID: p.bangumiID,
        episode: p.episode,
        title: p.title,
        cover: p.cover,
        episodeTitle: p.episodeTitle ?? "",
        localPath: p.localPath,
      };
    },
    closePlayer() {
      this.player = { ...this.player, open: false, localPath: null };
    },
    setPlayerEpisode(episode: number, title: string) {
      this.player = { ...this.player, episode, episodeTitle: title ?? "" };
    },
    /** 本地模式切换集数：同步更新本地文件路径 */
    setPlayerLocalEpisode(episode: number, title: string, localPath: string) {
      this.player = { ...this.player, episode, episodeTitle: title ?? "", localPath };
    },
    setSidebarCollapsed(collapsed: boolean) {
      this.sidebarCollapsed = collapsed;
    },
  },
});
