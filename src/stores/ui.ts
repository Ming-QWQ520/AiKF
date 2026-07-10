import { defineStore } from "pinia";
import type { BangumiLang, BangumiType } from "@/lib/anich/types";

export type ViewKey =
  | "discover"
  | "calendar"
  | "browse"
  | "search"
  | "library"
  | "detail"
  | "settings";

export interface PlayerState {
  open: boolean;
  bangumiID: number | null;
  episode: number;
  title: string;
  cover: string;
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
}

export const useUIStore = defineStore("ui", {
  state: (): UIState => ({
    view: "discover",
    detailId: null,
    detailCover: "",
    searchQuery: "",
    browseFilters: { skip: 0 },
    player: { open: false, bangumiID: null, episode: 1, title: "", cover: "" },
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
    openPlayer(p: { bangumiID: number; episode: number; title: string; cover: string }) {
      this.player = {
        open: true,
        bangumiID: p.bangumiID,
        episode: p.episode,
        title: p.title,
        cover: p.cover,
      };
    },
    closePlayer() {
      this.player = { ...this.player, open: false };
    },
    setPlayerEpisode(episode: number, title: string) {
      this.player = { ...this.player, episode, title };
    },
  },
});
